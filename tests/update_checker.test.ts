import { describe, expect, it } from "vitest";
import { UPDATE_CHECK_INTERVAL_MS, UPDATE_RETRY_MS, UpdateChecker } from "../src/app/update_checker";

function setup(current = "1.0.0") {
  let now = 1_000_000;
  let calls = 0;
  let answer: () => Promise<unknown> = () => Promise.resolve({ version: "1.1.0" });
  const logs: string[] = [];
  const checker = new UpdateChecker(
    () => {
      calls++;
      return answer();
    },
    current,
    () => now,
    (m) => logs.push(m),
  );
  return {
    checker,
    logs,
    calls: () => calls,
    answer: (fn: () => Promise<unknown>) => {
      answer = fn;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("UpdateChecker", () => {
  it("確認する前は、新しいバージョンなし", () => {
    const t = setup();
    expect(t.checker.getStatus()).toEqual({ current: "1.0.0", latest: null });
    expect(t.calls()).toBe(0);
  });

  it("新しいバージョンがあれば latest に入る", async () => {
    const t = setup();
    await t.checker.refresh();
    expect(t.checker.getStatus()).toEqual({ current: "1.0.0", latest: "1.1.0" });
  });

  it("同じか古いバージョンなら latest は null", async () => {
    const t = setup("1.1.0");
    await t.checker.refresh();
    expect(t.checker.getStatus().latest).toBeNull();
    t.answer(() => Promise.resolve({ version: "1.0.5" }));
    t.advance(UPDATE_CHECK_INTERVAL_MS);
    await t.checker.refresh();
    expect(t.checker.getStatus().latest).toBeNull();
  });

  it("成功したら 6 時間は確認し直さない", async () => {
    const t = setup();
    await t.checker.refresh();
    await t.checker.refresh();
    t.advance(UPDATE_CHECK_INTERVAL_MS - 1);
    await t.checker.refresh();
    expect(t.calls()).toBe(1);
    t.advance(1);
    await t.checker.refresh();
    expect(t.calls()).toBe(2);
  });

  it("同時に呼ばれても通信は 1 回", async () => {
    const t = setup();
    await Promise.all([t.checker.refresh(), t.checker.refresh(), t.checker.refresh()]);
    expect(t.calls()).toBe(1);
  });

  it("通信に失敗しても例外を出さず、30 分後にやり直す。前に分かった結果は残す", async () => {
    const t = setup();
    await t.checker.refresh();
    t.answer(() => Promise.reject(new Error("offline")));
    t.advance(UPDATE_CHECK_INTERVAL_MS);
    await expect(t.checker.refresh()).resolves.toBeUndefined();
    expect(t.checker.getStatus().latest).toBe("1.1.0");
    t.advance(UPDATE_RETRY_MS - 1);
    await t.checker.refresh();
    expect(t.calls()).toBe(2);
    t.advance(1);
    await t.checker.refresh();
    expect(t.calls()).toBe(3);
  });

  it("壊れた応答は無視する", async () => {
    const t = setup();
    t.answer(() => Promise.resolve({ version: "<script>" }));
    await t.checker.refresh();
    expect(t.checker.getStatus().latest).toBeNull();
    expect(t.logs.some((l) => l.includes("update check failed"))).toBe(true);
  });

  it("stop のあとは通信しない", async () => {
    const t = setup();
    t.checker.stop();
    await t.checker.refresh();
    expect(t.calls()).toBe(0);
  });
});
