# smart-router 4-tier follow-up 배치 결과 (2026-03-27)

## 목적

`nano` 4-tier 반영 이후 남아 있던 세 가지 질문을 실제 OpenClaw 호출로 다시 확인했다.

1. `advanced -> full` 승격을 더 강하게 만들면 실제로 개선되는가
2. `nano vs mini` 는 moderate 실사용에서 어느 쪽이 더 빠른가
3. 같은 날 30~40건 규모 배치에서 새 정책이 어떤 부작용을 만드는가

## 코드 변경 요약

이번 follow-up 전에 반영한 핵심 수정은 아래와 같다.

1. rule 기반 평가에 `advanced` 전용 신호를 추가했다.
2. 운영 정책, KPI, 경보, fallback, runbook, trade-off, threat model 같은 표현을 `advanced/full` 힌트로 별도 취급했다.
3. 짧지만 명시적인 advanced 운영 설계 프롬프트도 fallback rule 에서 `full` 로 승격할 수 있게 보정했다.
4. LLM classifier prompt 에 아래 guardrail 을 추가했다.
   - 기술 용어만 많다고 `advanced` 로 올리지 말 것
   - 단일 주제 설명, 체크리스트, `3개 제안` 류는 보통 `moderate` 또는 `complex`
   - `advanced` 는 end-to-end/system-wide 범위와 KPI/alerts, rollout/runbook, migration/governance, failure-mode/threat-model, validation plan 중 최소 2축 이상이 결합된 경우에만 선택

## 테스트

실행 명령:

```bash
cd /Volumes/ExtData/MyOpenClawRepo/extensions/smart-router
pnpm exec vitest run complexity.test.ts index.test.ts smart-router-log.test.ts
```

결과:

- `3`개 테스트 파일 통과
- `44`개 테스트 통과

## 40건 본배치

배치 prefix:

- `sr-followup-20260327-223857-*`

구성:

- auto simple `6건`
- auto moderate `8건`
- auto complex `5건`
- auto advanced `5건`
- direct nano moderate `8건`
- direct mini moderate `8건`

### auto 결과 요약

| 그룹 | 결과 |
| --- | --- |
| simple | `5 local / 1 nano` |
| moderate | `5 nano / 3 full` |
| complex | `1 mini / 4 full` |
| advanced | `4 full / 1 local` |

해석:

1. `advanced/full` 미도달 문제는 상당 부분 해결됐다.
2. 그러나 같은 시점에 moderate/complex 일부가 `full` 로 과승격됐다.
3. 또 한 advanced 샘플은 LLM 평가 timeout 후 fallback 되면서 `local` 로 내려갔다.

### 대표 로그 해석

#### over-route: `m4`

- 세션: `sr-followup-20260327-223857-m4`
- 질문: `사용자 요청 난이도 분류에서 false positive를 줄이는 방법을 알려줘.`
- LLM classifier 결과: `advanced`
- 최종 route: `full`

즉, 분류 모델이 "분류 전략, 검증 계획, 임계값 조정" 같은 단어를 보고 단일 주제 설명 요청도 `advanced` 로 과대평가했다.

#### under-route: `a5`

- 세션: `sr-followup-20260327-223857-a5`
- 질문: `threat model, capacity planning, KPI, runbook, end-to-end validation` 포함
- 결과: LLM 평가 timeout
- fallback rule 결과: `simple/local`

즉, 이 케이스는 classifier 품질 문제라기보다 timeout 이후 fallback 품질과 timeout budget 의 문제에 더 가깝다.

## direct nano vs mini 비교

같은 moderate 성격 프롬프트 8개를 direct selection 으로 비교했다.

### 평균 지연시간

| tier | 평균 응답시간 |
| --- | ---: |
| `nano` | 약 `11.0s` |
| `mini` | 약 `4.9s` |

### 중앙값 지연시간

| tier | 중앙값 응답시간 |
| --- | ---: |
| `nano` | 약 `5.8s` |
| `mini` | 약 `4.1s` |

보정 해석:

1. `nano` 쪽에 `49.7s` outlier 한 건이 있었다.
2. 그 outlier 를 감안해도 중앙값 기준으로 `mini`가 더 빠르다.
3. 따라서 현재 환경에서는 `nano`가 moderate 기본 tier 라기보다 저비용 remote tier 또는 평가 모델로 더 적합해 보인다.

## retune 재검증

본배치 결과를 본 뒤 classifier prompt 와 fallback rule 을 다시 조정하고, 문제 세션 위주로 재검증을 돌렸다.

배치 prefix:

- `sr-retune-20260327-231723-*`

실제 완료된 세션은 8건이었다.

### 결과

| 세션 | 질문 성격 | 결과 |
| --- | --- | --- |
| `t1` | nano 모델 역할 설명 | `nano` |
| `t2` | prompt cache 설명 | `nano` |
| `t3` | false positive 완화 | `mini` |
| `t4` | p95 + error rate 기준 | `full` |
| `t5` | 경보 조건 3개 | `mini` |
| `t6` | 리팩토링 전략 | `mini` |
| `t7` | 장애 지점 분석 | `mini` |
| `t8` | 4-tier 운영 정책 재설계 | `full` |

### 비교 해석

좋아진 점:

1. `false positive` 완화 요청은 `full -> mini` 로 내려왔다.
2. `경보 조건 3개` 요청도 `full -> mini` 로 내려왔다.
3. `리팩토링 전략`, `장애 지점 분석` 역시 `full -> mini` 로 내려왔다.
4. 진짜 advanced 성격의 운영 정책 재설계는 계속 `full` 로 유지됐다.

남은 문제:

1. `latency p95 + error rate` 판단 기준은 아직 `full` 이다.
2. `nano 모델 역할` 같은 짧은 기술 질의는 `local` 이 아니라 `nano` 로 간다.
3. retune 에서 일부 예정 세션은 끝까지 완료되지 않아 timeout 재현성은 더 확인이 필요하다.

## 추가 calibration 재검증

후속으로 아래 두 가지를 더 보정했다.

1. `p95 + error rate` 같은 단일 metric 판단 요청은 `advanced` 응답이 와도 `complex/mini` 쪽으로 낮추는 calibration
2. `nano 모델 역할`, `threshold 뜻` 같은 짧은 기술 설명 질의는 `simple/local` 로 낮추는 calibration

짧은 실호출 재검증(`sr-calib-20260327-233246-*`) 결과:

| 세션 | 질문 성격 | 결과 |
| --- | --- | --- |
| `1` | `p95 + error rate` 판단 기준 | `complex/mini` |
| `2` | 일일 리포트 경보 조건 3개 | `advanced/full` |
| `3` | nano 모델 역할 설명 | `simple/local` |
| `4` | threshold 뜻 설명 | `simple/local` |

해석:

1. 이번 단계의 핵심 목표였던 `p95 + error rate` 과승격과 짧은 기술 설명의 과원격화는 해결됐다.
2. 반면 `경보 조건 3개` 류는 여전히 `advanced/full` 로 보는 경향이 있어, 다음 보정은 alert-only 짧은 운영 요청을 `complex/mini` 로 낮추는 guardrail 이 된다.

## 현재 판단

이번 follow-up 에서 도출된 결론은 아래와 같다.

1. `advanced/full 강화` 자체는 성공했다.
2. 다만 live `llm` 분류에서는 guardrail 이 없으면 쉽게 과승격한다.
3. guardrail 을 넣은 뒤에는 `full` 남용이 상당히 줄었지만 아직 완전히 안정적이지는 않다.
4. `nano`는 현재 환경에서 moderate 기본 tier 라기보다 `저비용 remote tier`, `evaluation 모델`, `local 1차 fallback` 역할이 더 적합하다.
5. 일반 remote 기본 tier 는 여전히 `mini`가 가장 안정적이다.

## 다음 우선순위

1. `p95 + error rate` 류의 짧은 운영 지표 질의를 `complex/mini` 로 낮추는 추가 guardrail
2. `nano 모델 역할`, `threshold 설명` 같은 짧은 기술 설명 질의를 `local` 또는 `nano` 중 어떤 쪽이 맞는지 정책 확정
3. `llm` evaluation timeout 시 rule fallback 뿐 아니라 `advanced signal preserve` 성격의 보조 규칙 도입 검토