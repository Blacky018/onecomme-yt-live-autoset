import { describe, expect, it } from "vitest";
import { buildAuthUrl, classifyTokenError, parseCallback, parseTokenResponse } from "../src/domain/oauth";

describe("buildAuthUrl", () => {
  it("PKCE・読み取り専用 scope・offline を付ける", () => {
    const url = new URL(
      buildAuthUrl({ clientId: "123-abc.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:5555/", state: "st&ate", codeChallenge: "chal" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = Object.fromEntries(url.searchParams);
    expect(q).toEqual({
      client_id: "123-abc.apps.googleusercontent.com",
      redirect_uri: "http://127.0.0.1:5555/",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly",
      state: "st&ate",
      code_challenge: "chal",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
  });
});

describe("parseCallback", () => {
  it("state が合えばコードを返す", () => {
    expect(parseCallback("/?state=S1&code=4%2Fabc&scope=x", "S1")).toEqual({ ok: true, value: "4/abc" });
  });
  it.each([
    ["/?state=WRONG&code=c", "state"],
    ["/?code=c", "state"],
    ["/?state=S1&error=access_denied", "denied"],
    ["/?state=S1", "missing-code"],
    ["/?state=S1&code=", "missing-code"],
    ["/favicon.ico", "not-callback"],
    ["/", "not-callback"],
    ["/other?state=S1&code=c", "not-callback"],
  ])("%s → %s", (path, error) => {
    expect(parseCallback(path, "S1")).toEqual({ ok: false, error });
  });
  it("拒否でも state が違えば state エラー（他サイトからの偽装を弾く）", () => {
    expect(parseCallback("/?state=X&error=access_denied", "S1")).toEqual({ ok: false, error: "state" });
  });
});

describe("parseTokenResponse", () => {
  it("リフレッシュトークン付き", () => {
    expect(parseTokenResponse({ access_token: "ya29.dummy-access", expires_in: 3599, refresh_token: "1//dummy-refresh", token_type: "Bearer" })).toEqual({
      ok: true,
      value: { accessToken: "ya29.dummy-access", expiresInSec: 3599, refreshToken: "1//dummy-refresh" },
    });
  });
  it("更新時はリフレッシュトークンなし", () => {
    expect(parseTokenResponse({ access_token: "ya29.dummy-access", expires_in: 3599 })).toMatchObject({ ok: true, value: { refreshToken: null } });
  });
  it.each([null, {}, { access_token: "ya29.dummy-access" }, { access_token: "short", expires_in: 1 }, { access_token: "ya29.dummy-access", expires_in: -1 }, { access_token: "ya29.dummy-access", expires_in: 10, refresh_token: 5 }, { access_token: "ya29 has space", expires_in: 10 }])(
    "壊れた応答 %j",
    (body) => {
      expect(parseTokenResponse(body).ok).toBe(false);
    },
  );
});

describe("classifyTokenError", () => {
  it.each([
    [{ error: "invalid_grant", error_description: "Token has been expired or revoked." }, "invalid-grant"],
    [{ error: "invalid_client" }, "invalid-client"],
    [{ error: "unauthorized_client" }, "invalid-client"],
    [{ error: "server_error" }, "other"],
    [null, "other"],
  ])("%j → %s", (body, kind) => {
    expect(classifyTokenError(body)).toBe(kind);
  });
});
