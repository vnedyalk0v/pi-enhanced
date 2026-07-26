export type ProviderErrorKind =
  | "quota"
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "transient"
  | "unknown";

export type ClassifiedError = {
  kind: ProviderErrorKind;
  status?: number;
  message: string;
  /** True when search should try a no-key fallback. */
  fallbackEligible: boolean;
};

const QUOTA_RE =
  /insufficient credits|credit.?limit|quota|payment required|out of credits|no credits|plan limit|upgrade your plan|402/i;
const AUTH_RE = /unauthorized|invalid.?api.?key|api key|authentication|forbidden/i;
const RATE_RE = /rate limit|too many requests|429/i;
const BAD_RE = /bad request|invalid|validation|malformed|400/i;

/**
 * Classify Firecrawl (or similar) HTTP failures.
 * Quota exhaustion is distinct from auth, rate limits, and bad requests.
 */
export function classifyHttpError(status: number, bodyText: string): ClassifiedError {
  const message = extractErrorMessage(bodyText) || `HTTP ${status}`;

  if (status === 402 || QUOTA_RE.test(bodyText) || QUOTA_RE.test(message)) {
    return {
      kind: "quota",
      status,
      message: message || "Firecrawl quota exhausted",
      fallbackEligible: true,
    };
  }
  if (status === 401 || status === 403) {
    // Some gateways misuse 403 for quota; still check body first (above).
    if (AUTH_RE.test(bodyText) || AUTH_RE.test(message) || status === 401) {
      return {
        kind: "auth",
        status,
        message: message || "Authentication failed",
        fallbackEligible: false,
      };
    }
  }
  if (status === 429 || RATE_RE.test(bodyText)) {
    return {
      kind: "rate_limit",
      status,
      message: message || "Rate limit exceeded",
      fallbackEligible: false,
    };
  }
  if (status === 400 || status === 422 || BAD_RE.test(message)) {
    return {
      kind: "bad_request",
      status,
      message: message || "Invalid request",
      fallbackEligible: false,
    };
  }
  if (status >= 500 || status === 408) {
    return {
      kind: "transient",
      status,
      message: message || "Transient provider error",
      fallbackEligible: false,
    };
  }
  return {
    kind: "unknown",
    status,
    message,
    fallbackEligible: false,
  };
}

export function classifyThrown(error: unknown): ClassifiedError {
  if (error && typeof error === "object" && "kind" in error && "fallbackEligible" in error) {
    return error as ClassifiedError;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (QUOTA_RE.test(message)) {
    return { kind: "quota", message, fallbackEligible: true };
  }
  if (AUTH_RE.test(message)) {
    return { kind: "auth", message, fallbackEligible: false };
  }
  if (RATE_RE.test(message)) {
    return { kind: "rate_limit", message, fallbackEligible: false };
  }
  return { kind: "unknown", message, fallbackEligible: false };
}

function extractErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as { error?: unknown; message?: unknown; code?: unknown };
    if (typeof json.error === "string" && json.error.trim()) return json.error.trim();
    if (typeof json.message === "string" && json.message.trim()) return json.message.trim();
    if (typeof json.code === "string" && json.code.trim()) return json.code.trim();
  } catch {
    // plain text body
  }
  return trimmed.slice(0, 500);
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly fallbackEligible: boolean;

  constructor(classified: ClassifiedError) {
    super(classified.message);
    this.name = "ProviderError";
    this.kind = classified.kind;
    this.status = classified.status;
    this.fallbackEligible = classified.fallbackEligible;
  }
}
