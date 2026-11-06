import { err, isRecord, ok, type Result } from "./result";

// バージョンは x.y.z の数字だけ（各 4 桁まで）
export const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = VERSION.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// latest が current より新しいか。どちらかが読めなければ false（お知らせを出さない）
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// 公式サイトの version.json（{ "version": "x.y.z" }）を検証する
export function parseLatestVersion(body: unknown): Result<string> {
  if (!isRecord(body)) return err("body");
  const v = body["version"];
  if (typeof v !== "string" || !parseVersion(v)) return err("version");
  return ok(v);
}
