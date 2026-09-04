import fs from "node:fs";
import path from "node:path";
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
  InstagramSourceTab,
} from "./types";
import { parseInstagramProfileUrl } from "./url";

const MAX_SCROLL_ROUNDS_PER_TAB = 1_200;
const STALL_ROUNDS = 8;
const PAGE_TIMEOUT = 60_000;
const POST_DELAY_MS = 500;
const SESSION_FILE = path.join(process.cwd(), ".instagram-storage-state.json");

type CollectOptions = {
  url: string;
  maxPosts?: number;
  onProgress?: (progress: CollectorProgress) => void | Promise<void>;
};

type PageSignals = {
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogVideo: string | null;
  canonical: string | null;
  datetime: string | null;
  locationName: string | null;
  locationUrl: string | null;
  audioTitle: string | null;
  audioUrl: string | null;
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

    const scripts: string[] = [];
    let totalLength = 0;
    for (const script of document.querySelectorAll<HTMLScriptElement>(
      'script[type="application/json"],script[type="application/ld+json"]',
    )) {
      const raw = script.textContent?.trim();
      if (!raw || raw.length > 4_000_000) continue;
      if (totalLength + raw.length > 20_000_000) break;
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
      description: meta('meta[name="description"]'),
      ogTitle: meta('meta[property="og:title"]'),
      ogDescription: meta('meta[property="og:description"]'),
      ogImage: meta('meta[property="og:image"]'),
      ogVideo:
        meta('meta[property="og:video"]') || meta('meta[property="og:video:secure_url"]'),
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || null,
      datetime:
        document.querySelector<HTMLTimeElement>("article time[datetime], main time[datetime]")
          ?.dateTime || null,
      locationName: locationAnchor?.textContent?.trim() || null,
      locationUrl: locationAnchor?.href || null,
      audioTitle: audioAnchor?.textContent?.trim() || null,
      audioUrl: audioAnchor?.href || null,
      scripts,
    };
  });
}

async function collectDomMedia(page: Page): Promise<Omit<InstagramMediaItem, "index">[]> {
  return page.evaluate(() => {
    const results: Array<Omit<InstagramMediaItem, "index">> = [];
    const seen = new Set<string>();
    const root = document.querySelector("article") ?? document.querySelector("main") ?? document;

    const push = (item: Omit<InstagramMediaItem, "index">) => {
      if (!item.url || seen.has(item.url)) return;
      if (!/^https?:\/\//i.test(item.url)) return;
      if (!/(cdninstagram|fbcdn|instagram)/i.test(item.url)) return;
      seen.add(item.url);
      results.push(item);
    };

    for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      const rect = image.getBoundingClientRect();
      const width = Math.round(Math.max(image.naturalWidth || 0, rect.width || 0));
      const height = Math.round(Math.max(image.naturalHeight || 0, rect.height || 0));
      if (width < 180 || height < 180) continue;
      push({
        id: null,
        shortcode: null,
        kind: "IMAGE",
        url: image.currentSrc || image.src,
        thumbnailUrl: null,
        alt: image.alt || null,
        width: width || null,
        height: height || null,
        durationSeconds: null,
        viewCount: null,
        playCount: null,
      });
    }

    for (const video of root.querySelectorAll<HTMLVideoElement>("video")) {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      const width = video.videoWidth || null;
      const height = video.videoHeight || null;
      const urls = [video.currentSrc || video.src, ...[...video.querySelectorAll("source[src]")].map((s) => (s as HTMLSourceElement).src)];
      for (const url of urls) {
        push({
          id: null,
          shortcode: null,
          kind: "VIDEO",
          url,
          thumbnailUrl: video.poster || null,
          alt: null,
          width,
          height,
          durationSeconds: duration,
          viewCount: null,
          playCount: null,
        });
      }
    }
    return results;
  });
}

async function collectCarouselMedia(page: Page) {
  const all = new Map<string, Omit<InstagramMediaItem, "index">>();
  const addCurrent = async () => {
    for (const item of await collectDomMedia(page)) if (!all.has(item.url)) all.set(item.url, item);
  };

  await addCurrent();
  for (let step = 0; step < 30; step += 1) {
    const nextButton = page.locator("article").getByRole("button", { name: /^(next|다음)$/i }).last();
    if ((await nextButton.count()) === 0) break;
    try {
      if (!(await nextButton.isVisible({ timeout: 400 }))) break;
      await nextButton.click({ timeout: 1_500 });
      await page.waitForTimeout(220);
      await addCurrent();
    } catch {
      break;
    }
  }
  return [...all.values()];
}

async function assertPageAvailable(page: Page, username: string) {
  const currentUrl = page.url();
  if (/\/accounts\/login|\/challenge\//i.test(currentUrl)) {
    throw new Error(`@${username} 페이지가 로그인 또는 추가 확인 화면으로 전환되었습니다.`);
  }

  const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""))
    .slice(0, 10_000)
    .toLowerCase();
  if (bodyText.includes("this account is private") || bodyText.includes("비공개 계정")) {
    throw new Error(`@${username} 계정은 비공개 계정이라 현재 세션에서 수집할 수 없습니다.`);
  }
  if (bodyText.includes("sorry, this page isn't available") || bodyText.includes("페이지를 사용할 수 없습니다")) {
    throw new Error(`@${username} 프로필을 찾을 수 없거나 현재 접근할 수 없습니다.`);
  }
}

function displayNameFromOgTitle(ogTitle: string | null, username: string) {
  if (!ogTitle) return null;
  const marker = `(@${username})`;
  const index = ogTitle.toLowerCase().indexOf(marker.toLowerCase());
  return index > 0 ? ogTitle.slice(0, index).trim() || null : null;
}

function buildFallbackProfile(username: string, profileUrl: string, signals: PageSignals): InstagramProfile {
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
    bioLinks: [],
    pronouns: [],
    isBusinessAccount: null,
    isProfessionalAccount: null,
  };
}

function normalizeContentUrl(href: string) {
  if (!/^https:\/\/(www\.)?instagram\.com\/(p|reel)\//i.test(href)) return null;
  const clean = href.split("?")[0].split("#")[0];
  return clean.endsWith("/") ? clean : `${clean}/`;
}

async function discoverTab(
  page: Page,
  tabUrl: string,
  tab: InstagramSourceTab,
  global: Map<string, Set<InstagramSourceTab>>,
  maxPosts: number,
  onProgress?: CollectOptions["onProgress"],
) {
  await page.goto(tabUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
  if (/\/accounts\/login|\/challenge\//i.test(page.url())) {
    throw new Error("현재 브라우저 세션에서는 이 탭이 로그인/추가 확인 화면으로 전환됩니다.");
  }
  await page.waitForTimeout(650);

  let stalledRounds = 0;
  let previousSize = global.size;
  for (let round = 0; round < MAX_SCROLL_ROUNDS_PER_TAB; round += 1) {
    const hrefs = await page.locator('a[href*="/p/"],a[href*="/reel/"]').evaluateAll((anchors: Element[]) =>
      anchors.map((anchor: Element) => (anchor as HTMLAnchorElement).href),
    );

    for (const href of hrefs) {
      const normalized = normalizeContentUrl(href);
      if (!normalized) continue;
      const tabs = global.get(normalized) ?? new Set<InstagramSourceTab>();
      tabs.add(tab);
      global.set(normalized, tabs);
      if (maxPosts > 0 && global.size >= maxPosts) break;
    }

    await onProgress?.({
      phase: "discover",
      message: `${tab} 탭 탐색 중 · 총 ${global.size.toLocaleString()}개 발견`,
      current: global.size,
      total: maxPosts > 0 ? maxPosts : undefined,
    });

    if (maxPosts > 0 && global.size >= maxPosts) break;
    if (global.size === previousSize) stalledRounds += 1;
    else stalledRounds = 0;
    previousSize = global.size;
    if (stalledRounds >= STALL_ROUNDS) break;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(850);
  }
}

function shortcodeFromUrl(url: string) {
  return url.match(/\/(?:p|reel)\/([^/?#]+)/i)?.[1] ?? "unknown";
}

function mergeMedia(...groups: Array<Array<Omit<InstagramMediaItem, "index">>>): InstagramMediaItem[] {
  const map = new Map<string, Omit<InstagramMediaItem, "index">>();
  for (const group of groups) {
    for (const item of group) {
      const previous = map.get(item.url);
      map.set(item.url, {
        ...previous,
        ...item,
        id: item.id ?? previous?.id ?? null,
        shortcode: item.shortcode ?? previous?.shortcode ?? null,
        thumbnailUrl: item.thumbnailUrl ?? previous?.thumbnailUrl ?? null,
        alt: item.alt ?? previous?.alt ?? null,
        width: item.width ?? previous?.width ?? null,
        height: item.height ?? previous?.height ?? null,
        durationSeconds: item.durationSeconds ?? previous?.durationSeconds ?? null,
        viewCount: item.viewCount ?? previous?.viewCount ?? null,
        playCount: item.playCount ?? previous?.playCount ?? null,
      });
    }
  }
  return [...map.values()].map((item, index) => ({ ...item, index }));
}

async function collectOnePost(
  page: Page,
  url: string,
  username: string,
  sourceTabs: InstagramSourceTab[],
): Promise<InstagramPost> {
  const shortcode = shortcodeFromUrl(url);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await assertPageAvailable(page, username);
    await page.waitForTimeout(400);

    const signals = await readPageSignals(page);
    const scriptPost = parsePostFromScripts(parseJsonScripts(signals.scripts), shortcode);
    const carouselMedia = await collectCarouselMedia(page);
    const fallbackMedia: Array<Omit<InstagramMediaItem, "index">> = [];
    if (signals.ogVideo) {
      fallbackMedia.push({
        id: null, shortcode: null, kind: "VIDEO", url: signals.ogVideo,
        thumbnailUrl: signals.ogImage, alt: null, width: null, height: null,
        durationSeconds: null, viewCount: null, playCount: null,
      });
    } else if (signals.ogImage) {
      fallbackMedia.push({
        id: null, shortcode: null, kind: "IMAGE", url: signals.ogImage,
        thumbnailUrl: null, alt: null, width: null, height: null,
        durationSeconds: null, viewCount: null, playCount: null,
      });
    }

    const media = mergeMedia(scriptPost?.media ?? [], carouselMedia, fallbackMedia);
    const metaDescription = signals.ogDescription ?? signals.description;
    const caption = scriptPost?.caption ?? captionFromMetaDescription(metaDescription);

    return normalizePost({
      status: caption || media.length > 0 ? "collected" : "partial",
      id: scriptPost?.id ?? null,
      shortcode,
      url: signals.canonical?.includes("instagram.com/") ? signals.canonical : url,
      type: url.includes("/reel/") ? "REEL" : media.length > 1 ? "CAROUSEL" : "POST",
      sourceTabs,
      ownerUsername:
        scriptPost?.ownerUsername ??
        (sourceTabs.length === 1 && sourceTabs[0] === "tagged" ? null : username),
      caption,
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      taggedAccounts: scriptPost?.taggedAccounts ?? [],
      coauthors: scriptPost?.coauthors ?? [],
      isPinned: scriptPost?.isPinned ?? null,
      publishedAt: scriptPost?.publishedAt ?? signals.datetime,
      likeCount: scriptPost?.likeCount ?? parseCountFromMeta(metaDescription, ["likes", "like", "좋아요"]),
      commentCount: scriptPost?.commentCount ?? parseCountFromMeta(metaDescription, ["comments", "comment", "댓글"]),
      viewCount: scriptPost?.viewCount ?? null,
      playCount: scriptPost?.playCount ?? null,
      locationName: scriptPost?.locationName ?? signals.locationName,
      locationUrl: signals.locationUrl,
      audioTitle: scriptPost?.audioTitle ?? signals.audioTitle,
      audioUrl: scriptPost?.audioUrl ?? signals.audioUrl,
      audioArtist: scriptPost?.audioArtist ?? null,
      media,
      comments: scriptPost?.comments ?? [],
      error: null,
    });
  } catch (error) {
    return {
      status: "failed", id: null, shortcode, url,
      type: url.includes("/reel/") ? "REEL" : "POST",
      sourceTabs, ownerUsername: null, caption: null, hashtags: [], mentions: [],
      taggedAccounts: [], coauthors: [], isPinned: null, publishedAt: null,
      likeCount: null, commentCount: null, viewCount: null, playCount: null,
      locationName: null, locationUrl: null, audioTitle: null, audioUrl: null,
      audioArtist: null, media: [], comments: [],
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
      throw new Error("Playwright Chromium이 설치되지 않았습니다. `npx playwright install chromium`을 실행해주세요.");
    }
    throw error;
  }
}

export async function collectInstagramProfile({ url, maxPosts = 0, onProgress }: CollectOptions): Promise<InstagramCollection> {
  const { username, profileUrl } = parseInstagramProfileUrl(url);
  const requestedLimit = Number.isFinite(maxPosts) ? Math.max(0, Math.floor(maxPosts)) : 0;
  const startedAt = new Date().toISOString();
  const hasSession = fs.existsSync(SESSION_FILE);
  let browser: Browser | null = null;

  await onProgress?.({ phase: "launch", message: "Chromium 브라우저를 시작하는 중" });
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1365, height: 900 },
      ...(hasSession ? { storageState: SESSION_FILE } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    await onProgress?.({ phase: "profile", message: `@${username} 프로필 메타데이터를 확인하는 중` });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
    await assertPageAvailable(page, username);
    await page.waitForTimeout(650);

    const profileSignals = await readPageSignals(page);
    const fallbackProfile = buildFallbackProfile(username, profileUrl, profileSignals);
    const scriptProfile = parseProfileFromScripts(parseJsonScripts(profileSignals.scripts), username, profileUrl);
    const profile = {
      ...fallbackProfile,
      ...Object.fromEntries(Object.entries(scriptProfile).filter(([, value]) => value !== null && value !== undefined)),
      username,
      profileUrl,
    } as InstagramProfile;

    const discovered = new Map<string, Set<InstagramSourceTab>>();
    const tabCounts: Record<InstagramSourceTab, number> = { timeline: 0, reels: 0, tagged: 0 };
    const warnings: string[] = [];
    const tabs: Array<[InstagramSourceTab, string]> = [
      ["timeline", profileUrl],
      ["reels", `${profileUrl}reels/`],
      ["tagged", `${profileUrl}tagged/`],
    ];

    for (const [tab, tabUrl] of tabs) {
      if (requestedLimit > 0 && discovered.size >= requestedLimit) break;
      try {
        await discoverTab(page, tabUrl, tab, discovered, requestedLimit, onProgress);
      } catch (error) {
        warnings.push(`${tab} 탭: ${error instanceof Error ? error.message : "탐색 실패"}`);
      }
      tabCounts[tab] = [...discovered.values()].filter((sourceTabs) => sourceTabs.has(tab)).length;
    }

    const entries = [...discovered.entries()]
      .slice(0, requestedLimit > 0 ? requestedLimit : undefined)
      .map(([postUrl, sourceTabs]) => ({ postUrl, sourceTabs: [...sourceTabs] }));

    const posts: InstagramPost[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      await onProgress?.({
        phase: "posts",
        message: `게시물 상세 정보를 수집하는 중 · ${index + 1}/${entries.length}`,
        current: index + 1,
        total: entries.length,
      });
      posts.push(await collectOnePost(page, entries[index].postUrl, username, entries[index].sourceTabs));
      if (index < entries.length - 1) await sleep(POST_DELAY_MS);
    }

    const collected = posts.filter((post) => post.status === "collected").length;
    const partial = posts.filter((post) => post.status === "partial").length;
    const failed = posts.filter((post) => post.status === "failed").length;

    warnings.push(...compactUnique([
      hasSession
        ? "로컬 브라우저 로그인 세션을 사용했습니다. 대상 계정의 OAuth 승인은 필요하지 않습니다."
        : "비로그인 공개 모드입니다. `npm run instagram:login`으로 본인 브라우저 세션을 저장하면 로그인 사용자에게 공개되는 범위까지 수집할 수 있습니다.",
      "전체 선택 시 게시물 개수의 고정 상한은 두지 않으며 각 탭에서 새 링크가 더 이상 나타나지 않을 때까지 스크롤합니다.",
      "댓글은 페이지에 포함된 공개 JSON에서 확인되는 댓글만 저장되며 Instagram이 추가 로딩 뒤에만 제공하는 댓글 전체는 보장되지 않습니다.",
      "이미지·영상 URL은 파일 자체가 아니라 CDN 참조 URL이며 만료될 수 있습니다.",
      "Stories/Highlights, 팔로워·팔로잉 전체 목록, Insights(도달·노출·저장·공유), DM 등 현재 세션에 페이지 데이터로 제공되지 않는 정보는 수집할 수 없습니다.",
    ]));

    const result: InstagramCollection = {
      schemaVersion: 2,
      source: "instagram-web",
      profile,
      crawl: {
        startedAt,
        finishedAt: new Date().toISOString(),
        authMode: hasSession ? "browser-session" : "public",
        requestedLimit,
        found: entries.length,
        collected,
        partial,
        failed,
        discoveredByTab: tabCounts,
      },
      warnings: compactUnique(warnings),
      posts,
    };

    await onProgress?.({ phase: "done", message: `수집 완료 · ${posts.length.toLocaleString()}개 처리`, current: posts.length, total: posts.length });
    return result;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
