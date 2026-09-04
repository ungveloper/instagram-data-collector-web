import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isServerlessLinux = process.env.VERCEL === "1" || process.platform === "linux";

if (isServerlessLinux) {
  console.log("✅ 서버 환경: @sparticuz/chromium 바이너리를 사용합니다.");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(root, "node_modules", "playwright", "cli.js");

console.log("== 로컬 Playwright Chromium 자동 설치 ==");
const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
