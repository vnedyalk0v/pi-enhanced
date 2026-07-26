import { classifyHttpError, throwClassified } from "./errors.ts";
import {
  normalizeFirecrawlCrawl,
  normalizeFirecrawlScrape,
  normalizeFirecrawlSearch,
  type CrawlResult,
  type ScrapeResult,
  type SearchResult,
} from "./normalize.ts";

const BASE_URL = "https://api.firecrawl.dev/v2";

export type FirecrawlOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export async function firecrawlSearch(
  options: FirecrawlOptions & { query: string; limit?: number; signal?: AbortSignal },
): Promise<SearchResult> {
  const limit = clampInt(options.limit, 1, 20, 5);
  const json = await requestJson(options, "POST", "/search", {
    body: {
      query: options.query,
      limit,
      sources: [{ type: "web" }],
    },
    signal: options.signal,
  });
  const creditsUsed =
    typeof (json as { creditsUsed?: unknown }).creditsUsed === "number"
      ? (json as { creditsUsed: number }).creditsUsed
      : undefined;
  return normalizeFirecrawlSearch(options.query, json, creditsUsed);
}

export async function firecrawlScrape(
  options: FirecrawlOptions & { url: string; signal?: AbortSignal },
): Promise<ScrapeResult> {
  const json = await requestJson(options, "POST", "/scrape", {
    body: {
      url: options.url,
      formats: [{ type: "markdown" }],
      onlyMainContent: true,
    },
    signal: options.signal,
  });
  return normalizeFirecrawlScrape(options.url, json);
}

export async function firecrawlCrawl(
  options: FirecrawlOptions & {
    url: string;
    limit?: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
  },
): Promise<CrawlResult> {
  const limit = clampInt(options.limit, 1, 50, 10);
  const maxWaitMs = options.maxWaitMs ?? 90_000;

  const started = await requestJson(options, "POST", "/crawl", {
    body: {
      url: options.url,
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
    throwClassified({
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
    last = await requestJson(options, "GET", `/crawl/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
    const status = String((last as { status?: unknown }).status ?? "");
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const result = normalizeFirecrawlCrawl(options.url, last);
      if (status !== "completed") {
        throwClassified({
          kind: "unknown",
          message: `Firecrawl crawl ${status}`,
          fallbackEligible: false,
        });
      }
      return result;
    }
    await sleep(Math.min(1500, Math.max(100, Math.floor(maxWaitMs / 30))), options.signal);
  }

  throwClassified({
    kind: "transient",
    message: `Firecrawl crawl timed out after ${maxWaitMs}ms (job ${id})`,
    fallbackEligible: false,
  });
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.FIRECRAWL_API_KEY?.trim();
  return key || undefined;
}

async function requestJson(
  options: FirecrawlOptions,
  method: "GET" | "POST",
  path: string,
  req: { body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    signal: req.signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throwClassified(classifyHttpError(res.status, text));
  }

  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throwClassified({
      kind: "unknown",
      message: "Firecrawl returned non-JSON response",
      fallbackEligible: false,
    });
  }
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
