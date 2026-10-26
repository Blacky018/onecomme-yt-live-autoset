import { err, ok, type Result } from "./result";

export type ChannelRef = { kind: "handle"; handle: string } | { kind: "id"; id: string };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const MAX_HANDLE = 100;

// 「@ハンドル」「ハンドル」「チャンネル URL」「UC から始まるチャンネル ID」を受け付ける
export function parseChannelInput(raw: string): Result<ChannelRef> {
  const input = raw.trim();
  if (input === "") return err("empty");
  if (CHANNEL_ID.test(input)) return ok({ kind: "id", id: input });
  if (/^https?:\/\//i.test(input)) return parseChannelUrl(input);
  if (input.includes(":") || input.includes("/")) return err("invalid");
  return handleRef(input.startsWith("@") ? input : `@${input}`);
}

function parseChannelUrl(input: string): Result<ChannelRef> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return err("invalid-url");
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return err("not-youtube");
  const segments = url.pathname.split("/").filter((s) => s !== "");
  const first = segments[0];
  if (first === undefined) return err("no-channel");
  if (first === "channel") {
    const id = segments[1] ?? "";
    return CHANNEL_ID.test(id) ? ok({ kind: "id", id }) : err("invalid-channel-id");
  }
  if (!first.startsWith("@")) return err("no-channel");
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    return err("invalid-url");
  }
  return handleRef(decoded);
}

function handleRef(handle: string): Result<ChannelRef> {
  const body = handle.slice(1);
  if (body === "" || handle.length > MAX_HANDLE) return err("invalid-handle");
  // 空白・URL の区切り文字・制御文字を含むものは不可（日本語などは可）
  if (/[\s/?#&%:@\u0000-\u001f\u007f]/u.test(body)) return err("invalid-handle");
  return ok({ kind: "handle", handle });
}
