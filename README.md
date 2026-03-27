# My OpenClaw Extensions

OpenClaw에서 사용할 커스텀 확장과 설정을 정리하는 저장소입니다.

추천 GitHub 설명 문구:

`OpenClaw smart-router plugin and local config samples for complexity-based local/remote LLM routing.`

현재 포함된 핵심 구성은 `smart-router` 플러그인입니다. 이 플러그인은 요청 복잡도에 따라 로컬 LLM과 외부 LLM을 자동으로 선택합니다.

## 포함 내용

- `extensions/smart-router/`
  - OpenClaw용 smart-router 플러그인
- `configs/`
  - 로컬 실행용 설정 예시
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

1. OpenClaw 설정에 플러그인 경로를 추가합니다.
2. `agents.defaults.model.primary`를 `smart-router/auto`로 설정합니다.
3. 로컬 모델은 LM Studio 또는 Ollama 중 하나를 준비합니다.
4. `llm` 분류 모드를 사용할 경우 `OPENAI_API_KEY`를 게이트웨이 실행 프로세스 환경에 넣습니다.

예시 설정은 [configs/openclaw-hybrid.json5](configs/openclaw-hybrid.json5) 에 있습니다.

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
        "smart-router/full": {}
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
- `evaluationMode: llm` 사용 시 `OPENAI_API_KEY`가 게이트웨이 프로세스 환경에서 보이는지 확인

## 문서

- 상세 플러그인 설명: [extensions/smart-router/README.md](extensions/smart-router/README.md)

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
