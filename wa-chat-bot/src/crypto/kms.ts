// Key custody (day-one spec, task 0.4/5a.10). The app NEVER holds long-lived key
// material when OpenBao is configured: data keys are wrapped/unwrapped by the transit
// engine over HTTP, and `deleteKey` (key destruction in Bao) is the crypto-shred
// primitive — everything wrapped under a destroyed key is permanently unrecoverable,
// including copies in backups.
//
// Two implementations behind one async interface:
//  - OpenBaoWrapper: transit engine (BAO_URL + BAO_TOKEN set). Production path.
//  - LocalWrapper:   AES keys in data/keys.json. Dev fallback ONLY — key material on
//                    the app disk; excluded from backups (see erasure runbook).
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config";

export interface KeyWrapper {
  /** Encrypt (wrap) bytes under the named key; creates the key on first use. */
  wrap(keyId: string, plaintext: Buffer): Promise<string>;
  /** Decrypt (unwrap). Throws if the key was destroyed — that IS the shred. */
  unwrap(keyId: string, blob: string): Promise<Buffer>;
  /** Deterministic keyed MAC for equality lookups (pseudonyms). */
  hmac(keyId: string, value: string): Promise<string>;
  /** Crypto-shred primitive: destroy the key. */
  deleteKey(keyId: string): Promise<void>;
}

const KEYFILE = "data/keys.json";

class LocalWrapper implements KeyWrapper {
  private keys: Record<string, string>;

  constructor() {
    this.keys = existsSync(KEYFILE) ? (JSON.parse(readFileSync(KEYFILE, "utf8")) as Record<string, string>) : {};
  }

  private flush(): void {
    mkdirSync(dirname(KEYFILE), { recursive: true });
    writeFileSync(KEYFILE, JSON.stringify(this.keys, null, 2));
  }

  private key(id: string, create: boolean): Buffer | null {
    if (!this.keys[id]) {
      if (!create) return null;
      this.keys[id] = randomBytes(32).toString("base64");
      this.flush();
    }
    return Buffer.from(this.keys[id], "base64");
  }

  async wrap(keyId: string, plaintext: Buffer): Promise<string> {
    const key = this.key(keyId, true)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `local:v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
  }

  async unwrap(keyId: string, blob: string): Promise<Buffer> {
    const key = this.key(keyId, false);
    if (!key) throw new Error(`key destroyed: ${keyId}`);
    const raw = Buffer.from(blob.replace(/^local:v1:/, ""), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }

  async hmac(keyId: string, value: string): Promise<string> {
    return createHmac("sha256", this.key(keyId, true)!).update(value).digest("hex");
  }

  async deleteKey(keyId: string): Promise<void> {
    if (this.keys[keyId]) {
      delete this.keys[keyId];
      this.flush();
    }
  }
}

/** OpenBao transit engine. Key names: transit keys are auto-created with
 *  deletion_allowed=true so per-subject/per-entity destruction (the shred) works. */
class OpenBaoWrapper implements KeyWrapper {
  private known = new Set<string>();

  constructor(
    private baseUrl: string = config.baoUrl,
    private token: string = config.baoToken,
    private mount: string = config.baoTransitMount,
  ) {}

  private name(keyId: string): string {
    return keyId.replace(/[^a-zA-Z0-9_-]/g, "_"); // transit-safe key names
  }

  private async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/v1/${path}`, {
      method,
      headers: { "X-Vault-Token": this.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openbao ${method} ${path} ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  private async ensureKey(name: string): Promise<void> {
    if (this.known.has(name)) return;
    await this.api("POST", `${this.mount}/keys/${name}`, {}); // idempotent create
    await this.api("POST", `${this.mount}/keys/${name}/config`, { deletion_allowed: true });
    this.known.add(name);
  }

  async wrap(keyId: string, plaintext: Buffer): Promise<string> {
    const name = this.name(keyId);
    await this.ensureKey(name);
    const r = await this.api("POST", `${this.mount}/encrypt/${name}`, { plaintext: plaintext.toString("base64") });
    return (r.data as { ciphertext: string }).ciphertext; // "vault:v1:..."
  }

  async unwrap(keyId: string, blob: string): Promise<Buffer> {
    const r = await this.api("POST", `${this.mount}/decrypt/${this.name(keyId)}`, { ciphertext: blob });
    return Buffer.from((r.data as { plaintext: string }).plaintext, "base64");
  }

  async hmac(keyId: string, value: string): Promise<string> {
    const name = this.name(keyId);
    await this.ensureKey(name);
    const r = await this.api("POST", `${this.mount}/hmac/${name}/sha2-256`, {
      input: Buffer.from(value, "utf8").toString("base64"),
    });
    return (r.data as { hmac: string }).hmac;
  }

  async deleteKey(keyId: string): Promise<void> {
    const name = this.name(keyId);
    this.known.delete(name);
    try {
      await this.api("DELETE", `${this.mount}/keys/${name}`);
    } catch (err) {
      // Deleting a never-created key is a successful shred (nothing to recover).
      if (!(err as Error).message.includes("404")) throw err;
    }
  }
}

export const wrapper: KeyWrapper = config.baoUrl && config.baoToken ? new OpenBaoWrapper() : new LocalWrapper();
