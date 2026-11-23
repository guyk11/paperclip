import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { AI_KEY_VERIFICATION_FAILURES, type AiKeyVerificationFailure } from "./ai-api-key-failures.js";

const PROVIDER_ERROR_TYPE_RE = /^[A-Za-z_]{1,48}$/;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const BILLING_ERROR_TYPES = new Set(["billing_error", "insufficient_quota", "insufficient_credits"]);

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES).toString("utf8");
}

async function providerErrorType(response: Response, key: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedBody(response));
  } catch {
    return null;
  }
  const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return null;
  const { type, code, status } = error as { type?: unknown; code?: unknown; status?: unknown };
  for (const candidate of [type, code, status]) {
    if (typeof candidate === "string" && PROVIDER_ERROR_TYPE_RE.test(candidate) && !key.includes(candidate)) return candidate;
  }
  return null;
}

function classify(status: number, errorType: string | null): AiKeyVerificationFailure {
  if (status === 401 || status === 403) return "rejected";
  if (status === 402 || (errorType !== null && BILLING_ERROR_TYPES.has(errorType))) return "billing";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "unavailable";
  return "failed";
}

function fail(failure: AiKeyVerificationFailure): never {
  const { code, message } = AI_KEY_VERIFICATION_FAILURES[failure];
  throw unprocessable(message, { code });
}

/** Fixed provider endpoints; credentials are never sent to a caller-supplied URL or through a redirect. */
export async function validateAiApiKey(
  provider: AiProvider,
  key: string,
  request: typeof fetch = fetch,
) {
  if (provider === "github") throw unprocessable("Copilot requires verification in the selected execution environment.", { code: "copilot_environment_required" });
  const endpoints = {
    anthropic: "https://api.anthropic.com/v1/models?limit=1",
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
    google: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
  };
  let response: Response;
  try {
    response = await request(endpoints[provider], {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers:
        provider === "google" ? { "x-goog-api-key": key } : provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause as { code?: unknown } : undefined;
    logger.warn({ provider, networkError: timedOut ? "timeout" : typeof cause?.code === "string" ? cause.code : "request_failed" },
      "AI provider API key verification request failed");
    fail(timedOut ? "timeout" : "unreachable");
  }
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const errorType = response.status === 401 || response.status === 403 ? null : await providerErrorType(response, key);
  if (response.status === 401 || response.status === 403) await response.body?.cancel();
  const failure = classify(response.status, errorType);
  logger.warn({ provider, status: response.status, providerErrorType: errorType, failure: AI_KEY_VERIFICATION_FAILURES[failure].code },
    "AI provider did not verify an API key");
  fail(failure);
}
