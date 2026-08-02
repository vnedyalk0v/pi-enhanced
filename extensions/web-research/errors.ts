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

// Bare status-code digits deliberately excluded: matched as unanchored substrings
// against arbitrary provider body text, "40284" or "ref id 4029384" would false-hit.
// The real HTTP status is already checked directly in classifyHttpError.
const QUOTA_RE =
  /insufficient credits|credit.?limit|quota|payment required|out of credits|no credits|plan limit|upgrade your plan/i;
const AUTH_RE = /unauthorized|invalid.?api.?key|api key|authentication|forbidden/i;
const RATE_RE = /rate limit|too many requests/i;
const BAD_RE = /bad request|invalid|validation|malformed/i;

/**
 * Classify Firecrawl (or similar) HTTP failures.
 * Quota exhaustion is distinct from auth, rate limits, and bad requests.
 */
export function classifyHttpError(status: number, bodyText: string): ClassifiedError {
  const message = extractErrorMessage(bodyText) || `HTTP ${status}`;

  // Rate limit wins over quota keywords: real 429 bodies often say "upgrade
  // your plan", and the documented contract is that rate limits never fall back.
  if (status === 429 || RATE_RE.test(bodyText)) {
    return { kind: "rate_limit", status, message, fallbackEligible: false };
  }
  if (status === 402 || QUOTA_RE.test(bodyText) || QUOTA_RE.test(message)) {
    return { kind: "quota", status, message, fallbackEligible: true };
  }
  if (status === 401) {
    return { kind: "auth", status, message, fallbackEligible: false };
  }
  // 403 is ambiguous across gateways (auth vs. other denial) — only claim "auth"
  // when the body confirms it; otherwise fall through to the checks below.
  if (status === 403 && (AUTH_RE.test(bodyText) || AUTH_RE.test(message))) {
    return { kind: "auth", status, message, fallbackEligible: false };
  }
  if (status === 400 || status === 422 || BAD_RE.test(message)) {
    return { kind: "bad_request", status, message, fallbackEligible: false };
  }
  if (status >= 500 || status === 408) {
    return { kind: "transient", status, message, fallbackEligible: false };
  }
  return {
    kind: "unknown",
    status,
    message,
    fallbackEligible: false,
  };
}

export function classifyThrown(error: unknown): ClassifiedError {
  if (isClassifiedError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (RATE_RE.test(message)) {
    return { kind: "rate_limit", message, fallbackEligible: false };
  }
  if (QUOTA_RE.test(message)) {
    return { kind: "quota", message, fallbackEligible: true };
  }
  if (AUTH_RE.test(message)) {
    return { kind: "auth", message, fallbackEligible: false };
  }
  return { kind: "unknown", message, fallbackEligible: false };
}

export function isClassifiedError(error: unknown): error is ClassifiedError {
  return (
    !!error &&
    typeof error === "object" &&
    "kind" in error &&
    "fallbackEligible" in error &&
    "message" in error &&
    typeof (error as ClassifiedError).message === "string"
  );
}

/** Throw a ClassifiedError-shaped Error for catch paths that use classifyThrown. */
export function throwClassified(classified: ClassifiedError): never {
  const err = new Error(classified.message) as Error & ClassifiedError;
  err.kind = classified.kind;
  err.status = classified.status;
  err.fallbackEligible = classified.fallbackEligible;
  throw err;
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
