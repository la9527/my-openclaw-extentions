# Smart Router

OpenClaw에서 요청 복잡도에 따라 로컬 LLM과 외부 LLM을 자동으로 고르는 플러그인입니다.

현재 기본 라우팅은 아래와 같습니다.

| 복잡도 | 기본 target | 기본 모델 |
|---|---|---|
| `simple` | `local` | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` |
| `moderate` | `mini` | `gpt-5.4-mini-2026-03-17` |
| `complex` | `full` | `gpt-5.4-2026-03-05` |
| `advanced` | `full` | `gpt-5.4-2026-03-05` |

## 핵심 동작

1. 기본값은 `rule` 평가입니다.
2. 아주 짧은 인사나 단순 입력은 세션 깊이가 있어도 로컬로 유지합니다.
3. 실제 tool 사용 이력이 있을 때만 복잡도 점수에 반영합니다.
4. `nano`는 직접 선택 또는 `llm` 분류 모델 용도로만 사용할 수 있습니다.
5. 응답 첫 줄에 현재 선택된 tier/model 라벨을 표시할 수 있습니다.

예시 라벨:

```text
[smart-router local/simple] lmstudio-community/LFM2-24B-A2B-MLX-4bit
[smart-router mini/complex] gpt-5.4-mini-2026-03-17
[smart-router full/advanced] gpt-5.4-2026-03-05
[smart-router nano/direct] gpt-5.4-nano-2026-03-17
```

## 평가 모드

| 값 | 설명 |
|---|---|
| `rule` | 키워드, 길이, 코드, tool 사용, 대화 깊이 기반 점수 평가 |
| `llm` | 별도 분류 모델에 복잡도 판정을 요청 |

권장 구성은 아래 두 가지입니다.

1. 가장 안정적으로 쓰려면 `rule`
2. `nano`를 분류 전용으로 쓰려면 `llm` + `evaluationLlmTarget: nano`

주의:

- `llm` 분류 모드는 분류 요청을 직접 HTTP로 보내므로, OpenAI 경로를 쓸 때는 실행 프로세스에 `OPENAI_API_KEY` 환경변수가 실제로 있어야 합니다.
- macOS LaunchAgent로 게이트웨이를 띄운 경우 셸 export만으로는 부족할 수 있으므로, 게이트웨이 프로세스 환경에서 `OPENAI_API_KEY`가 보이는지 함께 확인해야 합니다.
- OpenClaw auth profile만 있고 셸 환경변수가 없으면 분류 요청은 실패하고 `rule` 기반으로 fallback 됩니다.

## 요구사항

| 항목 | 값 |
|---|---|
| OpenClaw | 2026.3.13 이상 권장 |
| Node.js | 22+ |
| 로컬 LLM | LM Studio 또는 Ollama |
| 외부 인증 | `OPENAI_API_KEY` |

LM Studio 기준 기본 연결값:

```text
localBaseUrl = http://127.0.0.1:1235/v1
localApi = openai
```

## 빠른 설정

`~/.openclaw/openclaw.json` 에 아래 항목이 들어가면 됩니다.

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "smart-router/auto",
        "fallbacks": [
          "openai/gpt-5.4-mini-2026-03-17"
        ]
      },
      "models": {
        "smart-router/auto": {},
        "smart-router/local": {},
        "smart-router/nano": {},
        "smart-router/mini": {},
        "smart-router/full": {},
        "openai/gpt-5.4-mini-2026-03-17": {}
      }
    }
  },
  "plugins": {
    "load": {
      "paths": [
        "/Volumes/ExtData/MyOpenClawRepo/extensions/smart-router"
      ]
    },
    "entries": {
      "smart-router": {
        "enabled": true,
        "config": {
          "localProvider": "lmstudio",
          "localModel": "lmstudio-community/LFM2-24B-A2B-MLX-4bit",
          "localBaseUrl": "http://127.0.0.1:1235/v1",
          "localApi": "openai",
          "remoteProvider": "openai",
          "nanoModel": "gpt-5.4-nano-2026-03-17",
          "miniModel": "gpt-5.4-mini-2026-03-17",
          "fullModel": "gpt-5.4-2026-03-05",
          "remoteBaseUrl": "https://api.openai.com/v1",
          "remoteApi": "openai-responses",
          "threshold": "moderate",
          "evaluationMode": "llm",
          "evaluationLlmTarget": "nano",
          "showModelLabel": true
        }
      }
    }
  }
}
```

실제 실행 예시는 [configs/openclaw-hybrid.json5](/Volumes/ExtData/MyOpenClawRepo/configs/openclaw-hybrid.json5) 를 보면 됩니다.

## 설정 키

| 키 | 기본값 | 설명 |
|---|---|---|
| `localProvider` | `lmstudio` | 로컬 provider ID |
| `localModel` | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` | 로컬 기본 모델 |
| `localBaseUrl` | `http://127.0.0.1:1235/v1` | 로컬 API 주소 |
| `localApi` | `openai` | `openai` 또는 `ollama` |
| `remoteProvider` | `openai` | 외부 provider ID |
| `nanoModel` | `gpt-5.4-nano-2026-03-17` | `llm` 분류 모델 또는 직접 nano 선택 모델 |
| `miniModel` | `gpt-5.4-mini-2026-03-17` | auto 라우팅 4~6 구간 모델 |
| `fullModel` | `gpt-5.4-2026-03-05` | auto 라우팅 7점 이상 구간 모델 |
| `remoteModel` | 없음 | 레거시 alias. `fullModel` 미설정 시만 사용 |
| `remoteBaseUrl` | `https://api.openai.com/v1` | 외부 API 주소 |
| `remoteApi` | `openai-responses` | 외부 API 타입 |
| `threshold` | `moderate` | 기본값일 때 `0~3 local`, `4~6 mini`, `7+ full` |
| `evaluationMode` | `rule` | `rule` 또는 `llm` |
| `evaluationLlmTarget` | `nano` | `llm` 평가용 target |
| `evaluationLlmModel` | 없음 | `llm` 평가용 모델 override |
| `evaluationTimeoutMs` | `15000` | `llm` 평가 타임아웃 |
| `showModelLabel` | `true` | 응답 첫 줄 라벨 표시 여부 |

## threshold 의미

기본값 `threshold: moderate` 에서는 점수 기준으로 아래처럼 동작합니다.

| 점수 | 결과 |
|---|---|
| `0~3` | `local` |
| `4~6` | `mini` |
| `7+` | `full` |

`threshold` 를 `complex`로 올리면 `moderate`는 다시 local에 남습니다.

## 라우팅 로그

게이트웨이 로그에는 아래처럼 남습니다.

```text
[smart-router] 🏠 simple (score: 1, eval: rule) → local:lmstudio-community/LFM2-24B-A2B-MLX-4bit | 짧은 인사
[smart-router] ☁️ moderate (score: 4, eval: llm) → mini:gpt-5.4-mini-2026-03-17 | 일반 설명 요청
[smart-router] ☁️ complex (score: 11, eval: rule) → full:gpt-5.4-2026-03-05 | 코드 리팩토링 및 분석 요청
[smart-router] ☁️ advanced (score: 12, eval: rule) → full:gpt-5.4-2026-03-05 | 시스템 설계 및 고난도 분석 요청
[smart-router] 🎯 direct selection → nano:gpt-5.4-nano-2026-03-17
```

실시간 확인:

```bash
tail -f /tmp/openclaw-gateway.log | grep smart-router
```

## 검증 예시

```bash
openclaw agent --local --to +15555550123 --message '안녕' --thinking low --json
openclaw agent --local --to +15555550124 --message 'dataclass와 pydantic 차이를 설명해줘' --thinking low --json
openclaw agent --local --to +15555550125 --message '다음 TypeScript 코드를 리팩토링해줘: ...' --thinking low --json
```

## 직접 선택 방법

직접 모델을 고르고 싶으면 아래 4개를 쓰는 편이 좋습니다.

| 모델 ref | 의미 |
|---|---|
| `smart-router/local` | LM Studio 로컬 모델 직접 사용 |
| `smart-router/nano` | nano 모델 직접 사용 |
| `smart-router/mini` | mini 모델 직접 사용 |
| `smart-router/full` | full 모델 직접 사용 |

예시:

```bash
openclaw models set smart-router/local
openclaw models set smart-router/nano
openclaw models set smart-router/mini
openclaw models set smart-router/full
openclaw models set smart-router/auto
```

검토:

1. 직접 선택용 모델을 두는 건 적절합니다.
2. `openai/gpt-5.4-*`를 직접 고르는 것보다 `smart-router/*` alias를 쓰는 편이 현재 환경에서는 더 안전합니다.
3. 이유는 smart-router provider auth는 이미 붙어 있지만, `openai` provider 직접 호출은 별도 API key auth가 없으면 실패할 수 있기 때문입니다.

## 테스트

이 디렉토리에서 실행:

```bash
pnpm exec vitest run complexity.test.ts index.test.ts
```

## 파일 구성

```text
extensions/smart-router/
├── complexity.ts
├── complexity.test.ts
├── index.ts
├── index.test.ts
├── openclaw.plugin.json
└── README.md
```