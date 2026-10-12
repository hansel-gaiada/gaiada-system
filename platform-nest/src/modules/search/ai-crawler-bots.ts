// M5-P5b — the allow-list of known AI crawlers, with the documented source of each token.
//
// Only a request whose User-Agent contains one of these tokens (case-insensitive) is ever kept; every other
// request (humans, ordinary search bots, unknown bots) is dropped by the parser and never stored. What we keep
// is the bot's id from this list, never the User-Agent string itself.
//
// MAINTENANCE: vendors add and rename crawlers. Add an entry here with its documentation URL, and a sample line
// to ai-crawler-log.test.ts. The source URLs are the vendors' documentation pages as known when this was written; they were NOT fetched then, so re-check each on a maintenance pass. Entries marked [UNVERIFIED] have no vendor page we know of.
//
// `purpose` groups what the crawler does for a site owner: "training" (collected to train a model),
// "search" (builds an AI search index), "user" (fetches a page because a person asked an assistant to).
// Robots-only tokens (Google-Extended, Applebot-Extended) are control tokens in robots.txt: the vendor's normal
// crawler fetches the page and no request ever carries them as a User-Agent. They are listed with `uaToken: null`
// so the panel can explain them, and they can never be matched in a log.
export type AiCrawlerPurpose = "training" | "search" | "user" | "mixed";

export interface AiCrawlerBot {
  /** Stable id stored in the database and shown in the UI. */
  id: string;
  vendor: string;
  /** Substring of the User-Agent header (matched case-insensitively), or null for a robots-only token. */
  uaToken: string | null;
  purpose: AiCrawlerPurpose;
  /** Where the vendor documents the token (not re-fetched on 2026-10-12; re-check on the next maintenance pass). */
  source: string;
  /** Does the vendor publish IP ranges we can verify against? (The ranges themselves are NOT bundled: they change;
   *  see ai-crawler-verify.ts.) */
  publishesRanges: boolean;
}

export const AI_CRAWLERS: readonly AiCrawlerBot[] = [
  { id: "GPTBot", vendor: "OpenAI", uaToken: "GPTBot", purpose: "training", source: "https://platform.openai.com/docs/bots", publishesRanges: true },
  { id: "OAI-SearchBot", vendor: "OpenAI", uaToken: "OAI-SearchBot", purpose: "search", source: "https://platform.openai.com/docs/bots", publishesRanges: true },
  { id: "ChatGPT-User", vendor: "OpenAI", uaToken: "ChatGPT-User", purpose: "user", source: "https://platform.openai.com/docs/bots", publishesRanges: true },
  { id: "ClaudeBot", vendor: "Anthropic", uaToken: "ClaudeBot", purpose: "training", source: "https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler", publishesRanges: false },
  { id: "Claude-SearchBot", vendor: "Anthropic", uaToken: "Claude-SearchBot", purpose: "search", source: "https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler", publishesRanges: false },
  { id: "Claude-User", vendor: "Anthropic", uaToken: "Claude-User", purpose: "user", source: "https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler", publishesRanges: false },
  { id: "PerplexityBot", vendor: "Perplexity", uaToken: "PerplexityBot", purpose: "search", source: "https://docs.perplexity.ai/guides/bots", publishesRanges: true },
  { id: "Perplexity-User", vendor: "Perplexity", uaToken: "Perplexity-User", purpose: "user", source: "https://docs.perplexity.ai/guides/bots", publishesRanges: true },
  { id: "Google-Extended", vendor: "Google", uaToken: null, purpose: "training", source: "https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers (robots.txt token; the fetch is made by Googlebot)", publishesRanges: false },
  { id: "GoogleOther", vendor: "Google", uaToken: "GoogleOther", purpose: "mixed", source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers", publishesRanges: true },
  { id: "Google-CloudVertexBot", vendor: "Google", uaToken: "Google-CloudVertexBot", purpose: "user", source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers", publishesRanges: true },
  { id: "Applebot", vendor: "Apple", uaToken: "Applebot", purpose: "search", source: "https://support.apple.com/en-us/119829", publishesRanges: true },
  { id: "Applebot-Extended", vendor: "Apple", uaToken: null, purpose: "training", source: "https://support.apple.com/en-us/119829 (robots.txt token; the fetch is made by Applebot)", publishesRanges: false },
  { id: "Bytespider", vendor: "ByteDance", uaToken: "Bytespider", purpose: "training", source: "[UNVERIFIED] no vendor documentation found; the UA token is widely reported by site owners", publishesRanges: false },
  { id: "CCBot", vendor: "Common Crawl", uaToken: "CCBot", purpose: "training", source: "https://commoncrawl.org/ccbot", publishesRanges: true },
  { id: "Amazonbot", vendor: "Amazon", uaToken: "Amazonbot", purpose: "mixed", source: "https://developer.amazon.com/amazonbot", publishesRanges: false },
  { id: "meta-externalagent", vendor: "Meta", uaToken: "meta-externalagent", purpose: "training", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers", publishesRanges: false },
  { id: "meta-webindexer", vendor: "Meta", uaToken: "meta-webindexer", purpose: "search", source: "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers", publishesRanges: false },
  { id: "DuckAssistBot", vendor: "DuckDuckGo", uaToken: "DuckAssistBot", purpose: "user", source: "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot", publishesRanges: true },
  { id: "MistralAI-User", vendor: "Mistral", uaToken: "MistralAI-User", purpose: "user", source: "[UNVERIFIED] Mistral documents the token on its robots page; URL not re-checked", publishesRanges: true },
  { id: "cohere-ai", vendor: "Cohere", uaToken: "cohere-ai", purpose: "training", source: "[UNVERIFIED] no vendor documentation found; the UA token is widely reported by site owners", publishesRanges: false },
  { id: "Diffbot", vendor: "Diffbot", uaToken: "Diffbot", purpose: "training", source: "https://docs.diffbot.com/docs/getting-started-with-diffbot-crawler", publishesRanges: false },
  { id: "YouBot", vendor: "You.com", uaToken: "YouBot", purpose: "search", source: "https://about.you.com/youbot/", publishesRanges: false },
];

const BY_TOKEN: Array<{ lower: string; bot: AiCrawlerBot }> = AI_CRAWLERS
  .filter((b): b is AiCrawlerBot & { uaToken: string } => b.uaToken !== null)
  // Longest token first, so "Applebot" never shadows a more specific token added later.
  .sort((a, b) => b.uaToken.length - a.uaToken.length)
  .map((b) => ({ lower: b.uaToken.toLowerCase(), bot: b }));

/** The AI crawler a User-Agent claims to be, or null (a human, an ordinary search bot, an unknown bot). */
export function matchAiCrawler(userAgent: string): AiCrawlerBot | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const { lower, bot } of BY_TOKEN) if (ua.includes(lower)) return bot;
  return null;
}

export const AI_CRAWLER_IDS: ReadonlySet<string> = new Set(AI_CRAWLERS.map((b) => b.id));
