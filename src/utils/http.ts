// ============================================================
// CIAS - HTTP fetch utilities with timeout and retry
// ============================================================

/**
 * Fetch with timeout. Aborts the request if it takes longer than timeoutMs.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch with timeout and exponential backoff retry.
 * Retries on network errors and 429/5xx responses.
 * Does NOT retry on 4xx (except 429) as those are likely permanent failures.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10_000,
  maxRetries: number = 2,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);

      // Retry on 429 (rate limit) or 5xx (server error)
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[HTTP] ${resp.status} on attempt ${attempt + 1}/${maxRetries + 1} for ${url}, retrying in ${backoffMs}ms`);
          await sleep(backoffMs);
          continue;
        }
      }

      return resp;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[HTTP] Network error on attempt ${attempt + 1}/${maxRetries + 1} for ${url}: ${lastError.message}, retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
    }
  }

  throw lastError ?? new Error(`fetchWithRetry: exhausted ${maxRetries + 1} attempts for ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
