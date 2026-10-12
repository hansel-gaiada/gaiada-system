#!/usr/bin/env node
// Copies one template's files into a LOCAL clone of its GitHub template repo so a human can review
// the diff, commit and push. Never runs git, never touches the network.
//   node webdesk/templates/publish.mjs <static|fullstack|wp> <path-to-clone>
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const DIRS = { static: "static-astro", fullstack: "fullstack-next-nest", wp: "wp" };
const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".astro"]);
const SKIP_FILES = new Set([".env"]);

const [kind, target] = process.argv.slice(2);
if (!DIRS[kind] || !target) {
  console.error("usage: publish.mjs <static|fullstack|wp> <path-to-clone>");
  process.exit(2);
}
const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = path.join(here, DIRS[kind]);
const dest = path.resolve(target);
if (!fs.existsSync(path.join(dest, ".git"))) {
  console.error(`${dest} is not a git clone (no .git); refusing.`);
  process.exit(2);
}

let n = 0;
(function copy(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name) || SKIP_FILES.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copy(s, d);
    } else {
      fs.copyFileSync(s, d);
      n++;
    }
  }
})(src, dest);
console.log(`copied ${n} files from ${DIRS[kind]}/ into ${dest}. Review with: git -C "${dest}" status && git -C "${dest}" diff`);
