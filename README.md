# Instagram Data Collector Web

공개 Instagram 프로필에 브라우저로 접근해 화면에 노출되는 프로필/게시물 메타데이터를 수집하고 JSON 또는 CSV로 내려받는 로컬 우선 Next.js 애플리케이션입니다.

## 수집 대상

- 공개 프로필 기본 정보
- 게시물 / 릴스 / 캐러셀 URL과 shortcode
- 캡션, 해시태그, 멘션
- 가능한 경우 태그 계정 / 공동 작성자
- 게시 시각
- 좋아요 / 댓글 수(공개 화면 또는 페이지 데이터에 존재하는 경우)
- 위치 / 릴스 오디오 제목(노출되는 경우)
- 이미지 / 영상 CDN 참조 URL과 썸네일

> Instagram이 비로그인 브라우저에 실제로 제공한 정보만 사용합니다. 비공개 계정, 로그인 벽, CAPTCHA, 지역/연령 제한을 우회하지 않습니다.

## 실행

Node.js 20.9 이상이 필요합니다.

```bash
npm install
npx playwright install chromium
npm run dev
```

브라우저에서 `http://localhost:3000`을 열고 Instagram 프로필 URL을 입력합니다.

## 다운로드 파일

### JSON

프로필, crawl 통계, warnings, 각 게시물의 구조화된 전체 결과를 저장합니다.

### CSV

마케팅/리서치용 목록으로 바로 다루기 쉽도록 게시물 1개를 1행으로 평탄화합니다. Excel에서 한글이 깨지지 않도록 UTF-8 BOM을 포함합니다.

## 동작 방식

- Next.js App Router의 Node.js Route Handler에서 Playwright Chromium을 실행합니다.
- 프로필을 스크롤하며 공개 게시물 링크를 탐색합니다.
- 게시물을 순차 방문해 DOM, 메타 태그, 페이지에 포함된 공개 JSON 신호를 best-effort로 읽습니다.
- 서버 DB에는 저장하지 않으며 최종 결과는 브라우저 메모리에 전달됩니다.

## 제한 사항

Instagram의 화면/페이지 구조는 언제든 변경될 수 있어 일부 필드가 `null` 또는 `partial` 상태가 될 수 있습니다. 대량 계정 병렬 수집, 로그인 우회, CAPTCHA 우회, 프록시 회전 기능은 포함하지 않습니다.

“가능한 만큼”은 무한 스크롤 방지를 위해 1회 최대 2,000개의 게시물 링크까지만 탐색합니다. 매우 큰 계정은 실행 시간이 길어질 수 있으므로 이 앱은 우선 로컬 실행을 권장합니다.
