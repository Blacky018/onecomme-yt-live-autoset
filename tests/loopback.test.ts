import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkce, randomState, startLoopback } from "../src/infra/loopback";

describe("createPkce", () => {
  it("S256 のチャレンジを作る（verifier は 43〜128 文字）", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(createPkce().verifier).not.toBe(verifier);
    expect(randomState()).not.toBe(randomState());
  });
});

describe("startLoopback", () => {
  it("127.0.0.1 で受け、処理したら固定のページを返して閉じる", async () => {
    const seen: string[] = [];
    const server = await startLoopback(async (path) => {
      seen.push(path);
      return path.startsWith("/?")
        ? { handled: true, title: "完了", message: "閉じてください" }
        : { handled: false, title: "", message: "" };
    });
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const miss = await fetch(new URL("favicon.ico", server.redirectUri));
    expect(miss.status).toBe(404);

    const hit = await fetch(`${server.redirectUri}?code=<script>&state=x`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await hit.text();
    expect(html).toContain("完了");
    expect(html).not.toContain("<script>"); // 受け取った値は画面に出さない
    expect(seen).toEqual(["/favicon.ico", "/?code=%3Cscript%3E&state=x"]);

    // 1 回処理したら閉じている
    await expect(fetch(server.redirectUri)).rejects.toThrow();
  });

  it("GET 以外は 405", async () => {
    const server = await startLoopback(async () => ({ handled: true, title: "t", message: "m" }));
    const res = await fetch(server.redirectUri, { method: "POST" });
    expect(res.status).toBe(405);
    server.close();
  });
});
