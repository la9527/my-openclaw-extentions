# MyOpenClawRepo Workspace Instructions

이 저장소에서 작업하는 AI 에이전트는 아래 원칙을 기본값으로 따른다.

## 목적

- OpenClaw에서 재사용할 smart-router 플러그인과 로컬 설정 예시를 안정적으로 유지한다.
- 복잡도 기반 `local`, `nano`, `mini`, `full` 4-tier 라우팅 정책을 문서, 설정, 테스트와 함께 맞춰 관리한다.
- 실호출 검증 결과와 코드 기본값이 어긋나지 않도록 유지한다.

## 저장소 구조 기준

- `extensions/smart-router/`: smart-router 플러그인 구현과 테스트의 기준 위치다.
- `configs/`: 실제 OpenClaw 설정 예시를 둔다.
- `docs/`: 라우팅 실험 결과, 운영 메모, 튜닝 배경을 기록한다.

## 작업 원칙

- 문서는 한글 우선을 유지한다. 모델 ID, 환경변수, API 이름 같은 기술 식별자는 영어 원문을 유지해도 된다.
- 구현을 바꾸면 가능한 범위에서 코드, 테스트, 설정 설명, 문서를 함께 갱신한다.
- 변경은 최소 범위로 유지하고, smart-router 외 영역을 불필요하게 일반화하지 않는다.
- OpenClaw 본체 동작을 참고할 수는 있지만, 이 저장소의 주 변경 대상은 `extensions/smart-router/` 와 관련 문서다.
- `/Volumes/ExtData/OpenClaw` 는 소스 참고 전용이다. 해당 저장소 파일은 수정하지 않는다.
- `/Volumes/ExtData/OpenClaw` 내부 스크립트와 로컬 개발 명령은 실행하지 않는다. 검증이나 운영 확인은 글로벌로 설치된 `openclaw` CLI 기준으로만 수행한다.
- OpenClaw 런타임 검증, 설정 확인, 플러그인 반영은 글로벌 설치본과 `~/.openclaw/*` 기준으로 진행한다.
- 실제 실행 OpenClaw가 글로벌 npm 설치본일 수 있으므로, UI 표시 문제는 이 저장소 플러그인 레이어에서 우회해야 하는지 먼저 확인한다.

## smart-router 현재 기준

- 기본 4-tier는 `local`, `nano`, `mini`, `full` 이다.
- 일반 remote 기본 tier 는 현재 `mini` 로 본다.
- `nano` 는 기본 remote tier 가 아니라, 짧고 경량인 비교/요약 요청, `llm` 분류 모델, local 상태 불량 시 1차 fallback tier 로 다룬다.
- `advanced` 급 요청은 `full` 로 보내되, `llm` 분류는 guardrail 과 fallback floor 없이 과신하지 않는다.
- route tier 를 채팅 UI에 노출해야 할 때는 현재 설치된 OpenClaw가 무엇을 렌더링하는지 확인한다. 현재 검증된 호환 방식은 assistant `message.model` 을 route alias 로 노출하고 실제 모델 ID는 구조화 메타에 보존하는 것이다.

## 변경 시 동기화 대상

아래 파일은 smart-router 동작 변경 시 같이 확인한다.

- `extensions/smart-router/index.ts`
- `extensions/smart-router/index.test.ts`
- `extensions/smart-router/README.md`
- `extensions/smart-router/openclaw.plugin.json`
- `configs/openclaw-hybrid.json5`
- 관련 `docs/*.md`

## 검증 기준

- 라우팅 로직이나 설정 설명을 바꾸면 최소한 아래 테스트를 우선 검토한다.
  - `cd extensions/smart-router && pnpm exec vitest run complexity.test.ts index.test.ts`
- 로그/관측성까지 건드렸다면 가능하면 아래까지 포함한다.
  - `cd extensions/smart-router && pnpm exec vitest run complexity.test.ts index.test.ts smart-router-log.test.ts`
- 실호출 검증 시 아래를 함께 확인한다.
  - 게이트웨이 로그의 smart-router route 출력
  - `~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl` 실행 로그
  - 필요 시 채팅 UI footer 에서 tier alias 노출 여부

## 우선순위 가이드

- 1순위: 현재 검증된 4-tier 운영 정책과 충돌하지 않는 변경
- 2순위: 코드, 문서, 설정, 테스트의 동기화 유지
- 3순위: 실호출 관측성과 후속 튜닝 가능성 유지

## Git 운영 기본값

- 작업 시작 전 `git status --short --branch` 로 상태를 확인한다.
- 사용자가 요청하면 기능 단위로 커밋한다.
- unrelated 변경은 건드리지 않는다.