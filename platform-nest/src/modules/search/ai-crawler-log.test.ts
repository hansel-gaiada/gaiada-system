// M5-P5b — the AI-crawler log parser, aggregator and verifier. Pure: no database, no network.
import { describe, it, expect } from "vitest";
import { AI_CRAWLERS, matchAiCrawler } from "./ai-crawler-bots";
import { aggregateAiCrawlerLog, cleanPath, parseAccessLogLine } from "./ai-crawler-log";
import { createRangeVerifier, verifierFromEnv } from "./ai-crawler-verify";
import { chunkHash } from "./ai-crawler-store";
import { AI_CRAWLER_MCP_TOOLS } from "./ai-crawler-mcp-tools";

const NOW = new Date("2026-10-12T12:00:00Z");
const HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// nginx "combined" (infra/nginx/*.conf: $remote_addr - $remote_user [$time_local] "$request" $status $bytes "$referer" "$ua")
const line = (ip: string, ua: string, path = "/pricing/", status = 200, time = "11/Oct/2026:13:55:36 +0000", method = "GET") =>
  `${ip} - - [${time}] "${method} ${path} HTTP/1.1" ${status} 5120 "-" "${ua}"`;

// Real user-agent strings as the vendors document them.
const UA: Record<string, string> = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Claude-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)",
  "Claude-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Perplexity-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  GoogleOther: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)",
  "Google-CloudVertexBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-CloudVertexBot; +http://www.google.com/bot.html) Chrome/126.0.0.0 Safari/537.36",
  Applebot: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  Bytespider: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  CCBot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  Amazonbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36",
  "meta-externalagent": "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "meta-webindexer": "meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  DuckAssistBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; DuckAssistBot/1.2; +http://duckduckgo.com/duckassistbot.html)",
  "MistralAI-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
  "cohere-ai": "cohere-ai",
  Diffbot: "Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)",
  YouBot: "Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)",
};

describe("the allow-list", () => {
  it("every entry with a UA token is recognised from a real UA, and each has a documented source", () => {
    for (const b of AI_CRAWLERS) {
      expect(b.source.length, b.id).toBeGreaterThan(5);
      if (b.uaToken === null) continue;
      expect(UA[b.id], `${b.id} needs a sample UA in this test`).toBeDefined();
      expect(matchAiCrawler(UA[b.id])?.id, b.id).toBe(b.id);
    }
  });
  it("Google-Extended and Applebot-Extended are robots-only tokens: listed, but never matched in a log", () => {
    const ro = AI_CRAWLERS.filter((b) => b.uaToken === null).map((b) => b.id).sort();
    expect(ro).toEqual(["Applebot-Extended", "Google-Extended"]);
    expect(matchAiCrawler("Mozilla/5.0 (compatible; Google-Extended)")).toBeNull();
  });
  it("humans, Googlebot and an empty UA are not AI crawlers", () => {
    expect(matchAiCrawler(HUMAN_UA)).toBeNull();
    expect(matchAiCrawler("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBeNull();
    expect(matchAiCrawler("")).toBeNull();
  });
  it("matching is case-insensitive", () => {
    expect(matchAiCrawler("gptbot/1.1")?.id).toBe("GPTBot");
  });
});

describe("parseAccessLogLine", () => {
  it("parses nginx combined, converts the time zone to UTC and strips the query string", () => {
    const p = parseAccessLogLine(line("203.0.113.9", UA.GPTBot, "/blog/post/?utm_source=x&email=a@b.c", 200, "11/Oct/2026:23:30:00 -0200"));
    expect(p).toMatchObject({ method: "GET", path: "/blog/post/", status: 200 });
    expect(p!.at.toISOString()).toBe("2026-10-12T01:30:00.000Z");
  });
  it("parses a Caddy JSON access-log line", () => {
    const j = JSON.stringify({ level: "info", ts: 1760187336.5, logger: "http.log.access", msg: "handled request",
      request: { remote_ip: "203.0.113.9", method: "GET", uri: "/a/?q=1", headers: { "User-Agent": [UA.ClaudeBot] } }, status: 404 });
    const p = parseAccessLogLine(j);
    expect(p).toMatchObject({ path: "/a/", status: 404, method: "GET" });
    expect(matchAiCrawler(p!.userAgent)?.id).toBe("ClaudeBot");
  });
  it("returns null for garbage, partial lines and bad statuses", () => {
    expect(parseAccessLogLine("")).toBeNull();
    expect(parseAccessLogLine("not a log line")).toBeNull();
    expect(parseAccessLogLine("{broken json")).toBeNull();
    expect(parseAccessLogLine(line("1.2.3.4", "x", "/a", 200).replace(" 200 ", " 999 "))).toBeNull();
    expect(parseAccessLogLine('1.2.3.4 - - [11/Oct/2026:13:55:36 +0000] "BADREQUEST" 200 1 "-" "x"')).toBeNull();
  });
  it("cleanPath: absolute-form targets, fragments, non-paths and over-long paths", () => {
    expect(cleanPath("http://example.com/a/b?x=1#f")).toBe("/a/b");
    expect(cleanPath("*")).toBeNull();
    expect(cleanPath("/a\u0001b")).toBeNull();
    expect(cleanPath("/" + "a".repeat(600))!.length).toBe(512);
  });
});

describe("aggregateAiCrawlerLog", () => {
  it("drops human requests entirely and keeps each listed bot", async () => {
    const lines = [
      line("198.51.100.1", HUMAN_UA),
      line("198.51.100.2", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
      ...Object.entries(UA).map(([, ua]) => line("203.0.113.5", ua)),
    ].join("\n");
    const r = await aggregateAiCrawlerLog(lines, { now: NOW });
    expect(r.stats).toMatchObject({ linesSeen: 2 + Object.keys(UA).length, dropped: 2, kept: Object.keys(UA).length, malformed: 0 });
    expect(r.rows.map((x) => x.bot).sort()).toEqual(Object.keys(UA).sort());
  });

  it("aggregates per (day, bot, path, status) and counts repeats", async () => {
    const lines = [
      line("203.0.113.5", UA.GPTBot, "/a/", 200),
      line("203.0.113.6", UA.GPTBot, "/a/?x=1", 200),
      line("203.0.113.5", UA.GPTBot, "/a/", 403),
      line("203.0.113.5", UA.GPTBot, "/a/", 200, "10/Oct/2026:01:00:00 +0000"),
      line("203.0.113.5", UA.GPTBot, "/a/", 200, "11/Oct/2026:13:00:00 +0000", "POST"),
    ].join("\r\n");
    const r = await aggregateAiCrawlerLog(lines, { now: NOW });
    const k = (day: string, status: number) => r.rows.find((x) => x.day === day && x.status === status && x.path === "/a/");
    expect(k("2026-10-11", 200)?.hits).toBe(2);
    expect(k("2026-10-11", 403)?.hits).toBe(1);
    expect(k("2026-10-10", 200)?.hits).toBe(1);
    expect(r.rows).toHaveLength(3);
    expect(r.stats.dropped).toBe(1); // the POST
  });

  it("never carries an IP, a User-Agent or a raw line in its output", async () => {
    const lines = [line("203.0.113.77", UA.ClaudeBot, "/x/?token=secret"), line("198.51.100.99", HUMAN_UA, "/y/?email=a@b.c")].join("\n");
    const r = await aggregateAiCrawlerLog(lines, { now: NOW });
    const out = JSON.stringify(r);
    for (const bad of ["203.0.113.77", "198.51.100.99", "Mozilla", "AppleWebKit", "token=secret", "email=", "claudebot@anthropic.com", "/y/"]) {
      expect(out, bad).not.toContain(bad);
    }
    expect(Object.keys(r.rows[0]).sort()).toEqual(["bot", "day", "hits", "path", "status", "verification"]);
  });

  it("without a verifier every row is 'claimed'", async () => {
    const r = await aggregateAiCrawlerLog(line("203.0.113.5", UA.GPTBot), { now: NOW });
    expect(r.rows[0].verification).toBe("claimed");
  });

  it("with verification on, a spoofed claim is 'unverified' and a genuine one 'verified'; the two are separate rows", async () => {
    const verifier = createRangeVerifier({ GPTBot: ["203.0.113.0/24", "2001:db8:abcd::/48"], ClaudeBot: [] });
    const lines = [
      line("203.0.113.5", UA.GPTBot),          // inside
      line("2001:db8:abcd::1", UA.GPTBot),     // inside (IPv6)
      line("198.51.100.200", UA.GPTBot),       // outside: spoof
      line("::ffff:203.0.113.9", UA.GPTBot),   // mapped IPv4, inside
      line("198.51.100.201", UA.ClaudeBot),    // no ranges for this bot: claimed
    ].join("\n");
    const r = await aggregateAiCrawlerLog(lines, { now: NOW, verifier });
    const get = (bot: string, v: string) => r.rows.find((x) => x.bot === bot && x.verification === v)?.hits;
    expect(get("GPTBot", "verified")).toBe(3);
    expect(get("GPTBot", "unverified")).toBe(1);
    expect(get("ClaudeBot", "claimed")).toBe(1);
  });

  it("a verifier that throws marks the row unverified instead of failing the chunk", async () => {
    const r = await aggregateAiCrawlerLog(line("203.0.113.5", UA.GPTBot), { now: NOW, verifier: () => { throw new Error("dns down"); } });
    expect(r.rows[0].verification).toBe("unverified");
  });

  it("asks the verifier once per distinct (ip, bot)", async () => {
    let n = 0;
    await aggregateAiCrawlerLog([line("203.0.113.5", UA.GPTBot, "/a"), line("203.0.113.5", UA.GPTBot, "/b")].join("\n"), {
      now: NOW, verifier: () => { n++; return "verified"; },
    });
    expect(n).toBe(1);
  });

  it("counts malformed and out-of-range lines and keeps going", async () => {
    const lines = ["garbage", line("203.0.113.5", UA.GPTBot, "/old", 200, "01/Jan/2020:00:00:00 +0000"),
      line("203.0.113.5", UA.GPTBot, "/future", 200, "01/Jan/2030:00:00:00 +0000"), line("203.0.113.5", UA.GPTBot)].join("\n");
    const r = await aggregateAiCrawlerLog(lines, { now: NOW });
    expect(r.stats).toMatchObject({ malformed: 1, outOfRange: 2, kept: 1 });
  });

  it("an empty chunk is an empty result", async () => {
    const r = await aggregateAiCrawlerLog("\n\n", { now: NOW });
    expect(r.rows).toEqual([]);
    expect(r.stats.linesSeen).toBe(0);
  });
});

describe("createRangeVerifier / verifierFromEnv", () => {
  const gpt = AI_CRAWLERS.find((b) => b.id === "GPTBot")!;
  it("no IP for a bot with ranges is unverified; a bot without ranges is claimed", () => {
    const v = createRangeVerifier({ GPTBot: ["203.0.113.0/24"] });
    expect(v(null, gpt)).toBe("unverified");
    expect(v("not-an-ip", gpt)).toBe("unverified");
    expect(v("203.0.113.1", AI_CRAWLERS.find((b) => b.id === "CCBot")!)).toBe("claimed");
  });
  it("ignores malformed CIDRs rather than throwing", () => {
    const v = createRangeVerifier({ GPTBot: ["nope", "203.0.113.0/99", "203.0.113.7"] });
    expect(v("203.0.113.7", gpt)).toBe("verified");
    expect(v("203.0.113.8", gpt)).toBe("unverified");
  });
  it("verifierFromEnv: off without the variable, off (not a crash) with a missing file", () => {
    expect(verifierFromEnv({})).toBeUndefined();
    expect(verifierFromEnv({ AI_CRAWLER_RANGES_FILE: "/nonexistent/ranges.json" })).toBeUndefined();
  });
});

describe("chunkHash", () => {
  it("is stable across CRLF, a trailing newline and blank lines, and differs for different content", () => {
    expect(chunkHash("a\nb\n")).toBe(chunkHash("a\r\nb"));
    expect(chunkHash("a\n\nb")).toBe(chunkHash("a\nb"));
    expect(chunkHash("a\nb")).not.toBe(chunkHash("a\nc"));
    expect(chunkHash("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("MCP tools", () => {
  it("ingest is a MEDIUM write; the reads carry no impact", () => {
    const by = new Map(AI_CRAWLER_MCP_TOOLS.map((t) => [t.name, t]));
    expect(by.get("search.aiCrawlers.ingest")).toMatchObject({ write: true, impact: "medium", method: "POST", minAssurance: "verified" });
    for (const n of ["search.aiCrawlers.summary", "search.aiVisibility.summary"]) {
      expect(by.get(n)?.write).not.toBe(true);
      expect(by.get(n)?.impact).toBeUndefined();
    }
    for (const t of AI_CRAWLER_MCP_TOOLS) {
      const inputs = Object.keys((t.inputSchema as { properties: object }).properties);
      for (const m of (t.pathTemplate ?? "").matchAll(/:(\w+)/g)) expect(inputs, `${t.name} :${m[1]}`).toContain(m[1]);
    }
  });
});
