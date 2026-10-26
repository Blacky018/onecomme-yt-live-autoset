// 検証用: 予約枠・配信中の枠がアップロード再生リストに含まれるかを調べる。本体からは使わない。
// 使い方（PowerShell）:
//   $env:YT_API_KEY = "<APIキー>"; node spikes/find-live.mjs "@ハンドル"
// API キーは表示しない。消費する quota は 3 units。

const key = process.env.YT_API_KEY;
const handleArg = process.argv[2] ?? "";

if (!key) {
  console.error("環境変数 YT_API_KEY がありません");
  process.exit(1);
}
const handle = handleArg.startsWith("@") ? handleArg : `@${handleArg}`;
if (handle.length < 2 || /[\s/?#&]/.test(handle)) {
  console.error('使い方: node spikes/find-live.mjs "@ハンドル"');
  process.exit(1);
}

async function call(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? "unknown";
    throw new Error(`${endpoint}: HTTP ${res.status} (${reason})`);
  }
  return body;
}

try {
  const ch = await call("channels", { part: "id,contentDetails", forHandle: handle });
  const channel = ch.items?.[0];
  if (!channel) throw new Error(`チャンネルが見つかりません: ${handle}`);
  const uploads = channel.contentDetails.relatedPlaylists.uploads;
  console.log("channelId:", channel.id, "uploads:", uploads);

  const pl = await call("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "10" });
  const ids = (pl.items ?? []).map((i) => i.contentDetails.videoId);
  console.log("recent video ids:", ids.join(", "));
  const vids = ids.length ? await call("videos", { part: "snippet,liveStreamingDetails,status", id: ids.join(",") }) : {};
  for (const v of vids.items ?? []) {
    const ls = v.liveStreamingDetails ?? {};
    console.log(
      [
        v.id,
        v.snippet.liveBroadcastContent,
        v.status.privacyStatus,
        `start=${ls.actualStartTime ?? "-"}`,
        `scheduled=${ls.scheduledStartTime ?? "-"}`,
        v.snippet.title,
      ].join(" | "),
    );
  }
} catch (e) {
  console.error("失敗:", e instanceof Error ? e.message : e);
  // process.exit() は Windows の Node で fetch 後に異常終了することがあるので exitCode を使う
  process.exitCode = 1;
}
