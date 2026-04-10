# smart-router 환경 히스토리 (2026-04-04)

## 목적

- `MyOpenClawRepo` 문서에서 smart-router 로컬 런타임 기준이 시점별로 어떻게 바뀌었는지 한 번에 볼 수 있게 정리한다.
- 현재 운영 기준과 이전 운영/실험 기준을 분리해, 오래된 문서를 읽을 때 혼동을 줄인다.

## 현재 버전

기준 시점: `2026-04-04`

### 현재 실행 환경

| 항목 | 현재 값 |
|---|---|
| 실행 OpenClaw | 글로벌 설치본 `openclaw 2026.4.2 (d74a122)` |
| local runtime | host macOS `mlx_lm.server` |
| local base endpoint | `http://127.0.0.1:1235/v1` |
| WebUI filtered endpoint | `http://127.0.0.1:1236/v1` |
| local 기본 모델 | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` |
| local provider ID | `lmstudio` |
| local transport | OpenAI-compatible API |
| remote 기본 tier | `mini` |
| `nano` 역할 | 선택적 경량 remote, `llm` 분류 모델, local fallback 1차 승격 |

### 현재 해석에서 중요한 점

1. 현재 `localProvider: "lmstudio"` 는 실제 LM Studio 앱을 뜻하지 않는다.
2. 현재 운영에서는 host macOS의 `mlx_lm.server` 가 OpenAI-compatible endpoint를 `1235` 에 노출하고 있다.
3. WebUI 쪽은 `1236` filtered proxy를 통해 단일 모델 `LFM2` 만 노출한다.
4. `1235 /v1/models` 는 `mlx_lm.server` 구현상 Hugging Face 캐시에 있는 MLX 모델을 함께 나열할 수 있다.
5. smart-router의 실제 local 기본 모델은 계속 `LFM2` 다.

## 이전 버전

기준 시점: `2026-03-24 ~ 2026-03-28`

### 이전 문서 기준

| 항목 | 이전 값 |
|---|---|
| 실행 OpenClaw | 글로벌 설치본 `openclaw 2026.3.13` 전제 |
| local runtime | Docker Ollama 또는 LM Studio 혼용 문서 |
| local 기본 모델 | `gemma3:4b` 또는 초기 Ollama 계열 |
| 보조 local 후보 | `qwen2.5:14b-instruct` |
| 문서 기조 | Ollama 중심 quick start + 이후 LM Studio/LFM2 반영 혼재 |

### 이전 문서에서 혼동되던 지점

1. 루트 README는 Docker Ollama + `gemma3:4b` 를 현재 기본처럼 설명했다.
2. smart-router README는 상단 라우팅 표에는 `gemma3:4b` 를 남기고, 아래 설정 예시는 `LFM2` 로 섞여 있었다.
3. `docs/ollama-docker-operations.md` 는 제목상 현재 운영 문서처럼 보였지만 실제로는 대체/실험 프로필과 현재 기준이 같이 섞여 있었다.
4. `docs/hybrid-llm-routing-plan.md` 는 초기 Ollama 구상 문서인데도 현재 기준과의 경계가 충분히 드러나지 않았다.

## 변경 내역

### v2026-04-04

1. 루트 README를 현재 운영 기준인 `host mlx_lm.server + LFM2 + 1235/1236` 구조로 갱신
2. Docker Ollama 문서를 "대체/이전 프로필" 성격으로 재정리
3. smart-router README의 상단 라우팅 표, 예시 로그, 요구사항 설명을 현재 환경 기준으로 수정
4. 초기 구상 문서에 현재 기준/히스토리 안내를 추가

### v2026-03-28

1. smart-router 4-tier(`local`, `nano`, `mini`, `full`) 운영 정책 정리
2. local 기본 모델을 `lmstudio-community/` 로 올리는 방향 확정
3. `llm` 평가 fallback 정책과 `nano` 역할 정리

### v2026-03-24

1. Docker Ollama + `gemma3:4b` 중심의 초기 하이브리드 계획 문서 작성
2. 로컬 우선 / 외부 fallback 구조 초안 정리

## 현재 source of truth

현재 운영 기준을 볼 때는 아래 문서를 우선한다.

1. `extensions/smart-router/README.md`
2. `configs/openclaw-hybrid.json5`
3. 이 문서 `docs/smart-router-environment-history-2026-04-04.md`

다음 문서는 참고용 과거 문서로 본다.

1. `docs/hybrid-llm-routing-plan.md`
2. `docs/ollama-docker-operations.md`
3. 날짜가 붙은 실험/배치 분석 문서들