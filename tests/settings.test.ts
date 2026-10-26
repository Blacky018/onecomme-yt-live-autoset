import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MIN_INTERVAL_SEC, applySettingsPatch, loadSettings, publicSettings } from "../src/domain/settings";

describe("applySettingsPatch", () => {
  const base = { ...DEFAULT_SETTINGS, apiKey: "AIzaOLDKEY", channel: "@old" };

  it("渡した項目だけ変える", () => {
    const r = applySettingsPatch(base, { channel: " @new ", intervalSec: 120 });
    expect(r).toEqual({ ok: true, value: { ...base, channel: "@new", intervalSec: 120 } });
  });

  it("apiKey は空文字なら変えない・clearApiKey で消す", () => {
    expect(applySettingsPatch(base, { apiKey: "" })).toEqual({ ok: true, value: base });
    expect(applySettingsPatch(base, { apiKey: "  AIzaNEW_key-1  " })).toEqual({ ok: true, value: { ...base, apiKey: "AIzaNEW_key-1" } });
    expect(applySettingsPatch(base, { clearApiKey: true })).toEqual({ ok: true, value: { ...base, apiKey: "" } });
  });

  it("間隔は下限 60 秒・上限 3600 秒に収める", () => {
    expect(applySettingsPatch(base, { intervalSec: 5 })).toMatchObject({ ok: true, value: { intervalSec: MIN_INTERVAL_SEC } });
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
    [{ serviceId: "../etc" }, "serviceId"],
    [{ serviceId: 3 }, "serviceId"],
    [{ intervalSec: "60" }, "intervalSec"],
    [{ intervalSec: Number.NaN }, "intervalSec"],
    [{ enabled: "yes" }, "enabled"],
    [{ channel: 5 }, "channel"],
  ])("不正な値 %j → %s", (patch, field) => {
    expect(applySettingsPatch(base, patch)).toEqual({ ok: false, error: field });
  });

  it.each([null, "x", [], 1])("オブジェクトでない %j はエラー", (patch) => {
    expect(applySettingsPatch(base, patch)).toEqual({ ok: false, error: "body" });
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
  it.each([undefined, null, "x"])("%j なら既定値", (raw) => {
    expect(loadSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("publicSettings", () => {
  it("API キーを含めない", () => {
    const p = publicSettings({ ...DEFAULT_SETTINGS, apiKey: "AIzaSECRET" });
    expect(JSON.stringify(p)).not.toContain("AIzaSECRET");
    expect(p.hasApiKey).toBe(true);
  });
});
