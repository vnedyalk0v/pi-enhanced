import { classifyHttpError, ProviderError } from "./errors.ts";
import {
  normalizeFirecrawlCrawl,
  normalizeFirecrawlScrape,
  normalizeFirecrawlSearch,
  type CrawlResult,
  type ScrapeResult,
  type SearchResult,
} from "./normalize.ts";

const BASE_URL = "https://api.firecrawl.dev/v2";

export type FirecrawlClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class FirecrawlClient {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: FirecrawlClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    const limit = clampInt(options.limit, 1, 20, 5);
    const json = await this.requestJson("POST", "/search", {
      body: {
        query,
        limit,
        sources: [{ type: "web" }],
      },
      signal: options.signal,
    });
    const creditsUsed =
      typeof (json as { creditsUsed?: unknown }).creditsUsed === "number"
        ? (json as { creditsUsed: number }).creditsUsed
        : undefined;
    return normalizeFirecrawlSearch(query, json, creditsUsed);
  }

  async scrape(
    url: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ScrapeResult> {
    const json = await this.requestJson("POST", "/scrape", {
      body: {
        url,
        formats: [{ type: "markdown" }],
        onlyMainContent: true,
      },
      signal: options.signal,
    });
    return normalizeFirecrawlScrape(url, json);
  }

  async crawl(
    url: string,
    options: {
      limit?: number;
      maxWaitMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<CrawlResult> {
    const limit = clampInt(options.limit, 1, 50, 10);
    const maxWaitMs = options.maxWaitMs ?? 90_000;

    const started = await this.requestJson("POST", "/crawl", {
      body: {
        url,
        limit,
        scrapeOptions: {
          formats: [{ type: "markdown" }],
          onlyMainContent: true,
        },
      },
      signal: options.signal,
    });

    const id = String((started as { id?: unknown }).id ?? "");
    if (!id) {
      throw new ProviderError({
        kind: "unknown",
        message: "Firecrawl crawl did not return a job id",
        fallbackEligible: false,
      });
    }

    const deadline = Date.now() + maxWaitMs;
    let last: unknown = started;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw new Error("Crawl wait aborted");
      }
      last = await this.requestJson("GET", `/crawl/${encodeURIComponent(id)}`, {
        signal: options.signal,
      });
      const status = String((last as { status?: unknown }).status ?? "");
      if (status === "completed" || status === "failed" || status === "cancelled") {
        const result = normalizeFirecrawlCrawl(url, last);
        if (status !== "completed") {
          throw new ProviderError({
            kind: "unknown",
            message: `Firecrawl crawl ${status}`,
            fallbackEligible: false,
          });
        }
        return result;
      }
      await sleep(Math.min(1500, Math.max(100, Math.floor(maxWaitMs / 30))), options.signal);
    }

    throw new ProviderError({
      kind: "transient",
      message: `Firecrawl crawl timed out after ${maxWaitMs}ms (job ${id})`,
      fallbackEligible: false,
    });
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError(classifyHttpError(res.status, text));
    }

    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError({
        kind: "unknown",
        message: "Firecrawl returned non-JSON response",
        fallbackEligible: false,
      });
    }
  }
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.FIRECRAWL_API_KEY?.trim();
  return key || undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
