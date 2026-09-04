import serverlessChromium from "@sparticuz/chromium-min";
import { chromium, type Browser } from "playwright-core";

const SERVERLESS_CHROMIUM_VERSION = "143.0.4";

function serverlessChromiumPackUrl() {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  return `https://github.com/Sparticuz/chromium/releases/download/v${SERVERLESS_CHROMIUM_VERSION}/chromium-v${SERVERLESS_CHROMIUM_VERSION}-pack.${architecture}.tar`;
}

export async function launchCollectorBrowser(): Promise<Browser> {
  if (process.env.VERCEL === "1") {
    const executablePath = await serverlessChromium.executablePath(
      serverlessChromiumPackUrl(),
    );

    return chromium.launch({
      headless: true,
      executablePath,
      args: [...serverlessChromium.args, "--disable-dev-shm-usage"],
    });
  }

  return chromium.launch({ headless: true });
}
