# smart-router 로그 분석 및 개선안 (2026-03-27)

## 목적

smart-router의 실제 송수신 데이터를 남겨서, 라우팅 품질과 토큰 사용량을 나중에 분석할 수 있도록 기반을 만든 뒤 현재 상태를 실측으로 점검했다.

## 후속 반영 업데이트

같은 날짜에 P0, P1, P2 후속 작업을 추가로 반영했다.

- `evaluation` 이벤트 추가
- `sessionId`, `turnIndex`, `rootTurnId`, `parentRequestId` 상관관계 필드 추가
- LLM 평가 호출 자체의 duration과 usage 기록 추가
- `promptBreakdown` 추가
- local usage 추정 추가
- `toolExposureApplied`, `originalToolCount`, `retainedToolCount` 추가
- `routeAdjustmentReason`, `localHealth` 추가

즉, 아래 항목 중 일부는 이 문서 초안 작성 시점 이후 실제로 해소됐다.

1. 라우팅 평가 자체의 비용이 안 보임
2. 사용자 턴 단위 상관관계가 약함

현재는 최소한 아래까지는 로그에서 직접 확인 가능하다.

- 분류용 LLM 호출이 몇 토큰을 썼는지
- 평가 결과가 fallback 인지 아닌지
- 같은 세션에서 몇 번째 user turn 인지
- 같은 turn 에 속한 request 를 어떤 key로 묶어야 하는지
- payload에서 system/history/user/tool schema 비율을 어떻게 봐야 하는지
- local 경로에서 provider usage가 없을 때 추정 usage가 얼마인지
- 단순 local 요청에 tool schema가 실제로 제거됐는지

이번 점검에서는 아래를 수행했다.

- smart-router 실행 로그를 JSONL로 적재하도록 반영
- 로그 파일을 일별 파일명으로 분리하고 기본 10일 보관 정책 적용
- OpenClaw 실제 메시지 20건을 `openclaw agent --local` 경로로 전송
- 생성된 로그를 읽어 라우팅 분포, 응답 시간, 토큰 사용량, 송수신 데이터 종류를 확인
- 관련 테스트 재실행

## 실행 요약

### 반영된 로그 파일

- 경로: `~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl`
- 기본 보관일: `10`
- 설정 키: `logEnabled`, `logFilePath`, `logPayloadBody`, `logMaxTextChars`, `logRetentionDays`

### 실측 트래픽

- 프로브 포함 총 분석 요청 수: `25`
- 추가 배치 전송: `20`건
- 배치 전송 성공: `20/20`
- 이벤트 적재: `route 25`, `payload 25`, `response 25`

### 테스트

아래 테스트를 통과했다.

```bash
pnpm exec vitest run smart-router-log.test.ts complexity.test.ts index.test.ts
```

후속 P1/P2 반영과 log flush 보강 후 현재 테스트 수는 `40`개다.

## OpenClaw 송수신 데이터 종류

현재 로그로 확인 가능한 데이터 종류는 다음과 같다.

### 1. route 이벤트

라우팅 결정 시점의 메타데이터를 기록한다.

- `requestedModelId`
- `routeMode`
- `evaluationMode`
- `threshold`
- `routeTier`
- `routeProvider`
- `routeModel`
- `routeApi`
- `routeLabel`
- `thinkingLevel`
- `decision.level`
- `decision.reason`
- `decision.scoreTotal`
- `decision.scoreBreakdown`
- `contextSummary`
- `streamOptions`

즉, "왜 local/mini/full로 보냈는지"는 현재 로그만으로도 추적 가능하다.

### 2. payload 이벤트

실제 모델 호출 직전 payload 요약을 기록한다.

- payload 최상위 키 목록
- `messages` 또는 `input` 기준 message 수
- role 분포
- content type 분포
- 전체 텍스트 길이
- tool 개수와 tool 이름 목록
- 실제 호출 모델명
- `max_output_tokens` 또는 `max_completion_tokens`
- `store`, `stream`
- payload digest
- 재작성 여부 (`rewritten`)
- `promptBreakdown`
- `toolSchemaChars`

이번 실측에서 확인된 content type 예시는 아래와 같다.

- `text`
- `string`
- `input_text`
- `output_text`
- `toolCall`

### 3. response 이벤트

모델 응답 완료 시점의 결과를 기록한다.

- `durationMs`
- stream 내부 이벤트 개수
- `usage.input`
- `usage.output`
- `usage.cacheRead`
- `usage.cacheWrite`
- `usage.totalTokens`
- `responseSummary.provider`
- `responseSummary.api`
- `responseSummary.model`
- `responseSummary.responseId`
- `responseSummary.stopReason`
- `responseSummary.contentTypes`
- `responseSummary.toolCallCount`
- `responseSummary.toolCallNames`
- `responseSummary.textChars`
- `responseSummary.firstTextPreview`
- `usageSource`

즉, 현재도 "무슨 모델이 어떤 형태의 응답을 반환했고, tool 호출이 있었는지"는 확인 가능하다.

## 실측 결과

### 라우팅 분포

총 25건 기준 분포는 아래와 같았다.

| route tier | 건수 |
| --- | ---: |
| local | 4 |
| mini | 14 |
| full | 7 |

단순 요청도 일부는 `mini`로 올라갔고, 복합 설계/정책형 요청은 `full`로 올라갔다.

### 응답 시간과 사용량

| tier | 건수 | input 합계 | output 합계 | cacheRead 합계 | duration 합계 |
| --- | ---: | ---: | ---: | ---: | ---: |
| local | 4 | 0 | 0 | 0 | 54,994ms |
| mini | 14 | 61,127 | 3,233 | 74,240 | 27,815ms |
| full | 7 | 60,572 | 5,788 | 9,472 | 101,506ms |

관찰 포인트:

1. `mini`는 평균 응답 시간이 매우 짧았다.
2. `full`은 응답 품질은 높지만 지연시간이 크게 증가했다.
3. `local`은 이번 환경에서 토큰 사용량이 `0`으로 기록됐다. 즉 실제 토큰/비용 비교에는 아직 바로 쓰기 어렵다.

### 토큰 사용량의 핵심 관찰

짧은 사용자 입력도 원격 호출 시 input token이 매우 컸다.

실제 예시:

- 사용자 프롬프트 길이: 약 `44`자
- `systemPromptChars`: 약 `27,617`
- tool 수: `18`
- 해당 mini 호출의 `usage.input`: `9,604`

즉, 현재 비용의 대부분은 사용자 본문보다 아래 항목에서 발생한다.

1. 긴 system prompt
2. 매 요청마다 포함되는 전체 tool 스키마
3. 누적 대화 이력

### 캐시 사용 관찰

같은 세션의 후속 요청에서는 `cacheRead`가 크게 잡혔다.

예시:

- `sr-summary-a` 후속 요청: `cacheRead = 9,216`
- `sr-security-a`: `cacheRead = 9,216`

즉, OpenAI 측 prompt cache는 실제로 동작하고 있다. 다만 현재 smart-router 로그만으로는 세션별 cache hit ratio를 집계하기엔 정보가 조금 부족하다.

### tool 사용 관찰

`sr-scale-a` 요청은 첫 응답에서 `toolUse`가 발생했고, 이후 같은 세션에서 다시 full tier 요청이 이어졌다.

이는 현재 로그가 아래 흐름을 포착할 수 있음을 보여준다.

1. 모델이 tool 호출을 선택함
2. tool result가 대화 이력에 들어감
3. 후속 full-tier 요청이 이어짐

다만 현재는 이 두 요청을 하나의 사용자 턴으로 묶어서 보기 어렵다.

## 현재 로그만으로 충분히 알 수 있는 것

- 어떤 요청이 local, mini, full 중 어디로 갔는지
- 그 결정 이유가 무엇이었는지
- 실제 payload에 message 몇 개와 tool 몇 개가 들어갔는지
- 응답이 text인지 toolCall인지
- 응답 시간과 OpenAI usage 수치가 어떤지
- 세션 이력 누적으로 message 수와 text 길이가 얼마나 커졌는지

## 아직 부족한 점

### 1. 라우팅 평가 자체의 비용이 안 보임

후속 반영으로 이 항목은 해소됐다.

이제 `evaluation` 이벤트에서 아래를 바로 볼 수 있다.

- `evaluationDurationMs`
- `evaluationUsage`
- `evaluationTarget`
- `evaluationFallbackToRule`
- `evaluation.classifierLevel`
- `evaluation.classifierReason`

남은 과제는 이를 일/주 단위 집계로 연결하는 것이다.

실제 비용이 높아 보이는 원인이 아래 둘 중 어느 쪽인지 분리할 수 있게 됐다.

1. 최종 응답 생성 비용
2. 사전 라우팅 평가 비용

### 2. local 모델 토큰 사용량이 0으로 남음

이 항목은 부분 해소됐다.

이제 provider usage가 비어 있으면 추정치가 `usageSource: estimate` 로 남는다.

다만 이 값은 아직 실측 usage가 아니라서, LM Studio 원본 usage 파싱이 가능해지면 교체하는 것이 맞다.

### 3. 사용자 턴 단위 상관관계가 약함

후속 반영으로 기본 필드는 추가됐다.

- `sessionId`
- `turnIndex`
- `rootTurnId`
- `parentRequestId`

따라서 로그 스키마 기준 상관관계는 이제 가능하다.

추가 배치 실측에서 `sr-batch-h:turn:2` 는 `memory_search` tool call 이후 같은 `rootTurnId` 안에서 `parentRequestId`가 이어지는 연쇄 request 를 실제로 남겼다.

tool 호출이 끼어들면 하나의 사용자 요청이 여러 requestId로 분리되므로, 운영 문서나 대시보드에서는 `rootTurnId` 중심 집계를 기본값으로 잡는 것이 좋다.

### 4. prompt 구성 비율이 더 세밀하게 안 보임

이 항목도 부분 해소됐다.

이제 payload에서 아래를 직접 볼 수 있다.

- `systemChars`
- `currentUserChars`
- `historyChars`
- `toolResultChars`
- `toolSchemaChars`

다만 assistant/toolCall/toolResult를 더 세밀하게 운영 대시보드용으로 집계하는 작업은 아직 남아 있다.

- system prompt 길이
- tool schema 길이
- conversation history 길이
- 현재 user message 길이
- tool result 길이

### 5. preview가 너무 길 수 있음

이 항목은 해소됐다.

`logPreviewChars`로 별도 상한을 둘 수 있고, 테스트로도 검증했다.

### 6. tool 노출 과다

이 항목은 부분 해소됐다.

단순 local 요청은 `toolExposureMode=conservative` 기본값에서 tool schema를 제거해 prompt 비용을 줄인다.

라이브 검증에서는 아래가 확인됐다.

- `toolExposureApplied: true`
- `originalToolCount: 18`
- `retainedToolCount: 0`

## 현재 남은 과제

이미 반영된 항목은 제외하고, 현재 우선순위는 아래다.

### 1. local usage 실측치 확보

현재 local 응답은 `usageSource: estimate` 로 남는다. LM Studio 또는 로컬 provider 원본 usage를 직접 파싱할 수 있으면 추정치를 실측치로 교체하는 것이 가장 큰 남은 과제다.

### 2. latency-aware routing 임계값 실데이터 보정

정책 자체는 들어갔지만 이번 배치에서는 `routeAdjustmentReason` 이 한 번도 발생하지 않았다. 즉 샘플은 쌓였지만 아직 임계값이 보수적이거나, local health 샘플 수가 부족하다. 운영 로그를 더 모아 아래 값을 보정해야 한다.

- `localLatencyP95ThresholdMs`
- `localErrorRateThreshold`
- `localHealthMinSamples`

### 3. tool schema 선택적 주입을 mini/full에도 확장 검토

이번 39개 사용자 턴 배치에서 local/simple 2건만 tool schema가 제거됐다. 나머지 대부분은 mini/full로 가면서 평균 `toolSchemaChars`가 약 `15.7k` 수준으로 유지됐다. tool이 필요하지 않은 moderate 질문까지 줄일 수 있는지 추가 실험이 필요하다.

### 4. 운영 대시보드 또는 정기 리포트 자동화

일별 집계 스크립트는 추가됐지만, 아직 cron/CI/대시보드 연결은 없다. 운영자가 매일 직접 JSONL을 읽지 않도록 아래 중 하나로 이어가면 좋다.

1. 일일 요약 JSON 파일 생성
2. Markdown 리포트 자동 생성
3. Grafana/Notebook용 중간 집계 테이블 적재

## 추천 후속 작업

1. local provider usage 실측치 파싱 추가
2. `routeAdjustmentReason` 이 실제 발생할 때까지 local health 임계값 보정 실험
3. moderate 질문에 대한 tool schema 축소 A/B 실험
4. 일일 집계 스크립트를 자동 실행으로 연결

## 결론

이번 작업으로 smart-router의 실제 라우팅, payload, 응답 결과를 나중에 분석할 수 있는 최소 관측성은 확보했다.

추가 후속 반영까지 포함하면, 이제 smart-router는 단순 route/payload/response 수준을 넘어 아래까지 추적할 수 있다.

1. 분류용 LLM 평가 비용과 지연시간
2. 세션/턴 단위 상관관계
3. fallback 여부

다만 실측 기준으로 가장 큰 비용 원인은 "짧은 사용자 입력" 자체가 아니라 아래에 더 가깝다.

1. 긴 system prompt
2. 매 요청 tool 스키마 포함
3. LLM 기반 라우팅 평가 비용 미계측
4. local usage 미기록

다음 개선은 단순히 로그를 더 많이 남기는 방향보다, 위 네 항목을 정량적으로 분리해서 볼 수 있게 로그 스키마를 한 단계 더 세분화하는 방향이 맞다.