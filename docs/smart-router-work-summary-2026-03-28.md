# smart-router 작업 요약 (2026-03-28)

## 목적

이 문서는 2026-03-27부터 2026-03-28까지 진행한 smart-router 개선 작업을 한 번에 정리한 마감 요약 문서다.

기존 문서들이 단계별 분석과 실험 결과를 쪼개서 기록했다면, 이 문서는 아래 질문에 바로 답할 수 있도록 정리한다.

1. 무엇을 구현했는가
2. 실제 OpenClaw 실호출에서 무엇이 확인됐는가
3. 지금 기준으로 어떤 정책을 쓰는 것이 맞는가
4. 아직 남은 리스크는 무엇인가

## 이번 작업에서 구현한 내용

### 1. smart-router 로그/관측성 강화

아래 항목을 JSONL 실행 로그로 남기도록 정리했다.

1. `evaluation`, `route`, `payload`, `response`, `response_error`
2. `sessionId`, `turnIndex`, `rootTurnId`, `parentRequestId`
3. prompt breakdown
4. tool exposure 적용 여부
5. local health 정보
6. usage source (`provider` 또는 `estimate`)

이로 인해 한 사용자 turn 안에서 발생하는 tool call 연쇄와 후속 request를 다시 묶어 분석할 수 있게 됐다.

### 2. 일별 로그 분리와 보관 정책

실행 로그는 날짜별 파일로 분리되며, 기본 보관 기간은 10일이다.

기본 경로:

- `~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl`

### 3. 4-tier 라우팅 도입

기존 구조를 아래 4-tier로 정리했다.

1. `simple -> local`
2. `moderate -> mini` 를 기본 remote 경로로 사용
3. 짧고 경량인 비교/요약 요청만 선택적으로 `nano`
4. `advanced -> full`

직접 선택 모델도 함께 제공한다.

1. `smart-router/local`
2. `smart-router/nano`
3. `smart-router/mini`
4. `smart-router/full`

### 4. local health 기반 승격

local 상태가 나쁠 때는 무조건 local을 고집하지 않고, 1차로 `nano` 쪽으로 올릴 수 있게 했다.

기본 기준:

1. `localLatencyP95ThresholdMs`
2. `localErrorRateThreshold`
3. `localHealthMinSamples`

### 5. tool exposure 정책

tool schema가 prompt 비용을 크게 키는 문제를 줄이기 위해 아래 모드를 유지한다.

1. `full`
2. `conservative`
3. `minimal`

현재는 `local`과 일부 `nano` 경로에서 tool pruning이 적용될 수 있다.

### 6. classifier 보정

복잡도 판단 로직은 두 층으로 정리됐다.

1. rule 기반 평가
2. LLM 기반 평가 후 calibration

보정된 핵심 포인트:

1. KPI, rollout, runbook, fallback, threat model, capacity planning 같은 운영 설계 신호는 `advanced/full` 쪽으로 더 잘 올라가도록 강화
2. `p95 + error rate` 같은 단일 metric 판단 요청은 `advanced` 과승격을 막고 `complex/mini` 쪽으로 낮추는 calibration 추가
3. `nano 모델 역할`, `threshold 뜻` 같은 짧은 기술 설명 질의는 `simple/local` 쪽으로 낮추는 calibration 추가
4. `경보 조건 3개` 같은 alert-only 운영 요청은 `complex/mini` 쪽으로 낮추는 guardrail 추가
5. LLM timeout 시 짧은 고급 운영 설계 질의가 `local` 로 떨어지지 않도록 fallback floor 추가

### 7. 분류 실패 원인별 fallback 최종 정책

2026-03-29 기준으로 분류 실패 시 fallback 정책을 아래로 고정했다.

1. 분류 timeout이 `3초 이상`이면 `full`로 fallback
2. 분류 JSON 파싱 실패면 `nano`로 fallback
3. 분류 연결 실패(fetch/network)면 `nano`로 fallback
4. 분류 HTTP 실패면 `nano`로 fallback

즉, timeout 계열만 `full` 승격 후보로 보고 그 외 실패는 `nano`로 통일한다.

## 현재 기본 모델 구성

현재 기본값은 아래와 같다.

### local

- provider: `lmstudio`
- model: `lmstudio-community/LFM2-24B-A2B-MLX-4bit`

### remote

- `nano`: `gpt-5.4-nano-2026-03-17`
- `mini`: `gpt-5.4-mini-2026-03-17`
- `full`: `gpt-5.4-2026-03-05`

## 테스트 결과

최종 확인 기준:

```bash
cd /Volumes/ExtData/MyOpenClawRepo/extensions/smart-router
pnpm exec vitest run complexity.test.ts index.test.ts smart-router-log.test.ts
```

결과(2026-03-29 재확인):

1. `complexity.test.ts` + `index.test.ts` 는 `54`개 모두 통과
2. `smart-router-log.test.ts` 는 환경 의존 `prune` 케이스 `1`건이 간헐 실패할 수 있음
3. 전체 실행 기준 최근 결과는 `61`개 중 `60`개 통과

## 실호출 검증에서 확인된 핵심 결과

### 1. nano 4-tier 구조는 기술적으로 정상 동작

초기 검증에서 아래는 확인됐다.

1. `simple -> local`
2. 일반 `moderate -> mini`
3. 선택적 경량 `moderate -> nano`
4. direct `local/nano/mini/full` 모델 선택 모두 정상 동작

### 2. nano는 moderate 기본 tier로 확정하지 않는 쪽이 맞다

같은 moderate 성격 프롬프트 8개를 direct selection으로 비교했을 때:

1. `nano` 평균 응답시간: 약 `11.0s`
2. `mini` 평균 응답시간: 약 `4.9s`

`nano` 쪽에 큰 outlier가 한 번 있었지만, 중앙값 기준으로 봐도 `mini`가 더 빨랐다.

즉, 현재 환경에서는 일반 remote 기본 tier는 여전히 `mini`가 더 안정적이다. 현재 코드도 이 결론에 맞춰 `moderate` 기본 target 을 `mini`로 두고, 짧고 경량인 비교/요약 요청에만 `nano`를 선택적으로 사용하도록 정리했다.

### 3. advanced/full 강화는 성공했지만, LLM classifier는 과승격 위험이 있었다

40건 follow-up 배치에서 한때 아래 문제가 동시에 나타났다.

1. moderate/complex 일부가 `full`로 과승격
2. advanced 일부가 timeout fallback으로 `local`로 하강

원인 확인 결과:

1. live 구성에서 `evaluationMode=llm` 영향이 컸다.
2. classifier prompt가 운영/지표 관련 표현을 과하게 `advanced`로 해석하는 경우가 있었다.
3. timeout 시 rule fallback이 짧은 advanced 프롬프트를 충분히 보존하지 못하는 경우가 있었다.

### 4. 후속 calibration과 정책 보정으로 주요 문제를 줄였다

최종 추가 검증(`sr-calib-20260327-233246-*`)에서 확인된 결과:

1. `latency p95와 error rate를 함께 보는 판단 기준` → `complex/mini`
2. `nano 모델이 어떤 역할인지 짧게 말해줘` → `simple/local`
3. `threshold 뜻을 한 문장으로 설명해줘` → `simple/local`

즉, 이번 마감 시점 기준으로 아래 문제들은 코드 정책상 해결된 상태다.

1. `p95 + error rate` 류 단일 metric 요청의 과승격
2. 짧은 기술 설명 질의의 과원격화
3. alert-only 운영 요청의 `advanced/full` 과승격
4. LLM timeout 시 짧은 고급 운영 요청의 과도한 하향 fallback

## 현재 시점의 정책 결론

현재까지의 실측과 보정을 종합한 결론은 아래와 같다.

### 1. 일반 remote 기본 tier는 `mini`

`nano`가 도입됐더라도, 현재 환경에서는 일반적인 moderate remote 질의에서 `mini`가 더 안정적인 latency를 보여준다.

### 2. `nano`의 현실적인 역할

현재 기준으로 `nano`는 아래 역할이 더 자연스럽다.

1. 저비용 remote tier
2. 분류용 evaluation 모델
3. local 상태가 나쁠 때의 1차 fallback 후보
4. 짧고 경량인 비교/요약 요청 전용 tier

### 3. `llm` 분류는 쓸 수 있지만 guardrail이 필수

`llm` 평가 자체를 끄지 않아도 되지만, 아래 guardrail 없이 운영하면 `full` 남용 가능성이 높다.

1. 단일 metric 요청은 `complex` 쪽으로 제한
2. 짧은 기술 설명 질의는 `simple/local` 쪽으로 제한
3. truly advanced한 요청은 end-to-end 범위와 운영 설계 신호가 함께 있을 때만 `full`로 승격

### 4. 가장 안전한 운영 방향

당장 운영 안정성을 우선하면 아래 방향이 가장 무난하다.

1. 기본 정책은 `mini` 중심 remote 경로 유지
2. `nano`는 경량 remote 또는 evaluation 용도로 제한한다
3. `llm` 평가는 유지하되 calibration과 timeout fallback floor를 함께 둔다
4. alert-only 운영 요청은 `complex/mini` 쪽에서 소화한다

## 아직 남은 이슈

이번 작업 기준으로 아직 남아 있는 대표 이슈는 아래다.

1. 새 alert-only guardrail 과 timeout fallback floor 는 실호출 재검증이 더 필요하다.
2. local usage는 여전히 일부 구간에서 추정치 의존이 남아 있다.
3. `nano` 선택 조건은 실제 트래픽에서 더 좁히거나 넓힐 여지가 있다.

즉, 남은 다음 튜닝 포인트는 새 정책을 실호출 배치로 다시 검증하고 `nano` 선택 조건을 더 다듬는 것이다.

## 관련 문서

세부 분석과 단계별 결과는 아래 문서를 함께 보면 된다.

1. `docs/smart-router-log-analysis-2026-03-27.md`
2. `docs/smart-router-p0-followup-2026-03-27.md`
3. `docs/smart-router-live-batch-analysis-2026-03-27.md`
4. `docs/smart-router-improvement-roadmap-2026-03-27.md`
5. `docs/smart-router-nano-4tier-validation-2026-03-27.md`
6. `docs/smart-router-4tier-followup-batch-2026-03-27.md`

## 관련 커밋

이번 흐름의 핵심 커밋은 아래와 같다.

1. `2932090 smart-router: add evaluation tracing`
2. `d189263 smart-router: add routing analytics followup`
3. `ed05dda smart-router: add nano 4-tier routing`
4. `bf43059 smart-router: tune 4-tier classifier guardrails`

## 최종 요약

이번 작업으로 smart-router는 단순한 local/remote 라우터가 아니라, 아래 성격을 갖는 4-tier 실험형 라우터로 정리됐다.

1. 로그와 분석이 가능한 구조
2. `local/nano/mini/full` 4-tier 구조
3. local health, tool exposure, evaluation tracing이 연결된 구조
4. live 실험 결과를 바탕으로 classifier를 계속 튜닝할 수 있는 구조

현재 마감 시점에서 가장 실무적인 한 줄 결론은 아래다.

`mini`는 여전히 기본 remote 균형점이고, `nano`는 경량 remote / evaluation 용도에 더 적합하며, `llm` classifier는 calibration 없이 그대로 쓰면 안 된다.