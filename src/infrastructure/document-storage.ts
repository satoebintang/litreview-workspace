import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { isDocumentStorageKey, isPdfSignature } from "@/domain/full-text-documents";

export type DocumentByteSource = AsyncIterable<Uint8Array>;

export interface StagedDocument {
  temporaryKey: string;
  byteSize: number;
  sha256: string;
  signature: Uint8Array;
}

export interface DocumentStorage {
  stage(source: DocumentByteSource, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<StagedDocument>;
  promote(temporaryKey: string, storageKey: string): Promise<void>;
  open(storageKey: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
}

export class DocumentStorageError extends Error {
  constructor(public readonly code: "UPLOAD_TOO_LARGE" | "UPLOAD_INTERRUPTED" | "STORAGE_INTEGRITY", message: string) {
    super(message);
    this.name = "DocumentStorageError";
  }
}

function asBuffer(chunk: Uint8Array) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export class LocalDocumentStorage implements DocumentStorage {
  private rootPathPromise: Promise<string>;

  constructor(rootPath: string) {
    if (!rootPath || !path.isAbsolute(rootPath)) throw new Error("Document storage root must be an absolute path");
    this.rootPathPromise = mkdir(rootPath, { recursive: true }).then(() => realpath(rootPath));
  }

  private async rootPath() {
    return this.rootPathPromise;
  }

  private async resolveKey(key: string) {
    if (!key || path.isAbsolute(key) || key.includes("\\") || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid document storage key");
    }
    const root = await this.rootPath();
    const resolved = path.resolve(root, ...key.split("/"));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Document storage key escapes the configured root");
    return resolved;
  }

  private async verifyExistingPath(key: string) {
    const resolved = await this.resolveKey(key);
    const actual = await realpath(resolved);
    const root = await this.rootPath();
    const relative = path.relative(root, actual);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Document storage path escapes the configured root");
    return actual;
  }

  async stage(source: DocumentByteSource, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    const temporaryKey = `.tmp/${randomUUID()}.upload`;
    const temporaryPath = await this.resolveKey(temporaryKey);
    await mkdir(path.dirname(temporaryPath), { recursive: true });
    const output = createWriteStream(temporaryPath, { flags: "wx" });
    const hash = createHash("sha256");
    const signature = Buffer.alloc(5);
    let signatureBytes = 0;
    let byteSize = 0;
    let failed = true;
    const abortHandler = () => {
      const destroyable = source as unknown as { destroy?: (error?: Error) => void };
      destroyable.destroy?.(new DocumentStorageError("UPLOAD_INTERRUPTED", "Document upload was cancelled"));
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      for await (const chunk of source) {
        if (options.signal?.aborted) throw new DocumentStorageError("UPLOAD_INTERRUPTED", "Document upload was cancelled");
        const bytes = asBuffer(chunk);
        if (byteSize + bytes.byteLength > maxBytes) throw new DocumentStorageError("UPLOAD_TOO_LARGE", "Document exceeds the 50 MiB upload limit");
        if (signatureBytes < signature.byteLength) {
          const copyLength = Math.min(signature.byteLength - signatureBytes, bytes.byteLength);
          bytes.copy(signature, signatureBytes, 0, copyLength);
          signatureBytes += copyLength;
        }
        byteSize += bytes.byteLength;
        hash.update(bytes);
        if (!output.write(bytes)) await new Promise<void>((resolve, reject) => { output.once("drain", resolve); output.once("error", reject); });
      }
      await new Promise<void>((resolve, reject) => { output.end(() => resolve()); output.once("error", reject); });
      const handle = await open(temporaryPath, "r");
      try {
        await handle.sync();
      } catch (error) {
        // Windows can report EPERM for fsync on a read-only handle after the
        // write stream has finished. The close below still establishes the
        // normal stream durability boundary; other sync failures are real.
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM")) throw error;
      } finally {
        await handle.close();
      }
      if (byteSize === 0 || !isPdfSignature(signature)) throw new DocumentStorageError("UPLOAD_INTERRUPTED", "Document is not a PDF artifact");
      failed = false;
      return { temporaryKey, byteSize, sha256: hash.digest("hex"), signature: new Uint8Array(signature) };
    } catch (error) {
      if (error instanceof DocumentStorageError) throw error;
      throw new DocumentStorageError("UPLOAD_INTERRUPTED", "Document upload stream failed");
    } finally {
      options.signal?.removeEventListener("abort", abortHandler);
      if (failed) {
        output.destroy();
        await new Promise<void>((resolve) => {
          if (output.closed) resolve();
          else output.once("close", () => resolve());
        });
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      } else {
        output.destroy();
      }
    }
  }

  async promote(temporaryKey: string, storageKey: string) {
    if (!isDocumentStorageKey(storageKey)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid final document storage key");
    const sourcePath = await this.resolveKey(temporaryKey);
    const destinationPath = await this.resolveKey(storageKey);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
  }

  async open(storageKey: string) {
    if (!isDocumentStorageKey(storageKey)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid final document storage key");
    const actual = await this.verifyExistingPath(storageKey);
    return createReadStream(actual);
  }

  async remove(key: string) {
    const resolved = await this.resolveKey(key);
    await rm(resolved, { force: true });
  }

  async exists(key: string) {
    try { await this.verifyExistingPath(key); return true; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
      try { await stat(await this.resolveKey(key)); return true; } catch { return false; }
    }
  }

  async listKeys() {
    const root = await this.rootPath();
    const result: string[] = [];
    const walk = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath, key);
        else if (entry.isFile()) result.push(key.replaceAll(path.sep, "/"));
      }
    };
    await walk(root, "");
    return result;
  }
}

export function readableToAsyncIterable(stream: Readable): DocumentByteSource {
  return stream as unknown as DocumentByteSource;
}
