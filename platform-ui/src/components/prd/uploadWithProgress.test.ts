import { describe, it, expect, vi } from "vitest";
import { uploadWithProgress } from "./uploadWithProgress";

// A minimal stand-in for XMLHttpRequest: records what was sent, lets the test fire progress and
// completion. Injected, so the uploader's behaviour is tested without a network or a browser.
class FakeXhr {
  static last: FakeXhr | null = null;
  method = ""; url = ""; body: unknown = null; status = 0; responseText = "";
  upload = { onprogress: null as null | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) };
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  open(method: string, url: string) { this.method = method; this.url = url; FakeXhr.last = this; }
  send(body: unknown) { this.body = body; }
  abort() { this.onabort?.(); }
}

function run(opts: { status: number; response: string; progress?: Array<[number, number]> }, onProgress = vi.fn()) {
  const file = new File(["abc"], "take.mp4", { type: "video/mp4" });
  const p = uploadWithProgress("/api/meetings/rec-1/audio", file, onProgress, FakeXhr as unknown as typeof XMLHttpRequest);
  const xhr = FakeXhr.last!;
  for (const [loaded, total] of opts.progress ?? []) xhr.upload.onprogress?.({ lengthComputable: true, loaded, total });
  xhr.status = opts.status; xhr.responseText = opts.response; xhr.onload?.();
  return { p, xhr, onProgress };
}

describe("uploadWithProgress — the browser posts the file itself, so it can show progress", () => {
  it("POSTs multipart with the file under `file` to the given url", async () => {
    const { p, xhr } = run({ status: 202, response: JSON.stringify({ id: "rec-1", status: "transcribing", audioRef: "a" }) });
    await p;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/meetings/rec-1/audio");
    expect(xhr.body).toBeInstanceOf(FormData);
    expect((xhr.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("reports progress as a 0–1 fraction plus bytes", async () => {
    const { p, onProgress } = run({ status: 202, response: "{}", progress: [[50, 200], [200, 200]] });
    await p;
    expect(onProgress).toHaveBeenNthCalledWith(1, { fraction: 0.25, loaded: 50, total: 200 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { fraction: 1, loaded: 200, total: 200 });
  });

  it("resolves ok on a 2xx", async () => {
    const { p } = run({ status: 202, response: JSON.stringify({ status: "transcribing" }) });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("surfaces the platform's own error text on a failure status (413 too large, 415 wrong type)", async () => {
    const { p } = run({ status: 413, response: JSON.stringify({ error: "file exceeds MEETING_VIDEO_MAX_BYTES (500 MB)" }) });
    await expect(p).resolves.toEqual({ ok: false, status: 413, error: "file exceeds MEETING_VIDEO_MAX_BYTES (500 MB)" });
  });

  it("gives a plain sentence when the failure body is not JSON", async () => {
    const { p } = run({ status: 502, response: "<html>Bad gateway</html>" });
    await expect(p).resolves.toEqual({ ok: false, status: 502, error: "Upload failed (502)." });
  });

  it("a dropped connection is an error, not a hang", async () => {
    const file = new File(["abc"], "take.mp4");
    const p = uploadWithProgress("/u", file, () => {}, FakeXhr as unknown as typeof XMLHttpRequest);
    FakeXhr.last!.onerror?.();
    await expect(p).resolves.toEqual({ ok: false, status: 0, error: "Upload failed — the connection dropped. Check your network and try again." });
  });
});
