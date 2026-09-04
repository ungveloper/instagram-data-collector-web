import { chromium, type Browser, type Page } from "playwright";
import {
  captionFromMetaDescription,
  extractHashtags,
  extractMentions,
  normalizePost,
  parseCountFromMeta,
  parseJsonScripts,
  parsePostFromScripts,
  parseProfileFromScripts,
} from "./parser";
import type {
  CollectorProgress,
  InstagramCollection,
  InstagramMediaItem,
  InstagramPost,
  InstagramProfile,
} from "./types";
import { parseInstagramProfileUrl } from "./url";

const ABSOLUTE_MAX_POSTS = 2_000;
const MAX_SCROLL_ROUNDS = 300;
const PAGE_TIMEOUT = 60_000;
const POST_DELAY_MS = 550;

type CollectOptions = {
  url: string;
  maxPosts?: number;
  onProgress?: (progress: CollectorProgress) => void | Promise<void>;
};

type PageSignals = {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogVideo: string | null;
  canonical: string | null;
  datetime: string | null;
  headerText: string | null;
  locationName: string | null;
  audioTitle: string | null;
  scripts: string[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactUnique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function readPageSignals(page: Page): Promise<PageSignals> {
  return page.evaluate(() => {
    const meta = (selector: string) =>
      document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null;
    const text = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.innerText?.trim() || null;

    const scripts: string[] = [];
    let totalLength = 0;
    for (const script of document.querySelectorAll<HTMLScriptElement>(
      'script[type="application/json"],script[type="application/ld+json"]',
    )) {
      const raw = script.textContent?.trim();
      if (!raw || raw.length > 3_000_000) continue;
      if (totalLength + raw.length > 12_000_000) break;
      scripts.push(raw);
      totalLength += raw.length;
    }

    const locationAnchor = document.querySelector<HTMLAnchorElement>(
      'article a[href*="/explore/locations/"], main a[href*="/explore/locations/"]',
    );
    const audioAnchor = document.querySelector<HTMLAnchorElement>(
      'article a[href*="/reels/audio/"], main a[href*="/reels/audio/"]',
    );

    return {
      title: document.title || null,
      description: meta('meta[name="description"]'),
      ogTitle: meta('meta[property="og:title"]'),
      ogDescription: meta('meta[property="og:description"]'),
      ogImage: meta('meta[property="og:image"]'),
      ogVideo:
        meta('meta[property="og:video"]') || meta('meta[property="og:video:secure_url"]'),
      canonical:
        document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || null,
      datetime:
        document.querySelector<HTMLTimeElement>("article time[datetime], main time[datetime]")
          ?.dateTime || null,
      headerText: text("header"),
      locationName: locationAnchor?.textContent?.trim() || null,
      audioTitle: audioAnchor?.textContent?.trim() || null,
      scripts,
    };
  });
}

async function collectDomMedia(page: Page): Promise<Omit<InstagramMediaItem, "index">[]> {
  return page.evaluate(() => {
    const results: Array<{
      kind: "IMAGE" | "VIDEO";
      url: string;
      thumbnailUrl: string | null;
      alt: string | null;
    }> = [];
    const seen = new Set<string>();
    const root = document.querySelector("article") ?? document.querySelector("main") ?? document;

    const push = (
      kind: "IMAGE" | "VIDEO",
      url: string | null | undefined,
      thumbnailUrl: string | null,
      alt: string | null,
    ) => {
      if (!url || seen.has(url)) return;
      if (!/^https?:\/\//i.test(url)) return;
      if (!/(cdninstagram|fbcdn|instagram)/i.test(url)) return;
      seen.add(url);
      results.push({ kind, url, thumbnailUrl, alt });
    };

    for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      const rect = image.getBoundingClientRect();
      const width = Math.max(image.naturalWidth || 0, rect.width || 0);
      const height = Math.max(image.naturalHeight || 0, rect.height || 0);
      if (width < 180 || height < 180) continue;
      push("IMAGE", image.currentSrc || image.src, null, image.alt || null);
    }

    for (const video of root.querySelectorAll<HTMLVideoElement>("video")) {
      push("VIDEO", video.currentSrc || video.src, video.poster || null, null);
      for (const source of video.querySelectorAll<HTMLSourceElement>("source[src]")) {
        push("VIDEO", source.src, video.poster || null, null);
      }
    }

    return results;
  });
}

async function collectCarouselMedia(page: Page) {
  const all = new Map<string, Omit<InstagramMediaItem, "index">>();
  const addCurrent = async () => {
    for (const item of await collectDomMedia(page)) {
      if (!all.has(item.url)) all.set(item.url, item);
    }
  };

  await addCurrent();

  for (let step = 0; step < 20; step += 1) {
    const article = page.locator("article");
    const nextButton = article.getByRole("button", { name: /^(next|다음)$/i }).last();
    if ((await nextButton.count()) === 0) break;

    try {
      if (!(await nextButton.isVisible({ timeout: 500 }))) break;
      await nextButton.click({ timeout: 1_500 });
      await page.waitForTimeout(250);
      await addCurrent();
    } catch {
      break;
    }
  }

  return [...all.values()];
}

async function assertPublicPageAvailable(page: Page, username: string) {
  const currentUrl = page.url();
  if (/\/accounts\/login|\/challenge\//i.test(currentUrl)) {
    throw new Error(
      `@${username} 페이지가 로그인 또는 추가 확인 화면으로 전환되었습니다. 비로그인 공개 범위에서는 수집할 수 없습니다.`,
    );
  }

  const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""))
    .slice(0, 8_000)
    .toLowerCase();

  if (
    bodyText.includes("this account is private") ||
    bodyText.includes("비공개 계정입니다") ||
    bodyText.includes("비공개 계정")
  ) {
    throw new Error(`@${username} 계정은 비공개 계정이라 수집할 수 없습니다.`);
  }

  if (
    bodyText.includes("sorry, this page isn't available") ||
    bodyText.includes("페이지를 사용할 수 없습니다")
  ) {
    throw new Error(`@${username} 프로필을 찾을 수 없거나 현재 접근할 수 없습니다.`);
  }
}

function displayNameFromOgTitle(ogTitle: string | null, username: string) {
  if (!ogTitle) return null;
  const marker = `(@${username})`;
  const index = ogTitle.toLowerCase().indexOf(marker.toLowerCase());
  const candidate = index > 0 ? ogTitle.slice(0, index).trim() : null;
  return candidate || null;
}

function buildFallbackProfile(
  username: string,
  profileUrl: string,
  signals: PageSignals,
): InstagramProfile {
  const description = signals.description ?? signals.ogDescription;
  return {
    username,
    profileUrl,
    displayName: displayNameFromOgTitle(signals.ogTitle, username),
    biography: null,
    profileImageUrl: signals.ogImage,
    followersCount: parseCountFromMeta(description, ["Followers", "팔로워"]),
    followingCount: parseCountFromMeta(description, ["Following", "팔로잉"]),
    postsCount: parseCountFromMeta(description, ["Posts", "게시물"]),
    isVerified: null,
    categoryName: null,
    externalUrl: null,
  };
}

async function discoverPostUrls(
  page: Page,
  limit: number,
  onProgress?: CollectOptions["onProgress"],
) {
  const urls = new Set<string>();
  let stalledRounds = 0;
  let previousSize = -1;

  for (let round = 0; round < MAX_SCROLL_ROUNDS && urls.size < limit; round += 1) {
    const hrefs = await page.locator('a[href*="/p/"],a[href*="/reel/"]').evaluateAll(
      (anchors) =>
        anchors
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter((href) => /^https:\/\/(www\.)?instagram\.com\/(p|reel)\//i.test(href)),
    );

    for (const href of hrefs) {
      const clean = href.split("?")[0];
      urls.add(clean.endsWith("/") ? clean : `${clean}/`);
      if (urls.size >= limit) break;
    }

    await onProgress?.({
      phase: "discover",
      message: `게시물 링크를 찾는 중 · ${Math.min(urls.size, limit).toLocaleString()}개 발견`,
      current: Math.min(urls.size, limit),
      total: limit,
    });

    if (urls.size === previousSize) stalledRounds += 1;
    else stalledRounds = 0;
    previousSize = urls.size;

    if (stalledRounds >= 5) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);
  }

  return [...urls].slice(0, limit);
}

function shortcodeFromUrl(url: string) {
  const match = url.match(/\/(?:p|reel)\/([^/?#]+)/i);
  return match?.[1] ?? "unknown";
}

function mergeMedia(
  ...groups: Array<Array<Omit<InstagramMediaItem, "index">>>
): InstagramMediaItem[] {
  const map = new Map<string, Omit<InstagramMediaItem, "index">>();
  for (const group of groups) {
    for (const item of group) {
      const previous = map.get(item.url);
      map.set(item.url, {
        kind: item.kind,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl ?? previous?.thumbnailUrl ?? null,
        alt: item.alt ?? previous?.alt ?? null,
      });
    }
  }
  return [...map.values()].map((item, index) => ({ ...item, index }));
}

async function collectOnePost(page: Page, url: string, username: string): Promise<InstagramPost> {
  const shortcode = shortcodeFromUrl(url);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await assertPublicPageAvailable(page, username);
    await page.waitForTimeout(450);

    const signals = await readPageSignals(page);
    const roots = parseJsonScripts(signals.scripts);
    const scriptPost = parsePostFromScripts(roots, shortcode);
    const carouselMedia = await collectCarouselMedia(page);

    const fallbackMedia: Array<Omit<InstagramMediaItem, "index">> = [];
    if (signals.ogVideo) {
      fallbackMedia.push({
        kind: "VIDEO",
        url: signals.ogVideo,
        thumbnailUrl: signals.ogImage,
        alt: null,
      });
    } else if (signals.ogImage) {
      fallbackMedia.push({
        kind: "IMAGE",
        url: signals.ogImage,
        thumbnailUrl: null,
        alt: null,
      });
    }

    const media = mergeMedia(scriptPost?.media ?? [], carouselMedia, fallbackMedia);
    const metaDescription = signals.ogDescription ?? signals.description;
    const caption = scriptPost?.caption ?? captionFromMetaDescription(metaDescription);
    const publishedAt = scriptPost?.publishedAt ?? signals.datetime;

    return normalizePost({
      status: caption || media.length > 0 ? "collected" : "partial",
      shortcode,
      url: signals.canonical?.includes("instagram.com/") ? signals.canonical : url,
      type: url.includes("/reel/") ? "REEL" : media.length > 1 ? "CAROUSEL" : "POST",
      caption,
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      taggedAccounts: scriptPost?.taggedAccounts ?? [],
      coauthors: scriptPost?.coauthors ?? [],
      publishedAt,
      likeCount:
        scriptPost?.likeCount ?? parseCountFromMeta(metaDescription, ["likes", "like", "좋아요"]),
      commentCount:
        scriptPost?.commentCount ??
        parseCountFromMeta(metaDescription, ["comments", "comment", "댓글"]),
      locationName: scriptPost?.locationName ?? signals.locationName,
      audioTitle: signals.audioTitle,
      media,
      error: null,
    });
  } catch (error) {
    return {
      status: "failed",
      shortcode,
      url,
      type: url.includes("/reel/") ? "REEL" : "POST",
      caption: null,
      hashtags: [],
      mentions: [],
      taggedAccounts: [],
      coauthors: [],
      publishedAt: null,
      likeCount: null,
      commentCount: null,
      locationName: null,
      audioTitle: null,
      media: [],
      error: error instanceof Error ? error.message : "게시물 수집 중 알 수 없는 오류가 발생했습니다.",
    };
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/executable|browser.*not found|install/i.test(message)) {
      throw new Error(
        "Playwright Chromium이 설치되지 않았습니다. 터미널에서 `npx playwright install chromium`을 실행해주세요.",
      );
    }
    throw error;
  }
}

export async function collectInstagramProfile({
  url,
  maxPosts = 0,
  onProgress,
}: CollectOptions): Promise<InstagramCollection> {
  const { username, profileUrl } = parseInstagramProfileUrl(url);
  const requestedLimit = Number.isFinite(maxPosts) ? Math.max(0, Math.floor(maxPosts)) : 0;
  const discoveryLimit =
    requestedLimit === 0
      ? ABSOLUTE_MAX_POSTS
      : Math.min(requestedLimit, ABSOLUTE_MAX_POSTS);
  const startedAt = new Date().toISOString();
  let browser: Browser | null = null;

  await onProgress?.({ phase: "launch", message: "Chromium 브라우저를 시작하는 중" });

  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1365, height: 900 },
    });
    const profilePage = await context.newPage();
    profilePage.setDefaultTimeout(15_000);

    await onProgress?.({ phase: "profile", message: `@${username} 공개 프로필을 확인하는 중` });
    await profilePage.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT,
    });
    await assertPublicPageAvailable(profilePage, username);
    await profilePage.waitForTimeout(750);

    const profileSignals = await readPageSignals(profilePage);
    const profileRoots = parseJsonScripts(profileSignals.scripts);
    const fallbackProfile = buildFallbackProfile(username, profileUrl, profileSignals);
    const scriptProfile = parseProfileFromScripts(profileRoots, username, profileUrl);
    const profile: InstagramProfile = {
      ...fallbackProfile,
      ...Object.fromEntries(
        Object.entries(scriptProfile).filter(([, value]) => value !== null && value !== undefined),
      ),
      username,
      profileUrl,
    } as InstagramProfile;

    const postUrls = await discoverPostUrls(profilePage, discoveryLimit, onProgress);
    const posts: InstagramPost[] = [];
    const postPage = await context.newPage();
    postPage.setDefaultTimeout(15_000);

    for (let index = 0; index < postUrls.length; index += 1) {
      await onProgress?.({
        phase: "posts",
        message: `게시물 상세 정보를 수집하는 중 · ${index + 1}/${postUrls.length}`,
        current: index + 1,
        total: postUrls.length,
      });
      posts.push(await collectOnePost(postPage, postUrls[index], username));
      if (index < postUrls.length - 1) await sleep(POST_DELAY_MS);
    }

    const collected = posts.filter((post) => post.status === "collected").length;
    const partial = posts.filter((post) => post.status === "partial").length;
    const failed = posts.filter((post) => post.status === "failed").length;
    const warnings = compactUnique([
      requestedLimit === 0 && postUrls.length >= ABSOLUTE_MAX_POSTS
        ? `안전한 실행을 위해 한 번에 최대 ${ABSOLUTE_MAX_POSTS.toLocaleString()}개 링크까지만 탐색합니다.`
        : null,
      "Instagram이 비로그인 사용자에게 노출한 공개 정보만 수집합니다. 로그인 벽, 비공개 계정, 지역/연령 제한 콘텐츠는 누락될 수 있습니다.",
      "이미지·영상 CDN URL은 원본 파일을 저장하지 않는 임시 참조 URL이며 시간이 지나면 만료될 수 있습니다.",
      "Instagram 화면 구조가 바뀌면 일부 필드가 null 또는 partial 상태로 저장될 수 있습니다.",
    ]);

    const result: InstagramCollection = {
      schemaVersion: 1,
      source: "instagram-public-web",
      profile,
      crawl: {
        startedAt,
        finishedAt: new Date().toISOString(),
        requestedLimit,
        discoveryLimit,
        found: postUrls.length,
        collected,
        partial,
        failed,
      },
      warnings,
      posts,
    };

    await onProgress?.({
      phase: "done",
      message: `수집 완료 · ${posts.length.toLocaleString()}개 처리`,
      current: posts.length,
      total: posts.length,
    });

    return result;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
