import { describe, expect, it } from "vitest";
import { extractVideoId, watchUrl } from "../src/domain/video_url";

describe("extractVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abcDEF12_-x", "abcDEF12_-x"],
    ["https://youtube.com/watch?feature=share&v=abcDEF12_-x", "abcDEF12_-x"],
    ["https://youtube.com/live/abcDEF12_-x?feature=share", "abcDEF12_-x"],
    ["https://youtu.be/abcDEF12_-x", "abcDEF12_-x"],
    ["https://m.youtube.com/watch?v=abcDEF12_-x", "abcDEF12_-x"],
  ])("%s → %s", (url, id) => {
    expect(extractVideoId(url)).toBe(id);
  });

  it.each([
    "",
    "https://www.youtube.com/@handle/live",
    "https://www.youtube.com/@handle",
    "https://www.youtube.com/watch?v=short",
    "https://twitcasting.tv/user",
    "not a url",
  ])("動画 ID のない %j は null", (url) => {
    expect(extractVideoId(url)).toBeNull();
  });
});

describe("watchUrl", () => {
  it("watch?v= 形式を作る", () => {
    expect(watchUrl("abcDEF12_-x")).toBe("https://www.youtube.com/watch?v=abcDEF12_-x");
  });
});
