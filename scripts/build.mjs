// dist/yt-live-autoset/ に わんコメ のプラグインフォルダを作る
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "yt-live-autoset");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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
  define: { PLUGIN_VERSION: JSON.stringify(version) },
  metafile: true,
  logLevel: "warning",
}).then((r) => {
  // 配布物に第三者のコードが入っていないことを確かめる（入れるなら THIRD_PARTY_NOTICES が必要）
  const foreign = Object.keys(r.metafile.inputs).filter((f) => f.includes("node_modules"));
  if (foreign.length > 0) throw new Error(`第三者のコードが含まれています: ${foreign.join(", ")}`);
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
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
console.log(`built: ${out}`);
