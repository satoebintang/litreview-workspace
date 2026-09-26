import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUnsupportedDirectorySyncError, LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";

async function withTemporaryStorageRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "litreview_storage_integrity_test_"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("full-text document storage", () => {
  let root = "";
  let storage!: LocalDocumentStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "litreview_document_storage_test_"));
    storage = new LocalDocumentStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("hashes streamed PDF bytes and installs a final key without consuming its recovery stage", async () => {
    const bytes = Buffer.from("%PDF-1.7\nstreamed test bytes\n");
    const staged = await storage.stage(Readable.from([bytes]), { maxBytes: 50 });
    expect(staged.byteSize).toBe(bytes.byteLength);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(staged.signature)).toEqual(Array.from(Buffer.from("%PDF-")));
    const key = `projects/${randomUUID()}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
    await storage.install(staged.temporaryKey, key);
    expect(await storage.exists(key)).toBe(true);
    expect(await readFile(path.join(root, key))).toEqual(bytes);
    expect(await storage.exists(staged.temporaryKey)).toBe(true);
    await storage.remove(staged.temporaryKey);
    expect(await storage.exists(staged.temporaryKey)).toBe(false);
  });

  it("installs with exclusive destination semantics and preserves a concurrent winner", async () => {
    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const local = new LocalDocumentStorage(temporaryRoot);
      const finalKey = `projects/${randomUUID()}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
      const leftBytes = Buffer.from("%PDF-1.7\nleft winner");
      const rightBytes = Buffer.from("%PDF-1.7\nright winner");
      const left = await local.stage(Readable.from([leftBytes]));
      const right = await local.stage(Readable.from([rightBytes]));

      await Promise.all([
        local.install(left.temporaryKey, finalKey),
        local.install(right.temporaryKey, finalKey),
      ]);
      const final = await local.inspect(finalKey);
      expect(final).not.toBeNull();
      expect([left.sha256, right.sha256]).toContain(final?.sha256);
      expect([leftBytes.byteLength, rightBytes.byteLength]).toContain(final?.byteSize);
      expect(await local.exists(left.temporaryKey)).toBe(true);
      expect(await local.exists(right.temporaryKey)).toBe(true);
      await local.remove(left.temporaryKey);
      await local.remove(right.temporaryKey);
    });
  });

  it("does not create a missing storage root during a read-only inventory", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "litreview_storage_read_only_root_"));
    const missingRoot = path.join(parent, "not-created");
    try {
      const local = new LocalDocumentStorage(missingRoot);
      await expect(local.listKeys()).resolves.toEqual([]);
      await expect((await import("node:fs/promises")).stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("classifies unsupported directory fsync separately from real durability failures", () => {
    const error = (code: string) => Object.assign(new Error(code), { code });
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"]) {
      expect(isUnsupportedDirectorySyncError(error(code), "linux")).toBe(true);
      expect(isUnsupportedDirectorySyncError(error(code), "win32")).toBe(true);
    }
    expect(isUnsupportedDirectorySyncError(error("EPERM"), "win32")).toBe(true);
    expect(isUnsupportedDirectorySyncError(error("EPERM"), "linux")).toBe(false);
    expect(isUnsupportedDirectorySyncError(error("EIO"), "win32")).toBe(false);
  });

  it("removes staged bytes after overflow, invalid signatures, and stream interruption", async () => {
    await expect(storage.stage(Readable.from([Buffer.from("%PDF-1.7\n1234567890")]), { maxBytes: 10 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE", message: expect.stringContaining("10 bytes") });
    await expect(storage.stage(Readable.from([Buffer.from("not a PDF")]), { maxBytes: 50 })).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    async function* interrupted() {
      yield Buffer.from("%PDF-1.7\npartial");
      throw new Error("client disconnected");
    }
    await expect(storage.stage(interrupted(), { maxBytes: 50 })).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    expect((await storage.listKeys()).filter((key) => key.startsWith(".tmp/"))).toEqual([]);
  });

  it("accepts exactly 50 MiB and rejects one byte more", async () => {
    const maxBytes = 50 * 1024 * 1024;
    const exact = Buffer.alloc(maxBytes);
    Buffer.from("%PDF-").copy(exact);
    const staged = await storage.stage(Readable.from([exact]), { maxBytes });
    expect(staged.byteSize).toBe(maxBytes);
    await storage.remove(staged.temporaryKey);
    const overflow = Buffer.concat([exact, Buffer.from("x")]);
    await expect(storage.stage(Readable.from([overflow]), { maxBytes })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE", message: expect.stringContaining("50 MiB") });
  }, 20_000);

  it("rejects traversal and absolute storage keys", async () => {
    const staged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\nbytes")]), { maxBytes: 50 });
    await expect(storage.install(staged.temporaryKey, "../escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await expect(storage.install(staged.temporaryKey, "C:\\escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await storage.remove(staged.temporaryKey);
  });

  it("keeps retained PDF intake bytes in a separate namespace", async () => {
    const intake = new LocalPdfIntakeStorage(root);
    const staged = await intake.stage(Readable.from([Buffer.from("%PDF-1.7\naccepted for metadata inspection")]));
    expect(staged.temporaryKey).toMatch(/^\.pdf-intake\/.tmp\//);
    expect(await intake.exists(staged.temporaryKey)).toBe(true);
    expect(staged.temporaryKey).not.toMatch(/^\.tmp\//);
    await expect(intake.open("projects/not-an-intake-key")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await intake.remove(staged.temporaryKey);
  });

  it("returns false only for missing keys in each adapter's namespace", async () => {
    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const documentStorage = new LocalDocumentStorage(temporaryRoot);
      const intakeStorage = new LocalPdfIntakeStorage(temporaryRoot);
      const projectId = randomUUID();
      const paperId = randomUUID();
      const documentId = randomUUID();
      const intakeId = randomUUID();
      const documentKey = `projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`;
      const intakeKey = `projects/${projectId}/pdf-intakes/${intakeId}/source.pdf`;

      await expect(documentStorage.exists(documentKey)).resolves.toBe(false);
      await expect(documentStorage.exists(`.tmp/${randomUUID()}.upload`)).resolves.toBe(false);
      await expect(intakeStorage.exists(intakeKey)).resolves.toBe(false);
      await expect(documentStorage.exists("documents/not-a-document.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(intakeStorage.exists("projects/not-an-intake-key")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(intakeStorage.exists(".pdf-intake/.tmp/../outside.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    });
  });

  it("rejects non-directory ancestors and directory final entries for both adapters", async () => {
    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const projectId = randomUUID();
      const documentKey = `projects/${projectId}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
      const intakeKey = `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`;
      const documentStorage = new LocalDocumentStorage(temporaryRoot);
      const intakeStorage = new LocalPdfIntakeStorage(temporaryRoot);

      await writeFile(path.join(temporaryRoot, "projects"), "not a directory");
      await expect(documentStorage.exists(documentKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(intakeStorage.exists(intakeKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    });

    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const projectId = randomUUID();
      const documentKey = `projects/${projectId}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
      const intakeKey = `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`;
      const documentPath = path.join(temporaryRoot, ...documentKey.split("/"));
      const intakePath = path.join(temporaryRoot, ...intakeKey.split("/"));
      await mkdir(documentPath, { recursive: true });
      await mkdir(intakePath, { recursive: true });

      await expect(new LocalDocumentStorage(temporaryRoot).exists(documentKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(new LocalPdfIntakeStorage(temporaryRoot).exists(intakeKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    });
  });

  it("wraps permission failures as storage integrity errors when the OS enforces them", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;

    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const projectDirectory = path.join(temporaryRoot, "projects", randomUUID());
      await mkdir(projectDirectory, { recursive: true });
      await chmod(projectDirectory, 0);
      try {
        let permissionDenied = false;
        try { await readdir(projectDirectory); }
        catch (error) {
          permissionDenied = Boolean(error && typeof error === "object" && "code" in error && ["EACCES", "EPERM"].includes(String((error as { code?: string }).code)));
        }
        if (!permissionDenied) return;

        const projectId = path.basename(projectDirectory);
        const documentKey = `projects/${projectId}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
        const intakeKey = `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`;
        await expect(new LocalDocumentStorage(temporaryRoot).exists(documentKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
        await expect(new LocalPdfIntakeStorage(temporaryRoot).exists(intakeKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      } finally {
        await chmod(projectDirectory, 0o700);
      }
    });
  });

  it("rejects ancestor and final symlinks for both adapters when creation is supported", async () => {
    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "litreview_storage_exists_symlink_outside_"));
      const directoryProbe = path.join(temporaryRoot, "directory-symlink-probe");
      const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
      let directorySymlinksSupported = true;
      try { await symlink(outside, directoryProbe, directorySymlinkType); }
      catch (error) {
        directorySymlinksSupported = false;
        if (process.platform !== "win32") throw error;
      }
      await rm(directoryProbe, { recursive: false, force: true });
      if (!directorySymlinksSupported) {
        expect(process.platform).toBe("win32");
        await rm(outside, { recursive: true, force: true });
        return;
      }

      const outsideFile = path.join(outside, "outside.pdf");
      await writeFile(outsideFile, "outside");
      const fileProbe = path.join(temporaryRoot, "file-symlink-probe");
      let fileSymlinksSupported = true;
      try { await symlink(outsideFile, fileProbe, process.platform === "win32" ? "file" : undefined); }
      catch (error) {
        fileSymlinksSupported = false;
        if (process.platform !== "win32") throw error;
      }
      await rm(fileProbe, { force: true });

      try {
        const projectId = randomUUID();
        await mkdir(path.join(temporaryRoot, "projects", projectId), { recursive: true });
        const cases = [
          {
            storage: new LocalDocumentStorage(temporaryRoot),
            key: `projects/${projectId}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`,
            ancestor: path.join(temporaryRoot, "projects", projectId, "papers"),
          },
          {
            storage: new LocalPdfIntakeStorage(temporaryRoot),
            key: `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`,
            ancestor: path.join(temporaryRoot, "projects", projectId, "pdf-intakes"),
          },
        ];

        for (const testCase of cases) {
          await symlink(outside, testCase.ancestor, directorySymlinkType);
          await expect(testCase.storage.exists(testCase.key)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
          await expect(testCase.storage.open(testCase.key)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
          await rm(testCase.ancestor, { recursive: false, force: true });

          if (fileSymlinksSupported) {
            const finalPath = path.join(temporaryRoot, ...testCase.key.split("/"));
            await mkdir(path.dirname(finalPath), { recursive: true });
            await symlink(outsideFile, finalPath, process.platform === "win32" ? "file" : undefined);
            await expect(testCase.storage.exists(testCase.key)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
            await expect(testCase.storage.open(testCase.key)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
            await rm(finalPath, { force: true });
          }
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects in-root symlink aliases for exists and open on both adapters", async () => {
    await withTemporaryStorageRoot(async (temporaryRoot) => {
      const projectId = randomUUID();
      const paperId = randomUUID();
      const documentId = randomUUID();
      const intakeId = randomUUID();
      const documentKey = `projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`;
      const intakeKey = `projects/${projectId}/pdf-intakes/${intakeId}/source.pdf`;
      const documentAlias = path.join(temporaryRoot, "projects", projectId, "papers");
      const documentTarget = path.join(temporaryRoot, "projects", projectId, "papers-target");
      const intakeAlias = path.join(temporaryRoot, "projects", projectId, "pdf-intakes");
      const intakeTarget = path.join(temporaryRoot, "projects", projectId, "pdf-intakes-target");
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await mkdir(path.dirname(documentAlias), { recursive: true });
      await mkdir(path.join(documentTarget, paperId, "documents", documentId), { recursive: true });
      await mkdir(path.join(intakeTarget, intakeId), { recursive: true });
      await writeFile(path.join(documentTarget, paperId, "documents", documentId, "source.pdf"), "%PDF-1.7\nin-root target");
      await writeFile(path.join(intakeTarget, intakeId, "source.pdf"), "%PDF-1.7\nin-root target");

      try {
        await symlink(documentTarget, documentAlias, symlinkType);
        await symlink(intakeTarget, intakeAlias, symlinkType);
      } catch (error) {
        if (process.platform !== "win32") throw error;
        return;
      }

      const documentStorage = new LocalDocumentStorage(temporaryRoot);
      const intakeStorage = new LocalPdfIntakeStorage(temporaryRoot);
      await expect(documentStorage.exists(documentKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(documentStorage.open(documentKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(intakeStorage.exists(intakeKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
      await expect(intakeStorage.open(intakeKey)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    });
  });

  it("executes all write-side symlink confinement cases when the platform permits symlinks", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "litreview_storage_symlink_outside_"));
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    const probe = path.join(root, "symlink-probe");
    let capable = true;
    try { await symlink(outside, probe, symlinkType); }
    catch { capable = false; }
    await rm(probe, { recursive: false, force: true });
    if (!capable) {
      // Windows without Developer Mode/privilege is an explicit capability
      // skip; hosted Linux must take the exercised branch below.
      expect(process.platform).toBe("win32");
      await rm(outside, { recursive: true, force: true });
      return;
    }

    // On POSIX, a successful directory-symlink probe is sufficient evidence
    // that the final-file symlink case must execute. Windows may lack file
    // symlink privilege even when junctions are available, so retain an
    // explicit capability probe only for that platform.
    let fileSymlinkCapable = process.platform !== "win32";
    if (!fileSymlinkCapable) {
      const fileProbeOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_file_symlink_probe_"));
      const fileProbeTarget = path.join(fileProbeOutside, "file-probe");
      await writeFile(fileProbeTarget, "probe");
      const fileProbe = path.join(root, "file-symlink-probe");
      try { await symlink(fileProbeTarget, fileProbe, "file"); }
      catch { fileSymlinkCapable = false; }
      await rm(fileProbe, { force: true });
      await rm(fileProbeOutside, { recursive: true, force: true });
    }

    let executed = 0;
    const pdf = Readable.from([Buffer.from("%PDF-1.7\nsymlink test")]);
    const projectId = randomUUID();
    const paperId = randomUUID();

    await rm(path.join(root, "projects"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "projects"), symlinkType);
    const rootStaged = await storage.stage(pdf);
    await expect(storage.install(rootStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readdir(outside)).toEqual([]);
    await storage.remove(rootStaged.temporaryKey);
    await rm(path.join(root, "projects"), { recursive: false, force: true });
    executed += 1;

    const intake = new LocalPdfIntakeStorage(root);
    await mkdir(path.join(root, "projects", projectId), { recursive: true });
    const intakeOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_intake_symlink_outside_"));
    await symlink(intakeOutside, path.join(root, "projects", projectId, "pdf-intakes"), symlinkType);
    const intakeStaged = await intake.stage(Readable.from([Buffer.from("%PDF-1.7\nintake")]))
    await expect(intake.install(intakeStaged.temporaryKey, `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readdir(intakeOutside)).toEqual([]);
    await intake.remove(intakeStaged.temporaryKey);
    await rm(path.join(root, "projects", projectId, "pdf-intakes"), { recursive: false, force: true });
    await rm(intakeOutside, { recursive: true, force: true });
    executed += 1;

    const papersOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_papers_symlink_outside_"));
    await symlink(papersOutside, path.join(root, "projects", projectId, "papers"), symlinkType);
    const papersStaged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\npapers")]))
    await expect(storage.install(papersStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readdir(papersOutside)).toEqual([]);
    await storage.remove(papersStaged.temporaryKey);
    await rm(path.join(root, "projects", projectId, "papers"), { recursive: false, force: true });
    await rm(papersOutside, { recursive: true, force: true });
    executed += 1;

    if (!fileSymlinkCapable) {
      await rm(path.join(root, "projects"), { recursive: true, force: true });
      expect(executed).toBe(3);
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const finalOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_final_symlink_outside_"));
    const documentId = randomUUID();
    const finalParent = path.join(root, "projects", projectId, "papers", paperId, "documents", documentId);
    await mkdir(finalParent, { recursive: true });
    const outsideFile = path.join(finalOutside, "sentinel.pdf");
    const sentinel = Buffer.from("outside sentinel");
    await writeFile(outsideFile, sentinel);
    const finalPath = path.join(finalParent, "source.pdf");
    await symlink(outsideFile, finalPath, process.platform === "win32" ? "file" : undefined);
    const finalStaged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\nfinal")]))
    await expect(storage.install(finalStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readFile(outsideFile)).toEqual(sentinel);
    await storage.remove(finalStaged.temporaryKey);
    await rm(finalPath, { force: true });
    await rm(finalOutside, { recursive: true, force: true });
    await rm(path.join(root, "projects"), { recursive: true, force: true });
    executed += 1;
    expect(executed).toBe(4);
  });
});
