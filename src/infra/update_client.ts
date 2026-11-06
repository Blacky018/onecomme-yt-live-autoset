import { requestJson, type FetchLike } from "./http";

// 公式サイト（GitHub Pages）に置いた最新バージョンの情報。送るのは取得の依頼だけで、利用者の情報は付けない
export const VERSION_URL = "https://blacky018.github.io/onecomme-yt-live-autoset/version.json";

export async function fetchLatestVersion(fetchFn: FetchLike): Promise<unknown> {
  const res = await requestJson(fetchFn, VERSION_URL, { cache: "no-store" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body;
}
