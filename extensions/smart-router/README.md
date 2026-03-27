# Smart Router

OpenClaw에서 요청 복잡도에 따라 로컬 LLM과 외부 LLM을 자동으로 고르는 플러그인입니다.

현재 기본 라우팅은 아래와 같습니다.

| 복잡도 | 기본 target | 기본 모델 |
|---|---|---|
| `simple` | `local` | `lmstudio-community/LFM2-24B-A2B-MLX-4bit` |
| `moderate` | `mini` | `gpt-5.4-mini-2026-03-17` |
| `complex` | `mini` | `gpt-5.4-mini-2026-03-17` |
| `advanced` | `full` | `gpt-5.4-2026-03-05` |

`nano`는 auto 라우팅에서 사라진 것이 아니라, 짧고 경량인 비교/요약 요청, `llm` 분류 모델, local 상태 불량 시 1차 fallback tier 로 선택적으로 사용합니다.

## 핵심 동작

1. 기본값은 `rule` 평가입니다.
2. 아주 짧은 인사나 단순 입력은 세션 깊이가 있어도 로컬로 유지합니다.
3. 실제 tool 사용 이력이 있을 때만 복잡도 점수에 반영합니다.
4. `nano`는 선택적 경량 remote tier 이면서 `llm` 분류 모델 용도로도 사용할 수 있습니다.
5. 응답 첫 줄에 현재 선택된 tier/model 라벨을 표시할 수 있습니다.

예시 라벨:

```text
[smart-router local/simple] lmstudio-community/LFM2-24B-A2B-MLX-4bit
[smart-router nano/moderate] gpt-5.4-nano-2026-03-17
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
2. `nano`를 경량 remote + 분류 모델로 함께 쓰려면 `llm` + `evaluationLlmTarget: nano`

2026-03-27 실측 기준 추가 메모:

1. `llm` 분류는 `advanced/full` 승격을 더 잘 잡지만, 짧은 운영 지표 질의까지 과승격할 수 있다.
2. 최근 보정으로 `false positive`, `경보 조건`, `리팩토링 전략`, `장애 지점 분석` 같은 요청의 과승격은 일부 줄었지만 `p95 + error rate` 유형은 아직 `full`로 올라갈 수 있다.
3. 안정적인 tier 분리를 우선하면 현재는 `rule` 또는 향후 `ambiguity-gated llm` 방향이 더 안전하다.

추가 calibration 재검증 결과:

1. `latency p95 + error rate 판단 기준` 요청은 `complex/mini` 로 내려왔다.
2. `nano 모델 역할`, `threshold 뜻` 같은 짧은 기술 설명 질의는 `simple/local` 로 내려왔다.
3. `경보 조건 3개`처럼 alert-only 운영 요청은 최근 guardrail 에서 `complex/mini` 쪽으로 낮추도록 보정했다.

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
| `nanoModel` | `gpt-5.4-nano-2026-03-17` | 경량 비교/요약용 nano tier, `llm` 분류 모델, local fallback 승격 tier |
| `miniModel` | `gpt-5.4-mini-2026-03-17` | 기본 auto 라우팅의 일반 remote tier (`moderate`, `complex`) |
| `fullModel` | `gpt-5.4-2026-03-05` | auto 라우팅 `advanced` tier 모델 |
| `remoteModel` | 없음 | 레거시 alias. `fullModel` 미설정 시만 사용 |
| `remoteBaseUrl` | `https://api.openai.com/v1` | 외부 API 주소 |
| `remoteApi` | `openai-responses` | 외부 API 타입 |
| `threshold` | `moderate` | 기본값일 때 `0~3 local`, `4~11 mini`, `12+ full`, 단 짧고 경량인 비교/요약 요청은 `nano` 가능 |
| `evaluationMode` | `rule` | `rule` 또는 `llm` |
| `evaluationLlmTarget` | `nano` | `llm` 평가용 target |
| `evaluationLlmModel` | 없음 | `llm` 평가용 모델 override |
| `evaluationTimeoutMs` | `15000` | `llm` 평가 타임아웃 |
| `showModelLabel` | `true` | 응답 첫 줄 라벨 표시 여부 |
| `logEnabled` | `true` | smart-router 실행 로그 JSONL 기록 여부 |
| `logFilePath` | `~/.openclaw/logs/smart-router.jsonl` | 실행 로그 파일 경로 override |
| `logPayloadBody` | `false` | provider payload 본문까지 기록할지 여부 |
| `logMaxTextChars` | `600` | 응답 미리보기와 텍스트 필드 최대 기록 길이 |
| `logPreviewChars` | `240` | `firstTextPreview` 최대 길이 |
| `logRetentionDays` | `10` | 날짜별 로그 파일 보관 일수 |
| `toolExposureMode` | `conservative` | tool schema 노출 정책 |
| `latencyAwareRouting` | `true` | local 상태가 나쁘면 nano로 1차 승격할지 여부 |
| `localLatencyP95ThresholdMs` | `12000` | local p95 지연시간 기준 |
| `localErrorRateThreshold` | `0.25` | local 오류율 기준 |
| `localHealthMinSamples` | `3` | local 상태 판단 전 최소 샘플 수 |

## threshold 의미

기본값 `threshold: moderate` 에서는 점수 기준으로 아래처럼 동작합니다.

| 점수 | 결과 |
|---|---|
| `0~3` | `local` |
| `4~11` | `mini` |
| `12+` | `full` |

추가 규칙:

- 짧고 경량인 비교/요약 요청은 `moderate` 여도 `nano` 로 낮출 수 있습니다.
- local 상태가 나쁘면 latency-aware routing 이 `local -> nano` 1차 승격을 적용할 수 있습니다.

`threshold` 를 `complex`로 올리면 `moderate`는 다시 local에 남습니다.

## 2026-03-27 실검증 요약

`local/nano/mini/full` 4-tier 반영 후 실호출을 두 번 검증했다.

1. 40건 본배치(`sr-followup-20260327-223857-*`)
2. 오분류 세션만 다시 돌린 retune 배치(`sr-retune-20260327-231723-*`)

본배치 핵심 결과:

- simple auto: `6건` 중 `5 local`, `1 nano`
- moderate auto: `8건` 중 `5 nano`, `3 full`
- complex auto: `5건` 중 `1 mini`, `4 full`
- advanced auto: `5건` 중 `4 full`, `1 local`

즉, `advanced/full`은 확실히 잘 잡히기 시작했지만, `llm` 분류 기준에서는 moderate/complex 일부가 `full`로 과승격됐다.

같은 moderate 프롬프트 8개를 direct selection으로 비교하면 평균 응답시간은 아래와 같았다.

- `nano`: 약 `11.0s`
- `mini`: 약 `4.9s`

`nano` 쪽에 `49.7s` outlier 한 건이 있어 평균이 벌어졌지만, 중앙값으로 봐도 `mini`가 더 빨랐다.

retune 배치 핵심 결과:

1. `false positive 완화`, `경보 3개`, `리팩토링 전략`, `장애 지점 분석`은 `full`에서 `mini` 또는 `nano`로 내려왔다.
2. `4-tier 운영 정책 재설계`는 계속 `full`로 유지돼 advanced 승격은 살아 있었다.
3. 반면 `p95 + error rate 판단 기준`은 여전히 `full`, `nano 모델 역할` 같은 짧은 기술 질의는 `nano`로 남았다.

그 뒤 calibration 을 한 번 더 넣고 아래 4건을 다시 실호출로 확인했다.

1. `latency p95와 error rate를 함께 보는 판단 기준` → `complex/mini`
2. `smart-router 일일 리포트에서 바로 경보로 연결할 조건 3개` → `advanced/full`
3. `nano 모델이 어떤 역할인지 짧게 말해줘` → `simple/local`
4. `threshold 뜻을 한 문장으로 설명해줘` → `simple/local`

현재 권장 해석은 아래와 같다.

1. `mini`는 여전히 가장 안정적인 일반 remote tier 다.
2. `nano`는 moderate 기본값이라기보다 짧은 비교/요약, 평가용 LLM, local fallback tier 역할이 더 자연스럽다.
3. `llm` 분류는 guardrail 이 필수이며, alert-only 요청과 timeout fallback 에 대한 보정을 현재 코드에 반영했다.

## 라우팅 로그

게이트웨이 로그에는 아래처럼 남습니다.

```text
[smart-router] 🏠 simple (score: 1, eval: rule) → local:lmstudio-community/LFM2-24B-A2B-MLX-4bit | 짧은 인사
[smart-router] ☁️ moderate (score: 4, eval: llm) → mini:gpt-5.4-mini-2026-03-17 | 일반 설명 요청
[smart-router] ☁️ moderate (score: 5, eval: rule) → nano:gpt-5.4-nano-2026-03-17 | 짧은 비교 요약 요청
[smart-router] ☁️ complex (score: 11, eval: rule) → mini:gpt-5.4-mini-2026-03-17 | 코드 리팩토링 및 분석 요청
[smart-router] ☁️ advanced (score: 12, eval: rule) → full:gpt-5.4-2026-03-05 | 시스템 설계 및 고난도 분석 요청
[smart-router] 🎯 direct selection → nano:gpt-5.4-nano-2026-03-17
```

실시간 확인:

```bash
tail -f /tmp/openclaw-gateway.log | grep smart-router
```

## 실행 로그 JSONL

콘솔 라우팅 로그와 별도로, smart-router는 요청 단위 실행 로그를 JSONL로 남길 수 있습니다.

기본 경로:

```text
~/.openclaw/logs/smart-router-YYYY-MM-DD.jsonl
```

- 로그 파일은 일 단위로 분리됩니다.
- 기본 보관 기간은 최근 10일입니다.
- `logRetentionDays` 또는 `OPENCLAW_SMART_ROUTER_LOG_RETENTION_DAYS` 로 변경할 수 있습니다.
- `0` 이하로 주면 보관 정리를 하지 않습니다.

한 요청에서 기본적으로 남는 이벤트:

1. `evaluation`: rule 또는 llm 평가 결과, 평가 지연시간, LLM 분류 usage, fallback 여부
2. `route`: 복잡도 판정, 선택 tier/model, OpenClaw context 요약
3. `payload`: 실제 provider로 전송된 payload 요약
4. `response` 또는 `response_error`: 응답 usage, stopReason, content type, tool call 요약

P1/P2 후속 반영으로 추가로 볼 수 있는 항목:

- `payloadSummary.promptBreakdown.systemChars`
- `payloadSummary.promptBreakdown.currentUserChars`
- `payloadSummary.promptBreakdown.historyChars`
- `payloadSummary.promptBreakdown.toolResultChars`
- `payloadSummary.promptBreakdown.toolSchemaChars`
- `usageSource` (`provider` 또는 `estimate`)
- `toolExposureApplied`, `originalToolCount`, `retainedToolCount`
- `routeAdjustmentReason`
- `localHealth`

또한 아래 상관관계 필드가 함께 남습니다.

- `sessionId`
- `turnIndex`
- `rootTurnId`
- `parentRequestId`

이 조합으로 같은 사용자 턴에서 tool 호출이나 후속 재요청이 여러 request로 분리되는 경우를 다시 묶어볼 수 있습니다.

예시:

```json
{"event":"evaluation","requestId":"...","evaluationTarget":"mini","evaluationFallbackToRule":false}
{"event":"route","requestedModelId":"auto","routeTier":"mini","evaluationMode":"llm","rootTurnId":"session-1:turn:3","toolExposureApplied":true}
{"event":"payload","routeApi":"openai-responses","payloadSummary":{"rootKeys":["input","model","reasoning","tools"],"promptBreakdown":{"systemChars":1234,"currentUserChars":31,"historyChars":400,"toolSchemaChars":2800}}}
{"event":"response","usage":{"input":123,"output":45,"totalTokens":168},"usageSource":"provider","responseSummary":{"contentTypes":["text"],"toolCallCount":0}}
```

원하면 환경변수로도 제어할 수 있습니다.

```bash
export OPENCLAW_SMART_ROUTER_LOG=1
export OPENCLAW_SMART_ROUTER_LOG_FILE="$HOME/.openclaw/logs/smart-router.jsonl"
export OPENCLAW_SMART_ROUTER_LOG_PAYLOAD=0
export OPENCLAW_SMART_ROUTER_LOG_PREVIEW_LIMIT=240
export OPENCLAW_SMART_ROUTER_LOG_RETENTION_DAYS=10
```

일별 로그를 빠르게 요약하려면 아래 스크립트를 사용하면 됩니다.

```bash
node extensions/smart-router/summarize-smart-router-log.mjs
node extensions/smart-router/summarize-smart-router-log.mjs /tmp/smart-router-batch-2026-03-27.jsonl
```

출력에는 이벤트 수, tier별 사용량, evaluation usage 총량, tool exposure 적용 건수, turn 수 등이 포함됩니다.

## P2 정책

### latency-aware routing

최근 local 응답 기록을 보고 아래 조건이면 `local` 대신 `nano`로 1차 승격합니다.

1. 최근 샘플 수가 `localHealthMinSamples` 이상
2. `p95 >= localLatencyP95ThresholdMs` 이거나
3. `errorRate >= localErrorRateThreshold`

이 결과는 `routeAdjustmentReason` 과 `localHealth` 로 로그에 남습니다.

### selective tool exposure

기본값 `toolExposureMode=conservative` 에서는 아래 조건에서 tool 목록을 비웁니다.

1. 최종 route tier 가 `local`
2. 사용자 메시지에 명시적 tool 의도가 없음
3. 이전 turn 에 실제 tool 사용 흔적이 없음

즉 단순 인사/요약/짧은 설명 요청은 tool schema 비용을 줄이고, 파일/검색/웹/실행/SQL 같이 명시적 tool 성격이 있는 요청은 그대로 유지합니다.

`toolExposureMode=minimal` 로 올리면 `nano`까지 같은 정책을 적용해, moderate 급 설명/요약 요청의 tool schema 비용도 줄일 수 있습니다.

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
pnpm exec vitest run smart-router-log.test.ts complexity.test.ts index.test.ts
```

## 파일 구성

```text
extensions/smart-router/
├── complexity.ts
├── complexity.test.ts
├── index.ts
├── index.test.ts
├── openclaw.plugin.json
├── summarize-smart-router-log.mjs
└── README.md
```