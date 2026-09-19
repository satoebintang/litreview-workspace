import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";

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

  it("hashes and sizes streamed PDF bytes, then promotes only the generated key", async () => {
    const bytes = Buffer.from("%PDF-1.7\nstreamed test bytes\n");
    const staged = await storage.stage(Readable.from([bytes]), { maxBytes: 50 });
    expect(staged.byteSize).toBe(bytes.byteLength);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(staged.signature)).toEqual(Array.from(Buffer.from("%PDF-")));
    const key = `projects/${randomUUID()}/papers/${randomUUID()}/documents/${randomUUID()}/source.pdf`;
    await storage.promote(staged.temporaryKey, key);
    expect(await storage.exists(key)).toBe(true);
    expect(await readFile(path.join(root, key))).toEqual(bytes);
    expect(await storage.listKeys()).not.toContain(staged.temporaryKey);
  });

  it("removes staged bytes after overflow, invalid signatures, and stream interruption", async () => {
    await expect(storage.stage(Readable.from([Buffer.from("%PDF-1.7\n1234567890")]), { maxBytes: 10 })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
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
    await expect(storage.stage(Readable.from([overflow]), { maxBytes })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  }, 20_000);

  it("rejects traversal and absolute storage keys", async () => {
    const staged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\nbytes")]), { maxBytes: 50 });
    await expect(storage.promote(staged.temporaryKey, "../escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await expect(storage.promote(staged.temporaryKey, "C:\\escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
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

    const fileProbeOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_file_symlink_probe_"));
    const fileProbeTarget = path.join(fileProbeOutside, "file-probe");
    await writeFile(fileProbeTarget, "probe");
    const fileProbe = path.join(root, "file-symlink-probe");
    let fileSymlinkCapable = true;
    try { await symlink(fileProbeTarget, fileProbe, "file"); }
    catch { fileSymlinkCapable = false; }
    await rm(fileProbe, { force: true });
    await rm(fileProbeOutside, { recursive: true, force: true });
    if (!fileSymlinkCapable) {
      expect(process.platform).toBe("win32");
    }

    let executed = 0;
    const pdf = Readable.from([Buffer.from("%PDF-1.7\nsymlink test")]);
    const projectId = randomUUID();
    const paperId = randomUUID();

    await rm(path.join(root, "projects"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "projects"), symlinkType);
    const rootStaged = await storage.stage(pdf);
    await expect(storage.promote(rootStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readdir(outside)).toEqual([]);
    await storage.remove(rootStaged.temporaryKey);
    await rm(path.join(root, "projects"), { recursive: false, force: true });
    executed += 1;

    const intake = new LocalPdfIntakeStorage(root);
    await mkdir(path.join(root, "projects", projectId), { recursive: true });
    const intakeOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_intake_symlink_outside_"));
    await symlink(intakeOutside, path.join(root, "projects", projectId, "pdf-intakes"), symlinkType);
    const intakeStaged = await intake.stage(Readable.from([Buffer.from("%PDF-1.7\nintake")]))
    await expect(intake.promote(intakeStaged.temporaryKey, `projects/${projectId}/pdf-intakes/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readdir(intakeOutside)).toEqual([]);
    await intake.remove(intakeStaged.temporaryKey);
    await rm(path.join(root, "projects", projectId, "pdf-intakes"), { recursive: false, force: true });
    await rm(intakeOutside, { recursive: true, force: true });
    executed += 1;

    const papersOutside = await mkdtemp(path.join(os.tmpdir(), "litreview_papers_symlink_outside_"));
    await symlink(papersOutside, path.join(root, "projects", projectId, "papers"), symlinkType);
    const papersStaged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\npapers")]))
    await expect(storage.promote(papersStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${randomUUID()}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
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
    await symlink(outsideFile, finalPath, "file");
    const finalStaged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\nfinal")]))
    await expect(storage.promote(finalStaged.temporaryKey, `projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    expect(await readFile(outsideFile)).toEqual(sentinel);
    await storage.remove(finalStaged.temporaryKey);
    await rm(finalPath, { force: true });
    await rm(finalOutside, { recursive: true, force: true });
    await rm(path.join(root, "projects"), { recursive: true, force: true });
    expect(executed).toBe(4);
  });
});
