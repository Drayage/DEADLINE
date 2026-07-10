---
name: webgame-ship
description: 바닐라 JS 웹게임(GitHub Pages + PWA) 작업 필수 체크리스트. 기능 구현·버그 수정 후 커밋 전 검증, 서비스워커/캐시 수정, PWA/manifest, 배포, 모바일 레이아웃·UI(버튼 잘림, 겹침, z-index) 작업 시 반드시 참조. 캐시 고착과 모바일 레이아웃 시행착오 재발 방지용.
---

# 웹게임 출시 체크리스트

이 규칙들은 이 계정의 12개 게임 저장소에서 실제로 반복된 버그의 확정 해법이다.
추측으로 우회하지 말고 그대로 따를 것.

## 경로 (GitHub Pages subpath)

- 모든 리소스 경로는 상대경로 (`./asset.png`, `js/main.js`). 절대경로(`/js/...`)는
  Pages subpath(`user.github.io/repo/`)에서 깨진다.
- `manifest.json`의 `start_url`, 아이콘 경로도 상대경로.

## 서비스워커 — 캐시 고착 방지 확정 패턴

4개 프로젝트가 각각 따로 도달한 동일 결론이다. 새로 설계하지 말 것.

1. HTML·JS·CSS(앱 코드): **network-first**, fetch 실패 시에만 캐시 폴백
2. 이미지/오디오 등 불변 에셋: cache-first
3. `CACHE_VERSION` 상수 존재 — **코드를 수정한 커밋마다 반드시 bump**
4. index.html의 `<script src="...?v=버전">` 쿼리도 함께 갱신 (import 구문에 버전
   쿼리를 쓰는 프로젝트는 import 경로도 갱신)
5. 등록 스크립트에서 `controllerchange` 이벤트 시 sessionStorage 가드를 두고
   **1회만** `location.reload()` — 새 SW가 활성화되면 자동 반영
6. precache 실패 하나가 install 전체를 막지 않도록 개별 예외 처리

## 커밋 전 검증 (생략 금지)

1. 변경된 모든 .js: `node --check <file>` (훅이 자동 실행되지만 실패를 무시하지 말 것)
2. 프로젝트에 test/sim 스크립트가 있으면 실행 (package.json scripts, sim.js,
   scripts/simulate.mjs 등을 먼저 확인)
3. UI/레이아웃 변경 시: 로컬 서버(`python3 -m http.server`)를 띄우고 Playwright로
   **360×640 모바일 뷰포트** 스크린샷 확인 — 버튼이 화면 안에 있는지, 콘솔 에러 0인지
4. 레이아웃 버그 수정이면 수정 전 재현 스크린샷 → 수정 → 수정 후 스크린샷으로 증명

## 모바일 레이아웃 — 반복 버그 예방

- 세로 높이는 `100vh` 대신 `window.innerHeight` 또는 `100dvh` 기반
  (모바일 브라우저 주소창 때문에 100vh는 버튼을 화면 밖으로 밀어냄)
- 액션 버튼은 스크롤 영역 밖에 고정(pin)하고, 카드 목록 등 가변 콘텐츠만 내부 스크롤
- 요소 겹침/밀림 문제는 z-index를 추가하기 전에 **컨테이너 높이 고정 + overflow**부터
  검토 (z-index 덧대기는 8커밋짜리 두더지잡기로 끝난 전례가 있음)
- 새 CSS 클래스는 `.empty` 같은 일반명 대신 구체적 프리픽스(`.zone-empty`) 사용
  — 클래스명 충돌 버그 전례
- 뷰포트 크기가 바뀌는 시점(키보드, 화면 전환, 패 확정 등)에는 높이 재측정

## 배포

- push 후 GitHub Actions(Pages) 상태를 확인하고, 실패면 빈 커밋으로 재시도하기 전에
  실패 로그부터 확인 (transient 실패는 재시도로 해결되지만 원인 확인이 먼저)

## 게임 로직/AI/밸런스 작업

- AI·밸런스·라운드 플로우를 수정하기 전에 headless 시뮬 스크립트가 있는지 확인하고,
  없으면 먼저 만들 것 (N판 자동 진행 + 교착 감지). 시뮬 통과를 수정의 기준으로 삼는다.
- 이벤트 큐/턴 전환 로직은 단일 큐 + 명시적 블로킹 상태로 관리하고, 즉흥적 게이트
  추가 대신 기존 큐에 편입시킬 것 (즉흥 게이트 누적 → 교착 15커밋 전례)
