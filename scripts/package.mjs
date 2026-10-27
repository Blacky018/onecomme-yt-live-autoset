// 配布用 zip を作る: dist/yt-live-autoset-<version>.zip と SHA-256
// 中身: yt-live-autoset/（プラグインフォルダ）, README.md, LICENSE
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: false });

// コミットしていない変更が入った zip を配らない
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (dirty !== "" && !process.argv.includes("--allow-dirty")) {
  console.error("コミットしていない変更があります。コミットしてから実行してください（確認用なら --allow-dirty）");
  process.exit(1);
}

// 型チェックとテスト（npm を shell 経由で呼ばずに直接実行する）
run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
run(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run"]);
run(process.execPath, [join(root, "scripts", "build.mjs")]);

const name = `yt-live-autoset-${version}`;
const stage = join(root, "dist", "package", name);
rmSync(join(root, "dist", "package"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist", "yt-live-autoset"), join(stage, "yt-live-autoset"), { recursive: true });
cpSync(join(root, "README.md"), join(stage, "README.md"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

const zip = join(root, "dist", `${name}.zip`);
rmSync(zip, { force: true });
// Windows 標準の tar（bsdtar）は zip を作れる。Git Bash の GNU tar は作れないので絶対パスで呼ぶ
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "zip";
// zip の一番上に中身を直接置く。Windows の「すべて展開」は zip 名のフォルダを自動で作るため、
// 外側にもう 1 段フォルダがあると 3 重になり、外側ごとプラグインフォルダに入れる間違いが起きる
const entries = ["yt-live-autoset", "README.md", "LICENSE"];
if (process.platform === "win32") {
  if (!existsSync(tar)) throw new Error(`tar.exe が見つかりません: ${tar}`);
  execFileSync(tar, ["-a", "-c", "-f", zip, "-C", stage, ...entries], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-r", "-q", zip, ...entries], { cwd: stage, stdio: "inherit" });
}

const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${hash}  ${name}.zip\n`);
console.log(`\n${zip}\nSHA-256: ${hash}`);
