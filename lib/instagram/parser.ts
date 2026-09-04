import type {
  InstagramBioLink,
  InstagramComment,
  InstagramMediaItem,
  InstagramPost,
  InstagramProfile,
} from "./types";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function firstString(record: JsonRecord, paths: string[][]): string | null {
  for (const path of paths) {
    const value = path.length === 1 ? record[path[0]] : nested(record, path);
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

function firstNumber(record: JsonRecord, paths: string[][]): number | null {
  for (const path of paths) {
    const value = path.length === 1 ? record[path[0]] : nested(record, path);
    const number = numberValue(value);
    if (number !== null) return number;
  }
  return null;
}

function firstBoolean(record: JsonRecord, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = path.length === 1 ? record[path[0]] : nested(record, path);
    const bool = booleanValue(value);
    if (bool !== null) return bool;
  }
  return null;
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
    if (visited > 120_000 || depth > 28 || value === null) return;
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
    for (const child of Object.values(value)) walk(child, depth + 1);
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
      // Instagram 페이지에는 JSON이 아닌 script payload가 섞일 수 있다.
    }
  }
  return parsed;
}

function parseBioLinks(candidate: JsonRecord): InstagramBioLink[] {
  const links: InstagramBioLink[] = [];
  const seen = new Set<string>();
  const arrays = [candidate.bio_links, candidate.bioLinks, candidate.external_links];

  for (const value of arrays) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isRecord(item)) continue;
      const url = firstString(item, [["url"], ["lynx_url"], ["href"]]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({ title: firstString(item, [["title"], ["text"]]), url });
    }
  }

  const direct = firstString(candidate, [["external_url"], ["externalUrl"]]);
  if (direct && !seen.has(direct)) links.push({ title: null, url: direct });
  return links;
}

function parsePronouns(candidate: JsonRecord) {
  const value = candidate.pronouns;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter((item): item is string => Boolean(item)))];
}

export function parseProfileFromScripts(
  roots: unknown[],
  username: string,
  profileUrl: string,
): Partial<InstagramProfile> {
  const target = username.toLowerCase();
  const candidate = deepFindBest(
    roots,
    (record) => stringValue(record.username)?.toLowerCase() === target,
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
        "bio_links",
        "is_verified",
      ];
      return keys.reduce((sum, key) => sum + (record[key] !== undefined ? 1 : 0), 0);
    },
  );

  if (!candidate) return { username, profileUrl };

  return {
    username,
    profileUrl,
    displayName: firstString(candidate, [["full_name"], ["fullName"]]),
    biography: firstString(candidate, [["biography"], ["bio"]]),
    profileImageUrl: firstString(candidate, [
      ["profile_pic_url_hd"],
      ["profile_pic_url"],
      ["profilePicUrl"],
    ]),
    followersCount: firstNumber(candidate, [
      ["edge_followed_by", "count"],
      ["follower_count"],
      ["followers_count"],
    ]),
    followingCount: firstNumber(candidate, [
      ["edge_follow", "count"],
      ["following_count"],
      ["follows_count"],
    ]),
    postsCount: firstNumber(candidate, [
      ["edge_owner_to_timeline_media", "count"],
      ["media_count"],
      ["posts_count"],
    ]),
    isVerified: firstBoolean(candidate, [["is_verified"], ["isVerified"]]),
    categoryName: firstString(candidate, [["category_name"], ["category"]]),
    externalUrl: firstString(candidate, [["external_url"], ["externalUrl"]]),
    bioLinks: parseBioLinks(candidate),
    pronouns: parsePronouns(candidate),
    isBusinessAccount: firstBoolean(candidate, [["is_business_account"], ["isBusinessAccount"]]),
    isProfessionalAccount: firstBoolean(candidate, [
      ["is_professional_account"],
      ["isProfessionalAccount"],
    ]),
  };
}

function captionFromCandidate(candidate: JsonRecord): string | null {
  const direct = firstString(candidate, [["caption"], ["text"], ["description"]]);
  if (direct) return direct;

  const captionText = nested(candidate, ["caption", "text"]);
  if (typeof captionText === "string" && captionText.trim()) return captionText.trim();

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
  const sources = [
    nested(candidate, ["edge_media_to_tagged_user", "edges"]),
    candidate.usertags,
  ];

  for (const source of sources) {
    const values = isRecord(source) && Array.isArray(source.in) ? source.in : source;
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      const node = isRecord(item) && isRecord(item.node) ? item.node : item;
      if (!isRecord(node)) continue;
      const user = isRecord(node.user) ? node.user : node;
      const username = isRecord(user) ? stringValue(user.username) : null;
      if (username) usernames.add(username);
    }
  }
  return [...usernames];
}

function collectCoauthors(candidate: JsonRecord) {
  const usernames = new Set<string>();
  for (const key of ["coauthor_producers", "invited_coauthor_producers", "collaborators"]) {
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

  const pushNode = (node: JsonRecord) => {
    const videoUrl = firstString(node, [["video_url"], ["videoUrl"]]);
    const displayUrl = firstString(node, [
      ["display_url"],
      ["displayUrl"],
      ["thumbnail_src"],
      ["image_versions2", "candidates", "0", "url"],
    ]);
    const url = videoUrl ?? displayUrl;
    if (!url || seen.has(url)) return;
    seen.add(url);

    const dimensions = isRecord(node.dimensions) ? node.dimensions : null;
    media.push({
      id: firstString(node, [["id"], ["pk"]]),
      shortcode: firstString(node, [["shortcode"], ["code"]]),
      kind: videoUrl ? "VIDEO" : "IMAGE",
      url,
      thumbnailUrl: videoUrl ? displayUrl : null,
      alt: firstString(node, [["accessibility_caption"], ["accessibilityCaption"]]),
      width:
        (dimensions ? numberValue(dimensions.width) : null) ??
        firstNumber(node, [["original_width"], ["width"]]),
      height:
        (dimensions ? numberValue(dimensions.height) : null) ??
        firstNumber(node, [["original_height"], ["height"]]),
      durationSeconds: firstNumber(node, [["video_duration"], ["duration"]]),
      viewCount: firstNumber(node, [["video_view_count"], ["view_count"]]),
      playCount: firstNumber(node, [["video_play_count"], ["play_count"]]),
    });
  };

  const sidecar = nested(candidate, ["edge_sidecar_to_children", "edges"]);
  if (Array.isArray(sidecar)) {
    for (const edge of sidecar) {
      if (isRecord(edge) && isRecord(edge.node)) pushNode(edge.node);
    }
  }

  const carousel = candidate.carousel_media;
  if (Array.isArray(carousel)) {
    for (const item of carousel) if (isRecord(item)) pushNode(item);
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

function commentFromRecord(record: JsonRecord): InstagramComment | null {
  const text = firstString(record, [["text"], ["comment_text"]]);
  if (!text) return null;
  const user = isRecord(record.owner) ? record.owner : isRecord(record.user) ? record.user : null;
  return {
    id: firstString(record, [["id"], ["pk"]]),
    username: user ? stringValue(user.username) : stringValue(record.username),
    text,
    publishedAt:
      isoFromTimestamp(record.created_at) ??
      isoFromTimestamp(record.created_at_utc) ??
      isoFromTimestamp(record.taken_at) ??
      isoFromTimestamp(record.timestamp),
    likeCount: firstNumber(record, [["comment_like_count"], ["like_count"]]),
    replyCount: firstNumber(record, [["child_comment_count"], ["reply_count"]]),
  };
}

function collectComments(candidate: JsonRecord) {
  const comments: InstagramComment[] = [];
  const seen = new Set<string>();
  const sources: unknown[] = [
    nested(candidate, ["edge_media_to_parent_comment", "edges"]),
    nested(candidate, ["edge_media_to_comment", "edges"]),
    candidate.preview_comments,
    candidate.comments,
  ];

  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const record = isRecord(item) && isRecord(item.node) ? item.node : item;
      if (!isRecord(record)) continue;
      const comment = commentFromRecord(record);
      if (!comment) continue;
      const key = comment.id ?? `${comment.username ?? ""}:${comment.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push(comment);
    }
  }
  return comments;
}

function audioFromCandidate(candidate: JsonRecord) {
  const title = firstString(candidate, [
    ["clips_metadata", "music_info", "music_asset_info", "title"],
    ["clips_metadata", "original_sound_info", "original_audio_title"],
    ["music_metadata", "music_info", "music_asset_info", "title"],
    ["audio_title"],
  ]);
  const url = firstString(candidate, [
    ["clips_metadata", "original_sound_info", "progressive_download_url"],
    ["audio_url"],
  ]);
  const artist = firstString(candidate, [
    ["clips_metadata", "music_info", "music_asset_info", "display_artist"],
    ["clips_metadata", "original_sound_info", "ig_artist", "username"],
    ["clips_metadata", "original_sound_info", "ig_artist", "full_name"],
    ["audio_artist"],
  ]);
  return { title, url, artist };
}

export function parsePostFromScripts(roots: unknown[], shortcode: string) {
  const candidate = deepFindBest(
    roots,
    (record) =>
      firstString(record, [["shortcode"], ["code"], ["media_code"]]) === shortcode,
    (record) => {
      const keys = [
        "edge_media_to_caption",
        "caption",
        "display_url",
        "video_url",
        "taken_at_timestamp",
        "edge_sidecar_to_children",
        "carousel_media",
        "edge_media_preview_like",
        "edge_media_to_comment",
        "clips_metadata",
      ];
      return keys.reduce((sum, key) => sum + (record[key] !== undefined ? 1 : 0), 0);
    },
  );

  if (!candidate) return null;
  const location = isRecord(candidate.location) ? candidate.location : null;
  const owner = isRecord(candidate.owner)
    ? candidate.owner
    : isRecord(candidate.user)
      ? candidate.user
      : null;
  const audio = audioFromCandidate(candidate);

  return {
    id: firstString(candidate, [["id"], ["pk"]]),
    ownerUsername: owner ? stringValue(owner.username) : null,
    caption: captionFromCandidate(candidate),
    publishedAt:
      isoFromTimestamp(candidate.taken_at_timestamp) ??
      isoFromTimestamp(candidate.taken_at) ??
      isoFromTimestamp(candidate.date),
    likeCount: firstNumber(candidate, [
      ["edge_media_preview_like", "count"],
      ["edge_liked_by", "count"],
      ["like_count"],
    ]),
    commentCount: firstNumber(candidate, [
      ["edge_media_to_comment", "count"],
      ["comment_count"],
    ]),
    viewCount: firstNumber(candidate, [["video_view_count"], ["view_count"]]),
    playCount: firstNumber(candidate, [["video_play_count"], ["play_count"]]),
    isPinned: firstBoolean(candidate, [["is_pinned"], ["isPinned"]]),
    locationName: location ? stringValue(location.name) : null,
    taggedAccounts: collectTaggedAccounts(candidate),
    coauthors: collectCoauthors(candidate),
    audioTitle: audio.title,
    audioUrl: audio.url,
    audioArtist: audio.artist,
    comments: collectComments(candidate),
    media: mediaFromCandidate(candidate),
  };
}

export function extractHashtags(caption: string | null) {
  if (!caption) return [];
  return [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])].map((tag) => tag.slice(1));
}

export function extractMentions(caption: string | null) {
  if (!caption) return [];
  return [...new Set(caption.match(/@[A-Za-z0-9._]+/g) ?? [])].map((mention) => mention.slice(1));
}

export function captionFromMetaDescription(description: string | null) {
  if (!description) return null;
  const quoted = description.match(/:\s*["“]([\s\S]+?)["”]\s*$/);
  return quoted?.[1]?.trim() || null;
}

export function parseCountFromMeta(description: string | null, labels: string[]): number | null {
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
    suffix === "k" ? 1_000 :
    suffix === "m" ? 1_000_000 :
    suffix === "b" ? 1_000_000_000 :
    suffix === "만" ? 10_000 :
    suffix === "천" ? 1_000 :
    suffix === "백" ? 100 : 1;
  return Math.round(value * multiplier);
}

export function normalizePost(post: InstagramPost): InstagramPost {
  const media = post.media.map((item, index) => ({ ...item, index }));
  const type = post.url.includes("/reel/") ? "REEL" : media.length > 1 ? "CAROUSEL" : "POST";
  return {
    ...post,
    type,
    media,
    sourceTabs: [...new Set(post.sourceTabs)],
    taggedAccounts: [...new Set(post.taggedAccounts)],
    coauthors: [...new Set(post.coauthors)],
    status:
      post.status === "failed"
        ? "failed"
        : post.caption || media.length > 0
          ? post.status
          : "partial",
  };
}
