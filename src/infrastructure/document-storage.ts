import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
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

/**
 * Rooted filesystem operations shared by document and PDF-intake storage.
 *
 * The primitive deliberately knows nothing about document key shape.  The
 * DocumentStorage adapter still validates canonical document keys before it
 * calls this class; intake storage uses its own private namespace.  Keeping
 * those two concerns separate prevents a future intake key from accidentally
 * becoming a valid historical document key.
 */
export class LocalStorageFilesystem {
  private readonly rootPathPromise: Promise<string>;

  constructor(rootPath: string) {
    if (!rootPath || !path.isAbsolute(rootPath)) throw new Error("Storage root must be an absolute path");
    this.rootPathPromise = mkdir(rootPath, { recursive: true }).then(() => realpath(rootPath));
  }

  async rootPath() {
    return this.rootPathPromise;
  }

  async resolveKey(key: string) {
    if (!key || path.isAbsolute(key) || key.includes("\\") || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid storage key");
    }
    const root = await this.rootPath();
    const resolved = path.resolve(root, ...key.split("/"));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage key escapes the configured root");
    return resolved;
  }

  private assertUnderRoot(root: string, candidate: string, message: string) {
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DocumentStorageError("STORAGE_INTEGRITY", message);
  }

  /**
   * Validate and create a destination's directory components one at a time.
   * Node does not expose a portable directory-fd openat/renameat equivalent,
   * so the final recheck narrows (but cannot eliminate) a concurrent swap race.
   */
  async prepareWritePath(key: string) {
    const resolved = await this.resolveKey(key);
    const root = await this.rootPath();
    const relativeParent = path.relative(root, path.dirname(resolved));
    this.assertUnderRoot(root, path.dirname(resolved), "Storage path escapes the configured root");
    let current = root;
    for (const component of relativeParent ? relativeParent.split(path.sep) : []) {
      current = path.join(current, component);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage ancestor is not a real directory");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
        try { await mkdir(current); }
        catch (mkdirError) {
          if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && (mkdirError as { code?: string }).code === "EEXIST")) throw mkdirError;
        }
        const created = await lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage ancestor is not a real directory");
      }
    }
    const actualParent = await realpath(path.dirname(resolved));
    this.assertUnderRoot(root, actualParent, "Storage path escapes the configured root");
    try {
      const finalEntry = await lstat(resolved);
      if (finalEntry.isSymbolicLink()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage final path is a symbolic link");
      if (finalEntry.isDirectory()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage final path is a directory");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
    }
    return resolved;
  }

  /** Validate a source/final path before a write-side rename or removal. */
  async prepareExistingWritePath(key: string) {
    const resolved = await this.resolveKey(key);
    const root = await this.rootPath();
    const relativeParent = path.relative(root, path.dirname(resolved));
    this.assertUnderRoot(root, path.dirname(resolved), "Storage path escapes the configured root");
    let current = root;
    for (const component of relativeParent ? relativeParent.split(path.sep) : []) {
      current = path.join(current, component);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage ancestor is not a real directory");
    }
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage path is a symbolic link");
    if (!entry.isFile()) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage source is not a regular file");
    const actual = await realpath(path.dirname(resolved));
    this.assertUnderRoot(root, actual, "Storage path escapes the configured root");
    return resolved;
  }

  async verifyExistingPath(key: string) {
    const resolved = await this.resolveKey(key);
    const actual = await realpath(resolved);
    const root = await this.rootPath();
    const relative = path.relative(root, actual);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage path escapes the configured root");
    return actual;
  }

  /**
   * Check a storage key without following any path entry. Missing valid paths
   * return false; malformed paths and filesystem integrity failures throw.
   */
  async verifyExistingFile(key: string) {
    let resolved: string;
    let root: string;
    try {
      resolved = await this.resolveKey(key);
      root = await this.rootPath();
    } catch (error) {
      if (error instanceof DocumentStorageError) throw error;
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Unable to resolve storage path");
    }
    this.assertUnderRoot(root, resolved, "Storage path escapes the configured root");

    const inspect = async (candidate: string) => {
      try { return await lstat(candidate); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
        throw new DocumentStorageError("STORAGE_INTEGRITY", "Unable to inspect stored document path");
      }
    };

    const rootEntry = await inspect(root);
    if (!rootEntry) throw new DocumentStorageError("STORAGE_INTEGRITY", "Configured storage root is missing");
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage root is not a real directory");
    }

    const relative = path.relative(root, resolved);
    const components = relative.split(path.sep);
    let current = root;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      const entry = await inspect(current);
      if (!entry) return false;
      if (entry.isSymbolicLink()) {
        throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage path contains a symbolic link");
      }
      if (index < components.length - 1 && !entry.isDirectory()) {
        throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage ancestor is not a real directory");
      }
      if (index === components.length - 1 && !entry.isFile()) {
        throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage final path is not a regular file");
      }
    }

    try {
      const actualParent = await realpath(path.dirname(resolved));
      this.assertUnderRoot(root, actualParent, "Storage path escapes the configured root");
      const actualFile = await realpath(resolved);
      this.assertUnderRoot(root, actualFile, "Storage path escapes the configured root");

      // Recheck the final entry after realpath so a concurrent replacement by
      // a symlink or non-file cannot be accepted as an ordinary file.
      const finalEntry = await inspect(resolved);
      if (!finalEntry) return false;
      if (finalEntry.isSymbolicLink() || !finalEntry.isFile()) {
        throw new DocumentStorageError("STORAGE_INTEGRITY", "Storage final path is not a regular file");
      }
      return true;
    } catch (error) {
      if (error instanceof DocumentStorageError) throw error;
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Unable to verify stored document path");
    }
  }

  async requireExistingFile(key: string) {
    const resolved = await this.resolveKey(key);
    if (!(await this.verifyExistingFile(key))) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Stored document file is missing");
    }
    return resolved;
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

export class LocalDocumentStorage implements DocumentStorage {
  readonly filesystem: LocalStorageFilesystem;

  constructor(rootPath: string) {
    this.filesystem = new LocalStorageFilesystem(rootPath);
  }

  async stage(source: DocumentByteSource, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    return stagePdfBytes(this.filesystem, ".tmp", source, options);
  }

  async promote(temporaryKey: string, storageKey: string) {
    if (!isDocumentStorageKey(storageKey)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid final document storage key");
    const sourcePath = await this.filesystem.prepareExistingWritePath(temporaryKey);
    const destinationPath = await this.filesystem.prepareWritePath(storageKey);
    await rename(sourcePath, destinationPath);
  }

  async open(storageKey: string) {
    if (!isDocumentStorageKey(storageKey)) throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid final document storage key");
    return createReadStream(await this.filesystem.requireExistingFile(storageKey));
  }

  async remove(key: string) {
    try {
      const resolved = await this.filesystem.prepareExistingWritePath(key);
      await rm(resolved, { force: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
  }

  async exists(key: string) {
    const validated = key.startsWith(".tmp/") ? key : isDocumentStorageKey(key) ? key : null;
    if (!validated) throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid document storage key");
    return this.filesystem.verifyExistingFile(validated);
  }

  async listKeys() {
    return this.filesystem.listKeys();
  }
}

/** Storage contract for an accepted PDF while local metadata is inspected. */
export type PdfIntakeStorage = Pick<DocumentStorage, "stage" | "promote" | "open" | "remove" | "exists" | "listKeys">;

export function isPdfIntakeStorageKey(value: string) {
  return /^projects\/[0-9a-f-]{36}\/pdf-intakes\/[0-9a-f-]{36}\/source\.pdf$/.test(value);
}

/**
 * Local intake storage is intentionally namespaced away from `.tmp/` and the
 * canonical `projects/.../documents/.../source.pdf` keys.  It can therefore
 * retain an accepted upload for a bounded parser without making full-text
 * storage audits report intake files as missing/orphaned documents.
 */
export class LocalPdfIntakeStorage implements PdfIntakeStorage {
  readonly filesystem: LocalStorageFilesystem;
  readonly namespace: string;

  constructor(rootPath: string, namespace = ".pdf-intake") {
    this.filesystem = new LocalStorageFilesystem(rootPath);
    if (!namespace || namespace.includes("/") || namespace.includes("\\") || namespace === "." || namespace === "..") {
      throw new Error("PDF intake namespace must be one path segment");
    }
    this.namespace = namespace;
  }

  private namespaced(key: string) {
    return `${this.namespace}/${key}`;
  }

  private assertTemporary(key: string) {
    if (!key.startsWith(`${this.namespace}/.tmp/`)) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "PDF intake temporary key is outside the intake namespace");
    }
    return key;
  }

  private assertFinal(key: string) {
    if (!isPdfIntakeStorageKey(key)) {
      throw new DocumentStorageError("STORAGE_INTEGRITY", "Invalid final PDF intake storage key");
    }
    return key;
  }

  async stage(source: DocumentByteSource, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    // Reuse the same stream/hash/signature primitive and then move the staged
    // file into the intake namespace.  A canonical DocumentStorage key is
    // never accepted here.
    const staged = await stagePdfBytes(this.filesystem, this.namespaced(".tmp"), source, options);
    return staged;
  }

  async promote(temporaryKey: string, storageKey: string) {
    const sourcePath = await this.filesystem.prepareExistingWritePath(this.assertTemporary(temporaryKey));
    const destinationPath = await this.filesystem.prepareWritePath(this.assertFinal(storageKey));
    await rename(sourcePath, destinationPath);
  }

  async open(storageKey: string) {
    return createReadStream(await this.filesystem.requireExistingFile(this.assertFinal(storageKey)));
  }

  async remove(key: string) {
    const validated = key.startsWith(`${this.namespace}/.tmp/`) ? this.assertTemporary(key) : this.assertFinal(key);
    try {
      await rm(await this.filesystem.prepareExistingWritePath(validated), { force: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
  }

  async exists(key: string) {
    const validated = key.startsWith(`${this.namespace}/.tmp/`) ? this.assertTemporary(key) : this.assertFinal(key);
    return this.filesystem.verifyExistingFile(validated);
  }

  async listKeys() {
    // The intake audit filters the returned inventory by the durable
    // project/pdf-intakes namespace and separately reports this adapter's
    // temporary files. Returning the shared inventory keeps those audits
    // independent from the canonical document audit.
    return this.filesystem.listKeys();
  }
}

/** Shared bounded stream-to-file implementation for accepted PDF uploads. */
async function stagePdfBytes(
  filesystem: LocalStorageFilesystem,
  temporaryNamespace: string,
  source: DocumentByteSource,
  options: { maxBytes?: number; signal?: AbortSignal },
): Promise<StagedDocument> {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const mebibyte = 1024 * 1024;
  const limitDescription = maxBytes % mebibyte === 0 ? `${maxBytes / mebibyte} MiB` : `${maxBytes} bytes`;
  const temporaryKey = `${temporaryNamespace}/${randomUUID()}.upload`;
  const temporaryPath = await filesystem.prepareWritePath(temporaryKey);
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
      if (byteSize + bytes.byteLength > maxBytes) throw new DocumentStorageError("UPLOAD_TOO_LARGE", `Document exceeds the upload limit of ${limitDescription}`);
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
    try { await handle.sync(); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM")) throw error;
    }
    finally { await handle.close(); }
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
      await new Promise<void>((resolve) => { if (output.closed) resolve(); else output.once("close", () => resolve()); });
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    } else output.destroy();
  }
}

export function readableToAsyncIterable(stream: Readable): DocumentByteSource {
  return stream as unknown as DocumentByteSource;
}
