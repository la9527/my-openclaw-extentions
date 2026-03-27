# smart-router P0 후속 반영 결과 (2026-03-27)

## 작업 개요

이 문서는 2026-03-27 기준 smart-router P0 후속 작업 내용을 정리한다.

이번 반영 범위는 아래 두 가지였다.

1. `evaluation` 이벤트 추가
2. turn 상관관계 필드 추가

이후 즉시 테스트와 짧은 실측 검증을 다시 수행해 결과를 반영했다.

## 반영 내용

### 1. evaluation 이벤트 추가

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

### 2. turn 상관관계 필드 추가

모든 요청 이벤트에 아래 필드를 붙였다.

- `sessionId`
- `turnIndex`
- `rootTurnId`
- `parentRequestId`

의미:

- 같은 세션의 몇 번째 user turn 인지 식별 가능
- tool 호출이나 내부 후속 요청이 생겨도 같은 turn 묶음으로 집계 가능
- 후속 request 는 `parentRequestId` 로 이전 request 와 직접 연결 가능

### 3. 테스트 보강

추가된 테스트:

- logger가 `evaluation -> route -> payload -> response` 순서로 남는지 검증
- 같은 `rootTurnId` 안에서 두 번째 request 의 `parentRequestId`가 첫 request 를 가리키는지 검증
- LLM 평가 trace에 usage/fallback 정보가 들어가는지 검증

## 수정 파일

- `extensions/smart-router/complexity.ts`
- `extensions/smart-router/index.ts`
- `extensions/smart-router/smart-router-log.ts`
- `extensions/smart-router/complexity.test.ts`
- `extensions/smart-router/smart-router-log.test.ts`
- `extensions/smart-router/README.md`

## 테스트 결과

실행 명령:

```bash
cd /Volumes/ExtData/MyOpenClawRepo/extensions/smart-router
pnpm exec vitest run smart-router-log.test.ts complexity.test.ts index.test.ts
```

결과:

- `3`개 테스트 파일 통과
- `29`개 테스트 통과
- 실패 없음

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

### C. parentRequestId 검증 상태

`parentRequestId` 는 같은 user turn 안에서 tool 호출 등으로 request 가 연쇄 발생할 때 채워진다.

이번 라이브 재검증에서는 tool 연쇄가 다시 발생하지 않아, 이 필드는 단위 테스트로 우선 검증했다.

단위 테스트에서는 아래가 확인됐다.

- 첫 request: `parentRequestId` 없음
- 같은 `rootTurnId` 의 두 번째 request: `parentRequestId = 첫 requestId`

즉, 스키마와 체인 로직은 구현 및 테스트 완료 상태다.

## 현재 분석 관점에서 달라진 점

이전에는 아래를 명확히 분리할 수 없었다.

1. 최종 응답 비용
2. 사전 라우팅 분류 비용

지금은 `evaluation` 이벤트가 추가되어 이 둘을 분리해서 볼 수 있다.

또한 이전에는 request 흐름을 시각과 세션으로만 추정해야 했지만, 지금은 `rootTurnId` 기준 집계가 가능하다.

## 남은 우선 과제

### 1. local usage 보강

여전히 local 경로는 usage가 0으로 남는 경우가 많다. local vs remote 비용 비교를 위해 usage 파싱 또는 추정치가 필요하다.

### 2. prompt 구성 breakdown 추가

현재도 전체 text 길이는 보이지만 아래를 분해해서 보는 것이 더 좋다.

- system prompt
- tool schema
- history
- current user message
- tool result

### 3. 운영 집계 스크립트 추가

현재 JSONL은 충분히 쌓이지만, 운영자가 빠르게 보기 위해서는 일간 요약이 필요하다.

권장 집계 항목:

- tier별 요청 수
- evaluation token 총량
- response token 총량
- fallback 비율
- rootTurnId 기준 평균 request 수
- tool call 포함 turn 비율

## 요약

이번 후속 반영으로 smart-router 로그는 아래 수준까지 올라왔다.

1. route/payload/response 기록
2. evaluation 비용과 지연시간 기록
3. session/turn/request chain 상관관계 기록

즉, 이제는 "왜 이 요청이 이 모델로 갔는지"뿐 아니라, "그 결정을 내리기 위해 얼마를 썼는지"와 "같은 turn 안에서 어떤 request 들이 연쇄됐는지"까지 분석 가능한 상태다.