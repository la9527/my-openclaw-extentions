# smart-router nano 4-tier 검증 결과 (2026-03-27)

## 목적

`nano`를 기존 smart-router 체계에 정식 중간 tier로 추가했을 때, 아래 두 가지를 확인하기 위해 재검증했다.

1. auto 라우팅이 실제로 `local / nano / mini / full` 4단계를 구분하는가
2. 같은 질문에서 `local / nano / mini / full` 직접 선택 시 응답 시간과 사용량이 어떻게 달라지는가

## 재확인 범위

### 코드 반영 여부

- `RouteTarget`: `local | nano | mini | full`
- 기본 auto 매핑:
  - `simple -> local`
  - `moderate -> nano`
  - `complex -> mini`
  - `advanced -> full`
- local health 기반 승격은 `local -> nano` 1차 승격으로 조정됨
- `toolExposureMode=minimal` 에서는 `nano`까지 tool 축소 대상으로 포함됨

### 테스트

실행 명령:

```bash
cd /Volumes/ExtData/MyOpenClawRepo/extensions/smart-router
pnpm exec vitest run smart-router-log.test.ts complexity.test.ts index.test.ts
```

결과:

- `3`개 테스트 파일 통과
- `41`개 테스트 통과
- 실패 없음

## auto 라우팅 실측 결과

실호출 세션:

- `sr-nano-auto-simple`
- `sr-nano-auto-moderate`
- `sr-nano-auto-complex`
- `sr-nano-auto-advanced`

결과:

| 세션 | 프롬프트 성격 | 분류 level | route tier | 응답 시간 |
| --- | --- | --- | --- | ---: |
| `sr-nano-auto-simple` | 인사 + 한 줄 자기소개 | `simple` | `local` | `13,549ms` |
| `sr-nano-auto-moderate` | dataclass vs pydantic 비교 | `moderate` | `nano` | `2,936ms` |
| `sr-nano-auto-complex` | TypeScript 서비스 레이어 리팩토링 전략 | `complex` | `mini` | `4,336ms` |
| `sr-nano-auto-advanced` | 4-tier 운영 실험 설계와 성공 지표 표 작성 | `complex` | `mini` | `1,024ms` + 후속 `9,655ms` |

해석:

1. `simple -> local`, `moderate -> nano`, `complex -> mini` 는 실제 로그에서 확인됐다.
2. 그러나 advanced로 의도한 샘플은 `advanced/full`이 아니라 `complex/mini`로 분류됐다.
3. advanced 샘플은 첫 응답에서 tool call이 발생했고, 같은 `rootTurnId` 안에서 후속 request 가 이어졌다.

즉, 4-tier 구조는 동작하지만 `advanced => full` 경로는 아직 분류 기준이 충분히 강하지 않다.

## direct selection 비교 결과

비교 프롬프트:

`파이썬 dataclass와 pydantic 차이를 5문장 이내로 비교해줘.`

세션:

- `sr-nano-direct-local`
- `sr-nano-direct-nano`
- `sr-nano-direct-mini`
- `sr-nano-direct-full`

결과:

| direct tier | 모델 | 응답 시간 | usage source | total tokens |
| --- | --- | ---: | --- | ---: |
| `local` | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` | `22,988ms` | `estimate` | `11,029` |
| `nano` | `gpt-5.4-nano-2026-03-17` | `4,839ms` | `provider` | `9,777` |
| `mini` | `gpt-5.4-mini-2026-03-17` | `1,791ms` | `provider` | `9,806` |
| `full` | `gpt-5.4-2026-03-05` | `4,469ms` | `provider` | `9,783` |

관찰:

1. 현재 환경에서 `mini`가 같은 moderate 질문에 가장 빨랐다.
2. `nano`는 `local`보다 훨씬 빠르지만, 이번 샘플에서는 `mini`보다 느렸다.
3. token 총량은 `nano/mini/full`이 거의 비슷했다. 즉 이 샘플에서는 비용 차이보다 latency 차이가 더 중요했다.
4. `local`은 여전히 느리고 usage도 추정치에 의존한다.

## 현재 시점의 판단

### 확인된 점

1. `nano` 4-tier 구조는 코드와 테스트에 반영됐다.
2. auto moderate는 실제로 `nano`로 간다.
3. direct nano는 별도 선택 모델로 정상 동작한다.

### 아직 미해결인 점

1. advanced 프롬프트가 이번 샘플에서 `full`까지 올라가지 않았다.
2. moderate 단건 설명 요청에서는 `nano`보다 `mini`가 더 빨랐다.
3. 따라서 현재 상태만으로 `nano`를 moderate 기본 tier로 확정하는 것은 이르다.

## 권장 개선안

### 1. advanced/full 승격 기준 강화

현재 classifier가 advanced 성격의 요청을 `complex`로 낮게 분류하는 경우가 있다.

우선 개선 포인트:

- 실험 설계
- 성공 지표 설계
- 다단계 운영 정책 수립
- fallback 설계
- 표/매트릭스 기반 비교 설계

같은 표현을 `advanced/full` 힌트로 더 강하게 반영해야 한다.

### 2. nano 기본 tier 여부는 latency 실험 후 확정

이번 결과만 보면 moderate 단건 설명 요청은 `mini`가 더 빠르다.

따라서 바로 고정하지 말고 아래 두 정책을 비교하는 것이 맞다.

1. `moderate -> nano`
2. `moderate -> mini`, 단 비용 절감이 중요할 때만 `nano`

### 3. nano는 기본 middle tier보다 "저비용 remote tier" 역할이 더 적합할 수 있음

현재 관측만 보면 `nano`는 다음 역할이 더 자연스럽다.

1. local이 느리거나 불안정할 때의 1차 remote fallback
2. 분류용 LLM evaluation 모델
3. 아주 짧은 설명/비교 요청용 저비용 remote tier

즉, 모든 moderate 요청의 기본값이 아니라, "작은 remote tier"로 쓰는 모델이 더 맞을 가능성이 있다.

## 다음 작업 순서

1. advanced/full 유도 프롬프트 세트를 10~20개 더 만들어 classifier 민감도 재검증
2. moderate 샘플 세트를 늘려 `nano vs mini` latency/quality 비교
3. `evaluation.classifierLevel=advanced` 비율과 실제 `routeTier=full` 비율을 함께 집계
4. 결과에 따라 `moderate -> nano` 유지 여부 또는 `nano` 역할 재정의

## 결론

이번 재확인으로 아래는 확정됐다.

1. `nano`는 smart-router에 기술적으로 정상 통합됐다.
2. `local/nano/mini/full` 4-tier는 코드와 테스트에서 모두 성립한다.
3. 실제 auto 라우팅에서도 `nano`가 중간 tier로 동작한다.

하지만 운영 정책 관점에서는 아래 결론이 더 중요하다.

1. `advanced -> full`은 아직 충분히 강하게 유도되지 않는다.
2. 현재 환경에서는 moderate 단건 설명 요청에 `mini`가 `nano`보다 더 빠를 수 있다.
3. 따라서 `nano`는 일단 도입하되, 기본 moderate tier로 확정하기 전에 추가 실험이 필요하다.