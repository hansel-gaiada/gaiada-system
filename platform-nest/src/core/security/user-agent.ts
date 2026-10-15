// DW-7h (FRONTEND-BFF-CONTRACT §52.6) — turns a user-agent string into `{browser, os, kind}` for the Connected page and
// the new-device alert. A small ordered rule table, no npm dependency: IT needs "Chrome on Windows" and "is this a phone",
// not a version matrix, and a library would add a supply-chain surface to a security view for that.
//
// Order is the whole trick. Almost every browser still says "Mozilla/5.0 ... Safari/537.36", and Chromium-based ones also
// say "Chrome/", so the specific tokens (Edge, Opera, Samsung) are tested BEFORE Chrome, and Chrome before Safari. The
// version is deliberately dropped: a browser update must not read as a new device (the alert keys on this triple).
//
// Honest limits: iPadOS 13+ Safari sends a macOS user agent, so an iPad reads as a Mac; Windows 10 and 11 share a token.
// Anything unrecognised is "Unknown", never a guess.

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export interface DeviceInfo {
  browser: string;
  os: string;
  kind: DeviceKind;
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, "Edge"],
  [/\b(?:OPR|OPT)\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows NT\b|\bWindows Phone\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

function kindOf(ua: string, os: string): DeviceKind {
  if (/\biPad\b|\bTablet\b/.test(ua)) return "tablet";
  // An Android phone says "Mobile"; an Android tablet leaves it out.
  if (os === "Android") return /\bMobile\b/.test(ua) ? "mobile" : "tablet";
  if (/\biPhone\b|\biPod\b|\bMobile\b/.test(ua)) return "mobile";
  if (os === "Windows" || os === "macOS" || os === "Linux" || os === "ChromeOS") return "desktop";
  return "unknown";
}

export function parseUserAgent(userAgent: string | null | undefined): DeviceInfo {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua.trim()) return { browser: "Unknown", os: "Unknown", kind: "unknown" };
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Unknown";
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? "Unknown";
  return { browser, os, kind: kindOf(ua, os) };
}

/** The identity the new-device alert compares: same browser on the same system and kind is the same device. */
export const deviceKey = (d: DeviceInfo): string => `${d.browser}|${d.os}|${d.kind}`;
