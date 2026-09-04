import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

const sessionPath = path.join(process.cwd(), ".instagram-storage-state.json");
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: "ko-KR" });
const page = await context.newPage();
await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });

const rl = readline.createInterface({ input, output });
console.log("\n브라우저에서 Instagram에 직접 로그인하세요.");
console.log("로그인이 완료되어 Instagram 홈/프로필이 보이면 터미널로 돌아오세요.");
await rl.question("Enter를 누르면 로그인 세션을 로컬 파일로 저장합니다: ");
rl.close();

await context.storageState({ path: sessionPath });
await browser.close();
console.log(`✅ 저장 완료: ${sessionPath}`);
console.log("이 파일은 .gitignore에 포함되며 Git에 커밋되지 않습니다.");
