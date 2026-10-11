import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { uploadFile, withFilename } from "./mediaUpload";

// A hand-rolled XMLHttpRequest: the real one is what runs in the browser; here it records what the upload SENDS and lets
// the test play back WebDesk's answer.
class FakeXhr {
  static last: FakeXhr | null = null;
  method = ""; url = ""; headers: Record<string, string> = {}; body: unknown = null; responseText = ""; status = 0; withCredentials = true; responseType = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  open(m: string, u: string) { this.method = m; this.url = u; FakeXhr.last = this; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(b: unknown) { this.body = b; }
  abort() { this.onabort?.(); }
  answer(status: number, body: unknown) { this.status = status; this.responseText = body === null ? "" : JSON.stringify(body); this.onload?.(); }
}

const OriginalXhr = globalThis.XMLHttpRequest;
beforeEach(() => { FakeXhr.last = null; (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr; });
afterEach(() => { (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = OriginalXhr; });

const URL_ = "https://webdesk.example/v1/t/gaiada/media/upload/SECRETTOKEN";
const file = (name = "hero.png", type = "image/png", size = 4) => new File([new Uint8Array(size)], name, { type });
const asset = { assetId: "a1", url: "/v1/t/gaiada/media/a1", bucket: "media", bucketKey: "k", mime: "image/png", sizeBytes: 4, scanStatus: "clean", title: null, alt: {}, tags: [], originalFilename: "hero.png", width: 1, height: 1, createdBy: "u1", createdAt: "t", updatedAt: "t" };

describe("the browser upload: the raw file straight to WebDesk's public URL", () => {
  it("POSTs the file itself to <uploadUrl>?filename=<name> with the file's own Content-Type, and no credentials", async () => {
    const f = file("my hero (1).png");
    const p = uploadFile(URL_, f);
    const x = FakeXhr.last!;
    expect(x.method).toBe("POST");
    const u = new URL(x.url);
    expect(`${u.origin}${u.pathname}`).toBe(URL_);
    expect(u.searchParams.get("filename")).toBe("my hero (1).png");
    expect(x.headers).toEqual({ "Content-Type": "image/png" });
    expect(x.withCredentials).toBe(false);
    expect(x.body).toBe(f); // the File itself: not a form, not base64, not JSON
    x.answer(201, asset);
    const out = await p;
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.asset.url).toBe("/v1/t/gaiada/media/a1");
  });

  it("reports progress as a fraction as bytes leave the browser", async () => {
    const seen: number[] = [];
    const p = uploadFile(URL_, file(), { onProgress: (f) => seen.push(f) });
    const x = FakeXhr.last!;
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    x.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    x.answer(201, asset);
    await p;
    expect(seen).toEqual([0.25, 0.75, 1]);
  });

  it("keeps a query the URL already carries", () => {
    expect(withFilename("https://w.example/u/T?x=1", "a b.png")).toBe("https://w.example/u/T?x=1&filename=a+b.png");
  });

  it.each([
    [413, { statusCode: 413, message: "upload exceeds the limit" }, "too_large"],
    [415, { statusCode: 415, message: "content-type 'x' is not allowed for this upload token" }, "type_not_allowed"],
    [403, { statusCode: 403, message: "upload refused: malware scan matched 'Eicar'" }, "infected"],
    [503, { statusCode: 503, message: "malware scan unavailable - upload refused: e" }, "scan_unavailable"],
    [404, { statusCode: 404, message: "Not Found" }, "token_expired"],
  ])("HTTP %i is shown in plain words (%s)", async (status, body, kind) => {
    const p = uploadFile(URL_, file(), { maxBytes: 1024 });
    FakeXhr.last!.answer(status, body);
    const out = await p;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.kind).toBe(kind);
  });

  it("no answer at all (CORS not configured, or the connection dropped) is 'uploads aren't enabled for this site yet'", async () => {
    const p = uploadFile(URL_, file());
    FakeXhr.last!.onerror?.();
    const out = await p;
    expect(out).toMatchObject({ ok: false, failure: { kind: "not_enabled", title: "Uploads aren't enabled for this site yet." } });
  });

  it("a 201 that is not an asset is drift: never 'failed', never an invented asset", async () => {
    const p = uploadFile(URL_, file());
    FakeXhr.last!.answer(201, { ok: true });
    const out = await p;
    expect(out).toMatchObject({ ok: false, failure: { kind: "drift" } });
    if (!out.ok) expect(out.failure.detail).not.toContain("SECRETTOKEN");
  });

  it("an upload URL the browser cannot use is refused without sending anything", async () => {
    const out = await uploadFile("not a url", file());
    expect(out.ok).toBe(false);
    expect(FakeXhr.last).toBeNull();
  });

  it("an abort signal cancels", async () => {
    const ac = new AbortController();
    const p = uploadFile(URL_, file(), { signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, failure: { title: "The upload was cancelled." } });
  });
});
