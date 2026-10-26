// dist/yt-live-autoset/ に わんコメ のプラグインフォルダを作る
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "yt-live-autoset");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// わんコメは CommonJS の module.exports = plugin を読む
await build({
  entryPoints: [join(root, "src", "plugin.ts")],
  outfile: join(out, "plugin.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  footer: { js: "module.exports = module.exports.default;" },
  logLevel: "warning",
});

await build({
  entryPoints: [join(root, "src", "settings", "main.ts")],
  outfile: join(out, "settings.js"),
  bundle: true,
  platform: "browser",
  target: "chrome120",
  format: "iife",
  logLevel: "warning",
});

cpSync(join(root, "static"), out, { recursive: true });
console.log(`built: ${out}`);
