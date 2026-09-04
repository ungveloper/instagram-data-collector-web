import type { Browser } from "playwright-core";

function isServerlessLinux() {
  return process.env.VERCEL === "1" || process.platform === "linux";
}

export async function launchCollectorBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");

  if (isServerlessLinux()) {
    const { default: serverlessChromium } = await import("@sparticuz/chromium");
    const executablePath = await serverlessChromium.executablePath();

    return chromium.launch({
      headless: true,
      executablePath,
      args: [...serverlessChromium.args, "--disable-dev-shm-usage"],
    });
  }

  return chromium.launch({ headless: true });
}
