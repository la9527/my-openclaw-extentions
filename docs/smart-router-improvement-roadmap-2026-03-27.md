# smart-router 개선 로드맵 (2026-03-27)

## 목적

이 문서는 2026-03-27 기준 smart-router 실측 결과를 바탕으로, 다음 단계에서 실제 효과가 큰 개선안을 우선순위 중심으로 정리한 문서다.

기존 문서가 "무엇을 관측했고 무엇이 남았는가"를 정리했다면, 이 문서는 "무엇부터 바꿔야 실제 비용, 지연시간, 라우팅 품질이 개선되는가"에 초점을 둔다.

기준 입력은 아래 세 가지다.

1. P0/P1/P2 후속 반영 결과
2. 39개 사용자 턴, 48개 request 실호출 배치 분석
3. 현재 smart-router 로그 스키마와 테스트 상태
4. `local/nano/mini/full` 4-tier 재검증 결과

## 4-tier 재검증 요약

2026-03-27에 `nano`를 auto 중간 tier로 추가한 뒤, 코드/테스트/실호출을 다시 확인했다.

확인 결과:

1. 코드상 `RouteTarget` 은 `local | nano | mini | full` 로 반영됐다.
2. `routeTargetFromLevel()` 기본 매핑은 `simple -> local`, `moderate -> nano`, `complex -> mini`, `advanced -> full` 이다.
3. 테스트는 `41`개 전부 통과했다.
4. 실호출에서 `auto simple -> local`, `auto moderate -> nano`, `auto complex -> mini` 는 확인됐다.
5. 다만 이번 advanced 샘플은 실제로 `full`이 아니라 `mini`로 분류됐다.

즉, 4-tier 구조 자체는 들어갔지만, 운영 품질 관점에서는 아직 "nano를 기본 moderate tier로 고정해도 되는가"와 "advanced가 full로 충분히 올라가는가"를 더 검증해야 한다.

### 직접 비교 결과

같은 moderate 질문 `파이썬 dataclass와 pydantic 차이를 5문장 이내로 비교해줘.` 를 direct selection으로 비교한 결과는 아래와 같았다.

| direct tier | duration | usage 특징 |
| --- | ---: | --- |
| `local` | `22,988ms` | `usageSource: estimate` |
| `nano` | `4,839ms` | provider usage 기록 |
| `mini` | `1,791ms` | provider usage 기록 |
| `full` | `4,469ms` | provider usage 기록 |

이 결과만 보면, 현재 환경에서는 moderate 단건 설명 요청에 대해 `mini`가 `nano`보다 더 빠르다.

즉, `nano`를 추가했다고 해서 곧바로 "moderate는 nano가 최적"이라고 결론 내리면 안 된다.

### auto 분류 결과

실호출 기준 확인된 auto 결과:

| 세션 | 실제 분류 |
| --- | --- |
| `sr-nano-auto-simple` | `local` |
| `sr-nano-auto-moderate` | `nano` |
| `sr-nano-auto-complex` | `mini` |
| `sr-nano-auto-advanced` | `mini` |

여기서 중요한 관찰은 마지막 항목이다.

- advanced 성격의 프롬프트를 넣었지만 분류 모델은 `complex`로 판정했다.
- 그 결과 target 도 `full`이 아니라 `mini`가 됐다.
- 추가 tool call 연쇄까지 포함되면서 한 turn 안에서 여러 request가 발생했다.

즉, 현재 가장 먼저 손봐야 할 것은 `nano` 추가 자체보다도, `advanced/full`로 올려야 할 프롬프트를 분류기가 충분히 강하게 올려주도록 기준을 보정하는 일이다.

## 현재 상태 요약

2026-03-27 추가 결정으로, 다음 단계 auto routing의 기본 축은 `local -> nano -> mini -> full` 4-tier 구조로 본다. 기존 3-tier(`local -> mini -> full`) 실측 결과에서 `mini`가 가장 안정적인 균형점이었기 때문에, `nano`를 moderate 전용 경량 remote tier로 삽입해 응답시간과 비용 변화를 따로 관측하는 것이 우선 과제가 됐다.

실측에서 확인된 핵심 사실은 아래와 같다.

1. `mini`가 현재 환경에서 가장 좋은 latency/capability 균형을 보였다.
2. `local`은 simple 요청 처리에는 맞지만 평균 응답시간이 여전히 약 `20초` 수준으로 느리다.
3. 평균 `estimatedPromptChars`는 약 `44.6k`이고, 그중 평균 `toolSchemaChars`는 약 `15.7k`였다.
4. `evaluation` 호출 비용은 평균 약 `383` tokens 수준으로, 최종 응답 비용보다 훨씬 작다.
5. tool-call 연쇄는 실제로 발생하며, `rootTurnId`/`parentRequestId` 기반 집계가 유효함이 확인됐다.
6. 현재 selective tool exposure는 local/simple 일부에만 적용되어 전체 prompt 비용 절감 폭은 제한적이다.

이 결과를 종합하면, 다음 단계의 핵심 문제는 아래 네 가지다.

1. local 경로의 latency가 아직 높다.
2. mini/full 경로의 prompt 비용이 여전히 크다.
3. routing policy는 들어갔지만 실데이터 기반 튜닝은 아직 부족하다.
4. 운영 집계는 가능해졌지만 자동 액션으로 이어지지 않는다.

## 개선 우선순위

### 1. local 경로를 "기본 선호"가 아니라 "건강할 때만 선호"로 전환

가장 큰 개선 효과가 예상되는 항목이다.

현재 관측상 `local`과 `full`의 평균 지연시간이 비슷한 수준으로 높고, `mini`가 훨씬 빠르다. 따라서 단순히 난이도가 낮다는 이유만으로 local을 우선하는 정책은 운영 체감 품질 측면에서 손해일 가능성이 크다.

개선 방향:

1. local route를 선택하기 전에 최근 `N`개 응답의 health를 먼저 본다.
2. local이 느리거나 오류율이 높으면 simple 요청도 우선 `mini`로 보낸다.
3. local은 "가장 싼 기본값"이 아니라 "건강할 때만 쓰는 저비용 옵션"으로 정의를 바꾼다.

권장 정책:

- `sampleCount >= localHealthMinSamples`
- `p95 >= localLatencyP95ThresholdMs` 이면 `local -> mini`
- `errorRate >= localErrorRateThreshold` 이면 `local -> mini`
- 첫 요청 또는 샘플 부족 시에는 warmup window를 별도로 둔다

추가 제안:

- `localWarmupPenaltyMs` 같은 개념을 도입해, local 첫 응답이 느린 환경에서는 warmup 기간 동안 local 점수를 보수적으로 계산한다.
- `routeAdjustmentReason` 에 단순 `latency` 외에 `insufficient_samples`, `warmup_penalty`, `error_rate` 등을 구분해서 남긴다.

기대 효과:

1. simple 요청의 체감 latency 감소
2. local 상태가 나쁠 때 route 품질이 흔들리는 문제 완화
3. local을 고집하느라 사용자 경험이 저하되는 상황 방지

### 2. tool schema 노출을 local/simple 밖으로 확장

현재 prompt 비용에서 가장 큰 고정비 중 하나는 tool schema다. local/simple에서는 일부 절감에 성공했지만, 전체 배치 기준으로는 평균 `toolSchemaChars`가 여전히 약 `15.7k`였다.

즉 다음 단계는 "tool을 완전히 제거할 수 있는가"보다 "정말 필요한 tool만 남길 수 있는가"가 된다.

개선 방향:

1. `local/simple` 뿐 아니라 `mini/moderate`에도 selective tool exposure를 적용한다.
2. tool intent가 명확하지 않은 요청은 전체 tool set 대신 최소 subset만 주입한다.
3. tool 사용 이력이 있는 세션도, 현재 turn에 필요한 tool만 남기는 방향으로 줄인다.

권장 정책 단계:

1. `none`: tool schema 전부 제거
2. `minimal`: 파일/검색/웹/실행 등 핵심 tool subset만 유지
3. `full`: 전체 tool 유지

예시 기준:

- 단순 설명/정리/번역/비교: `none`
- 일반 운영 질의, 로그 해석, 리포트 생성: `minimal`
- 파일 읽기, 검색, 실행, 세션 조작, 외부 호출 의도 명확: `full`

구현 포인트:

- 현재 boolean 성격의 `toolExposureApplied`를 `toolExposureProfile` 같은 다단계 값으로 확장
- `retainedToolNames` 또는 `retainedToolGroup` 요약 필드 추가
- 어떤 이유로 어떤 tool set이 선택됐는지 `toolExposureReason` 기록

기대 효과:

1. mini 경로 평균 input token 감소
2. moderate 질문의 불필요한 prompt 고정비 절감
3. tool 노출 정책을 A/B 실험하기 쉬워짐

### 3. rule-first + ambiguity-gated evaluation으로 분류 비용과 정책 불안정성 축소

현재 `evaluation` 비용 자체는 과하지 않지만, 모든 auto 요청에 LLM 평가를 거는 구조는 장기적으로 비용과 복잡성을 함께 키운다.

더 좋은 방향은 "명확한 케이스는 rule로 끝내고, 애매한 구간만 LLM에 묻는 것"이다.

개선 방향:

1. obvious simple는 즉시 local 또는 mini로 결정
2. obvious complex는 즉시 full로 결정
3. rule score가 경계 구간일 때만 LLM 평가 호출

권장 흐름:

1. 규칙 점수 계산
2. confidence band 계산
3. high confidence면 즉시 route
4. low confidence면 `evaluation` 호출

예시:

- score `0~1`: simple high confidence
- score `2~3`: ambiguity band
- score `4+`: moderate/complex high confidence

추가 로그 제안:

- `evaluationSkipped`
- `evaluationSkipReason`
- `ruleConfidence`
- `routeConfidence`

기대 효과:

1. 분류용 LLM 호출 수 자체 감소
2. 분류 latency 감소
3. route 정책이 더 설명 가능해짐

### 4. session history를 무조건 누적하지 말고 압축 정책을 도입

실측상 prompt 비용의 또 다른 큰 축은 누적 history다. 캐시가 일부 상쇄하긴 하지만, 매 요청마다 긴 history를 그대로 싣는 구조는 결국 느리고 비싸다.

개선 방향:

1. 최근 `K`개 turn은 그대로 유지
2. 오래된 turn은 summary block으로 압축
3. tool result는 원문 대신 구조화 요약으로 변환

권장 정책:

- keep-last-turns: 최근 3~5 turn 유지
- compress-older-turns: 이전 turn은 요약 텍스트로 변환
- keep-tool-results-short: tool result는 길이 제한 + 핵심 필드만 유지

추가 로그 제안:

- `historyCompressionApplied`
- `historyCharsBefore`
- `historyCharsAfter`
- `toolResultCompressionApplied`

기대 효과:

1. 세션 길이가 늘어도 prompt size 증가율 완화
2. cache hit가 없어도 비용 폭증 억제
3. long-running session 안정성 향상

### 5. local usage를 추정치에서 실측치로 전환

현재 분석에서 local 경로는 `usageSource: estimate` 의존이 남아 있다. 이 상태에서는 local vs remote 효율 비교가 근본적으로 부정확하다.

개선 방향:

1. LM Studio 또는 local provider 원본 usage 필드를 우선 파싱
2. usage가 없을 때만 추정치 fallback 유지
3. 실측치와 추정치 차이를 일정 기간 나란히 기록해 estimator 품질을 검증

권장 로그:

- `usageSource: provider | estimate | mixed`
- `usageEstimateDelta`
- `providerUsageAvailable`

기대 효과:

1. local route 비용 비교 신뢰도 상승
2. 정책 조정 시 잘못된 비용 가정 감소
3. local/mini/full 선택 기준을 정량적으로 재설계 가능

### 6. 운영 집계를 "보기용"에서 "경보용"으로 확장

지금은 JSONL을 요약할 수는 있지만, 운영 자동화는 아직 없다. 다음 단계는 지표를 읽는 것이 아니라, 조건이 나빠질 때 자동으로 알 수 있게 만드는 것이다.

권장 일일 KPI:

1. tier별 request 수
2. tier별 평균/95p latency
3. evaluation 호출 수와 total tokens
4. response total tokens
5. tool exposure profile 분포
6. tool-call turn 비율
7. cacheRead hit 비율
8. route adjustment 발생 비율
9. local usage source 분포
10. response_error 수

권장 경보 조건:

1. local p95 latency가 기준 초과
2. full route 비율이 평소 대비 급증
3. response_error 또는 evaluation fallback 증가
4. average prompt chars 급증

운영 연결 후보:

1. cron 기반 Markdown/JSON 일일 리포트
2. n8n webhook으로 운영 채널 전송
3. PostgreSQL 적재 후 대시보드 연결

## 권장 실행 순서

아래 순서가 가장 비용 대비 효과가 크다.

### 1단계: 운영 체감 개선

1. local health 기준 강화
2. selective tool exposure를 mini/moderate로 확장

이 단계는 latency와 prompt cost를 동시에 줄일 가능성이 크다.

### 2단계: 비용 구조 안정화

1. rule-first + ambiguity-gated evaluation 적용
2. session history compression 도입

이 단계는 장기 대화와 대량 트래픽에서 효과가 커진다.

### 3단계: 측정 정밀도 향상

1. local usage 실측치 파싱
2. 운영 집계 자동화 및 경보 연결

이 단계는 정책의 정확한 재조정을 가능하게 만든다.

## 실험 계획

### 실험 A: mini/moderate tool schema 축소

목표:

- average input tokens 감소 확인
- response quality 저하 여부 확인

비교군:

1. 현재 정책
2. moderate + no explicit tool intent 시 `minimal` tool set

성공 기준:

- input tokens 15% 이상 감소
- tool error 또는 quality regression이 유의미하게 늘지 않을 것

### 실험 B: local health 기반 aggressive reroute

목표:

- simple 요청의 평균 latency 감소

비교군:

1. 현재 threshold
2. 더 공격적인 `local -> mini` 전환 기준

성공 기준:

- simple 요청 평균 latency 30% 이상 감소
- full 비율 불필요 상승 없음

### 실험 C: ambiguity-gated evaluation

목표:

- evaluation 호출 수 감소
- route 품질 유지

성공 기준:

- evaluation request 수 40% 이상 감소
- full/mini/local 분포가 비정상적으로 흔들리지 않을 것

## 문서 기준 결론

이번 실측을 기준으로 보면, smart-router의 다음 개선은 "더 많은 로그 추가"가 아니라 아래 세 가지에 집중하는 것이 맞다.

1. local을 무조건 우선하지 않고 health-aware route로 재정의하기
2. tool schema를 local/simple 밖으로도 줄여 prompt 고정비를 낮추기
3. 애매한 경우에만 LLM 평가를 호출하도록 분류 흐름을 단순화하기

이 세 가지가 먼저 들어가면, 현재 로그 체계만으로도 개선 효과를 정량적으로 다시 검증할 수 있다.