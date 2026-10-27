// M6-P6o — the deploy credential's shape (deploy-credential.ts), the redactor, and the sealed box (core/github/sealed-box.ts).
// No database, no network. The canary values are minted per run: the repository is public, so nothing here may look like a
// real credential.
import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import sodium from "libsodium-wrappers";
import { DEPLOY_CREDENTIAL_FIELDS, parseDeployCredential, parseDeployCredentialText, redactorFor, scrubError } from "./deploy-credential";
import { decodeGithubPublicKey, sealForGithubSecret } from "../../core/github/sealed-box";
import { GithubApiError } from "../../core/github/errors";
import { findSecretValueLeaks } from "../../testing/secret-value-leaks";

const canary = (tag: string): string => `canary-${tag}-${randomBytes(12).toString("hex")}`;

function sftp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, environment: "staging", transport: "sftp", host: "sftp.example.invalid", port: 65002, user: "u_site_stg",
    password: canary("pw"), knownHosts: "[sftp.example.invalid]:65002 ssh-ed25519 AAAAplaceholder", remoteBase: "/home/u/domains/stg",
    docroot: "public_html", siteUrl: "https://stg.example.invalid", ...over,
  };
}

describe("M6-P6o · the deploy credential's shape (mirrors deploy-from-secret.sh)", () => {
  it("accepts the documented sftp shape and writes ONE canonical minified line in the documented field order", () => {
    const raw = sftp();
    // Key order scrambled on purpose: the canonical form does not depend on the caller's bytes.
    const scrambled = Object.fromEntries(Object.entries(raw).reverse());
    const p = parseDeployCredential(scrambled);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.canonical).not.toContain("\n");
    expect(Object.keys(JSON.parse(p.canonical))).toEqual(DEPLOY_CREDENTIAL_FIELDS.filter((f) => raw[f] !== undefined));
    expect(parseDeployCredential(raw)).toEqual(p);
    expect(parseDeployCredentialText(p.canonical)).toEqual(p);
  });

  it("accepts ftps with a pinned certificate and no docroot (wp)", () => {
    const p = parseDeployCredential({
      version: 1, environment: "production", transport: "ftps", host: "ftp.example.invalid", user: "u_wp", password: canary("pw"),
      certSha256: "AB:CD:EF", remoteBase: "/home/u/wp", siteUrl: "https://www.example.invalid", checkHostname: true,
    });
    expect(p.ok).toBe(true);
  });

  it.each([
    ["an unknown field", sftp({ hostname: "x" }), "unknown field: hostname"],
    ["plain ftp", sftp({ transport: "ftp" }), "transport must be sftp or ftps (plain ftp is never accepted)"],
    ["version 2", sftp({ version: 2 }), "version must be 1"],
    ["no secret", sftp({ password: undefined }), "password or privateKey is required"],
    ["both secrets", sftp({ privateKey: "k".repeat(20) }), "give password or privateKey, not both"],
    ["privateKey on ftps", { ...sftp({ transport: "ftps", certSha256: "AB", password: undefined, knownHosts: undefined }), privateKey: "k".repeat(20) }, "privateKey is for sftp only"],
    ["sftp without a host key", sftp({ knownHosts: undefined }), "knownHosts is required for sftp (the pinned host key line)"],
    ["ftps without a pin", sftp({ transport: "ftps", knownHosts: undefined }), "certSha256 or caPem is required for ftps (the pinned certificate)"],
    ["an http siteUrl", sftp({ siteUrl: "http://stg.example.invalid" }), "siteUrl must be an https:// URL with no query or fragment"],
    ["a siteUrl with a query", sftp({ siteUrl: "https://stg.example.invalid/?a=1" }), "siteUrl must be an https:// URL with no query or fragment"],
    ["a port out of range", sftp({ port: 70000 }), "port must be an integer from 1 to 65535"],
    ["a numeric user", sftp({ user: 42 }), "user must be a string"],
    ["a string checkHostname", sftp({ checkHostname: "yes" }), "checkHostname must be true or false"],
  ])("refuses %s, naming the field", (_label, raw, problem) => {
    const p = parseDeployCredential(raw);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems).toContain(problem);
  });

  it("a refusal names fields, NEVER a value", () => {
    const pw = canary("pw");
    const raw = sftp({ password: pw, transport: "ftp", [`${pw}`]: pw });
    const p = parseDeployCredential(raw);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(findSecretValueLeaks([{ where: "problems", text: p.problems.join("\n") }], { pw })).toEqual([]);
  });

  it("refuses what is not an object, and stored text that is not JSON without quoting it", () => {
    expect(parseDeployCredential("x")).toEqual({ ok: false, problems: ["the credential is not a JSON object"] });
    expect(parseDeployCredential([1])).toEqual({ ok: false, problems: ["the credential is not a JSON object"] });
    const secretish = canary("text");
    const p = parseDeployCredentialText(`{${secretish}`);
    expect(p).toEqual({ ok: false, problems: ["the stored credential is not JSON"] });
  });
});

describe("M6-P6o · the redactor and the error scrub (the PGL-10 sender.ts pattern)", () => {
  it("removes every string value, each line of a multi-line one, the canonical text, its base64 and extras; keeps the message's shape", () => {
    const pw = canary("pw");
    const keyLine2 = canary("keyline");
    const p = parseDeployCredential(sftp({ password: undefined, privateKey: `-----BEGIN KEY-----\n${keyLine2}\n-----END KEY-----` }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const sealed = canary("sealed");
    const redact = redactorFor(p.credential, p.canonical, [sealed]);
    const text = `GitHub refused 'PUT /orgs/o/actions/secrets/N' (HTTP 422: echoed ${keyLine2} and ${sealed} and ${p.canonical} and ${Buffer.from(p.canonical).toString("base64")} and ${pw})`;
    const out = redact(text);
    expect(out).toContain("GitHub refused 'PUT /orgs/o/actions/secrets/N' (HTTP 422");
    expect(out).not.toContain(keyLine2);
    expect(out).not.toContain(sealed);
    expect(out).not.toContain(p.canonical);
    // `pw` is not in this credential: a redactor only knows the value it was built from.
    expect(out).toContain(pw);
  });

  it("scrubs a GithubApiError in place: the message and stack lose the value, the class and GitHub's status/operation stay", () => {
    const pw = canary("pw");
    const p = parseDeployCredential(sftp({ password: pw }));
    if (!p.ok) throw new Error("fixture");
    const err = new GithubApiError("PUT /orgs/o/actions/secrets/N", 422, `bad value ${pw}`);
    const out = scrubError(err, redactorFor(p.credential, p.canonical)) as GithubApiError;
    expect(out).toBe(err);
    expect(out).toBeInstanceOf(GithubApiError);
    expect(out.message).not.toContain(pw);
    expect(out.stack ?? "").not.toContain(pw);
    expect((out.detail as { httpStatus: number }).httpStatus).toBe(422);
    expect(String(scrubError(`thrown ${pw}`, redactorFor(p.credential, p.canonical)))).not.toContain(pw);
  });
});

describe("M6-P6o · the libsodium sealed box GitHub requires", () => {
  it("the sealed bytes OPEN with the matching private key and give back the exact value; a second seal differs", async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const pub = Buffer.from(kp.publicKey).toString("base64");
    const value = JSON.stringify({ password: canary("pw") });
    const a = await sealForGithubSecret(pub, value);
    const b = await sealForGithubSecret(pub, value);
    expect(a).not.toEqual(b);
    // crypto_box_SEALBYTES (48) of overhead: an ephemeral public key and a MAC.
    expect(Buffer.from(a, "base64").length).toBe(Buffer.byteLength(value) + 48);
    for (const box of [a, b]) {
      const opened = sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(box, "base64")), kp.publicKey, kp.privateKey);
      expect(Buffer.from(opened).toString("utf8")).toBe(value);
    }
    // The plaintext is not in the box.
    expect(findSecretValueLeaks([{ where: "box", text: a }], { value })).toEqual([]);
  });

  it("a box sealed to another key does not open (the key matters)", async () => {
    await sodium.ready;
    const right = sodium.crypto_box_keypair();
    const wrong = sodium.crypto_box_keypair();
    const box = await sealForGithubSecret(Buffer.from(wrong.publicKey).toString("base64"), "value-for-the-wrong-key");
    expect(() => sodium.crypto_box_seal_open(new Uint8Array(Buffer.from(box, "base64")), right.publicKey, right.privateKey)).toThrow();
  });

  it("refuses a key that is not 32 bytes of base64, and an empty value", async () => {
    expect(() => decodeGithubPublicKey("not base64!")).toThrow(/not base64/);
    expect(() => decodeGithubPublicKey(Buffer.alloc(31).toString("base64"))).toThrow(/31 bytes/);
    await expect(sealForGithubSecret(Buffer.alloc(32, 1).toString("base64"), "")).rejects.toThrow(/empty/);
  });
});

describe("M6-P6o · the leak scanner itself", () => {
  it("finds a planted value raw, JSON-escaped, base64 and URL-encoded (positive controls), and refuses a short needle", () => {
    const v = `${canary("v")}"\\/`;
    const hits = findSecretValueLeaks(
      [
        { where: "raw", text: `x ${v} y` },
        { where: "json", text: JSON.stringify({ a: v }) },
        { where: "b64", text: Buffer.from(v).toString("base64") },
        { where: "url", text: `?q=${encodeURIComponent(v)}` },
        { where: "clean", text: "nothing here" },
      ],
      { v },
    );
    expect(hits.map((h) => h.split(":")[0])).toEqual(["raw", "json", "b64", "url"]);
    expect(() => findSecretValueLeaks([], { v: "short" })).toThrow(/shorter than 8/);
  });
});
