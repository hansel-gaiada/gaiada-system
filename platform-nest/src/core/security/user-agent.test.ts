// DW-7h — the user-agent rule table, against real strings from real browsers. The order of the rules is what these pin:
// Edge and Opera and Samsung also say "Chrome/" and "Safari/", and every Chromium browser says "Safari/".
import { describe, it, expect } from "vitest";
import { parseUserAgent, deviceKey } from "./user-agent";

const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  chromeIosIpad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  operaWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

describe("parseUserAgent", () => {
  it("Chrome on Windows is a desktop", () => {
    expect(parseUserAgent(UA.chromeWindows)).toEqual({ browser: "Chrome", os: "Windows", kind: "desktop" });
  });
  it("Safari on an iPhone is a mobile, not 'Chrome' or 'Mac'", () => {
    expect(parseUserAgent(UA.safariIphone)).toEqual({ browser: "Safari", os: "iOS", kind: "mobile" });
  });
  it("Firefox on Linux is a desktop (the X11 token, not a Windows or Mac one)", () => {
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({ browser: "Firefox", os: "Linux", kind: "desktop" });
  });
  it("Edge says Chrome and Safari as well, and is still Edge", () => {
    expect(parseUserAgent(UA.edgeWindows)).toEqual({ browser: "Edge", os: "Windows", kind: "desktop" });
  });
  it("an Android without 'Mobile' is a tablet, with it a phone", () => {
    expect(parseUserAgent(UA.androidTablet)).toEqual({ browser: "Chrome", os: "Android", kind: "tablet" });
    expect(parseUserAgent(UA.androidPhone)).toEqual({ browser: "Chrome", os: "Android", kind: "mobile" });
  });
  it("Safari on a Mac, Chrome on an iPad (CriOS), Samsung Internet, Opera and Chrome OS", () => {
    expect(parseUserAgent(UA.safariMac)).toEqual({ browser: "Safari", os: "macOS", kind: "desktop" });
    expect(parseUserAgent(UA.chromeIosIpad)).toEqual({ browser: "Chrome", os: "iOS", kind: "tablet" });
    expect(parseUserAgent(UA.samsung)).toEqual({ browser: "Samsung Internet", os: "Android", kind: "mobile" });
    expect(parseUserAgent(UA.operaWindows)).toEqual({ browser: "Opera", os: "Windows", kind: "desktop" });
    expect(parseUserAgent(UA.chromeOs)).toEqual({ browser: "Chrome", os: "ChromeOS", kind: "desktop" });
  });
  it("junk, empty and missing user agents are Unknown, never a guess", () => {
    for (const junk of ["", "   ", null, undefined, "curl/8.5.0", "💥 not a browser", "Mozilla/5.0"]) {
      expect(parseUserAgent(junk as string | null | undefined)).toEqual({ browser: "Unknown", os: "Unknown", kind: "unknown" });
    }
  });
  it("a browser update is the same device (the version is not part of the key)", () => {
    const a = parseUserAgent(UA.chromeWindows);
    const b = parseUserAgent(UA.chromeWindows.replace("141.0.0.0", "142.0.0.0"));
    expect(deviceKey(a)).toBe(deviceKey(b));
    expect(deviceKey(a)).not.toBe(deviceKey(parseUserAgent(UA.edgeWindows)));
  });
  it("a very long user agent is cut, not rejected", () => {
    expect(parseUserAgent(UA.chromeWindows + " x".repeat(5000)).browser).toBe("Chrome");
  });
});
