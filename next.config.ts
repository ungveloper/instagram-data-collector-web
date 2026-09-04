import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright Core는 서버 런타임 패키지로 유지하고,
  // @sparticuz/chromium-min은 Next.js가 번들링하도록 둡니다.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium-min"],
};

export default nextConfig;
