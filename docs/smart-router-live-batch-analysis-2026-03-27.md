# smart-router 실호출 배치 분석 (2026-03-27)

## 목적

2026-03-27에 smart-router 후속 반영(P0/P1/P2 + 집계 스크립트) 이후, 실제 OpenClaw 호출을 30~40건 수준으로 다시 보내 로그 품질과 라우팅 동작을 재검증했다.

이번 문서는 `sr-batch-*` 세션만 따로 모아 본 최종 스냅샷이다.

## 검증 범위

- 사용자 직접 호출 턴: `39`
- smart-router request 수: `48`
- `evaluation` 이벤트: `48`
- `route` 이벤트: `48`
- `payload` 이벤트: `48`
- `response` 이벤트: `48`

차이가 생긴 이유는 일부 사용자 턴에서 tool call 이후 같은 `rootTurnId` 안에서 후속 request 가 연쇄 발생했기 때문이다.

## 실행 방법

실호출은 `openclaw agent --local --session-id ... --thinking low --json` 형태로 보냈다.

배치 집계는 아래 두 단계로 확인했다.

```bash
rg '"sessionId":"sr-batch-' ~/.openclaw/logs/smart-router-2026-03-27.jsonl > /tmp/smart-router-batch-2026-03-27.jsonl
node extensions/smart-router/summarize-smart-router-log.mjs /tmp/smart-router-batch-2026-03-27.jsonl
```

추가 지표는 별도 임시 분석 스크립트로 계산했다.

## 핵심 결과

### 1. 라우팅 분포

`route` 48건 기준 분포:

| tier | 건수 |
| --- | ---: |
| `local` | 3 |
| `mini` | 34 |
| `full` | 11 |

관찰:

- 단순 인사/고정 JSON 출력 같은 매우 짧은 요청만 `local`로 유지됐다.
- 일반 설명, 비교, 운영 정리 요청은 대부분 `mini`로 갔다.
- 실험 설계, fallback 흐름 설계, 임계값 정책 수립 같은 요청은 `full`로 올라갔다.

### 2. 사용자 턴과 request 체인

이번 배치에서 `39`개 사용자 턴이 `48`개 request 로 확장됐다.

의미:

- 평균적으로 한 사용자 턴당 약 `1.23`개의 request 가 발생했다.
- `responseSummary.toolCallCount > 0` 인 응답은 `8`건이었다.
- 실제로 `sr-batch-h:turn:2` 에서 `memory_search` tool call 이후 `parentRequestId`가 채워진 후속 request 가 이어졌다.

즉, `rootTurnId` 중심 집계가 실제 운영 로그에서도 필요하다는 점이 확인됐다.

### 3. prompt 비용 구조

배치 평균값:

- `avgEstimatedPromptChars`: 약 `44,619`
- `avgToolSchemaChars`: 약 `15,679`
- `avgEvaluationInputTokens`: 약 `316`
- `avgEvaluationTotalTokens`: 약 `383`
- provider usage 가 있는 응답의 평균 `input tokens`: 약 `3,580`
- provider usage 가 있는 응답의 평균 `total tokens`: 약 `11,091`

해석:

- 최종 응답 payload 는 여전히 system prompt + tool schema + 누적 history 영향이 크다.
- 라우팅 전 `evaluation` 호출 비용은 응답 본호출 대비 훨씬 작고, 현재 수준에서는 관측 오버헤드로 수용 가능하다.
- tool schema가 들어가는 mini/full 경로에서는 prompt 비용이 크게 유지된다.

### 4. tool exposure 동작

이번 배치에서 `toolExposureApplied: true` 는 `2`건이었다.

실제 확인된 local/simple 샘플:

- `originalToolCount: 18`
- `retainedToolCount: 0`
- `toolSchemaChars: 0`
- `estimatedPromptChars`: 약 `27.6k`

즉, 단순 local 요청에서는 tool schema 제거가 실제 payload에 반영됐다.

반면 전체 48개 request 중 대부분은 `mini` 또는 `full`이었고, 이 경로에서는 tool을 그대로 유지했다. 따라서 현재 정책은 local/simple 비용 절감에는 효과가 있지만, 전체 prompt 비용을 크게 낮추기에는 아직 범위가 좁다.

### 5. cache hit 상태

- `cacheRead > 0` 인 응답: `32`건

의미:

- 세션을 이어가며 보낸 요청에서 remote prompt cache 가 실제로 반복적으로 동작했다.
- 따라서 history가 길더라도 일부 비용은 캐시로 상쇄되고 있다.
- 단, smart-router 운영 판단에는 cache hit 의존이 과도해지지 않도록 별도 추적이 필요하다.

### 6. 응답 시간

tier별 평균 `durationMs`:

| tier | 평균 duration |
| --- | ---: |
| `local` | `20,918ms` |
| `mini` | `3,691ms` |
| `full` | `20,337ms` |

해석:

- 이번 환경에서는 `mini`가 가장 안정적으로 빠르다.
- `local`은 sample 수가 적지만 여전히 `20초` 전후로 느렸다.
- `full`은 복잡 요청 처리용으로 적절하지만 latency 비용이 높다.

즉, 현재 정책 방향인 “간단하면 local, 일반 설명은 mini, 설계급은 full”은 유지할 수 있지만, local 승격/강등 임계값은 실데이터를 더 모아 조정할 필요가 있다.

### 7. fallback / route adjustment 상태

이번 배치에서는 아래가 모두 `0`이었다.

- `evaluationFallbackToRule`
- `routeAdjustmentReason`

의미:

- 분류용 LLM 호출 실패는 없었다.
- latency-aware routing 로직은 아직 실제 임계값 발동 사례가 없었다.

이는 구현이 불필요하다는 뜻이 아니라, 운영 데이터가 더 쌓여야 조정 효과를 볼 수 있다는 뜻에 가깝다.

## 대표 샘플

### local/simple + tool schema 제거

`sr-batch-a:turn:1`

- 인사 + 한 줄 자기소개 요청
- `routeTier: local`
- `toolExposureApplied: true`
- `retainedToolCount: 0`
- `toolSchemaChars: 0`

### full/complex

`sr-batch-j:turn:1`

- 응답 토큰 추정치와 실제 usage 차이 검증 실험 설계 요청
- `routeTier: full`
- 다단계 계획 수립이 필요한 설계형 질문으로 분류

### tool call 연쇄

`sr-batch-h:turn:2`

- `responseSummary.toolCallCount: 1`
- `memory_search` 호출 발생
- 같은 `rootTurnId` 안에서 후속 request 에 `parentRequestId` 연결 확인

## 종합 판단

이번 39개 사용자 턴 실험 기준으로 smart-router는 아래를 실제 로그에서 입증했다.

1. 라우팅 결정 전 `evaluation` 비용을 별도로 측정할 수 있다.
2. `rootTurnId`와 `parentRequestId`로 tool-call 연쇄를 추적할 수 있다.
3. local/simple 요청에서는 tool schema 제거가 실제 payload에 반영된다.
4. mini/full 요청에서는 prompt 비용의 큰 비중이 여전히 tool schema와 누적 history에서 나온다.
5. `mini`는 이번 환경에서 가장 좋은 latency/capability 균형을 보였다.

## 남은 작업

### 1. local usage 실측치 파싱

현재 local 응답은 여전히 `usageSource: estimate` 를 쓴다. 실측 usage를 직접 파싱해야 local vs remote 비교가 정교해진다.

### 2. latency-aware routing 임계값 보정

이번 배치에서 `routeAdjustmentReason` 이 한 번도 발생하지 않았으므로, 샘플 수와 임계값을 다시 조정할 필요가 있다.

### 3. tool schema 축소 정책 확대 여부 검증

현재는 local/simple 위주다. moderate 질문 중 tool 의도가 없는 케이스까지 축소해도 되는지 별도 실험이 필요하다.

### 4. 일일 리포트 자동화

`summarize-smart-router-log.mjs` 는 준비됐으므로, cron 또는 CI로 자동 발행만 연결하면 운영성이 올라간다.
