// E2E 用の「偽の外の世界」: わんコメの API・YouTube Data API・Google のトークン窓口。
// ビルドした plugin.js の fetch をここに向ける。それ以外の URL（ログインの戻り先 127.0.0.1）は本物の fetch に流す
import { createHash } from "node:crypto";

export interface FakeService {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface FakeBroadcast {
  id: string;
  scheduled: string;
  started?: string;
  ended?: string;
}

export const CLIENT_ID = "123-e2e.apps.googleusercontent.com";
export const CLIENT_SECRET = "GOCSPX-e2e-secret";
export const API_KEY = "AIzaE2EKEY0000000000";
export const REFRESH_TOKEN = "1//e2e-refresh-token-000";
const ACCESS_TOKEN = "ya29.e2e-access-token";
const AUTH_CODE = "4/e2e-auth-code";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const iso = (ms: number) => new Date(ms).toISOString();

export class FakeWorld {
  services: FakeService[] = [
    { id: "svc-yt", name: "YouTube", url: "", enabled: false },
    { id: "svc-tw", name: "Twitch", url: "https://www.twitch.tv/someone", enabled: true },
  ];
  // わんコメへの書き換えの記録（id ごと・順番どおり）
  updates: Array<{ id: string; patch: Partial<FakeService> }> = [];
  // 自分の配信（Google ログイン方式・API キー方式どちらからも見える）
  broadcasts: FakeBroadcast[] = [];
  // 失敗させたいとき
  onecommeDown = false;
  youtubeError: { status: number; reason: string } | null = null;
  tokenError: string | null = null;

  // PKCE の確認用（oauthStart の authUrl から入れる）
  expectedChallenge = "";
  expectedRedirect = "";
  revoked: string[] = [];
  tokenRequests: string[] = [];
  // 送られてきた URL とヘッダー（秘密の値が漏れていないかの確認用）
  seenUrls: string[] = [];

  constructor(private readonly realFetch: typeof fetch) {}

  live(id: string, startedMsAgo = 60_000): void {
    const now = Date.now();
    this.broadcasts.push({ id, scheduled: iso(now - startedMsAgo), started: iso(now - startedMsAgo) });
  }

  upcoming(id: string, inMs: number): void {
    this.broadcasts.push({ id, scheduled: iso(Date.now() + inMs) });
  }

  start(id: string): void {
    const b = this.broadcasts.find((x) => x.id === id);
    if (b) b.started = iso(Date.now());
  }

  end(id: string): void {
    const b = this.broadcasts.find((x) => x.id === id);
    if (b) b.ended = iso(Date.now());
  }

  service(id: string): FakeService {
    const s = this.services.find((x) => x.id === id);
    if (!s) throw new Error(`no service ${id}`);
    return s;
  }

  patchesFor(id: string): Array<Partial<FakeService>> {
    return this.updates.filter((u) => u.id === id).map((u) => u.patch);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.seenUrls.push(url.href);
    if (url.host === "127.0.0.1:11180") return this.onecomme(url, init);
    if (url.host === "www.googleapis.com") return this.youtube(url, init);
    if (url.host === "oauth2.googleapis.com") return this.oauth(url, init);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return this.realFetch(input, init);
    throw new Error(`E2E: 想定外の通信先 ${url.host}`);
  };

  private async onecomme(url: URL, init?: RequestInit): Promise<Response> {
    if (this.onecommeDown) throw new TypeError("fetch failed");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/services") return json(200, this.services);
    const m = /^\/api\/services\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && m) {
      const id = decodeURIComponent(m[1] ?? "");
      const s = this.services.find((x) => x.id === id);
      if (!s) return json(404, { error: "not found" });
      const patch = JSON.parse(String(init?.body)) as Partial<FakeService>;
      this.updates.push({ id, patch });
      Object.assign(s, patch);
      return json(200, s);
    }
    return json(404, {});
  }

  private youtube(url: URL, init?: RequestInit): Response {
    if (this.youtubeError) {
      return json(this.youtubeError.status, { error: { code: this.youtubeError.status, message: "e2e", errors: [{ reason: this.youtubeError.reason }] } });
    }
    const q = url.searchParams;
    const auth = new Headers(init?.headers).get("Authorization");
    const byKey = q.get("key") === API_KEY;
    const byToken = auth === `Bearer ${ACCESS_TOKEN}`;
    if (!byKey && !byToken) return json(401, { error: { code: 401, message: "unauthorized" } });
    const endpoint = url.pathname.replace("/youtube/v3/", "");

    if (endpoint === "channels" && byKey) {
      if (q.get("forHandle") !== "@e2e") return json(200, { items: [] });
      return json(200, { items: [{ id: "UCe2echannel0000000000aa", contentDetails: { relatedPlaylists: { uploads: "UUe2echannel0000000000aa" } } }] });
    }
    if (endpoint === "playlistItems" && byKey) {
      return json(200, { items: this.broadcasts.map((b) => ({ contentDetails: { videoId: b.id } })) });
    }
    if (endpoint === "videos" && byKey) {
      const ids = (q.get("id") ?? "").split(",");
      const items = this.broadcasts
        .filter((b) => ids.includes(b.id))
        .map((b) => ({
          id: b.id,
          liveStreamingDetails: {
            scheduledStartTime: b.scheduled,
            ...(b.started ? { actualStartTime: b.started } : {}),
            ...(b.ended ? { actualEndTime: b.ended } : {}),
          },
        }));
      return json(200, { items });
    }
    if (endpoint === "liveBroadcasts" && byToken) {
      const status = q.get("broadcastStatus");
      if (q.get("broadcastType") !== "all") return json(400, { error: { message: "broadcastType" } });
      const pick = this.broadcasts.filter((b) => (status === "active" ? b.started && !b.ended : !b.started));
      const items = pick.map((b) => ({
        id: b.id,
        snippet: {
          scheduledStartTime: b.scheduled,
          ...(b.started ? { actualStartTime: b.started } : {}),
          ...(b.ended ? { actualEndTime: b.ended } : {}),
        },
        status: { lifeCycleStatus: b.started ? "live" : "ready" },
      }));
      return json(200, { items });
    }
    return json(400, { error: { message: `unexpected ${endpoint}` } });
  }

  private async oauth(url: URL, init?: RequestInit): Promise<Response> {
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (url.pathname === "/revoke") {
      this.revoked.push(form.get("token") ?? "");
      return json(200, {});
    }
    if (url.pathname !== "/token") return json(404, {});
    this.tokenRequests.push(form.get("grant_type") ?? "");
    if (this.tokenError) return json(400, { error: this.tokenError });
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (form.get("code") !== AUTH_CODE || challenge !== this.expectedChallenge || form.get("redirect_uri") !== this.expectedRedirect) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, refresh_token: REFRESH_TOKEN, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") !== REFRESH_TOKEN) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  // ブラウザで Google の同意画面を通ったことにして、ループバックへ戻る
  async approveLogin(authUrl: string): Promise<Response> {
    const u = new URL(authUrl);
    this.expectedChallenge = u.searchParams.get("code_challenge") ?? "";
    this.expectedRedirect = u.searchParams.get("redirect_uri") ?? "";
    const back = new URL(this.expectedRedirect);
    back.searchParams.set("code", AUTH_CODE);
    back.searchParams.set("state", u.searchParams.get("state") ?? "");
    return this.realFetch(back);
  }
}
