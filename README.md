# Instagram Data Collector Web

Instagram 프로필의 공개 콘텐츠를 Playwright로 탐색해 가능한 메타데이터를 JSON/CSV로 내려받는 로컬 우선 Next.js 앱입니다. 대상 계정의 OAuth 승인은 사용하지 않습니다.

## 최대 수집 범위

### 프로필
- username / 표시 이름 / biography / 프로필 이미지
- 팔로워·팔로잉·게시물 수(노출되는 경우)
- 인증 여부 / 카테고리 / 외부 URL / bio link / pronouns
- Business / Professional 계정 여부(페이지 데이터에 존재하는 경우)

### 콘텐츠 발견
- 메인 프로필 timeline
- Reels 탭
- Tagged 탭
- 게시물 / Reel / Carousel URL과 shortcode
- 별도 게시물 개수 선택 없이 항상 메인 피드·Reels·Tagged 탭에서 새 링크가 더 이상 나오지 않을 때까지 각 탭 스크롤

### 게시물 / Reel / Carousel 상세
- 내부 ID / shortcode / canonical URL / 소유 username
- 콘텐츠 종류 / 발견된 탭 / pinned 여부
- 전체 caption / hashtag / mention
- 사진·영상에 태그된 계정 / 공동 작성자
- 게시 시각
- 좋아요 / 댓글 / 조회 / 재생 수(페이지 데이터에 있는 경우)
- 위치 이름 / 위치 URL
- Reel audio 제목 / artist / audio URL 또는 audio page URL(노출되는 경우)
- Carousel 각 아이템 순서
- 각 media의 ID / shortcode / IMAGE·VIDEO 구분 / CDN URL / thumbnail / alt text
- width / height / 영상 duration / media별 view·play count(페이지 데이터에 있는 경우)
- 페이지 JSON에 포함된 댓글: 댓글 ID / 작성 username / 본문 / 작성 시각 / 좋아요 / reply count

## 로그인 없이 부족한 경우

기본은 비로그인 공개 모드입니다. 본인 Instagram 로그인 세션을 로컬 Playwright에 저장하려면:

```bash
npm run instagram:login
```

열린 브라우저에서 **직접 로그인**한 뒤 터미널에서 Enter를 누르면 `.instagram-storage-state.json`이 생성됩니다. 이후 수집기는 이 세션을 자동 사용합니다. 이 파일은 `.gitignore`에 포함되어 Git에 올라가지 않습니다.

대상 계정이 OAuth를 승인할 필요는 없습니다. 로그인 입력 자동화, CAPTCHA 우회, 프록시 회전, 접근 제한 우회는 하지 않습니다.

## 수집할 수 없는/보장할 수 없는 것

Instagram이 현재 브라우저 세션에 제공하지 않는 데이터는 가져올 수 없습니다. 대표적으로 비공개 계정, 모든 팔로워·팔로잉 목록, 모든 댓글의 강제 전체 로딩, Insights(도달·노출·저장·공유 등), DM, 숨겨진 수치, 접근 권한이 필요한 Story/Highlight 내용은 보장할 수 없습니다.

이미지·영상은 파일 자체를 JSON/CSV에 넣지 않고 CDN URL을 저장합니다. 따라서 결과 파일은 가볍지만 CDN URL은 시간이 지나면 만료될 수 있습니다.

## 실행

```bash
npm install
npm run dev
```

`http://localhost:3000`에서 사용합니다.


## 브라우저 설치

`npm install`만 실행하면 환경에 맞게 브라우저가 준비됩니다.

- macOS/Windows 로컬: `postinstall`에서 Playwright Chromium 자동 설치
- Vercel/Linux 서버: npm dependency인 `@sparticuz/chromium`의 서버리스 Chromium 바이너리 사용
- Vercel에서 `npx playwright install chromium`을 수동 실행할 필요 없음
