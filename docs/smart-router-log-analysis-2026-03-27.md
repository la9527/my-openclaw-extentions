# smart-router 로그 분석 및 개선안 (2026-03-27)

## 목적

smart-router의 실제 송수신 데이터를 남겨서, 라우팅 품질과 토큰 사용량을 나중에 분석할 수 있도록 기반을 만든 뒤 현재 상태를 실측으로 점검했다.

## 후속 반영 업데이트

같은 날짜에 P0 후속 작업을 추가로 반영했다.

- `evaluation` 이벤트 추가
- `sessionId`, `turnIndex`, `rootTurnId`, `parentRequestId` 상관관계 필드 추가
- LLM 평가 호출 자체의 duration과 usage 기록 추가

즉, 아래 항목 중 일부는 이 문서 초안 작성 시점 이후 실제로 해소됐다.

1. 라우팅 평가 자체의 비용이 안 보임
2. 사용자 턴 단위 상관관계가 약함

현재는 최소한 아래까지는 로그에서 직접 확인 가능하다.

- 분류용 LLM 호출이 몇 토큰을 썼는지
- 평가 결과가 fallback 인지 아닌지
- 같은 세션에서 몇 번째 user turn 인지
- 같은 turn 에 속한 request 를 어떤 key로 묶어야 하는지

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
pnpm exec vitest run smart-router-log.test.ts index.test.ts complexity.test.ts
```

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

LM Studio 경로에서는 usage가 비어 있어서 local과 remote를 정량 비교하기 어렵다.

### 3. 사용자 턴 단위 상관관계가 약함

후속 반영으로 기본 필드는 추가됐다.

- `sessionId`
- `turnIndex`
- `rootTurnId`
- `parentRequestId`

따라서 로그 스키마 기준 상관관계는 이제 가능하다.

다만 실측에서는 tool이 실제로 연속 호출된 라이브 샘플을 추가로 더 모아야 `parentRequestId` 활용 패턴을 충분히 검증할 수 있다.

tool 호출이 끼어들면 하나의 사용자 요청이 여러 requestId로 분리되므로, 운영 문서나 대시보드에서는 `rootTurnId` 중심 집계를 기본값으로 잡는 것이 좋다.

### 4. prompt 구성 비율이 더 세밀하게 안 보임

현재도 `systemPromptChars`와 전체 message text 길이는 보이지만, 아래 항목을 분리해서 보기는 어렵다.

- system prompt 길이
- tool schema 길이
- conversation history 길이
- 현재 user message 길이
- tool result 길이

### 5. preview가 너무 길 수 있음

`responseSummary.firstTextPreview`가 긴 응답에서는 로그 자체를 크게 만들 수 있다. 운영 로그로 쓸 때는 preview 상한을 더 강하게 둘 필요가 있다.

## 개선 우선순위

### P0

#### 1. 라우팅 평가 LLM 호출도 별도 이벤트로 기록

권장 필드:

- `evaluationRequestId`
- `evaluationTarget`
- `evaluationPromptChars`
- `evaluationDurationMs`
- `evaluationUsage`
- `evaluationResult`

효과:

- 라우팅 정확도와 라우팅 비용을 분리 분석 가능
- "smart-router 때문에 토큰이 늘었는지"를 확인 가능

#### 2. 턴 단위 상관관계 추가

권장 필드:

- `sessionId`
- `turnIndex`
- `parentRequestId`
- `rootTurnId`

효과:

- tool 호출이 있는 요청도 하나의 사용자 턴으로 묶어 분석 가능
- 재시도/후속 요청 흐름 추적이 쉬워짐

### P1

#### 3. prompt 구성 비율 상세화

권장 필드:

- `promptBreakdown.systemChars`
- `promptBreakdown.toolSchemaChars`
- `promptBreakdown.historyChars`
- `promptBreakdown.userChars`
- `promptBreakdown.toolResultChars`

효과:

- 실제 비용 원인을 정확히 분해 가능
- tool 스키마 과다 전송 여부를 바로 판단 가능

#### 4. local usage 추정치 또는 공급자 usage 보강

권장 방식:

- LM Studio 응답에서 usage가 있으면 직접 파싱
- 없으면 tokenizer 기반 추정치를 별도 필드로 기록

효과:

- local vs remote 비용 비교가 가능해짐

#### 5. preview 길이 제한 강화

권장 방식:

- `firstTextPreview`를 더 짧게 제한
- 원문 전체가 아니라 앞부분과 길이만 기록

효과:

- 로그 파일 팽창 방지
- 개인정보/민감 텍스트 노출 범위 감소

#### 6. tool argument / tool result 요약 로깅

단, 원문 전체가 아니라 redaction 기반 요약만 남긴다.

효과:

- 실제로 어떤 종류의 외부 동작이 호출되었는지 분석 가능
- tool 경로에서 생기는 토큰/지연시간 상관관계 파악 가능

### P2

#### 7. latency-aware routing

이번 실측에서는 local이 단순 요청에서도 `24~26초`가 걸린 케이스가 있었고, mini는 대부분 훨씬 짧았다.

즉 단순도만 볼 것이 아니라 아래를 함께 봐야 한다.

- 최근 local p95 latency
- 최근 local error rate
- 최근 remote cache hit ratio

조건에 따라 단순 요청도 mini로 보내는 정책이 더 나을 수 있다.

#### 8. tool 노출 축소 또는 지연 주입

모든 요청에 tool 18개가 실리는 구조는 prompt 비용에 불리하다. 아래 둘 중 하나를 검토할 가치가 있다.

1. tool이 필요한 요청에만 tool 목록 주입
2. 기본은 최소 tool 세트만 주입하고 필요 시 확장

## 추천 후속 작업

1. 로그 스키마에 `evaluation_*` 이벤트 추가
2. `turnId` 계열 필드 추가
3. prompt 길이 breakdown 추가
4. local token 추정 또는 usage 파싱 추가
5. preview 길이 상한 축소
6. 주간 집계 스크립트 또는 대시보드 초안 추가

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