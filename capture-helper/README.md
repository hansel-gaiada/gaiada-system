# Gaiada Capture Helper (WS11 capture edge — build item 5)

The desktop companion that turns "click record in the ERP" into a real local recording that flows into
the delivery pipeline. **Node ESM, no build step** (runs with plain `node` — deliberately not a compiled
binary, so Windows Smart App Control doesn't block it). Needs **Node 20+** and **ffmpeg** on PATH.

## What it does (the flow)

```
[Record Audio | Record Audio+Video]           (local control UI at http://127.0.0.1:7842)
   → ffmpeg captures to  %USERPROFILE%\Gaiada\Recordings\<meetingId>.(m4a|mp4)   (LOCAL-FIRST)
   → register with the ERP  (POST /meetings/recordings/start — mints the stable meetingId)
 [Stop]
   → local whisper transcribes the file           (POST {WHISPER_URL}/v1/audio/transcriptions)
   → send the .txt to the ERP                      (POST …/:id/transcript)
   → ingest → delivery pipeline                    (POST …/:id/ingest — the ERP proxies the frozen
                                                     contract to n8n; the helper never holds the secret)
   → upload the media to the company Drive folder  (or set a "remind me" nudge if Drive isn't configured)
```

Only the **transcript text** ever enters the pipeline; the heavy audio/video stays local and goes to Drive
separately, so the pipeline is never clogged.

## Setup

1. **Install** Node 20+ and ffmpeg (`ffmpeg -version` should work).
2. `cp .env.example .env` and fill it in. Find your mic device name with:
   ```
   npm run devices
   ```
   Set `AUDIO_DEVICE` (and optionally `SYSTEM_AUDIO_DEVICE` to also capture system audio via a loopback
   device such as "Stereo Mix" or VB-Audio Cable).
3. **Google Drive (free personal account):** in Google Cloud → APIs & Services, create a project, enable the
   **Drive API**, create an **OAuth client (type: Desktop app)** → get the client id/secret. Then:
   ```
   DRIVE_CLIENT_ID=… DRIVE_CLIENT_SECRET=… npm run drive-token
   ```
   Approve in the browser; paste the printed `DRIVE_REFRESH_TOKEN` into `.env`. Create a Drive folder,
   share it with the team, and put its id in `DRIVE_FOLDER_ID`. (Drive is optional — without it the helper
   just reminds you to upload.)
4. **Run:**
   ```
   npm start
   ```
   Open http://127.0.0.1:7842 and record.

## Notes / limits

- **Windows-first** capture (dshow/gdigrab). Mac/Linux need different ffmpeg inputs (avfoundation / x11grab)
  — the `recorder.mjs` input args are the only place to change.
- **In-person meetings** = mic quality; to capture a desktop call's audio, route it through a loopback
  device and set `SYSTEM_AUDIO_DEVICE`.
- **Whisper is not instant** — a 1-hour meeting is minutes on CPU/iGPU; the UI shows `transcribing`.
- **Auth**: dev uses the platform service token + your user id; production swaps to an OIDC access token
  (`HELPER_ACCESS_TOKEN`).
- The helper is **loopback-only** and holds no n8n bridge secret — ingestion is proxied by the ERP backend.
