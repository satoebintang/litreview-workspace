import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDocumentStorage } from "@/infrastructure/document-storage";

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

  it("rejects traversal and absolute storage keys", async () => {
    const staged = await storage.stage(Readable.from([Buffer.from("%PDF-1.7\nbytes")]), { maxBytes: 50 });
    await expect(storage.promote(staged.temporaryKey, "../escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await expect(storage.promote(staged.temporaryKey, "C:\\escape.pdf")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY" });
    await storage.remove(staged.temporaryKey);
  });
});
