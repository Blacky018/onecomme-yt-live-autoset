export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 10_000;

export interface JsonResponse {
  status: number;
  body: unknown;
}

// JSON を送受信する。通信エラー・タイムアウトは例外（呼び出し側で network 扱い）
export async function requestJson(fetchFn: FetchLike, url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}
