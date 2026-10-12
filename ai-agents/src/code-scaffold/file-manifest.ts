// M6-P4b1 - describes a composed file tree by value (path, size, sha256) so the runner's result can carry
// it as data. M6-P4b2 makes platform-nest commit the tree; it checks what it fetches against this list.
import { createHash } from "node:crypto";
import type { ScaffoldFileEntry } from "./envelope";
import type { GeneratedFile } from "./page-composer";

export function fileManifest(files: GeneratedFile[]): ScaffoldFileEntry[] {
  return files
    .map((f) => {
      const bytes = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
      return { path: f.path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The first path that appears twice, or null. A git tree cannot hold one path twice, and two generated
 *  pages that resolve to the same route would silently overwrite each other. */
export function firstDuplicatePath(files: GeneratedFile[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) return f.path;
    seen.add(f.path);
  }
  return null;
}
