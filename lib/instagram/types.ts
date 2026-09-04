export type InstagramMediaKind = "IMAGE" | "VIDEO";
export type InstagramPostType = "POST" | "REEL" | "CAROUSEL";
export type InstagramPostStatus = "collected" | "partial" | "failed";

export type InstagramMediaItem = {
  index: number;
  kind: InstagramMediaKind;
  url: string;
  thumbnailUrl: string | null;
  alt: string | null;
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
};

export type InstagramPost = {
  status: InstagramPostStatus;
  shortcode: string;
  url: string;
  type: InstagramPostType;
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  taggedAccounts: string[];
  coauthors: string[];
  publishedAt: string | null;
  likeCount: number | null;
  commentCount: number | null;
  locationName: string | null;
  audioTitle: string | null;
  media: InstagramMediaItem[];
  error: string | null;
};

export type InstagramCollection = {
  schemaVersion: 1;
  source: "instagram-public-web";
  profile: InstagramProfile;
  crawl: {
    startedAt: string;
    finishedAt: string;
    requestedLimit: number;
    discoveryLimit: number;
    found: number;
    collected: number;
    partial: number;
    failed: number;
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
