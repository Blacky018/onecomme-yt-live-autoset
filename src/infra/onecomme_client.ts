import { err, isRecord, ok, type Result } from "../domain/result";
import { requestJson, type FetchLike } from "./http";

export interface OneCommeService {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export type OneCommeError = "network" | "not-found" | "bad-response" | "http";

const BASE = "http://127.0.0.1:11180/api/services";

function toService(v: unknown): OneCommeService | null {
  if (!isRecord(v)) return null;
  const { id, name, url, enabled } = v;
  if (typeof id !== "string" || typeof url !== "string") return null;
  return { id, name: typeof name === "string" ? name : "", url, enabled: enabled === true };
}

// わんコメ公式の HTTP API（同じ PC のみ）
export class OneCommeClient {
  constructor(private readonly fetchFn: FetchLike) {}

  async listServices(): Promise<Result<OneCommeService[], OneCommeError>> {
    let res;
    try {
      res = await requestJson(this.fetchFn, BASE);
    } catch {
      return err("network");
    }
    if (res.status !== 200) return err("http");
    if (!Array.isArray(res.body)) return err("bad-response");
    const list: OneCommeService[] = [];
    for (const item of res.body as unknown[]) {
      const s = toService(item);
      if (s !== null) list.push(s);
    }
    return ok(list);
  }

  async getService(id: string): Promise<Result<OneCommeService, OneCommeError>> {
    const list = await this.listServices();
    if (!list.ok) return list;
    const found = list.value.find((s) => s.id === id);
    return found ? ok(found) : err("not-found");
  }

  // 渡した項目だけ変わる（2026-10-26 実測）
  async updateService(id: string, patch: { url?: string; enabled?: boolean }): Promise<Result<void, OneCommeError>> {
    let res;
    try {
      res = await requestJson(this.fetchFn, `${BASE}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      return err("network");
    }
    if (res.status === 404) return err("not-found");
    if (res.status !== 200) return err("http");
    return ok(undefined);
  }
}
