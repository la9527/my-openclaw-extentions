# My OpenClaw Extensions

OpenClaw에서 사용할 커스텀 확장과 설정을 정리하는 저장소입니다.

추천 GitHub 설명 문구:

`OpenClaw smart-router plugin and local config samples for complexity-based local/remote LLM routing.`

현재 포함된 핵심 구성은 `smart-router` 플러그인과 로컬 런타임 운영용 설정/문서입니다. smart-router는 요청 복잡도에 따라 로컬 LLM과 외부 LLM을 자동으로 선택합니다.

## 현재 환경

기준 시점: `2026-04-04`

현재 운영 기준은 아래와 같습니다.

| 항목 | 현재 값 |
|---|---|
| OpenClaw runtime | 글로벌 설치본 `openclaw 2026.4.2` |
| local runtime | host macOS `mlx_lm.server` |
| local endpoint | `http://127.0.0.1:1235/v1` |
| WebUI filtered endpoint | `http://127.0.0.1:1236/v1` |
| local 기본 모델 | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` |
| remote 기본 tier | `mini` |

주의:

1. 현재 `localProvider: "lmstudio"` 는 LM Studio 앱 자체를 뜻하지 않고, `1235` OpenAI-compatible endpoint에 붙는 logical provider ID로 유지한다.
2. Docker Ollama는 현재 기본 운영안이 아니라 대체/실험 프로필이다.
3. 이전 환경과 현재 환경 차이는 [docs/smart-router-environment-history-2026-04-04.md](docs/smart-router-environment-history-2026-04-04.md)에 정리했다.

## 포함 내용

- `extensions/smart-router/`
  - OpenClaw용 smart-router 플러그인
- `configs/`
  - 로컬 실행용 설정 예시
- `infra/docker/`
  - Ollama 대체/실험 Compose 예시
- `infra/scripts/`
  - 모델 pull, 상태 점검 스크립트
- `docs/`
  - 플러그인 사용 및 운영 메모

## smart-router 요약

기본 라우팅 정책은 아래와 같습니다.

| 복잡도 점수 | 라우팅 대상 | 기본 모델 |
|---|---|---|
| `0~3` | `local` | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` |
| `4~6` | `mini` | `gpt-5.4-mini-2026-03-17` |
| `7+` | `full` | `gpt-5.4-2026-03-05` |

추가로 `nano`는 직접 선택 또는 `llm` 분류 전용 모델로 사용할 수 있습니다.

직접 선택 가능한 모델 alias:

- `smart-router/auto`
- `smart-router/local`
- `smart-router/nano`
- `smart-router/mini`
- `smart-router/full`

## 빠른 시작

1. host macOS에서 `1235` OpenAI-compatible local endpoint가 떠 있는지 확인합니다.
2. OpenClaw 설정에 플러그인 경로를 추가하고 `agents.defaults.model.primary`를 `smart-router/auto`로 설정합니다.
3. `llm` 분류 모드를 사용할 경우 `OPENAI_API_KEY`를 게이트웨이 실행 프로세스 환경에 넣습니다.
4. Docker Ollama는 필요할 때만 대체/실험 프로필로 사용합니다.

예시 설정은 [configs/openclaw-hybrid.json5](configs/openclaw-hybrid.json5) 에 있습니다.

현재 운영/히스토리 요약은 [docs/smart-router-environment-history-2026-04-04.md](docs/smart-router-environment-history-2026-04-04.md) 를 우선 참고합니다.

## 권장 운영 방식

현재 권장 로컬 런타임은 host macOS `mlx_lm.server` 입니다.

```bash
curl -sS http://127.0.0.1:1235/v1/models
curl -sS http://127.0.0.1:1236/v1/models
```

기본 local 모델은 `lmstudio-community/LFM2-24B-A2B-MLX-4bit` 이고, Docker Ollama는 대체/실험 프로필로 유지합니다.

이전 Docker Ollama 기준은 [docs/ollama-docker-operations.md](docs/ollama-docker-operations.md) 에 남겨 둡니다.

## 설치

smart-router 플러그인 디렉터리에서 의존성을 설치합니다.

```bash
cd extensions/smart-router
pnpm install
```

OpenClaw 설정 예시:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "smart-router/auto"
      },
      "models": {
        "smart-router/auto": {},
        "smart-router/local": {},
        "smart-router/nano": {},
        "smart-router/mini": {},
        "smart-router/full": {},
        "lmstudio/lmstudio-community/LFM2-24B-A2B-MLX-4bit": {},
        "openai/gpt-5.4-mini-2026-03-17": {}
      }
    }
  },
  "plugins": {
    "load": {
      "paths": [
        "/Volumes/ExtData/MyOpenClawRepo/extensions/smart-router"
      ]
    }
  }
}
```

## 테스트

smart-router 변경 후 최소 검증 명령:

```bash
cd extensions/smart-router
pnpm exec vitest run complexity.test.ts index.test.ts
```

권장 확인 항목:

- `smart-router/auto`에서 `mini`, `full` 자동 라우팅
- `smart-router/local`, `smart-router/nano`, `smart-router/mini`, `smart-router/full` 직접 선택
- `lmstudio/lmstudio-community/LFM2-24B-A2B-MLX-4bit` 직접 선택
- `evaluationMode: llm` 사용 시 `OPENAI_API_KEY`가 게이트웨이 프로세스 환경에서 보이는지 확인

## 문서

- 상세 플러그인 설명: [extensions/smart-router/README.md](extensions/smart-router/README.md)
- 현재/이전 환경 히스토리: [docs/smart-router-environment-history-2026-04-04.md](docs/smart-router-environment-history-2026-04-04.md)
- Docker Ollama 대체 운영 가이드: [docs/ollama-docker-operations.md](docs/ollama-docker-operations.md)

## AI 작업용 customization

이 저장소에는 이후 AI 작업 품질을 높이기 위한 repo-local instruction 과 skill 을 함께 둡니다.

- 항상 적용되는 기본 규칙: `.github/copilot-instructions.md`
- 라우팅 정책 변경 workflow: `.agents/skills/smart-router-routing-tuning/SKILL.md`
- 실런타임 검증 workflow: `.agents/skills/smart-router-runtime-validation/SKILL.md`
- 로그/실험 분석 workflow: `.agents/skills/smart-router-log-analysis/SKILL.md`

이 파일들은 smart-router 작업 시 아래 정보를 다시 찾는 비용을 줄이기 위한 목적입니다.

- 현재 4-tier 운영 기준
- `nano` 와 `mini` 역할 구분
- 글로벌 OpenClaw runtime 과 source repo 차이
- 테스트 및 실호출 검증 절차

## 검증 상태

현재 확인된 항목:

- `smart-router/auto`에서 `mini`, `full` 자동 라우팅 동작
- `smart-router/local`, `smart-router/nano`, `smart-router/mini`, `smart-router/full` 직접 선택 동작
- OpenAI Responses API 기반 `llm` 분류 동작
