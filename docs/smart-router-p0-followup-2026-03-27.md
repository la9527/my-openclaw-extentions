# smart-router P0/P1/P2 후속 반영 결과 (2026-03-27)

## 작업 개요

이 문서는 2026-03-27 기준 smart-router P0/P1/P2 후속 작업과 운영 보강 결과를 정리한다.

이번 반영 범위는 아래 세 단계였다.

1. P0: `evaluation` 이벤트 + turn 상관관계 필드 추가
2. P1: prompt breakdown, local usage 추정, preview 제한, tool/result 요약 추가
3. P2: selective tool exposure, latency-aware routing 추가

이후 즉시 테스트와 짧은 실측 검증을 다시 수행해 결과를 반영했다.

## 반영 내용

### 1. P0: evaluation 이벤트 추가

이제 auto 라우팅 요청은 최종 모델 호출 전에 `evaluation` 이벤트를 남긴다.

주요 필드:

- `evaluationId`
- `evaluationApiType`
- `evaluationDurationMs`
- `evaluationTarget`
- `evaluationFallbackToRule`
- `evaluationUsage`
- `evaluation.classifierLevel`
- `evaluation.classifierReason`
- `evaluation.httpStatus`
- `evaluation.promptChars`

의미:

- 분류용 LLM 호출 자체가 얼마나 느렸는지
- 분류용 LLM 호출이 실제로 몇 토큰을 썼는지
- fallback 으로 rule 평가로 내려갔는지
- 최종 target 이 local/mini/full 중 어디였는지

### 2. P0: turn 상관관계 필드 추가

모든 요청 이벤트에 아래 필드를 붙였다.

- `sessionId`
- `turnIndex`
- `rootTurnId`
- `parentRequestId`

의미:

- 같은 세션의 몇 번째 user turn 인지 식별 가능
- tool 호출이나 내부 후속 요청이 생겨도 같은 turn 묶음으로 집계 가능
- 후속 request 는 `parentRequestId` 로 이전 request 와 직접 연결 가능

### 3. P1: prompt breakdown / usage / preview 보강

이번 라운드에서 추가된 주요 관측 필드:

- `payloadSummary.promptBreakdown.systemChars`
- `payloadSummary.promptBreakdown.currentUserChars`
- `payloadSummary.promptBreakdown.historyChars`
- `payloadSummary.promptBreakdown.toolResultChars`
- `payloadSummary.promptBreakdown.toolSchemaChars`
- `payloadSummary.promptBreakdown.estimatedPromptChars`
- `usageSource`

또한 local 경로에서 provider usage가 비어 있으면 char 기반 추정치를 `usage`에 기록하도록 보강했다.

### 4. P2: selective tool exposure / latency-aware routing

이번 라운드에서 추가된 정책 필드:

- `toolExposureMode`
- `toolExposureApplied`
- `originalToolCount`
- `retainedToolCount`
- `routeAdjustmentReason`
- `localHealth`

정책 요약:

1. `toolExposureMode=conservative` 기본값에서 local/simple 요청은 tool schema를 비워 prompt 비용을 줄인다.
2. 최근 local 상태가 나쁘면 local 대신 mini로 승격할 수 있다.

### 5. 테스트 보강

추가된 테스트:

- logger가 `evaluation -> route -> payload -> response` 순서로 남는지 검증
- 같은 `rootTurnId` 안에서 두 번째 request 의 `parentRequestId`가 첫 request 를 가리키는지 검증
- LLM 평가 trace에 usage/fallback 정보가 들어가는지 검증
- prompt breakdown 이 payloadSummary에 기록되는지 검증
- local usage 추정이 response에 기록되는지 검증
- previewChars 제한이 적용되는지 검증
- local health snapshot 계산이 되는지 검증
- tool intent 감지와 tool pruning 정책이 동작하는지 검증
- latency-aware escalation 판단이 동작하는지 검증

## 수정 파일

- `extensions/smart-router/complexity.ts`
- `extensions/smart-router/index.ts`
- `extensions/smart-router/smart-router-log.ts`
- `extensions/smart-router/complexity.test.ts`
- `extensions/smart-router/smart-router-log.test.ts`
- `extensions/smart-router/index.test.ts`
- `extensions/smart-router/openclaw.plugin.json`
- `extensions/smart-router/README.md`
- `extensions/smart-router/summarize-smart-router-log.mjs`

## 테스트 결과

실행 명령:

```bash
cd /Volumes/ExtData/MyOpenClawRepo/extensions/smart-router
pnpm exec vitest run smart-router-log.test.ts complexity.test.ts index.test.ts
```

결과:

- `3`개 테스트 파일 통과
- `40`개 테스트 통과
- 실패 없음

추가로 이전에 간헐적으로 보이던 temp log writer `EINVAL` 경고는 `flushAllSmartRouterLogs()` 보강 후 재현되지 않았다.

## 실측 검증 결과

### A. evaluation 이벤트 실측 확인

세션 `sr-followup-p0` 로 2턴을 보내 확인했다.

실제 로그에서 확인된 예시:

- `event: "evaluation"`
- `sessionId: "sr-followup-p0"`
- `turnIndex: 1`
- `rootTurnId: "sr-followup-p0:turn:1"`
- `evaluationDurationMs: 1392`
- `evaluationTarget: "mini"`
- `evaluationUsage.input: 311`
- `evaluationUsage.output: 59`

즉, 라우팅 전 분류 호출 자체의 사용량과 지연시간이 실제 로그에 남는 것을 확인했다.

### B. turn 상관관계 실측 확인

같은 세션의 후속 사용자 메시지에서는 아래가 실제로 남았다.

- `sessionId: "sr-followup-p0"`
- `turnIndex: 2`
- `rootTurnId: "sr-followup-p0:turn:2"`

즉, 최소한 user turn 기준 상관관계는 라이브 로그에서도 바로 확인됐다.

### C. P1/P2 라이브 검증

세션 `sr-p1p2-local` 실측에서 아래가 확인됐다.

- `toolExposureApplied: true`
- `originalToolCount: 18`
- `retainedToolCount: 0`
- `routeTier: local`
- `payloadSummary.promptBreakdown.systemChars: 27617`
- `payloadSummary.promptBreakdown.currentUserChars: 12`
- `payloadSummary.promptBreakdown.toolSchemaChars: 0`

즉, 단순 local 요청에서 tool schema를 실제로 비워 prompt 비용을 줄이는 동작이 라이브 로그에 그대로 찍혔다.

`evaluationUsage`도 계속 기록되어, 분류용 LLM 비용과 최종 응답 비용을 분리해 볼 수 있다.

### D. parentRequestId 검증 상태

`parentRequestId` 는 같은 user turn 안에서 tool 호출 등으로 request 가 연쇄 발생할 때 채워진다.

추가 39개 사용자 턴 배치에서 `sr-batch-h:turn:2` 가 실제로 `memory_search` tool call 이후 같은 `rootTurnId` 안에서 `parentRequestId`를 남겼다.

단위 테스트와 라이브 샘플에서 아래가 확인됐다.

- 첫 request: `parentRequestId` 없음
- 같은 `rootTurnId` 의 두 번째 request: `parentRequestId = 첫 requestId`

즉, 스키마와 체인 로직은 구현 및 테스트 완료 상태다.

### E. 일일 집계 스크립트 추가

`extensions/smart-router/summarize-smart-router-log.mjs` 를 추가했다.

역할:

- 최신 `smart-router-YYYY-MM-DD.jsonl` 자동 선택
- 또는 임의의 JSONL 경로를 인자로 받아 집계
- 이벤트 수, tier별 사용량, tool exposure, fallback 수, turn 수 등을 바로 요약

예시:

```bash
node extensions/smart-router/summarize-smart-router-log.mjs
node extensions/smart-router/summarize-smart-router-log.mjs /tmp/smart-router-batch-2026-03-27.jsonl
```

## 현재 분석 관점에서 달라진 점

이전에는 아래를 명확히 분리할 수 없었다.

1. 최종 응답 비용
2. 사전 라우팅 분류 비용

지금은 `evaluation` 이벤트가 추가되어 이 둘을 분리해서 볼 수 있다.

또한 이전에는 request 흐름을 시각과 세션으로만 추정해야 했지만, 지금은 `rootTurnId` 기준 집계가 가능하다.

## 남은 우선 과제

### 1. local usage 실측치 확보

추정치 기록은 들어갔지만 아직 `usageSource: estimate` 에 의존한다. 로컬 provider 원본 usage 파싱이 가장 우선이다.

### 2. latency-aware routing 임계값 보정

정책은 들어갔지만 이번 배치에서는 `routeAdjustmentReason` 이 없었다. 운영 로그를 더 모아 local health 기준을 보정해야 한다.

### 3. tool schema 축소 정책 확대 검토

현재는 local/simple에서만 보수적으로 줄인다. moderate 질문 중 tool 의도가 없는 케이스까지 줄일지 별도 실험이 필요하다.

### 4. 집계 결과 자동 발행

스크립트는 준비됐으므로, 이제 남은 일은 cron/CI/대시보드 중 한 경로에 연결하는 것이다.

## 요약

이번 후속 반영으로 smart-router 로그는 아래 수준까지 올라왔다.

1. route/payload/response 기록
2. evaluation 비용과 지연시간 기록
3. session/turn/request chain 상관관계 기록
4. prompt breakdown 기록
5. local usage 추정 기록
6. tool exposure 적용 여부 기록
7. local health 기반 route adjustment 근거 기록

즉, 이제는 "왜 이 요청이 이 모델로 갔는지"뿐 아니라, "그 결정을 내리기 위해 얼마를 썼는지"와 "같은 turn 안에서 어떤 request 들이 연쇄됐는지"까지 분석 가능한 상태다.