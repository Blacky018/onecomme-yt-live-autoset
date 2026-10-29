import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MIN_INTERVAL_SEC,
  applySettingsPatch,
  effectiveIntervalSec,
  loadSettings,
  missingConfig,
  publicSettings,
  type Settings,
} from "../src/domain/settings";

const CLIENT = "123-abc.apps.googleusercontent.com";

describe("applySettingsPatch", () => {
  const base: Settings = { ...DEFAULT_SETTINGS, apiKey: "AIzaOLDKEY", channel: "@old" };

  it("渡した項目だけ変える", () => {
    const r = applySettingsPatch(base, { channel: " @new ", intervalSec: 120 });
    expect(r).toEqual({ ok: true, value: { ...base, channel: "@new", intervalSec: 120 } });
  });

  it("apiKey は空文字なら変えない・clearApiKey で消す", () => {
    expect(applySettingsPatch(base, { apiKey: "" })).toEqual({ ok: true, value: base });
    expect(applySettingsPatch(base, { apiKey: "  AIzaNEW_key-1  " })).toEqual({ ok: true, value: { ...base, apiKey: "AIzaNEW_key-1" } });
    expect(applySettingsPatch(base, { clearApiKey: true })).toEqual({ ok: true, value: { ...base, apiKey: "" } });
  });

  it("OAuth シークレットも同じ扱い", () => {
    const withSecret = { ...base, oauthClientSecret: "GOCSPX-old_secret" };
    expect(applySettingsPatch(withSecret, { oauthClientSecret: "" })).toEqual({ ok: true, value: withSecret });
    expect(applySettingsPatch(withSecret, { oauthClientSecret: "GOCSPX-new" })).toMatchObject({ ok: true, value: { oauthClientSecret: "GOCSPX-new" } });
    expect(applySettingsPatch(withSecret, { clearOauthClientSecret: true })).toMatchObject({ ok: true, value: { oauthClientSecret: "" } });
  });

  it("クライアント ID を変えるとログインを消す・同じなら残す", () => {
    const loggedIn = { ...base, oauthClientId: CLIENT, refreshToken: "1//dummy-refresh" };
    expect(applySettingsPatch(loggedIn, { oauthClientId: CLIENT })).toMatchObject({ ok: true, value: { refreshToken: "1//dummy-refresh" } });
    expect(applySettingsPatch(loggedIn, { oauthClientId: "999-x.apps.googleusercontent.com" })).toMatchObject({ ok: true, value: { refreshToken: "" } });
  });

  it("refreshToken は設定画面から書けない", () => {
    expect(applySettingsPatch(base, { refreshToken: "1//attacker-token" })).toEqual({ ok: true, value: base });
  });

  it("間隔は下限 60 秒・上限 3600 秒に収める", () => {
    expect(MIN_INTERVAL_SEC).toBe(30);
    expect(applySettingsPatch(base, { intervalSec: 5 })).toMatchObject({ ok: true, value: { intervalSec: 30 } });
    expect(applySettingsPatch(base, { intervalSec: 99999 })).toMatchObject({ ok: true, value: { intervalSec: 3600 } });
    expect(applySettingsPatch(base, { intervalSec: 90.7 })).toMatchObject({ ok: true, value: { intervalSec: 90 } });
  });

  it("チャンネルは空なら可・形が不正ならエラー", () => {
    expect(applySettingsPatch(base, { channel: "" })).toMatchObject({ ok: true, value: { channel: "" } });
    expect(applySettingsPatch(base, { channel: "https://example.com/@x" })).toEqual({ ok: false, error: "channel" });
  });

  it.each([
    [{ apiKey: "has space" }, "apiKey"],
    [{ apiKey: "x".repeat(201) }, "apiKey"],
    [{ apiKey: 1 }, "apiKey"],
    [{ oauthClientSecret: "short" }, "oauthClientSecret"],
    [{ oauthClientId: "not-a-client-id" }, "oauthClientId"],
    [{ oauthClientId: 1 }, "oauthClientId"],
    [{ authMode: "password" }, "authMode"],
    [{ serviceId: "../etc" }, "serviceId"],
    [{ serviceId: 3 }, "serviceId"],
    [{ intervalSec: "60" }, "intervalSec"],
    [{ intervalSec: Number.NaN }, "intervalSec"],
    [{ enabled: "yes" }, "enabled"],
    [{ presetUpcoming: 1 }, "presetUpcoming"],
    [{ autoConnectLive: "on" }, "autoConnectLive"],
    [{ channel: 5 }, "channel"],
  ])("不正な値 %j → %s", (patch, field) => {
    expect(applySettingsPatch(base, patch)).toEqual({ ok: false, error: field });
  });

  it.each([null, "x", [], 1])("オブジェクトでない %j はエラー", (patch) => {
    expect(applySettingsPatch(base, patch)).toEqual({ ok: false, error: "body" });
  });

  it("予約枠の先取りはオン・オフできる（既定オン）", () => {
    expect(DEFAULT_SETTINGS.presetUpcoming).toBe(true);
    expect(applySettingsPatch(base, { presetUpcoming: false })).toMatchObject({ ok: true, value: { presetUpcoming: false } });
  });

  it("配信中の自動接続はオン・オフできる（既定オン）", () => {
    expect(DEFAULT_SETTINGS.autoConnectLive).toBe(true);
    expect(applySettingsPatch(base, { autoConnectLive: false })).toMatchObject({ ok: true, value: { autoConnectLive: false } });
  });

  it("知らない項目は無視", () => {
    expect(applySettingsPatch(base, { foo: 1 })).toEqual({ ok: true, value: base });
  });
});

describe("loadSettings", () => {
  it("壊れた保存値でも使える項目だけ拾う", () => {
    expect(loadSettings({ apiKey: "has space", channel: "@ok", intervalSec: "x", enabled: false })).toEqual({
      ...DEFAULT_SETTINGS,
      channel: "@ok",
      enabled: false,
    });
  });
  it("保存したログイン情報を読み戻す", () => {
    const saved = { ...DEFAULT_SETTINGS, authMode: "oauth", oauthClientId: CLIENT, oauthClientSecret: "GOCSPX-secret", refreshToken: "1//dummy-refresh" };
    expect(loadSettings(saved)).toEqual(saved);
  });
  it("クライアント ID がなければトークンは捨てる", () => {
    expect(loadSettings({ refreshToken: "1//dummy-refresh" }).refreshToken).toBe("");
  });
  it.each([undefined, null, "x"])("%j なら既定値", (raw) => {
    expect(loadSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("missingConfig", () => {
  const svc = { ...DEFAULT_SETTINGS, serviceId: "svc" };
  it.each([
    [{ ...DEFAULT_SETTINGS }, "枠"],
    [svc, "API キー"],
    [{ ...svc, apiKey: "k", channel: "@c" }, null],
    [{ ...svc, authMode: "oauth" as const }, "クライアント"],
    [{ ...svc, authMode: "oauth" as const, oauthClientId: CLIENT, oauthClientSecret: "GOCSPX-x" }, "ログイン"],
    [{ ...svc, authMode: "oauth" as const, oauthClientId: CLIENT, oauthClientSecret: "GOCSPX-x", refreshToken: "1//t" }, null],
  ])("%#", (s, expected) => {
    const r = missingConfig(s);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toContain(expected);
  });
});

describe("effectiveIntervalSec", () => {
  it("API キー方式は 60 秒未満にしない・Google ログイン方式は設定どおり", () => {
    expect(effectiveIntervalSec({ ...DEFAULT_SETTINGS, authMode: "apiKey", intervalSec: 30 })).toBe(60);
    expect(effectiveIntervalSec({ ...DEFAULT_SETTINGS, authMode: "apiKey", intervalSec: 90 })).toBe(90);
    expect(effectiveIntervalSec({ ...DEFAULT_SETTINGS, authMode: "oauth", intervalSec: 30 })).toBe(30);
  });
});

describe("publicSettings", () => {
  it("秘密の値を含めない", () => {
    const p = publicSettings({
      ...DEFAULT_SETTINGS,
      apiKey: "AIzaSECRET",
      oauthClientId: CLIENT,
      oauthClientSecret: "GOCSPX-SECRET",
      refreshToken: "1//REFRESHSECRET",
    });
    const json = JSON.stringify(p);
    for (const secret of ["AIzaSECRET", "GOCSPX-SECRET", "REFRESHSECRET"]) expect(json).not.toContain(secret);
    expect(p).toMatchObject({ hasApiKey: true, hasClientSecret: true, loggedIn: true, oauthClientId: CLIENT });
  });
});
