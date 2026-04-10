/** HTTP + JSON (Python `http_client.py` parity). */

const DEFAULT_UA = "polymarket-arbitrage-bot node (+https://polymarket.com)";

export async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; data: unknown }> {
  const { timeoutMs = 45_000, ...fetchInit } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchInit,
      signal: ctrl.signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "application/json",
        ...(fetchInit.headers as Record<string, string>),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 800)}`);
    }
    if (!text) return { status: res.status, data: null };
    return { status: res.status, data: JSON.parse(text) as unknown };
  } finally {
    clearTimeout(t);
  }
}
