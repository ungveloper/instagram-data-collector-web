import type {
  InstagramMediaItem,
  InstagramPost,
  InstagramProfile,
} from "./types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nested(record: JsonRecord, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function deepFindBest(
  roots: unknown[],
  predicate: (record: JsonRecord) => boolean,
  score: (record: JsonRecord) => number,
): JsonRecord | null {
  let best: JsonRecord | null = null;
  let bestScore = -1;
  let visited = 0;

  const walk = (value: unknown, depth: number) => {
    if (visited > 80_000 || depth > 24 || value === null) return;
    visited += 1;

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    if (!isRecord(value)) return;

    if (predicate(value)) {
      const candidateScore = score(value);
      if (candidateScore > bestScore) {
        best = value;
        bestScore = candidateScore;
      }
    }

    for (const child of Object.values(value)) {
      walk(child, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return best;
}

export function parseJsonScripts(rawScripts: string[]) {
  const parsed: unknown[] = [];
  for (const raw of rawScripts) {
    try {
      parsed.push(JSON.parse(raw));
    } catch {
      // Instagram can include non-JSON script payloads. Ignore those safely.
    }
  }
  return parsed;
}

export function parseProfileFromScripts(
  roots: unknown[],
  username: string,
  profileUrl: string,
): Partial<InstagramProfile> {
  const target = username.toLowerCase();
  const candidate = deepFindBest(
    roots,
    (record) => {
      const directUsername = stringValue(record.username)?.toLowerCase();
      return directUsername === target;
    },
    (record) => {
      const keys = [
        "full_name",
        "biography",
        "profile_pic_url_hd",
        "profile_pic_url",
        "edge_followed_by",
        "edge_follow",
        "edge_owner_to_timeline_media",
        "follower_count",
        "following_count",
        "media_count",
      ];
      return keys.reduce((sum, key) => sum + (record[key] !== undefined ? 1 : 0), 0);
    },
  );

  if (!candidate) return { username, profileUrl };

  return {
    username,
    profileUrl,
    displayName:
      stringValue(candidate.full_name) ?? stringValue(candidate.fullName),
    biography: stringValue(candidate.biography) ?? stringValue(candidate.bio),
    profileImageUrl:
      stringValue(candidate.profile_pic_url_hd) ??
      stringValue(candidate.profile_pic_url) ??
      stringValue(candidate.profilePicUrl),
    followersCount:
      numberValue(nested(candidate, ["edge_followed_by", "count"])) ??
      numberValue(candidate.follower_count) ??
      numberValue(candidate.followers_count),
    followingCount:
      numberValue(nested(candidate, ["edge_follow", "count"])) ??
      numberValue(candidate.following_count) ??
      numberValue(candidate.follows_count),
    postsCount:
      numberValue(nested(candidate, ["edge_owner_to_timeline_media", "count"])) ??
      numberValue(candidate.media_count) ??
      numberValue(candidate.posts_count),
    isVerified:
      booleanValue(candidate.is_verified) ?? booleanValue(candidate.isVerified),
    categoryName:
      stringValue(candidate.category_name) ?? stringValue(candidate.category),
    externalUrl:
      stringValue(candidate.external_url) ?? stringValue(candidate.externalUrl),
  };
}

function captionFromCandidate(candidate: JsonRecord): string | null {
  const direct =
    stringValue(candidate.caption) ??
    stringValue(candidate.text) ??
    stringValue(candidate.description);
  if (direct) return direct;

  const captionText = nested(candidate, ["caption", "text"]);
  if (typeof captionText === "string" && captionText.trim()) {
    return captionText.trim();
  }

  const edges = nested(candidate, ["edge_media_to_caption", "edges"]);
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (!isRecord(edge) || !isRecord(edge.node)) continue;
      const text = stringValue(edge.node.text);
      if (text) return text;
    }
  }

  return null;
}

function collectTaggedAccounts(candidate: JsonRecord) {
  const usernames = new Set<string>();
  const edges = nested(candidate, ["edge_media_to_tagged_user", "edges"]);
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (!isRecord(edge) || !isRecord(edge.node) || !isRecord(edge.node.user)) continue;
      const username = stringValue(edge.node.user.username);
      if (username) usernames.add(username);
    }
  }
  return [...usernames];
}

function collectCoauthors(candidate: JsonRecord) {
  const usernames = new Set<string>();
  for (const key of ["coauthor_producers", "invited_coauthor_producers"]) {
    const value = candidate[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isRecord(item)) continue;
      const username = stringValue(item.username);
      if (username) usernames.add(username);
    }
  }
  return [...usernames];
}

function mediaFromCandidate(candidate: JsonRecord) {
  const media: Omit<InstagramMediaItem, "index">[] = [];
  const seen = new Set<string>();

  const pushMedia = (
    kind: "IMAGE" | "VIDEO",
    url: string | null,
    thumbnailUrl: string | null = null,
    alt: string | null = null,
  ) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    media.push({ kind, url, thumbnailUrl, alt });
  };

  const pushNode = (node: JsonRecord) => {
    const videoUrl = stringValue(node.video_url) ?? stringValue(node.videoUrl);
    const displayUrl =
      stringValue(node.display_url) ??
      stringValue(node.displayUrl) ??
      stringValue(node.thumbnail_src);
    const alt =
      stringValue(node.accessibility_caption) ?? stringValue(node.accessibilityCaption);

    if (videoUrl) pushMedia("VIDEO", videoUrl, displayUrl, alt);
    else if (displayUrl) pushMedia("IMAGE", displayUrl, null, alt);
  };

  const sidecar = nested(candidate, ["edge_sidecar_to_children", "edges"]);
  if (Array.isArray(sidecar)) {
    for (const edge of sidecar) {
      if (isRecord(edge) && isRecord(edge.node)) pushNode(edge.node);
    }
  }

  pushNode(candidate);
  return media;
}

function isoFromTimestamp(value: unknown) {
  const number = numberValue(value);
  if (number !== null) {
    const millis = number > 10_000_000_000 ? number : number * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const text = stringValue(value);
  if (text) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

export function parsePostFromScripts(roots: unknown[], shortcode: string) {
  const candidate = deepFindBest(
    roots,
    (record) => {
      const code =
        stringValue(record.shortcode) ??
        stringValue(record.code) ??
        stringValue(record.media_code);
      return code === shortcode;
    },
    (record) => {
      const keys = [
        "edge_media_to_caption",
        "caption",
        "display_url",
        "video_url",
        "taken_at_timestamp",
        "edge_sidecar_to_children",
        "edge_media_preview_like",
        "edge_media_to_comment",
      ];
      return keys.reduce((sum, key) => sum + (record[key] !== undefined ? 1 : 0), 0);
    },
  );

  if (!candidate) return null;

  const location = candidate.location;
  const locationName = isRecord(location) ? stringValue(location.name) : null;

  return {
    caption: captionFromCandidate(candidate),
    publishedAt:
      isoFromTimestamp(candidate.taken_at_timestamp) ??
      isoFromTimestamp(candidate.taken_at) ??
      isoFromTimestamp(candidate.date),
    likeCount:
      numberValue(nested(candidate, ["edge_media_preview_like", "count"])) ??
      numberValue(nested(candidate, ["edge_liked_by", "count"])) ??
      numberValue(candidate.like_count),
    commentCount:
      numberValue(nested(candidate, ["edge_media_to_comment", "count"])) ??
      numberValue(candidate.comment_count),
    locationName,
    taggedAccounts: collectTaggedAccounts(candidate),
    coauthors: collectCoauthors(candidate),
    media: mediaFromCandidate(candidate),
  };
}

export function extractHashtags(caption: string | null) {
  if (!caption) return [];
  return [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])].map((tag) =>
    tag.slice(1),
  );
}

export function extractMentions(caption: string | null) {
  if (!caption) return [];
  return [...new Set(caption.match(/@[A-Za-z0-9._]+/g) ?? [])].map((mention) =>
    mention.slice(1),
  );
}

export function captionFromMetaDescription(description: string | null) {
  if (!description) return null;

  const quoted = description.match(/:\s*["“]([\s\S]+?)["”]\s*$/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();

  return null;
}

export function parseCountFromMeta(
  description: string | null,
  labels: string[],
): number | null {
  if (!description) return null;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`([\\d,.]+(?:[KMB만천백]?)?)\\s*${escaped}`, "i");
    const match = description.match(regex);
    if (!match) continue;
    const parsed = parseHumanNumber(match[1]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseHumanNumber(input: string) {
  const normalized = input.replace(/,/g, "").trim();
  const match = normalized.match(/^([\d.]+)\s*([KMB만천백]?)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = match[2].toLowerCase();
  const multiplier =
    suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "b"
          ? 1_000_000_000
          : suffix === "만"
            ? 10_000
            : suffix === "천"
              ? 1_000
              : suffix === "백"
                ? 100
                : 1;

  return Math.round(value * multiplier);
}

export function normalizePost(post: InstagramPost): InstagramPost {
  const media = post.media.map((item, index) => ({ ...item, index }));
  const type = post.url.includes("/reel/")
    ? "REEL"
    : media.length > 1
      ? "CAROUSEL"
      : "POST";

  return {
    ...post,
    type,
    media,
    status:
      post.status === "failed"
        ? "failed"
        : post.caption || media.length > 0
          ? post.status
          : "partial",
  };
}
