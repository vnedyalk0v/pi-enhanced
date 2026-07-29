import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { SearchHit, SearchResult } from "./normalize.ts";
import { normalizeFallbackSearch } from "./normalize.ts";
import { readResponseText, withResponseTimeout } from "./response.ts";

export const DUCKDUCKGO_MAX_RESPONSE_BYTES = DEFAULT_MAX_BYTES * 20;

/**
 * No-key web search via DuckDuckGo HTML results.
 * Deliberately narrow: search only (no scrape/crawl).
 */
export async function duckDuckGoSearch(
  query: string,
  options: { limit?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult> {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = withResponseTimeout(options.signal);
  const url =
    "https://html.duckduckgo.com/html/?" +
    new URLSearchParams({ q: query }).toString();

  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "text/html",
      "User-Agent": "pi-enhanced-web-research/0.1 (+https://github.com/vnedyalk0v/pi-enhanced)",
    },
    signal,
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  }

  const html = await readResponseText(res, DUCKDUCKGO_MAX_RESPONSE_BYTES, "DuckDuckGo", signal);
  const hits = parseDuckDuckGoHtml(html, limit);
  if (hits.length === 0) {
    throw new Error("DuckDuckGo search returned no parseable results");
  }
  return normalizeFallbackSearch(query, hits);
}

/** Exported for unit tests. */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // Classic DDG HTML layout: result__a then nearby result__snippet
  const linkRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null && hits.length < limit) {
    const rawHref = decodeHtml(match[1] ?? "");
    const title = stripTags(decodeHtml(match[2] ?? "")).trim();
    const url = unwrapDuckDuckGoRedirect(rawHref);
    if (!url || !title) continue;

    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
    const snip = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i);
    const description = snip ? stripTags(decodeHtml(snip[1] ?? "")).trim() : "";
    hits.push({ title, url, description });
  }

  // Fallback: looser link scrape if class names change
  if (hits.length === 0) {
    const linkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRe.exec(html)) !== null && hits.length < limit) {
      const url = match[1] ?? "";
      const title = stripTags(decodeHtml(match[2] ?? "")).trim();
      if (!url || !title) continue;
      if (/duckduckgo\.com/i.test(url)) continue;
      hits.push({ title, url, description: "" });
    }
  }

  return hits;
}

function unwrapDuckDuckGoRedirect(href: string): string {
  try {
    const u = new URL(href, "https://html.duckduckgo.com");
    if (u.pathname.includes("/l/") && u.searchParams.has("uddg")) {
      return u.searchParams.get("uddg") || href;
    }
    return u.href;
  } catch {
    return href;
  }
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
