# ZeroClaw Web UI 기준 photos-classify review 흐름 설계

기준 시점: 2026-04-10

## 목적

`photos-classify` 의 review 흐름을 OpenClaw 플러그인 route 의존 없이 ZeroClaw 웹 UI 기준으로 다시 설계한다.

이번 설계의 핵심은 아래 두 가지다.

1. 분류/검토 상태를 ZeroClaw dashboard 안에서 발견 가능하게 만든다.
2. 실제 review 편집 UI는 별도 로컬 review app 을 유지하되, ZeroClaw 웹 UI가 진입점과 상태 허브 역할을 맡는다.

## 현재 제약

1. ZeroClaw에는 OpenClaw의 `registerHttpRoute()` 같은 플러그인 route 주입 지점이 없다.
2. 현재 `photo-ranker` review 앱은 `http://127.0.0.1:8765` 의 별도 로컬 HTTP 앱이다.
3. MCP 도구는 붙었지만 review 전용 링크와 상태 UX는 ZeroClaw 대시보드에 아직 없다.
4. Apple Photos 기반 분석은 ZeroClaw 실행 프로세스의 macOS TCC 권한 영향을 받는다.

## 권장 UX 방향

### Phase A. Dashboard 카드 기반 진입

ZeroClaw `Dashboard` overview 탭에 `Photos Review` 카드를 추가한다.

카드에는 아래만 먼저 노출한다.

1. 최근 classify job 5개
2. 상태 (`pending`, `running`, `completed`, `failed`)
3. 진행률 (`completed/total`, `%`)
4. selection profile
5. `Review 열기` 링크

이 단계에서는 review 편집 자체를 ZeroClaw 내부에 임베드하지 않는다.

## Review 열기 동작

1. 기본값: 새 탭으로 `http://127.0.0.1:8765/review/<job_id>` 오픈
2. review 앱이 꺼져 있으면 ZeroClaw가 `photo-ranker` auto-start 상태를 보여주고 재시도 버튼 제공
3. loopback 전용 접근이면 UI에 `로컬 전용` 배지 표시
4. token/Tailscale 이 활성화되면 badge 와 link hint 를 함께 노출

## 권장 정보 구조

### Dashboard Overview

- `Photos Review` 카드
- `최근 작업 보기`
- `Running job 있음` 배지
- `review app 연결 상태` (`healthy`, `starting`, `unreachable`)

### Dashboard 상세 패널 또는 신규 탭

가능하면 `Dashboard` 에 `photos` 탭을 추가한다.

표시 항목:

1. 최근 job 목록
2. 마지막 실행 source/path
3. selected 개수
4. ranked 개수
5. error message
6. review URL 복사 버튼
7. export / organize 후속 액션 안내

## 최소 API 계약

ZeroClaw가 review app 전체를 프록시하지 않고도 dashboard 에서 상태를 보여주려면 아래 정도만 있으면 충분하다.

1. `GET /api/jobs?limit=5`
2. `GET /api/jobs/<job_id>`
3. `GET /health`

이미 `photo-ranker` review app 쪽에 유사 API 가 있으므로, ZeroClaw는 이를 읽기 전용으로 consume 하는 편이 구현 비용이 낮다.

## Canvas / iframe 검토

ZeroClaw에는 `Canvas` 페이지가 있지만, review UI를 iframe 으로 그대로 넣는 것은 MVP 기준 비권장이다.

이유:

1. 로컬 loopback / auth token / Tailscale 접근 제어가 섞인다.
2. review app 이 별도 정적 자산과 API 경로를 가진다.
3. ZeroClaw dashboard 에서는 상태 허브 역할이 더 중요하다.

따라서 초기안은 `외부 앱 링크 + 상태 카드` 가 맞다.

## 구현 제안

### Step 1

ZeroClaw dashboard 또는 별도 page 에 `Photos Review` 카드 추가

### Step 2

ZeroClaw 측에 photos review summary fetcher 추가

### Step 3

link open / copy button / 상태 badge 추가

### Step 4

필요하면 이후에만 iframe 또는 reverse proxy 를 검토

## 운영상 장점

1. ZeroClaw 웹 UI에서 review 흐름의 존재를 바로 발견 가능
2. review 앱 장애와 ZeroClaw 본체 장애를 분리 가능
3. 향후 token/Tailscale 정책을 붙여도 UI 계약이 크게 안 바뀜

## 현 시점 결론

ZeroClaw 웹 UI 기준 재설계는 아래 방향이 적절하다.

1. ZeroClaw dashboard 가 review 상태와 진입 링크를 보여준다.
2. 실제 편집 UI 는 별도 review app 을 유지한다.
3. iframe/reverse proxy 는 2차 단계에서만 검토한다.