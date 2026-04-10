# ZeroClaw Smart Router Proxy

ZeroClaw에서 `custom:http://127.0.0.1:4310/v1` 형태로 붙일 수 있는 OpenAI-compatible 라우팅 프록시 초안입니다.

현재 범위:

1. `POST /v1/chat/completions`
2. `POST /route`
3. `GET /health`

지원 model alias:

- `auto`
- `local`
- `nano`
- `mini`
- `full`

`auto` 는 간단한 규칙 기반 복잡도 판정으로 `local / nano / mini / full` 중 하나를 고릅니다.

## 실행

```bash
cd services/zeroclaw-smart-router-proxy
node src/server.mjs
```

## 환경 변수

```bash
SMART_ROUTER_PORT=4310
SMART_ROUTER_HOST=127.0.0.1

SMART_ROUTER_LOCAL_BASE_URL=http://127.0.0.1:1242/v1
SMART_ROUTER_LOCAL_MODEL=LiquidAI/LFM2-24B-A2B-GGUF:Q4_0
SMART_ROUTER_LOCAL_API_KEY=

SMART_ROUTER_REMOTE_BASE_URL=https://api.openai.com/v1
SMART_ROUTER_REMOTE_API_KEY=
SMART_ROUTER_NANO_MODEL=gpt-5.4-nano-2026-03-17
SMART_ROUTER_MINI_MODEL=gpt-5.4-mini-2026-03-17
SMART_ROUTER_FULL_MODEL=gpt-5.4-2026-03-05
```

## ZeroClaw 연결 예시

```toml
default_provider = "custom:http://127.0.0.1:4310/v1"
default_model = "auto"
api_key = "smart-router-proxy"
```

## 현재 제한

1. 초안이므로 `chat/completions` 만 우선 지원합니다.
2. `responses` API 는 아직 지원하지 않습니다.
3. stream/fallback/logging 은 최소 수준만 넣었습니다.
4. 기존 OpenClaw `smart-router` 의 footer alias/UI 노출은 포함하지 않습니다.