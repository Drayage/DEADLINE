# DEADLINE — 라인 전략 RTS

바닐라 JS 웹게임. vs AI 싱글 + Firebase RTDB 온라인 대전(방 코드), PWA, GitHub Pages 배포.

## 절대 규칙: 빌드 구조

- **index.html을 직접 수정하지 말 것.** `node build.js`가 `index.template.html`의
  `/*__ENGINE_INLINE__*/` 자리에 `engine.js`를 인라인해 index.html을 생성한다.
- 게임 로직 → `engine.js`, 마크업/CSS/UI → `index.template.html` 수정 후 `node build.js` 재생성.

## 파일 지도

- `engine.js` (~1,200줄) — 게임 로직 단일 소스 (AI 플레이스타일, 전투, 경제)
- `index.template.html` (~1,800줄) — 마크업/CSS/UI
- `build.js` — 인라인 빌드 스크립트
- `sim.js` — AI 매치업/밸런스 시뮬레이터
- `sw.js`, `manifest.json` — PWA
- `database.rules.json` — Firebase 보안 규칙

## 검증

- 수정 후: `node --check engine.js && node build.js`
- AI/밸런스 변경 시: `node sim.js`로 매치업 매트릭스 확인 후 커밋
- SW/캐시/배포/모바일: webgame-ship 스킬 참조
- 온라인(방/동기화/규칙): firebase-online 스킬 참조
