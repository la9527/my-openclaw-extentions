---
name: smart-router-routing-tuning
description: Smart-router 라우팅 정책과 tier 보정을 수정하는 작업용 skill. Use when AI needs to tune thresholds, evaluationMode, nano or mini selection, latency-aware routing, tool exposure, classifier guardrails, or smart-router route metadata behavior.
---

# Smart Router Routing Tuning

smart-router 라우팅 정책을 손볼 때 이 skill 을 사용한다. 일반 문서 편집이나 단순 README 수정만 하는 경우에는 과하게 호출할 필요가 없다.

## 이 skill 이 필요한 작업

- `local`, `nano`, `mini`, `full` tier 기준을 바꿀 때
- `threshold`, `evaluationMode`, `evaluationLlmTarget` 동작을 조정할 때
- `nano` 선택 조건, local health 승격, timeout fallback floor 를 손볼 때
- tool exposure pruning 정책을 바꿀 때
- footer model alias 또는 `smartRouterRoute` 메타 구조를 바꿀 때

## 먼저 확인할 파일

- `extensions/smart-router/index.ts`
- `extensions/smart-router/index.test.ts`
- `extensions/smart-router/README.md`
- `extensions/smart-router/openclaw.plugin.json`
- `docs/smart-router-work-summary-2026-03-28.md`

## 현재 기준 정책

- 일반 remote 기본 tier 는 `mini` 다.
- `nano` 는 항상 기본 remote tier 가 아니다.
- `nano` 는 짧고 경량인 비교/요약 요청, `llm` 분류 모델, local 상태 불량 시 1차 fallback 에 우선 쓴다.
- `llm` 분류는 유지할 수 있지만 guardrail 없이 확장하지 않는다.
- route 표시가 필요하면 실제 실행 OpenClaw UI가 어떤 필드를 읽는지 먼저 확인한다.

## 작업 절차

1. 기존 정책과 최근 실호출 검증 결과가 문서와 코드에서 일치하는지 확인한다.
2. 정책을 바꿀 때는 왜 바꾸는지 분류 오차, latency, timeout, tool 비용 관점에서 근거를 남긴다.
3. 구현 변경 시 테스트와 README, 플러그인 스키마 설명을 같이 갱신한다.
4. 기존 public alias 와 config key 이름은 특별한 이유가 없으면 유지한다.

## 검증 체크리스트

최소:

```bash
cd extensions/smart-router
pnpm exec vitest run complexity.test.ts index.test.ts
```

로그나 관측성 변경 포함 시:

```bash
cd extensions/smart-router
pnpm exec vitest run complexity.test.ts index.test.ts smart-router-log.test.ts
```

## 변경 후 답변에 포함할 내용

- 어떤 tier 정책이 바뀌었는지
- `mini` 와 `nano` 역할이 어떻게 달라졌는지 또는 유지됐는지
- 실제 모델 ID 노출과 route alias 노출을 어떻게 처리했는지
- 실행한 테스트와 아직 남은 실호출 검증 항목