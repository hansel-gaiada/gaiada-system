// Local capture via ffmpeg (free). Windows-first: dshow for audio, gdigrab for screen.
// One recording at a time. Audio -> .m4a; Audio+Video -> .mp4. The file lands in RECORDINGS_DIR
// (local-first); nothing leaves the machine here — transcription + Drive are separate steps.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

let active = null; // { proc, kind, file, startedAt }

/** Build the ffmpeg input args for the chosen kind on Windows (dshow/gdigrab). */
function inputArgs(kind) {
  const args = [];
  if (kind === "video") {
    // Screen capture. gdigrab grabs the desktop; pair with an audio input below.
    args.push("-f", "gdigrab", "-framerate", "15", "-i", config.screenInput);
  }
  // Audio input(s): mic, and optionally a system/loopback device, mixed.
  if (config.audioDevice) {
    args.push("-f", "dshow", "-i", `audio=${config.audioDevice}`);
  }
  if (config.systemAudioDevice) {
    args.push("-f", "dshow", "-i", `audio=${config.systemAudioDevice}`);
  }
  return args;
}

/** Output/codec args. Mix the two audio inputs when a system device is set. */
function outputArgs(kind, file) {
  const args = [];
  const audioInputs = [config.audioDevice, config.systemAudioDevice].filter(Boolean).length;
  if (kind === "video") {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
    if (audioInputs >= 2) {
      // video is input 0, audio inputs are 1 & 2 -> merge to one stereo track.
      args.push("-filter_complex", "[1:a][2:a]amix=inputs=2:duration=longest[aout]", "-map", "0:v", "-map", "[aout]");
    }
    args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    if (audioInputs >= 2) {
      args.push("-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest[aout]", "-map", "[aout]");
    }
    args.push("-c:a", "aac", "-b:a", "128k");
  }
  args.push("-y", file);
  return args;
}

export function isRecording() {
  return !!active;
}

export function start(kind, meetingId) {
  if (active) throw new Error("already recording");
  if (kind !== "audio" && kind !== "video") throw new Error("kind must be audio|video");
  if (!config.audioDevice && kind === "audio") {
    throw new Error("AUDIO_DEVICE not set — run `npm run devices` and set it in .env");
  }
  mkdirSync(config.recordingsDir, { recursive: true });
  const ext = kind === "video" ? "mp4" : "m4a";
  const file = join(config.recordingsDir, `${meetingId}.${ext}`);
  const args = [...inputArgs(kind), ...outputArgs(kind, file)];
  const proc = spawn(config.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  active = { proc, kind, file, startedAt: Date.now(), errBuf: () => stderr };
  return { file, kind };
}

/** Graceful stop: ask ffmpeg to finalize (send "q"), wait for exit, return file metadata. */
export function stop() {
  if (!active) throw new Error("not recording");
  const a = active;
  active = null;
  return new Promise((resolve, reject) => {
    const done = () => {
      let sizeBytes = null;
      try { sizeBytes = statSync(a.file).size; } catch { /* file may be absent on failure */ }
      resolve({ file: a.file, kind: a.kind, durationSec: Math.round((Date.now() - a.startedAt) / 1000), sizeBytes });
    };
    a.proc.on("close", done);
    a.proc.on("error", reject);
    try { a.proc.stdin.write("q"); a.proc.stdin.end(); } catch { a.proc.kill("SIGINT"); }
    // Safety: hard-kill if ffmpeg doesn't finalize promptly.
    setTimeout(() => { try { a.proc.kill("SIGKILL"); } catch { /* already gone */ } }, 8000);
  });
}

/** Print available dshow devices (mic/camera names) so the operator can set AUDIO_DEVICE. */
export function listDevices() {
  const r = spawnSync(config.ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { encoding: "utf8" });
  // ffmpeg prints the device list to stderr and exits non-zero by design.
  process.stdout.write((r.stderr || r.stdout || "no output — is ffmpeg installed and on PATH?") + "\n");
}

// `node src/recorder.mjs --list-devices`
if (process.argv[1] && process.argv[1].endsWith("recorder.mjs") && process.argv.includes("--list-devices")) {
  listDevices();
}
