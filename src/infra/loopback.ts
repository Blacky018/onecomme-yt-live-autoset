import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url"); // 64 文字
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

export interface LoopbackServer {
  redirectUri: string;
  close(): void;
}

// 受けたリクエストに対して「処理したか」と、返す固定の文言を返すハンドラ
export type CallbackHandler = (pathAndQuery: string) => Promise<{ handled: boolean; title: string; message: string }>;

const PAGE = (title: string, message: string) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center}</style></head>` +
  `<body><h1>${title}</h1><p>${message}</p></body></html>`;

// 127.0.0.1 の空いているポートで Google からの戻りを 1 回だけ受ける。
// title / message は呼び出し側の固定文言のみ（受け取った値を画面に出さない）
export function startLoopback(onRequest: CallbackHandler): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    const close = () => {
      server?.close();
      server?.closeAllConnections();
      server = null;
    };
    const s = createServer(async (req, res) => {
      try {
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        const result = await onRequest(req.url ?? "/");
        if (!result.handled) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        // 送り終わってから閉じる（先に閉じるとページが届かない）
        res.end(PAGE(result.title, result.message), close);
      } catch {
        res.writeHead(500).end();
      }
    });
    server = s;
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        close();
        reject(new Error("no port"));
        return;
      }
      resolve({ redirectUri: `http://127.0.0.1:${addr.port}/`, close });
    });
  });
}
