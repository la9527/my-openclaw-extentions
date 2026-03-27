---
name: smart-router-log-analysis
description: Smart-router 실행 로그와 실호출 배치를 분석하는 skill. Use when AI needs to inspect JSONL logs, compare live batches, group turns by sessionId or rootTurnId, analyze misroutes, measure nano versus mini behavior, or summarize routing experiments into docs.
---

# Smart Router Log Analysis

smart-router 실험 결과를 재분석하거나 운영 이슈를 추적할 때 이 skill 을 사용한다.

## 이 skill 이 필요한 작업

- `~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl` 를 읽어 route 결과를 분석할 때
- live batch 결과를 요약 문서로 정리할 때
- `nano` 와 `mini` 응답시간, 과승격, fallback 패턴을 비교할 때
- tool 노출, local health, usage source 를 함께 확인할 때

## 로그에서 우선 볼 필드

- 이벤트 종류: `evaluation`, `route`, `payload`, `response`, `response_error`
- 식별자: `sessionId`, `turnIndex`, `rootTurnId`, `parentRequestId`
- 분류/라우팅: evaluation mode, score, tier, target model
- 운영 신호: tool exposure 여부, local health 정보, usage source

## 분석 원칙

- 한 turn 의 후속 request 는 `rootTurnId` 또는 `parentRequestId` 기준으로 다시 묶어서 본다.
- 단일 outlier 한 건으로 기본 tier 를 바꾸지 않는다. 평균과 중앙값을 같이 본다.
- `nano` 는 기본 remote tier 라기보다 선택적 lightweight tier 라는 현재 정책을 기준선으로 둔다.
- `llm` 분류 오판은 advanced 과승격과 timeout fallback 하향을 함께 본다.

## 결과 정리 방식

- 어떤 프롬프트 군이 `local`, `nano`, `mini`, `full` 로 갔는지 분류한다.
- latency 와 품질 문제가 함께 보일 때는 route policy 문제인지 provider 상태 문제인지 구분한다.
- 문서에는 구현 변경 사항, 실호출 관측 결과, 현재 정책 결론, 남은 리스크를 분리해서 적는다.

## 자주 남겨야 하는 결론 예시

- `mini` 가 일반 remote 기본 tier 로 더 안정적인지
- `nano` 를 기본 remote 로 확대할 근거가 충분한지
- 짧은 기술 설명 질의가 local 로 내려왔는지
- alert-only 운영 요청이 `full` 로 과승격되는지

## 관련 문서 시작점

- `docs/smart-router-work-summary-2026-03-28.md`
- `docs/smart-router-log-analysis-2026-03-27.md`
- `docs/smart-router-live-batch-analysis-2026-03-27.md`
- `docs/smart-router-nano-4tier-validation-2026-03-27.md`