// M6-P4b2 — TEST-ONLY: an in-memory GitHub that answers the Git Data API the way GitHub does, for the git-data and
// scaffold-commit suites. Never imported by production code. No network, no credential.
//
// What it models faithfully, because the code under test depends on it:
//   * content addressing: a blob's sha is git's real blob id (`gitBlobSha`); trees and commits get a deterministic sha
//     over their content, so creating the same object twice returns the same sha, exactly like GitHub;
//   * `base_tree`: a new tree starts from the base's entries and overlays the given ones;
//   * `PATCH …/git/refs/heads/<b>` with `force: false` answers 422 unless the new commit descends from the current head;
//   * a repo it does not hold answers 404 to everything (an App not installed on that repo), a missing ref 404;
//   * GitHub's error shape: `GithubApiError` with `detail.httpStatus`.
// Fault injection: `beforeRequest` runs before a request touches state (a request that never arrived), `afterRequest`
// after (the answer was lost), and `corruptNextBlobSha` returns a wrong blob sha once.
//
// M6-P4g adds the deploy gate's calls: the repo's numeric `id`, the contents API (`GET …/contents/<path>?ref=<sha>`,
// base64 wrapped at 60 columns like GitHub), and the org Actions secrets' selected-repository lists under
// `/orgs/<owner>/actions/secrets/<name>[/repositories/<id>]`: a missing secret is 404, a secret whose visibility is not
// `selected` is 409 on PUT/DELETE, and `orgSecretsPermission = false` answers every org-secret call with GitHub's 403
// "Resource not accessible by integration" (the App without `organization_secrets`, O-3).
//
// M6-P6o adds the secret VALUE calls (WSK-D88): `GET /orgs/<owner>/actions/secrets/public-key` answers the key pair a test
// installs with `useOrgKeyPair()` (404 until then: a test that forgot it fails loudly), and `PUT /orgs/<owner>/actions/secrets/
// <name>` stores the sealed `encrypted_value` as GitHub does (201 new, 204 update; a `key_id` that is not the current key is
// GitHub's 422; visibility and `selected_repository_ids` are applied). The fake never decrypts on its own: a test proves the
// sealing by opening the stored box with the private key (`openOrgSecretValue`), exactly what GitHub does on its side.
import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { GithubApiError } from "./errors";
import { gitBlobSha, type GitCaller } from "./git-data";
import type { GithubRequest, GithubResponse } from "./http-client";

export interface FakeEntry {
  mode: string;
  type: "blob" | "commit";
  sha: string;
}

export interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
  author: unknown;
  committer: unknown;
}

export type FakeFile = string | { content?: string; mode?: string; type?: "blob" | "commit"; sha?: string };

export interface FakeOrgSecret {
  visibility: "all" | "private" | "selected";
  repos: Set<number>;
}

export interface FakeOrgKey {
  keyId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

export class FakeGithub {
  defaultBranch = "main";
  readonly blobs = new Map<string, Buffer>();
  /** tree sha -> flat path -> entry (files, symlinks, submodules; directories are implied by paths). */
  readonly trees = new Map<string, Map<string, FakeEntry>>();
  readonly commits = new Map<string, FakeCommit>();
  readonly refs = new Map<string, string>();
  readonly calls: RecordedCall[] = [];
  beforeRequest?: (method: string, path: string) => void;
  afterRequest?: (method: string, path: string) => void;
  corruptNextBlobSha = false;
  /** GitHub's numeric id for this repo (the org-secret endpoints take it). */
  repoId = 424242;
  /** org Actions secrets by name: their visibility and selected repositories (a sealed value, once written, is in `orgSecretValues`). */
  readonly orgSecrets = new Map<string, FakeOrgSecret>();
  /** false: the App lacks `organization_secrets`; every org-secret call is GitHub's 403. */
  orgSecretsPermission = true;
  /** M6-P6o: the org's Actions key pair (`useOrgKeyPair`), and each secret's stored sealed value. */
  orgKey: FakeOrgKey | null = null;
  readonly orgSecretValues = new Map<string, { encryptedValue: string; keyId: string }>();

  constructor(
    readonly owner = "acme-org",
    readonly name = "acme-site",
  ) {}

  /** The template-generated repo: one parentless commit on the default branch. Returns its sha. */
  seedTemplate(files: Record<string, FakeFile>, branch = this.defaultBranch): string {
    const tree = this.putTree(new Map(), files);
    const sha = this.putCommit({ tree, parents: [], message: "Initial commit", author: { name: "template" }, committer: { name: "template" } });
    this.refs.set(branch, sha);
    return sha;
  }

  /** A human commit on top of the branch head. Returns its sha. */
  pushHumanCommit(files: Record<string, FakeFile>, branch = this.defaultBranch): string {
    const head = this.refs.get(branch) as string;
    const base = this.trees.get(this.commits.get(head)!.tree)!;
    const tree = this.putTree(base, files);
    const sha = this.putCommit({ tree, parents: [head], message: "human edit", author: { name: "dev" }, committer: { name: "dev" } });
    this.refs.set(branch, sha);
    return sha;
  }

  /** An org secret the owner created (visibility `selected` and no repository, unless said otherwise). */
  addOrgSecret(name: string, visibility: FakeOrgSecret["visibility"] = "selected", repos: number[] = []): void {
    this.orgSecrets.set(name, { visibility, repos: new Set(repos) });
  }

  /** M6-P6o: give the org an Actions key pair (a fresh X25519 pair). Rotating it (a second call) makes older key ids stale. */
  async useOrgKeyPair(keyId = `kid-${Math.random().toString(16).slice(2, 10)}`): Promise<FakeOrgKey> {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    this.orgKey = { keyId, publicKey: kp.publicKey, privateKey: kp.privateKey };
    return this.orgKey;
  }

  /** M6-P6o: open a stored sealed value with the org's private key, as GitHub would. Throws if it does not open. */
  async openOrgSecretValue(name: string): Promise<string> {
    const stored = this.orgSecretValues.get(name);
    if (!stored) throw new Error(`no value stored for ${name}`);
    if (!this.orgKey || stored.keyId !== this.orgKey.keyId) throw new Error(`${name} was sealed to a key this fake no longer holds`);
    await sodium.ready;
    const opened = sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(stored.encryptedValue, "base64")), this.orgKey.publicKey, this.orgKey.privateKey);
    return Buffer.from(opened).toString("utf8");
  }

  /** A human commit that deletes paths from the branch head. Returns its sha. */
  pushHumanDeletion(paths: string[], branch = this.defaultBranch): string {
    const head = this.refs.get(branch) as string;
    const flat = new Map(this.trees.get(this.commits.get(head)!.tree)!);
    for (const p of paths) flat.delete(p);
    const tree = this.storeTree(flat);
    const sha = this.putCommit({ tree, parents: [head], message: "human delete", author: { name: "dev" }, committer: { name: "dev" } });
    this.refs.set(branch, sha);
    return sha;
  }

  headOf(branch = this.defaultBranch): string | undefined {
    return this.refs.get(branch);
  }

  /** Every file in the tree a commit points at, decoded (blobs only). */
  filesAt(commitSha: string): Map<string, string> {
    const out = new Map<string, string>();
    const tree = this.trees.get(this.commits.get(commitSha)!.tree)!;
    for (const [p, e] of tree) if (e.type === "blob" && this.blobs.has(e.sha)) out.set(p, this.blobs.get(e.sha)!.toString("utf8"));
    return out;
  }

  count(method: string, pathPart: string): number {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
  }

  caller(): GitCaller {
    return async <T>(req: Omit<GithubRequest, "role">): Promise<GithubResponse<T>> => {
      const method = req.method ?? "GET";
      this.calls.push({ method, path: req.path, body: req.body });
      this.beforeRequest?.(method, req.path);
      const { status, data } = this.handle(method, req.path, req.body as Record<string, unknown> | undefined);
      this.afterRequest?.(method, req.path);
      return { data: data as T, status, rateLimit: { limit: 5000, remaining: 4999, resetAtMs: 0 } };
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  private putBlob(content: Buffer): string {
    const sha = gitBlobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }

  private putTree(base: Map<string, FakeEntry>, files: Record<string, FakeFile>): string {
    const flat = new Map(base);
    for (const [path, f] of Object.entries(files)) {
      if (typeof f === "string") {
        flat.set(path, { mode: "100644", type: "blob", sha: this.putBlob(Buffer.from(f, "utf8")) });
      } else {
        const type = f.type ?? "blob";
        const sha = f.sha ?? this.putBlob(Buffer.from(f.content ?? "", "utf8"));
        flat.set(path, { mode: f.mode ?? (type === "commit" ? "160000" : "100644"), type, sha });
      }
    }
    return this.storeTree(flat);
  }

  private storeTree(flat: Map<string, FakeEntry>): string {
    const canon = JSON.stringify([...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const sha = sha1(`tree:${canon}`);
    this.trees.set(sha, flat);
    return sha;
  }

  private putCommit(c: FakeCommit): string {
    const sha = sha1(`commit:${JSON.stringify(c)}`);
    this.commits.set(sha, c);
    return sha;
  }

  private fail(method: string, path: string, status: number, message: string): never {
    throw new GithubApiError(`${method} ${path}`, status, message);
  }

  private descends(from: string, ancestor: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const s = stack.pop() as string;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  private handle(method: string, rawPath: string, body: Record<string, unknown> | undefined): { status: number; data: unknown } {
    const [path, query = ""] = rawPath.split("?");
    const orgPrefix = `/orgs/${encodeURIComponent(this.owner)}/actions/secrets/`;
    if (path.startsWith(orgPrefix)) return this.handleOrgSecret(method, rawPath, path.slice(orgPrefix.length), body);
    const prefix = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
    if (path !== prefix && !path.startsWith(`${prefix}/`)) this.fail(method, rawPath, 404, "Not Found");
    const rest = path.slice(prefix.length);

    if (method === "GET" && rest === "") {
      return { status: 200, data: { id: this.repoId, full_name: `${this.owner}/${this.name}`, default_branch: this.defaultBranch } };
    }

    const c = /^\/contents\/(.+)$/.exec(rest);
    if (method === "GET" && c) {
      const filePath = c[1].split("/").map(decodeURIComponent).join("/");
      const ref = new URLSearchParams(query).get("ref") ?? this.defaultBranch;
      const commitSha = this.commits.has(ref) ? ref : this.refs.get(ref);
      const commit = commitSha ? this.commits.get(commitSha) : undefined;
      if (!commit) this.fail(method, rawPath, 404, "No commit found for the ref");
      const flat = this.trees.get(commit.tree)!;
      const entry = flat.get(filePath);
      if (!entry) {
        const children = [...flat.keys()].filter((p) => p.startsWith(`${filePath}/`));
        if (children.length === 0) this.fail(method, rawPath, 404, "Not Found");
        return { status: 200, data: children.map((p) => ({ type: "file", path: p })) };
      }
      if (entry.type !== "blob" || entry.mode === "120000") return { status: 200, data: { type: entry.type === "commit" ? "submodule" : "symlink", path: filePath } };
      const b64 = (this.blobs.get(entry.sha) ?? Buffer.alloc(0)).toString("base64").replace(/(.{60})/g, "$1\n");
      return { status: 200, data: { type: "file", path: filePath, sha: entry.sha, encoding: "base64", content: b64 } };
    }

    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === "GET" && m) {
      const branch = m[1].split("/").map(decodeURIComponent).join("/");
      const sha = this.refs.get(branch);
      if (!sha) this.fail(method, rawPath, 404, "Not Found");
      return { status: 200, data: { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } } };
    }

    m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (method === "GET" && m) {
      const c = this.commits.get(m[1]);
      if (!c) this.fail(method, rawPath, 404, "Not Found");
      return { status: 200, data: { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message } };
    }

    m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (method === "GET" && m) {
      const flat = this.trees.get(m[1]);
      if (!flat) this.fail(method, rawPath, 404, "Not Found");
      if (!/(^|&)recursive=1(&|$)/.test(query)) this.fail(method, rawPath, 400, "this fake only lists recursively");
      const dirs = new Set<string>();
      for (const p of flat.keys()) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      const tree = [
        ...[...dirs].map((d) => ({ path: d, mode: "040000", type: "tree", sha: sha1(`dir:${m![1]}:${d}`) })),
        ...[...flat.entries()].map(([p, e]) => ({ path: p, mode: e.mode, type: e.type, sha: e.sha })),
      ];
      return { status: 200, data: { sha: m[1], tree, truncated: false } };
    }

    if (method === "POST" && rest === "/git/blobs") {
      if (body?.encoding !== "base64" || typeof body.content !== "string") this.fail(method, rawPath, 422, "content + encoding required");
      const sha = this.putBlob(Buffer.from(body.content as string, "base64"));
      if (this.corruptNextBlobSha) {
        this.corruptNextBlobSha = false;
        return { status: 201, data: { sha: sha1(`corrupt:${sha}`) } };
      }
      return { status: 201, data: { sha } };
    }

    if (method === "POST" && rest === "/git/trees") {
      const base = typeof body?.base_tree === "string" ? this.trees.get(body.base_tree) : new Map<string, FakeEntry>();
      if (!base) this.fail(method, rawPath, 422, "base_tree not found");
      const flat = new Map(base);
      for (const e of (body?.tree as Array<{ path: string; mode: string; type: string; sha: string }>) ?? []) {
        if (e.type === "blob" && !this.blobs.has(e.sha)) this.fail(method, rawPath, 422, `blob ${e.sha} not found`);
        flat.set(e.path, { mode: e.mode, type: e.type === "commit" ? "commit" : "blob", sha: e.sha });
      }
      return { status: 201, data: { sha: this.storeTree(flat) } };
    }

    if (method === "POST" && rest === "/git/commits") {
      const tree = body?.tree as string;
      if (!this.trees.has(tree)) this.fail(method, rawPath, 422, "tree not found");
      const parents = (body?.parents as string[]) ?? [];
      for (const p of parents) if (!this.commits.has(p)) this.fail(method, rawPath, 422, "parent not found");
      const sha = this.putCommit({ tree, parents, message: String(body?.message ?? ""), author: body?.author, committer: body?.committer });
      return { status: 201, data: { sha } };
    }

    m = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === "PATCH" && m) {
      const branch = m[1].split("/").map(decodeURIComponent).join("/");
      const current = this.refs.get(branch);
      if (!current) this.fail(method, rawPath, 422, "Reference does not exist");
      const next = body?.sha as string;
      if (!this.commits.has(next)) this.fail(method, rawPath, 422, "Object does not exist");
      if (body?.force !== true && !this.descends(next, current)) this.fail(method, rawPath, 422, "Update is not a fast forward");
      this.refs.set(branch, next);
      return { status: 200, data: { ref: `refs/heads/${branch}`, object: { sha: next, type: "commit" } } };
    }

    return this.fail(method, rawPath, 404, "Not Found");
  }

  private handleOrgSecret(method: string, rawPath: string, rest: string, body?: Record<string, unknown>): { status: number; data: unknown } {
    if (!this.orgSecretsPermission) this.fail(method, rawPath, 403, "Resource not accessible by integration");
    if (rest === "public-key") {
      if (method !== "GET" || !this.orgKey) this.fail(method, rawPath, 404, "Not Found");
      return { status: 200, data: { key_id: this.orgKey.keyId, key: Buffer.from(this.orgKey.publicKey).toString("base64") } };
    }
    const m = /^([^/]+)(?:\/repositories\/(\d+))?$/.exec(rest);
    if (!m) this.fail(method, rawPath, 404, "Not Found");
    const name = decodeURIComponent(m[1]);
    if (m[2] === undefined && method === "PUT") return this.putOrgSecretValue(method, rawPath, name, body);
    const secret = this.orgSecrets.get(name);
    if (!secret) this.fail(method, rawPath, 404, "Not Found");
    if (m[2] === undefined) {
      if (method !== "GET") this.fail(method, rawPath, 404, "Not Found");
      return { status: 200, data: { name, visibility: secret.visibility, created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z" } };
    }
    if (secret.visibility !== "selected") this.fail(method, rawPath, 409, "Conflict when visibility type not set to selected");
    const id = Number(m[2]);
    if (method === "PUT") {
      secret.repos.add(id);
      return { status: 204, data: undefined };
    }
    if (method === "DELETE") {
      secret.repos.delete(id);
      return { status: 204, data: undefined };
    }
    return this.fail(method, rawPath, 404, "Not Found");
  }

  /** GitHub's create-or-update of an org secret's value (M6-P6o). */
  private putOrgSecretValue(method: string, rawPath: string, name: string, body?: Record<string, unknown>): { status: number; data: unknown } {
    const ev = body?.encrypted_value;
    const kid = body?.key_id;
    const visibility = body?.visibility;
    if (typeof ev !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(ev)) this.fail(method, rawPath, 422, "encrypted_value must be base64");
    if (!this.orgKey || kid !== this.orgKey.keyId) this.fail(method, rawPath, 422, "Bad request - key_id is not the current key");
    if (visibility !== "all" && visibility !== "private" && visibility !== "selected") this.fail(method, rawPath, 422, "visibility is required");
    const ids = body?.selected_repository_ids;
    if (ids !== undefined && (visibility !== "selected" || !Array.isArray(ids) || !ids.every((i) => Number.isSafeInteger(i)))) {
      this.fail(method, rawPath, 422, "selected_repository_ids is only for visibility selected");
    }
    const existing = this.orgSecrets.get(name);
    const repos = Array.isArray(ids) ? new Set(ids as number[]) : (existing?.repos ?? new Set<number>());
    this.orgSecrets.set(name, { visibility, repos });
    this.orgSecretValues.set(name, { encryptedValue: ev, keyId: kid as string });
    return { status: existing ? 204 : 201, data: undefined };
  }
}
