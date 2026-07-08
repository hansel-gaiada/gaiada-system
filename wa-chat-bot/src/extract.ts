// Local document/video extraction (5a.4). LOCAL-FIRST: docx/xlsx/pdf-with-text-layer
// extract on this box with no AI call; image-only PDFs fall back to the Gateway's vision
// OCR; video splits into keyframes + audio track via ffmpeg, each part enriched through
// the Gateway chain (audio → whisper local-first). Bytes only ever live in temp files
// for the duration of one ffmpeg run.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { describeMedia } from "./llm";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS = "application/vnd.ms-excel";

/** Minimum characters for a PDF text layer to count as "has text" (else → vision OCR). */
const PDF_TEXT_THRESHOLD = 40;

async function extractPdf(bytes: Buffer): Promise<string | null> {
  const { PDFParse } = await import("pdf-parse");
  try {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const text = (await parser.getText()).text.trim();
    return text.length >= PDF_TEXT_THRESHOLD ? text : null; // null → OCR fallback
  } catch {
    return null; // unparseable locally → OCR fallback
  }
}

function extractXlsx(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: "buffer" });
  return wb.SheetNames.map((name) => `# Sheet: ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join("\n\n").trim();
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`))));
  });
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Video → N keyframes (vision-described) + audio track (transcribed), via the Gateway. */
export async function extractVideo(bytes: Buffer, mime: string, frames = 3): Promise<string> {
  if (!(await ffmpegAvailable())) {
    throw new Error("video processing requires ffmpeg on this host (apk add ffmpeg / apt install ffmpeg)");
  }
  const dir = mkdtempSync(join(tmpdir(), "gaiada-video-"));
  try {
    const src = join(dir, `in.${mime.split("/")[1]?.split(";")[0] ?? "mp4"}`);
    writeFileSync(src, bytes);

    await run("ffmpeg", ["-y", "-i", src, "-vf", `thumbnail,fps=1/10`, "-frames:v", String(frames), join(dir, "frame-%02d.jpg")]);
    const parts: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.startsWith("frame-")).sort()) {
      const caption = await describeMedia(readFileSync(join(dir, f)), "image/jpeg");
      parts.push(`[frame] ${caption}`);
    }

    const audio = join(dir, "audio.ogg");
    try {
      await run("ffmpeg", ["-y", "-i", src, "-vn", "-acodec", "libvorbis", audio]);
      if (existsSync(audio)) {
        const transcript = await describeMedia(readFileSync(audio), "audio/ogg");
        parts.push(`[audio] ${transcript}`);
      }
    } catch {
      parts.push("[audio] (no audio track)");
    }
    return parts.join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Route one media payload to its extractor. Local extraction where possible; everything
 * else (images, audio, image-only PDFs) goes to the Gateway chain.
 */
export async function extractMediaText(bytes: Buffer, mime: string): Promise<string> {
  if (mime === DOCX) return (await mammoth.extractRawText({ buffer: bytes })).value.trim();
  if (mime === XLSX_MIME || mime === XLS) return extractXlsx(bytes);
  if (mime === "application/pdf") {
    const local = await extractPdf(bytes);
    if (local !== null) return local;
    return describeMedia(bytes, mime); // image-only PDF → Gateway vision OCR
  }
  if (mime.startsWith("video/")) return extractVideo(bytes, mime);
  return describeMedia(bytes, mime); // audio (whisper-first), images, everything else
}
