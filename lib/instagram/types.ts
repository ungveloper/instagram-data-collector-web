export type InstagramMediaKind = "IMAGE" | "VIDEO";
export type InstagramPostType = "POST" | "REEL" | "CAROUSEL";
export type InstagramPostStatus = "collected" | "partial" | "failed";
export type InstagramSourceTab = "timeline" | "reels" | "tagged";

export type InstagramBioLink = {
  title: string | null;
  url: string;
};

export type InstagramMediaItem = {
  index: number;
  id: string | null;
  shortcode: string | null;
  kind: InstagramMediaKind;
  url: string;
  thumbnailUrl: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  viewCount: number | null;
  playCount: number | null;
};

export type InstagramComment = {
  id: string | null;
  username: string | null;
  text: string;
  publishedAt: string | null;
  likeCount: number | null;
  replyCount: number | null;
};

export type InstagramProfile = {
  username: string;
  profileUrl: string;
  displayName: string | null;
  biography: string | null;
  profileImageUrl: string | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  isVerified: boolean | null;
  categoryName: string | null;
  externalUrl: string | null;
  bioLinks: InstagramBioLink[];
  pronouns: string[];
  isBusinessAccount: boolean | null;
  isProfessionalAccount: boolean | null;
};

export type InstagramPost = {
  status: InstagramPostStatus;
  id: string | null;
  shortcode: string;
  url: string;
  type: InstagramPostType;
  sourceTabs: InstagramSourceTab[];
  ownerUsername: string | null;
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  taggedAccounts: string[];
  coauthors: string[];
  isPinned: boolean | null;
  publishedAt: string | null;
  likeCount: number | null;
  commentCount: number | null;
  viewCount: number | null;
  playCount: number | null;
  locationName: string | null;
  locationUrl: string | null;
  audioTitle: string | null;
  audioUrl: string | null;
  audioArtist: string | null;
  media: InstagramMediaItem[];
  comments: InstagramComment[];
  error: string | null;
};

export type InstagramCollection = {
  schemaVersion: 2;
  source: "instagram-web";
  profile: InstagramProfile;
  crawl: {
    startedAt: string;
    finishedAt: string;
    authMode: "public" | "browser-session";
    requestedLimit: number;
    found: number;
    collected: number;
    partial: number;
    failed: number;
    discoveredByTab: Record<InstagramSourceTab, number>;
  };
  warnings: string[];
  posts: InstagramPost[];
};

export type CollectorProgress = {
  phase: "launch" | "profile" | "discover" | "posts" | "done";
  message: string;
  current?: number;
  total?: number;
};
