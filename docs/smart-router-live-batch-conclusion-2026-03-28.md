# smart-router 20건 실호출 배치 결론

## 개요

- 실행 일시: 2026-03-28 02:03~02:13 KST
- 배치 prefix: `sr-policy-20260328-0203`
- 실행 방식: `openclaw agent --local --session-id ... --thinking low --json`
- 목적: mini-first 정책, selective nano, alert-only guardrail, timeout fallback 보존 정책을 실제 호출 20건으로 재검증

## 배치 구성

- simple/local 후보 5건
- lightweight compare/summary nano 후보 5건
- mini 후보 5건
- full 후보 5건

## 세션별 실제 결과

| Session | 기대 | 실제 | 판정 |
| --- | --- | --- | --- |
| `s1` | local | local/simple | 일치 |
| `s2` | local | local/simple | 일치 |
| `s3` | local | local/simple | 일치 |
| `s4` | local | local/simple | 일치 |
| `s5` | local | local/simple | 일치 |
| `n1` | nano | nano/moderate | 일치 |
| `n2` | nano | mini/moderate | 불일치 |
| `n3` | nano | nano/moderate | 일치 |
| `n4` | nano | nano/moderate | 일치 |
| `n5` | nano | nano/moderate | 일치 |
| `m1` | mini | mini/complex | 일치 |
| `m2` | mini | mini/complex | 일치 |
| `m3` | mini | mini/complex | 일치 |
| `m4` | mini | mini/moderate | 일치 |
| `m5` | mini | mini/complex | 일치 |
| `a1` | full | full/advanced | 일치 |
| `a2` | full | full/advanced | 일치 |
| `a3` | full | full/advanced | 일치 |
| `a4` | full | full/advanced | 일치 |
| `a5` | full | full/advanced | 일치 |

## 집계

- 기대 일치: 19/20
- 기대 불일치: 1/20
- 실제 분포
  - `local`: 5
  - `nano`: 4
  - `mini`: 6
  - `full`: 5

## 관찰 사항

### 1. simple/local 경계는 안정적이다

짧은 용어 설명, 한 줄 설명, 기본 개념 설명 5건은 모두 `local/simple`로 처리됐다. 이번 배치에서는 simple 요청이 remote로 잘못 승격된 사례가 없었다.

### 2. mini-first 정책은 의도대로 동작한다

운영 기준 정리, threshold 튜닝, 리팩토링 전략, 자세한 기술 설명 같은 일반적인 중간 난이도 요청은 `mini`로 모였다. 특히 다음 두 케이스가 중요했다.

- `m1`: `p95 + error rate` 복합 기준 요청이 `mini/complex`
- `m2`: alert-only 성격의 운영 요청이 `full`로 오르지 않고 `mini/complex`

이는 이전에 문제였던 과승격 두 유형이 이번 배치에서는 재현되지 않았다는 뜻이다.

### 3. nano는 선택적으로만 사용된다

경량 비교/요약 5건 중 4건은 `nano`로 갔다. `n2` 한 건은 `REST vs GraphQL` 비교 요청이 `mini/moderate`로 분류됐다. 문장 길이는 짧지만 주제가 넓고 설명 범위가 비교적 일반적이라, 현재 규칙과 LLM 판정 조합에서 `nano`보다 `mini` 쪽으로 기운 것으로 보인다.

즉 현재 nano 정책은 "보수적인 선택적 사용"으로 해석하는 것이 맞다. 이번 결과는 nano를 일반 remote 기본 tier로 두지 않고, 경량 비교/요약에만 제한적으로 쓰는 현재 방향을 오히려 지지한다.

### 4. full 승격 경계는 명확하다

운영 정책 재설계, governance, migration strategy, threat model, rollout, runbook, capacity planning, validation plan을 포함한 5건은 모두 `full/advanced`로 승격됐다. advanced 요청이 `mini`에 머무른 사례는 없었다.

### 5. timeout fallback 보존은 부작용 없이 작동했다

배치 중 `a1`에서 parent request 이후 재평가가 있었고, evaluation timeout fallback 흔적이 보였지만 최종 target은 계속 `full`로 유지됐다. 이는 timeout fallback 보존 로직이 고급 신호를 잃지 않았다는 정성적 증거다.

## 최종 결론

이번 20건 실호출 기준으로 현재 정책의 결론은 다음과 같다.

1. `moderate -> mini` 기본 경로는 유지하는 것이 맞다.
2. `nano`는 경량 compare/summary 전용의 selective tier로 유지하는 것이 맞다.
3. alert-only guardrail은 효과가 있었고, 최소 이번 배치에서는 `full` 과승격을 막았다.
4. timeout fallback 보존 로직은 고난도 요청의 최종 tier를 보존하는 방향으로 정상 동작했다.
5. 남은 미세 조정 포인트는 `n2` 같은 짧은 범용 비교 요청을 `nano`로 더 적극적으로 보낼지 여부뿐이다.

현재 시점에서 정책 방향을 다시 뒤집을 근거는 없다. 운영 기본값은 다음처럼 유지하는 것이 가장 타당하다.

- `simple -> local`
- `lightweight compare/summary -> selective nano`
- `general moderate/complex -> mini`
- `advanced operational design -> full`

## 후속 권장 사항

- 즉시 수정이 필요한 수준의 오분류는 없으므로 코드 추가 수정 없이 현 정책을 유지한다.
- 다만 `REST vs GraphQL` 류의 짧은 범용 비교를 nano로 더 보내고 싶다면, `shouldPreferNanoForModerate(...)`에 비교 키워드 범위를 조금 더 넓히는 소규모 실험은 할 수 있다.
- 다음 재검증은 20건보다 큰 샘플보다도, `nano` 경계 프롬프트만 따로 10건 내외로 모아 precision 확인을 하는 편이 더 효율적이다.