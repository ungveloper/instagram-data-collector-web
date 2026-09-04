const RESERVED_PATHS = new Set([
  "about",
  "accounts",
  "developer",
  "direct",
  "directory",
  "explore",
  "legal",
  "p",
  "privacy",
  "reel",
  "reels",
  "stories",
  "terms",
  "web",
]);

export function parseInstagramProfileUrl(input: string) {
  const trimmed = input.trim();
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("올바른 Instagram 프로필 URL을 입력해주세요.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "instagram.com") {
    throw new Error("instagram.com 프로필 URL만 사용할 수 있습니다.");
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length !== 1) {
    throw new Error("게시물 URL이 아니라 Instagram 프로필 URL을 입력해주세요.");
  }

  const username = segments[0].replace(/^@/, "");
  if (
    !/^[A-Za-z0-9._]{1,30}$/.test(username) ||
    RESERVED_PATHS.has(username.toLowerCase())
  ) {
    throw new Error("Instagram 사용자명을 확인할 수 없습니다.");
  }

  return {
    username,
    profileUrl: `https://www.instagram.com/${username}/`,
  };
}
