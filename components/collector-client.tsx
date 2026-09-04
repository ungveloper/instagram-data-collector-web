"use client";

import { FormEvent, useMemo, useState } from "react";
import type {
  CollectorProgress,
  InstagramCollection,
  InstagramPost,
} from "@/lib/instagram/types";

type StreamEvent =
  | { type: "progress"; progress: CollectorProgress }
  | { type: "result"; result: InstagramCollection }
  | { type: "error"; error: string };

const LIMIT_OPTIONS = [
  { label: "50개", value: 50 },
  { label: "100개", value: 100 },
  { label: "250개", value: 250 },
  { label: "500개", value: 500 },
  { label: "가능한 만큼", value: 0 },
];

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function postsToCsv(collection: InstagramCollection) {
  const headers = [
    "profile_username", "profile_display_name", "profile_biography", "profile_followers_count",
    "profile_following_count", "profile_posts_count", "profile_is_verified", "profile_category",
    "profile_external_url", "profile_bio_links", "post_id", "shortcode", "status", "type", "source_tabs", "url",
    "owner_username", "published_at", "is_pinned", "caption", "hashtags", "mentions",
    "tagged_accounts", "coauthors", "like_count", "comment_count", "view_count", "play_count",
    "location_name", "location_url", "audio_title", "audio_artist", "audio_url",
    "media_count", "media_ids", "media_types", "media_urls", "thumbnail_urls", "media_alt_texts",
    "media_dimensions", "media_durations", "media_view_counts", "media_play_counts",
    "captured_comments_count", "captured_comments_json", "error",
  ];

  const rows = collection.posts.map((post) => [
    collection.profile.username,
    collection.profile.displayName,
    collection.profile.biography,
    collection.profile.followersCount,
    collection.profile.followingCount,
    collection.profile.postsCount,
    collection.profile.isVerified,
    collection.profile.categoryName,
    collection.profile.externalUrl,
    collection.profile.bioLinks.map((link) => link.url).join(" | "),
    post.id,
    post.shortcode,
    post.status,
    post.type,
    post.sourceTabs.join(" "),
    post.url,
    post.ownerUsername,
    post.publishedAt,
    post.isPinned,
    post.caption,
    post.hashtags.join(" "),
    post.mentions.join(" "),
    post.taggedAccounts.join(" "),
    post.coauthors.join(" "),
    post.likeCount,
    post.commentCount,
    post.viewCount,
    post.playCount,
    post.locationName,
    post.locationUrl,
    post.audioTitle,
    post.audioArtist,
    post.audioUrl,
    post.media.length,
    post.media.map((media) => media.id).filter(Boolean).join(" | "),
    post.media.map((media) => media.kind).join(" | "),
    post.media.map((media) => media.url).join(" | "),
    post.media.map((media) => media.thumbnailUrl).filter(Boolean).join(" | "),
    post.media.map((media) => media.alt).filter(Boolean).join(" | "),
    post.media.map((media) => `${media.width ?? ""}x${media.height ?? ""}`).join(" | "),
    post.media.map((media) => media.durationSeconds).filter((value) => value !== null).join(" | "),
    post.media.map((media) => media.viewCount).filter((value) => value !== null).join(" | "),
    post.media.map((media) => media.playCount).filter((value) => value !== null).join(" | "),
    post.comments.length,
    JSON.stringify(post.comments),
    post.error,
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filePrefix(collection: InstagramCollection) {
  const date = collection.crawl.finishedAt.slice(0, 10);
  return `instagram-${collection.profile.username}-${date}`;
}

function statusLabel(post: InstagramPost) {
  if (post.status === "collected") return "완료";
  if (post.status === "partial") return "일부";
  return "실패";
}

export function CollectorClient() {
  const [url, setUrl] = useState("");
  const [maxPosts, setMaxPosts] = useState(100);
  const [progress, setProgress] = useState<CollectorProgress | null>(null);
  const [result, setResult] = useState<InstagramCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const progressPercent = useMemo(() => {
    if (!progress?.total || !progress.current) return null;
    return Math.min(100, Math.round((progress.current / progress.total) * 100));
  }, [progress]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isRunning) return;

    setIsRunning(true);
    setError(null);
    setResult(null);
    setProgress({ phase: "launch", message: "수집 요청을 준비하는 중" });

    try {
      const response = await fetch("/api/instagram/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxPosts }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `요청이 실패했습니다. (${response.status})`);
      }
      if (!response.body) throw new Error("서버 응답 스트림을 읽을 수 없습니다.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          if (!raw.trim()) continue;
          const eventData = JSON.parse(raw) as StreamEvent;
          if (eventData.type === "progress") setProgress(eventData.progress);
          if (eventData.type === "result") setResult(eventData.result);
          if (eventData.type === "error") throw new Error(eventData.error);
        }
      }

      if (buffer.trim()) {
        const eventData = JSON.parse(buffer) as StreamEvent;
        if (eventData.type === "result") setResult(eventData.result);
        if (eventData.type === "error") throw new Error(eventData.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "수집 중 오류가 발생했습니다.");
    } finally {
      setIsRunning(false);
    }
  }

  function downloadJson() {
    if (!result) return;
    downloadText(
      `${filePrefix(result)}.json`,
      JSON.stringify(result, null, 2),
      "application/json;charset=utf-8",
    );
  }

  function downloadCsv() {
    if (!result) return;
    downloadText(
      `${filePrefix(result)}.csv`,
      `\uFEFF${postsToCsv(result)}`,
      "text/csv;charset=utf-8",
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-10 text-zinc-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-col gap-3">
          <div className="inline-flex w-fit items-center rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-600 shadow-sm">
            Public Web Collector · Local-first
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Instagram Data Collector
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-zinc-600 sm:text-base">
            Instagram 프로필 URL을 입력하면 메인 피드·Reels·Tagged 탭을 끝까지 탐색하고,
            각 콘텐츠의 캡션·태그·공동작성자·반응 수·위치·오디오·미디어·페이지에 포함된 댓글 등
            가능한 공개 메타데이터를 JSON 또는 CSV로 정리합니다.
          </p>
        </header>

        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <form onSubmit={handleSubmit} className="grid gap-4 lg:grid-cols-[1fr_180px_auto] lg:items-end">
            <label className="grid gap-2">
              <span className="text-sm font-semibold">Instagram 프로필 URL</span>
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.instagram.com/username/"
                className="h-12 rounded-xl border border-zinc-300 bg-white px-4 text-sm outline-none transition focus:border-zinc-950 focus:ring-2 focus:ring-zinc-950/10"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold">수집 범위</span>
              <select
                value={maxPosts}
                onChange={(event) => setMaxPosts(Number(event.target.value))}
                className="h-12 rounded-xl border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-950"
              >
                {LIMIT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={isRunning}
              className="h-12 rounded-xl bg-zinc-950 px-6 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              {isRunning ? "수집 중…" : "데이터 수집"}
            </button>
          </form>

          <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
            “가능한 만큼”은 2,000개 같은 게시물 고정 상한 없이 새 링크가 더 이상 나타나지 않을 때까지
            메인·Reels·Tagged 탭을 탐색합니다. 비로그인으로 부족하면 터미널에서 npm run instagram:login을
            실행해 본인 브라우저 세션을 저장할 수 있습니다. 로그인/CAPTCHA를 자동 우회하지는 않습니다.
          </div>
        </section>

        {(isRunning || progress) && (
          <section className="mt-5 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">진행 상태</p>
                <p className="mt-1 text-sm font-medium text-zinc-900">
                  {progress?.message ?? "준비 중"}
                </p>
              </div>
              {progressPercent !== null && (
                <span className="text-sm font-semibold tabular-nums">{progressPercent}%</span>
              )}
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100">
              <div
                className={`h-full rounded-full bg-zinc-950 transition-all ${progressPercent === null ? "w-1/3 animate-pulse" : ""}`}
                style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
              />
            </div>
          </section>
        )}

        {error && (
          <section className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-800">
            <strong className="font-semibold">수집 실패</strong>
            <p className="mt-1">{error}</p>
          </section>
        )}

        {result && (
          <section className="mt-5 space-y-5">
            <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">수집 결과</p>
                  <h2 className="mt-1 text-2xl font-bold">@{result.profile.username}</h2>
                  {result.profile.displayName && (
                    <p className="mt-1 text-sm text-zinc-600">{result.profile.displayName}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={downloadJson}
                    className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-zinc-50"
                  >
                    JSON 다운로드
                  </button>
                  <button
                    type="button"
                    onClick={downloadCsv}
                    className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
                  >
                    CSV 다운로드
                  </button>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ["발견", result.crawl.found],
                  ["완료", result.crawl.collected],
                  ["일부", result.crawl.partial],
                  ["실패", result.crawl.failed],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-zinc-50 p-4">
                    <p className="text-xs font-medium text-zinc-500">{label}</p>
                    <p className="mt-1 text-2xl font-bold tabular-nums">{Number(value).toLocaleString()}</p>
                  </div>
                ))}
              </div>

              {result.warnings.length > 0 && (
                <ul className="mt-5 space-y-1 rounded-xl bg-zinc-50 p-4 text-xs leading-5 text-zinc-600">
                  {result.warnings.map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
              <div className="border-b border-zinc-200 px-5 py-4">
                <h3 className="font-semibold">게시물 미리보기</h3>
                <p className="mt-1 text-xs text-zinc-500">
                  화면에는 최대 50개만 표시하며 다운로드 파일에는 수집된 전체 결과가 포함됩니다.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-500">
                    <tr>
                      <th className="px-4 py-3 font-semibold">상태</th>
                      <th className="px-4 py-3 font-semibold">유형</th>
                      <th className="px-4 py-3 font-semibold">Shortcode</th>
                      <th className="min-w-80 px-4 py-3 font-semibold">Caption</th>
                      <th className="px-4 py-3 font-semibold">Media</th>
                      <th className="px-4 py-3 font-semibold">게시일</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {result.posts.slice(0, 50).map((post) => (
                      <tr key={`${post.shortcode}-${post.url}`} className="align-top">
                        <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold">
                          {statusLabel(post)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs">{post.type}</td>
                        <td className="px-4 py-3">
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs underline decoration-zinc-300 underline-offset-2"
                          >
                            {post.shortcode}
                          </a>
                        </td>
                        <td className="max-w-xl px-4 py-3 text-xs leading-5 text-zinc-700">
                          {post.caption ? (
                            <p className="line-clamp-4 whitespace-pre-wrap">{post.caption}</p>
                          ) : (
                            <span className="text-zinc-400">캡션 없음</span>
                          )}
                          {post.error && <p className="mt-1 text-red-600">{post.error}</p>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums">
                          {post.media.length}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600">
                          {post.publishedAt ? post.publishedAt.slice(0, 10) : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
