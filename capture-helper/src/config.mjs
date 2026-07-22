// WS11 capture-helper config — read from env (dotenv-free; the launcher can export or use a .env
// sourced by the shell). Everything is local to the operator's machine. See .env.example + README.
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

export const config = {
  // Local control UI (bind to loopback only — never expose the helper).
  uiHost: env.HELPER_HOST ?? "127.0.0.1",
  uiPort: Number(env.HELPER_PORT ?? 7842),

  // Where recordings are saved (local-first) + watched for externally-made files.
  recordingsDir: env.RECORDINGS_DIR ?? join(homedir(), "Gaiada", "Recordings"),

  // Gaiada platform BFF (the ERP backend). The helper registers + ingests through it; the platform
  // holds the n8n bridge secret and proxies the frozen contract (helper never sees that secret).
  platformUrl: env.PLATFORM_URL ?? "http://localhost:3004",
  // Dev auth: the platform service token + an x-user-id (matches platform-ui's dev BFF path).
  // Prod: swap for the user's OIDC access token (set HELPER_ACCESS_TOKEN).
  platformServiceToken: env.PLATFORM_SERVICE_TOKEN ?? "",
  accessToken: env.HELPER_ACCESS_TOKEN ?? "",
  userId: env.HELPER_USER_ID ?? "",
  tenantId: env.HELPER_TENANT_ID ?? "",

  // Local whisper (faster-whisper-server, OpenAI-compatible). For meeting-length audio the helper
  // calls this DIRECTLY (the AI Gateway has a ~2.5-min per-call timeout — plan §4).
  whisperUrl: env.WHISPER_URL ?? "http://localhost:8000",
  whisperModel: env.WHISPER_MODEL ?? "Systran/faster-whisper-small",

  // ffmpeg capture (Windows dshow / gdigrab defaults; override per machine — run `npm run devices`).
  ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
  audioDevice: env.AUDIO_DEVICE ?? "", // dshow audio device name, e.g. "Microphone (Realtek)"
  // Optional second audio input to also capture system/loopback (e.g. a "Stereo Mix" or VB-Cable).
  systemAudioDevice: env.SYSTEM_AUDIO_DEVICE ?? "",
  screenInput: env.SCREEN_INPUT ?? "desktop", // gdigrab source for A/V

  // Google Drive (FREE personal account via OAuth refresh token — NOT a Workspace service account,
  // which personal Gmail can't do). Run `npm run drive-token` once to mint the refresh token.
  drive: {
    clientId: env.DRIVE_CLIENT_ID ?? "",
    clientSecret: env.DRIVE_CLIENT_SECRET ?? "",
    refreshToken: env.DRIVE_REFRESH_TOKEN ?? "",
    folderId: env.DRIVE_FOLDER_ID ?? "", // the shared folder recordings go into
  },
};

/** Auth headers for platform BFF calls (OIDC token if present, else dev service-token + x-user-id). */
export function platformHeaders() {
  if (config.accessToken) return { authorization: `Bearer ${config.accessToken}` };
  return { authorization: `Bearer ${config.platformServiceToken}`, "x-user-id": config.userId };
}

export function driveConfigured() {
  const d = config.drive;
  return !!(d.clientId && d.clientSecret && d.refreshToken && d.folderId);
}

export function assertReady() {
  const missing = [];
  if (!config.tenantId) missing.push("HELPER_TENANT_ID");
  if (!config.accessToken && (!config.platformServiceToken || !config.userId)) missing.push("HELPER_ACCESS_TOKEN or (PLATFORM_SERVICE_TOKEN + HELPER_USER_ID)");
  return missing;
}
