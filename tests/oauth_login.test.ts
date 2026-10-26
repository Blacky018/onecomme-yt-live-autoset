import { describe, expect, it } from "vitest";
import { LOGIN_TIMEOUT_MS, OAuthLogin } from "../src/app/oauth_login";
import type { TokenResponse } from "../src/domain/oauth";
import { err, ok, type Result } from "../src/domain/result";
import type { TokenError } from "../src/infra/google_oauth";
import type { CallbackHandler } from "../src/infra/loopback";

const CLIENT = { clientId: "1-a.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" };

function setup() {
  let handler: CallbackHandler | null = null;
  let timeoutFn: (() => void) | null = null;
  const closed: number[] = [];
  const saved: string[] = [];
  const exchanges: Array<{ code: string; verifier: string; redirect: string }> = [];
  let exchangeResult: Result<TokenResponse, TokenError> = ok({ accessToken: "ya29.access", expiresInSec: 3600, refreshToken: "1//refresh" });
  let serverCount = 0;
  const login = new OAuthLogin({
    startServer: async (h) => {
      handler = h;
      serverCount += 1;
      const n = serverCount;
      return { redirectUri: `http://127.0.0.1:5000${n}/`, close: () => closed.push(n) };
    },
    exchange: async (_c, code, verifier, redirect) => {
      exchanges.push({ code, verifier, redirect });
      return exchangeResult;
    },
    pkce: () => ({ verifier: "VERIFIER", challenge: "CHALLENGE" }),
    state: () => "STATE",
    setTimeout: (fn) => {
      timeoutFn = fn;
      return 1;
    },
    clearTimeout: () => {
      timeoutFn = null;
    },
    onToken: (t) => saved.push(t),
    log: () => undefined,
  });
  return {
    login,
    callback: (path: string) => {
      if (!handler) throw new Error("no server");
      return handler(path);
    },
    fireTimeout: () => timeoutFn?.(),
    closed,
    saved,
    exchanges,
    setExchange: (r: Result<TokenResponse, TokenError>) => {
      exchangeResult = r;
    },
  };
}

describe("OAuthLogin", () => {
  it("認可 URL を返し、戻りのコードを交換してトークンを保存する", async () => {
    const t = setup();
    const r = await t.login.start(CLIENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.value);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:50001/");
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(t.login.getStatus().state).toBe("waiting");

    const page = await t.callback("/?state=STATE&code=CODE");
    expect(page.title).toBe("ログインしました");
    expect(t.exchanges).toEqual([{ code: "CODE", verifier: "VERIFIER", redirect: "http://127.0.0.1:50001/" }]);
    expect(t.saved).toEqual(["1//refresh"]);
    expect(t.login.getStatus().state).toBe("done");
    // 応答はループバック側が送ってから閉じるので、ここでは閉じない
    expect(t.closed).toEqual([]);
  });

  it("state が違うリクエストは無視して待ち続ける", async () => {
    const t = setup();
    await t.login.start(CLIENT);
    expect((await t.callback("/?state=EVIL&code=X")).handled).toBe(false);
    expect((await t.callback("/favicon.ico")).handled).toBe(false);
    expect(t.exchanges).toEqual([]);
    expect(t.login.getStatus().state).toBe("waiting");
  });

  it("キャンセルされたらエラー表示", async () => {
    const t = setup();
    await t.login.start(CLIENT);
    const page = await t.callback("/?state=STATE&error=access_denied");
    expect(page.title).toContain("できませんでした");
    expect(t.login.getStatus()).toMatchObject({ state: "error", message: expect.stringContaining("キャンセル") });
    expect(t.saved).toEqual([]);
  });

  it("交換に失敗したら保存しない", async () => {
    const t = setup();
    t.setExchange(err("invalid-client"));
    await t.login.start(CLIENT);
    await t.callback("/?state=STATE&code=CODE");
    expect(t.saved).toEqual([]);
    expect(t.login.getStatus().message).toContain("シークレット");
  });

  it("リフレッシュトークンが来なければエラー", async () => {
    const t = setup();
    t.setExchange(ok({ accessToken: "ya29.access", expiresInSec: 3600, refreshToken: null }));
    await t.login.start(CLIENT);
    await t.callback("/?state=STATE&code=CODE");
    expect(t.saved).toEqual([]);
    expect(t.login.getStatus().state).toBe("error");
  });

  it("2 回目の戻りは受け付けない", async () => {
    const t = setup();
    await t.login.start(CLIENT);
    await t.callback("/?state=STATE&code=CODE");
    const second = await t.callback("/?state=STATE&code=CODE2");
    expect(second.title).toContain("できませんでした");
    expect(t.exchanges).toHaveLength(1);
  });

  it("時間切れでサーバーを閉じる", async () => {
    const t = setup();
    await t.login.start(CLIENT);
    t.fireTimeout();
    expect(t.closed).toEqual([1]);
    expect(t.login.getStatus().message).toContain("時間切れ");
    expect(LOGIN_TIMEOUT_MS).toBe(300_000);
  });

  it("やり直すと前のサーバーを閉じる", async () => {
    const t = setup();
    await t.login.start(CLIENT);
    await t.login.start(CLIENT);
    expect(t.closed).toEqual([1]);
  });

  it("クライアント情報が不正なら始めない", async () => {
    const t = setup();
    expect((await t.login.start({ clientId: "x", clientSecret: "GOCSPX-secret" })).ok).toBe(false);
    expect((await t.login.start({ clientId: CLIENT.clientId, clientSecret: "" })).ok).toBe(false);
  });
});
