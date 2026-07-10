---
name: firebase-online
description: Firebase RTDB/Firestore 온라인 멀티플레이 작업 시 필수 참조. 방 생성/참가, 턴 동기화, 새로고침 세션 복원, permission-denied, 보안 규칙 수정, 온라인 상태 버그 디버깅 시 반드시 읽을 것. undefined 거부·규칙 중첩·상태 덮어쓰기 등 반복 버그의 확정 해법.
---

# Firebase 온라인 멀티 확정 패턴

이 계정의 온라인 게임들(hammynap, uritichu 등)에서 수십 커밋을 들여 도달한
확정 해법이다. 재설계하지 말고 따를 것.

## 쓰기 규칙

- **쓰기 직전 깊은 순회로 `undefined` → `null` 치환** — Firebase는 undefined가
  섞인 객체 쓰기를 거부한다 (hammynap 전례: sendAction 버그)
- DB 최상위 경로는 앱별 네임스페이스: `<appname>_rooms/...` — 여러 게임이
  같은 Firebase 프로젝트(deadline-38cdb)를 공유하므로 프리픽스 없으면 충돌

## 보안 규칙 (permission-denied 단골 원인)

- 새 데이터 경로를 추가할 때 기존 rules의 **중첩 구조 안에** 넣었는지 확인.
  최상위에 병렬로 추가하면 상위 규칙이 적용되지 않아 permission-denied
  (Paws-Order 전례: games/ 규칙 아래로 중첩해서 해결)
- 규칙 배포 전 실제 read/write 스모크 테스트 1회
- 방 코드 형식 검증 등은 규칙에서 처리하되, 실패 원인을 화면에 표시할 것
  (권한 거부가 조용히 삼켜지면 디버깅 커밋만 늘어남)

## 상태 동기화 (호스트 권위 모델)

- 화면은 **서버 확정 상태만** 렌더 — 낙관적 렌더는 깜빡임/유령 상태를 만든다
- 저장은 **seq 번호 가드**로 낙관적 동시성 제어 — 오래된 쓰기가 새 상태를
  덮어쓰지 못하게 (구현 레퍼런스: uritichu의 seq-guarded saves)
- `onValue`는 여러 변경이 **합쳐진(coalesced) 업데이트**로 올 수 있다 —
  이벤트 로그/리플레이 기록은 마지막 값 diff가 아니라 누적 기록 기준으로 처리

## 새로고침 / 재접속

- presence(onDisconnect)로 방을 **즉시 삭제하지 말 것** — 새로고침이 방을
  파괴한다 (secrettactics 전례). 유예시간을 두고 정리
- localStorage에 (roomId, playerId, seq)를 저장해 재입장 지원
- 게스트 재접속 시 게임이 재시작되지 않도록 진행 상태 기준으로 복원

## 커밋 전 검증 (생략 금지)

브라우저 탭 2개(호스트/게스트)로 스모크 테스트:
입장 → 몇 턴 플레이 → 한쪽 새로고침 → 재입장 → 게임 종료까지.
온라인 코드는 이 테스트 없이 push하지 않는다.
