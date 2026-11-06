import { describe, expect, it } from "vitest";
import { isNewerVersion, parseLatestVersion, parseVersion } from "../src/domain/version";

describe("parseVersion", () => {
  it("x.y.z を数字の組にする", () => {
    expect(parseVersion("1.0.0")).toEqual([1, 0, 0]);
    expect(parseVersion("12.34.5678")).toEqual([12, 34, 5678]);
  });

  it("形が違うものは null", () => {
    for (const v of ["", "1.0", "1.0.0.0", "v1.0.0", "1.0.0-beta", " 1.0.0", "1.a.0", "99999.0.0", 1, null, undefined, {}]) {
      expect(parseVersion(v)).toBeNull();
    }
  });
});

describe("isNewerVersion", () => {
  it("数字として比べる（文字列の順ではない）", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("同じか古ければ false", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
  });

  it("どちらかが壊れていれば false（お知らせを出さない）", () => {
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.1.0", "dev")).toBe(false);
  });
});

describe("parseLatestVersion", () => {
  it("{ version: \"x.y.z\" } からバージョンを取り出す", () => {
    expect(parseLatestVersion({ version: "1.1.0" })).toEqual({ ok: true, value: "1.1.0" });
  });

  it("壊れた応答はエラー", () => {
    for (const body of [null, "1.1.0", [], {}, { version: 110 }, { version: "1.1" }, { version: "<b>1.1.0</b>" }]) {
      expect(parseLatestVersion(body).ok).toBe(false);
    }
  });
});
