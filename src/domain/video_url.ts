export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// わんコメの枠に入っている URL から動画 ID を取り出す。取れなければ null
export function extractVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname;
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const segments = url.pathname.split("/").filter((s) => s !== "");
    if (segments[0] === "watch") candidate = url.searchParams.get("v");
    else if (segments[0] === "live") candidate = segments[1] ?? null;
  }
  return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
