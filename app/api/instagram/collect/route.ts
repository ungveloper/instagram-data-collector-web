import { collectInstagramProfile } from "@/lib/instagram/collector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby의 Fluid Compute 상한에 맞춘 값입니다.
// Pro/Enterprise라도 현재 일반 상한은 800초이므로 1800은 배포 검증에서 거부될 수 있습니다.
export const maxDuration = 300;

type RequestBody = {
  url?: unknown;
  maxPosts?: unknown;
};

function line(payload: unknown) {
  return `${JSON.stringify(payload)}\n`;
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "JSON 요청 본문이 필요합니다." }, { status: 400 });
  }

  if (typeof body.url !== "string" || !body.url.trim()) {
    return Response.json({ error: "Instagram 프로필 URL을 입력해주세요." }, { status: 400 });
  }

  const maxPosts =
    typeof body.maxPosts === "number" && Number.isFinite(body.maxPosts)
      ? Math.max(0, Math.floor(body.maxPosts))
      : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(line(payload)));
      };

      void (async () => {
        try {
          const result = await collectInstagramProfile({
            url: body.url as string,
            maxPosts,
            onProgress(progress) {
              send({ type: "progress", progress });
            },
          });
          send({ type: "result", result });
        } catch (error) {
          send({
            type: "error",
            error:
              error instanceof Error
                ? error.message
                : "Instagram 수집 중 알 수 없는 오류가 발생했습니다.",
          });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
