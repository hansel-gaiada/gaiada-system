// The actual model call. Lives ONLY in the Gateway process — the bot never imports
// this or holds the key. Harden later: provider chain + failover + cost cap.
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config, aiEnabled } from "../config";

let model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

function getModel() {
  if (!model) {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    model = genAI.getGenerativeModel({ model: config.geminiModel });
  }
  return model;
}

export async function complete(prompt: string): Promise<string> {
  if (!aiEnabled) return "[AI disabled — set GEMINI_API_KEY on the Gateway]";
  try {
    const result = await getModel().generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    return `[AI error: ${(err as Error).message}]`;
  }
}

/** Instruction per media class: audio → transcript, image → description (+visible text), pdf → extraction. */
export function mediaInstruction(mime: string): string {
  if (mime.startsWith("audio/")) return "Transcribe this audio verbatim. Output only the transcript.";
  if (mime.startsWith("image/"))
    return "Describe this image for a work-group digest: what it shows, and transcribe any visible text (signs, documents, screens). Be factual and brief.";
  if (mime === "application/pdf") return "Extract the text content of this document. Output only the text.";
  if (mime.startsWith("video/")) return "Describe what happens in this video and transcribe any speech.";
  return "Describe the content of this file for a work-group digest.";
}

/** Multimodal extraction: transcribe/describe/extract media into text (Gemini inline data). */
export async function describeMedia(base64: string, mime: string): Promise<string> {
  if (!aiEnabled) return `[media ${mime} — AI disabled on the Gateway]`;
  try {
    const result = await getModel().generateContent([
      { inlineData: { data: base64, mimeType: mime } },
      { text: mediaInstruction(mime) },
    ]);
    return result.response.text().trim();
  } catch (err) {
    return `[AI error: ${(err as Error).message}]`;
  }
}
