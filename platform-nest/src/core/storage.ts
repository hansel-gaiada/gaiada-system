// Storage backend (5c.4). Local-first: bytes live under config.filesDir, one file per
// storage_key. The interface is the seam for the target-state object-store swap — routes
// depend only on StorageBackend, never on fs. Keys are tenant-prefixed and sanitized so a
// crafted key can't escape the root (path traversal).
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { config } from "../config";

export interface StorageBackend {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  del(key: string): Promise<void>;
}

function safePath(root: string, key: string): string {
  // Reject traversal: the resolved path must stay within root.
  const clean = key.replace(/\\/g, "/").replace(/\.\.+/g, "");
  const full = resolve(root, clean);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("invalid storage key");
  }
  return full;
}

export const localStorage: StorageBackend = {
  async put(key, data) {
    const root = resolve(config.filesDir);
    const full = safePath(root, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  },
  async get(key) {
    const root = resolve(config.filesDir);
    return readFile(safePath(root, key));
  },
  async del(key) {
    const root = resolve(config.filesDir);
    await unlink(safePath(root, key)).catch(() => undefined);
  },
};

/** Overridable for tests (in-memory) so file suites don't touch disk. */
let backend: StorageBackend = localStorage;
export function storage(): StorageBackend {
  return backend;
}
export function setStorageForTest(b: StorageBackend): void {
  backend = b;
}
