import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useMediaRecorder, formatElapsed, formatBytes, MAX_RECORDING_BYTES, MAX_VIDEO_RECORDING_BYTES,
} from "./useMediaRecorder";

// jsdom implements NEITHER MediaRecorder NOR navigator.mediaDevices, so the browser side is faked
// here. That is the point rather than a limitation: the things worth testing in this hook are its
// STATE MACHINE and its LIFECYCLE (does the clock exclude paused time, is the microphone actually
// released, does the size cap keep the audio it already has) — none of which need a real encoder,
// and all of which are the parts a manual click-through is worst at checking.

class FakeMediaStreamTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeMediaStream {
  tracks: FakeMediaStreamTrack[];
  constructor(n = 1) {
    this.tracks = Array.from({ length: n }, () => new FakeMediaStreamTrack());
  }
  getTracks() {
    return this.tracks;
  }
}

type RecState = "inactive" | "recording" | "paused";

/** Minimal MediaRecorder stand-in with the handful of behaviours the hook relies on. `emit()` is the
 *  test's lever for `ondataavailable`, standing in for the timeslice the real encoder would fire. */
class FakeMediaRecorder {
  static supported = new Set(["audio/webm;codecs=opus", "audio/webm", "video/webm;codecs=vp9,opus", "video/webm"]);
  static isTypeSupported(t: string) {
    return FakeMediaRecorder.supported.has(t);
  }
  static instances: FakeMediaRecorder[] = [];

  state: RecState = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Set to false to model an engine whose MediaRecorder cannot pause. */
  pausable = true;

  opts: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number } | undefined;
  constructor(_stream: unknown, opts?: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    this.opts = opts;
    FakeMediaRecorder.instances.push(this);
  }
  get last() {
    return this;
  }
  start(_timeslice?: number) {
    this.state = "recording";
  }
  pause() {
    if (!this.pausable) throw new Error("pause unsupported");
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }
}

let stream: FakeMediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;

function installBrowser(opts: { mediaDevices?: boolean; recorder?: boolean } = {}) {
  const { mediaDevices = true, recorder = true } = opts;
  stream = new FakeMediaStream(2);
  getUserMedia = vi.fn(async () => stream);
  if (mediaDevices) {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
  } else {
    Object.defineProperty(globalThis.navigator, "mediaDevices", { value: undefined, configurable: true });
  }
  if (recorder) {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  } else {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  }
  // No AudioContext in jsdom; the hook treats the analyser as best-effort, so leaving it absent also
  // asserts that a missing meter never breaks a take.
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
}

const rec = () => FakeMediaRecorder.instances.at(-1)!;

// jsdom ships no object-URL implementation. Counting create/revoke also lets the leak claim be
// checked rather than asserted: every URL the hook mints must be revoked by the time it unmounts.
let created: string[];
let revoked: string[];

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  created = [];
  revoked = [];
  let n = 0;
  Object.defineProperty(URL, "createObjectURL", {
    value: (_b: Blob) => {
      const u = `blob:fake/${(n += 1)}`;
      created.push(u);
      return u;
    },
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (u: string) => void revoked.push(u),
    configurable: true,
  });
  vi.useFakeTimers();
  installBrowser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMediaRecorder — capability detection", () => {
  it("reports unsupported (not an error) when MediaRecorder is absent", async () => {
    installBrowser({ recorder: false });
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("unsupported");
    // Nothing was requested, so no permission prompt was raised on a browser that could not use it.
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports unsupported when navigator.mediaDevices is absent", async () => {
    installBrowser({ mediaDevices: false });
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("unsupported");
  });

  it("reports unsupported when no candidate container is supported", async () => {
    const saved = FakeMediaRecorder.supported;
    FakeMediaRecorder.supported = new Set();
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("unsupported");
    expect(result.current.error).toMatch(/no audio container/i);
    FakeMediaRecorder.supported = saved;
  });

  it("hides Pause on an engine whose recorder cannot pause", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    // Strip pause/resume BEFORE construction so the hook's own capability probe sees the gap —
    // the point is that the UI hides the control rather than rendering a button that throws.
    const noPause = class extends FakeMediaRecorder {} as unknown as typeof FakeMediaRecorder;
    (noPause.prototype as unknown as { pause?: unknown }).pause = undefined;
    (noPause.prototype as unknown as { resume?: unknown }).resume = undefined;
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = noPause;
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("recording");
    expect(result.current.canPause).toBe(false);
  });
});

describe("useMediaRecorder — permission failures", () => {
  it("distinguishes a blocked microphone from a missing one", async () => {
    const { result } = renderHook(() => useMediaRecorder());

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("denied");
    expect(result.current.error).toMatch(/blocked/i);

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotFoundError" }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toMatch(/no microphone was found/i);
  });
});

describe("useMediaRecorder — transport: start / pause / resume / stop", () => {
  it("walks the full phase machine", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("recording");
    expect(rec().state).toBe("recording");

    act(() => result.current.pause());
    expect(result.current.phase).toBe("paused");
    expect(rec().state).toBe("paused");

    act(() => result.current.resume());
    expect(result.current.phase).toBe("recording");
    expect(rec().state).toBe("recording");

    act(() => {
      rec().emit(2048);
      result.current.stop();
    });
    expect(result.current.phase).toBe("review");
    expect(result.current.blob).toBeInstanceOf(Blob);
    expect(result.current.sizeBytes).toBe(2048);
  });

  it("EXCLUDES paused time from the elapsed clock", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });

    // 2s recording
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const afterFirst = result.current.elapsedMs;
    expect(afterFirst).toBeGreaterThanOrEqual(1800);
    expect(afterFirst).toBeLessThan(2400);

    // 5s PAUSED — must not accrue. This is the whole reason the hook keeps an accumulator instead of
    // subtracting a single start timestamp from `now`.
    act(() => result.current.pause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.elapsedMs).toBeLessThan(afterFirst + 200);

    // 1s more recording — resumes accruing from where it left off.
    act(() => result.current.resume());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(afterFirst + 800);
    expect(result.current.elapsedMs).toBeLessThan(afterFirst + 1500);
  });

  it("pause() and resume() are inert unless the recorder is in the matching state", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    // Nothing exists yet: neither call may throw or move the phase.
    act(() => result.current.pause());
    act(() => result.current.resume());
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      await result.current.start();
    });
    // resume() while already recording is a no-op, not a double-start.
    act(() => result.current.resume());
    expect(result.current.phase).toBe("recording");
    act(() => result.current.pause());
    act(() => result.current.pause());
    expect(result.current.phase).toBe("paused");
  });
});

describe("useMediaRecorder — microphone release (the mic-light bug)", () => {
  it("stops every track on stop()", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(stream.tracks.every((t) => t.stopped)).toBe(false);

    act(() => result.current.stop());
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("stops every track on unmount mid-recording", async () => {
    const { result, unmount } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    unmount();
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("stops every track on reset()", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.reset());
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(result.current.phase).toBe("idle");
    expect(result.current.blob).toBeNull();
    expect(result.current.elapsedMs).toBe(0);
  });
});

describe("useMediaRecorder — size cap", () => {
  it("force-stops at the cap and KEEPS the audio recorded so far", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      // One oversized chunk is enough to trip the guard; the real encoder would arrive here after
      // many timeslices.
      rec().emit(MAX_RECORDING_BYTES + 1);
    });
    expect(result.current.phase).toBe("review");
    expect(result.current.error).toMatch(/200 MB/);
    // The take survives — a size stop must not also be a data loss.
    expect(result.current.blob).toBeInstanceOf(Blob);
    expect(result.current.sizeBytes).toBeGreaterThan(MAX_RECORDING_BYTES);
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("raises nearSizeLimit before the cap, while still recording", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => rec().emit(Math.floor(MAX_RECORDING_BYTES * 0.92)));
    expect(result.current.nearSizeLimit).toBe(true);
    expect(result.current.phase).toBe("recording");
  });
});

describe("useMediaRecorder — recorder error", () => {
  it("surfaces an encoder failure and keeps what it captured", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      rec().emit(512);
      rec().onerror?.();
    });
    expect(result.current.error).toMatch(/stopped unexpectedly/i);
    expect(result.current.phase).toBe("review");
    expect(result.current.blob).toBeInstanceOf(Blob);
  });
});

describe("useMediaRecorder — blob identity", () => {
  it("labels the blob and filename with the recorder's OWN negotiated mimeType", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    // The engine negotiated ogg even though webm/opus was requested first — the blob and the
    // extension must follow the engine, or the upload's bytes and content-type disagree.
    rec().mimeType = "audio/ogg;codecs=opus";
    act(() => {
      rec().emit(64);
      result.current.stop();
    });
    // No `waitFor` here: fake timers are installed, and waitFor polls on REAL timers, so it would
    // simply hang. Everything relevant flushes inside `act` above.
    expect(result.current.blob!.type).toBe("audio/ogg;codecs=opus");
    expect(result.current.fileName).toBe("meeting-recording.ogg");
  });

  it("produces an object URL for playback and no blob when nothing was captured", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      rec().emit(32);
      result.current.stop();
    });
    expect(result.current.blobUrl).toBeTruthy();

    act(() => result.current.reset());
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.stop()); // stopped with zero chunks
    expect(result.current.blob).toBeNull();
    expect(result.current.blobUrl).toBeNull();
  });

  it("revokes every object URL it minted (no leaked blob URLs)", async () => {
    const { result, unmount } = renderHook(() => useMediaRecorder());
    // Two takes in a row, so a discard-then-record cycle is covered and not just a single unmount.
    for (const bytes of [16, 32]) {
      await act(async () => {
        await result.current.start();
      });
      act(() => {
        rec().emit(bytes);
        result.current.stop();
      });
      expect(result.current.blobUrl).toBeTruthy();
      act(() => result.current.reset());
    }
    unmount();
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(revoked.sort()).toEqual(created.sort());
  });
});

describe("useMediaRecorder — video takes", () => {
  it("requests the camera, picks a VIDEO container, and caps the bitrate", async () => {
    const { result } = renderHook(() => useMediaRecorder({ video: true }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("recording");
    expect(result.current.kind).toBe("video");

    // A video constraint must be requested, or the camera is never opened.
    const constraints = getUserMedia.mock.calls[0][0] as { audio: unknown; video?: unknown };
    expect(constraints.video).toBeTruthy();
    expect(constraints.audio).toBeTruthy();

    // The chosen container must be a video one whose BARE type is in the backend's video allowlist.
    expect(result.current.mimeType).toMatch(/^video\/webm/);
    expect(result.current.fileName).toBe("meeting-recording.webm");

    // Bitrate ceilings are the reason a 60-minute meeting fits under the cap at all; without them
    // the browser's own multi-Mbps default force-stops a meeting partway through.
    expect(rec().opts?.videoBitsPerSecond).toBeGreaterThan(0);
    expect(rec().opts?.audioBitsPerSecond).toBeGreaterThan(0);
  });

  it("exposes the live stream for preview only while a video take is running", async () => {
    const { result } = renderHook(() => useMediaRecorder({ video: true }));
    expect(result.current.previewStream).toBeNull();
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.previewStream).not.toBeNull();

    // Cleared on stop, BEFORE the tracks die — a <video srcObject> left pointing at a stopped
    // stream renders a frozen frame that reads as "still recording".
    act(() => result.current.stop());
    expect(result.current.previewStream).toBeNull();
  });

  it("never exposes a preview stream for an AUDIO take", async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.kind).toBe("audio");
    expect(result.current.previewStream).toBeNull();
    const constraints = getUserMedia.mock.calls[0][0] as { video?: unknown };
    // Asking for video on an audio take would raise a camera permission prompt for nothing.
    expect(constraints.video).toBeUndefined();
  });

  it("uses the LARGER video cap, so a video take is not refused at the audio limit", async () => {
    const { result } = renderHook(() => useMediaRecorder({ video: true }));
    expect(result.current.maxBytes).toBe(MAX_VIDEO_RECORDING_BYTES);
    expect(MAX_VIDEO_RECORDING_BYTES).toBeGreaterThan(MAX_RECORDING_BYTES);

    await act(async () => {
      await result.current.start();
    });
    // Comfortably past the AUDIO cap — a video take must keep going here, which is exactly what a
    // single shared cap would have got wrong.
    act(() => rec().emit(MAX_RECORDING_BYTES + 1));
    expect(result.current.phase).toBe("recording");

    act(() => rec().emit(MAX_VIDEO_RECORDING_BYTES));
    expect(result.current.phase).toBe("review");
    expect(result.current.error).toMatch(/500 MB/);
    expect(result.current.blob).toBeInstanceOf(Blob);
  });

  it("reports unsupported when no VIDEO container is available, without blaming the mic", async () => {
    FakeMediaRecorder.supported = new Set(["audio/webm"]); // audio works, video does not
    const { result } = renderHook(() => useMediaRecorder({ video: true }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("unsupported");
    expect(result.current.error).toMatch(/no video container/i);
    FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/webm", "video/webm;codecs=vp9,opus", "video/webm"]);
  });

  it("names BOTH devices when a video take is blocked", async () => {
    const { result } = renderHook(() => useMediaRecorder({ video: true }));
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toMatch(/camera or microphone/i);
  });
});

describe("formatters", () => {
  it("formats elapsed time, adding an hour field only past an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(600_000)).toBe("10:00");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("formats bytes across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
