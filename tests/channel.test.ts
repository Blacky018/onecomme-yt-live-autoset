import { describe, expect, it } from "vitest";
import { parseChannelInput } from "../src/domain/channel";

describe("parseChannelInput", () => {
  it.each([
    ["@handle", "@handle"],
    ["handle", "@handle"],
    ["  @handle  ", "@handle"],
    ["@ちゃんねる-x8l", "@ちゃんねる-x8l"],
    ["https://www.youtube.com/@handle", "@handle"],
    ["https://youtube.com/@handle/live", "@handle"],
    ["https://www.youtube.com/@handle/streams?x=1", "@handle"],
    ["https://m.youtube.com/@handle", "@handle"],
    ["https://www.youtube.com/@%E3%81%A1%E3%82%83%E3%82%93-x8l/live", "@ちゃん-x8l"],
  ])("ハンドル %s → %s", (input, handle) => {
    expect(parseChannelInput(input)).toEqual({ ok: true, value: { kind: "handle", handle } });
  });

  it.each([
    ["UCabcdefghijklmnopqrstuv", "UCabcdefghijklmnopqrstuv"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "UCabcdefghijklmnopqrstuv"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live", "UCabcdefghijklmnopqrstuv"],
  ])("チャンネル ID %s", (input, id) => {
    expect(parseChannelInput(input)).toEqual({ ok: true, value: { kind: "id", id } });
  });

  it.each([
    "",
    "   ",
    "@",
    "@a b",
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://example.com/@handle",
    "https://www.youtube.com/",
    "https://www.youtube.com/@%E3%81",
    "@" + "a".repeat(101),
    "javascript:alert(1)",
  ])("不正な入力 %j はエラー", (input) => {
    expect(parseChannelInput(input).ok).toBe(false);
  });
});
