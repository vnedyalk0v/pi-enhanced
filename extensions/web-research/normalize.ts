export type SearchHit = {
  title: string;
  url: string;
  description: string;
};

export type SearchResult = {
  provider: string;
  query: string;
  results: SearchHit[];
  warning?: string;
  creditsUsed?: number;
};

export type ScrapeResult = {
  provider: string;
  url: string;
  title?: string;
  markdown: string;
  warning?: string;
};

export type CrawlPage = {
  url: string;
  title?: string;
  markdown: string;
};

export type CrawlResult = {
  provider: string;
  url: string;
  status: string;
  pages: CrawlPage[];
  total?: number;
  completed?: number;
  creditsUsed?: number;
  warning?: string;
};

export function normalizeFirecrawlSearch(
  query: string,
  raw: unknown,
  creditsUsed?: number,
): SearchResult {
  // v2: { success, data: { web: [...] }, creditsUsed?, warning? }
  const root = asRecord(raw) ?? {};
  const nested = asRecord(root.data);
  const list = Array.isArray(nested?.web)
    ? nested.web
    : Array.isArray(root.web)
      ? root.web
      : Array.isArray(raw)
        ? raw
        : [];

  const results: SearchHit[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const url = stringField(row, "url") || stringField(row, "link");
    if (!url) continue;
    const description =
      stringField(row, "description") ||
      stringField(row, "snippet") ||
      stringField(row, "markdown").slice(0, 300);
    results.push({
      title: stringField(row, "title") || url,
      url,
      description,
    });
  }

  const warning =
    typeof root.warning === "string"
      ? root.warning
      : typeof nested?.warning === "string"
        ? nested.warning
        : undefined;

  return {
    provider: "firecrawl",
    query,
    results,
    warning,
    creditsUsed,
  };
}

export function normalizeFirecrawlScrape(url: string, raw: unknown): ScrapeResult {
  const root = asRecord(raw);
  const data = asRecord(root?.data) ?? root ?? {};
  const meta = asRecord(data.metadata);
  const title = meta ? stringField(meta, "title") : undefined;
  const markdown =
    stringField(data, "markdown") ||
    stringField(data, "summary") ||
    stringField(data, "html") ||
    "";

  return {
    provider: "firecrawl",
    url: stringField(data, "url") || stringField(meta ?? {}, "sourceURL") || url,
    title: title || undefined,
    markdown,
    warning: typeof root?.warning === "string" ? root.warning : undefined,
  };
}

export function normalizeFirecrawlCrawl(url: string, statusPayload: unknown): CrawlResult {
  const root = asRecord(statusPayload) ?? {};
  const status = stringField(root, "status") || "unknown";
  const data = Array.isArray(root.data) ? root.data : [];
  const pages: CrawlPage[] = [];

  for (const item of data) {
    const row = asRecord(item);
    if (!row) continue;
    const meta = asRecord(row.metadata);
    const pageUrl =
      stringField(row, "url") ||
      (meta ? stringField(meta, "sourceURL") || stringField(meta, "url") : "") ||
      "";
    if (!pageUrl) continue;
    pages.push({
      url: pageUrl,
      title: meta ? stringField(meta, "title") || undefined : undefined,
      markdown: stringField(row, "markdown") || "",
    });
  }

  return {
    provider: "firecrawl",
    url,
    status,
    pages,
    total: typeof root.total === "number" ? root.total : undefined,
    completed: typeof root.completed === "number" ? root.completed : undefined,
    creditsUsed: typeof root.creditsUsed === "number" ? root.creditsUsed : undefined,
  };
}

export function normalizeFallbackSearch(query: string, hits: SearchHit[]): SearchResult {
  return {
    provider: "duckduckgo",
    query,
    results: hits,
    warning: "Firecrawl unavailable or quota exhausted; used no-key DuckDuckGo fallback.",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}
