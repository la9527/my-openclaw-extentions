# Docker Ollama 운영 가이드

## 목적

이 문서는 글로벌 `npm install -g openclaw` 설치본을 계속 사용하면서, 로컬 LLM 런타임만 `MyOpenClawRepo`에서 Docker Ollama로 운영하는 기준 문서다.

주의: 이 문서는 Docker Ollama 운영 프로필 문서다. smart-router 기본값 문서([extensions/smart-router/README.md](../extensions/smart-router/README.md))와 값이 다를 수 있다.

현재 채택 기준은 아래와 같다.

- 실행 OpenClaw: 글로벌 설치본 `openclaw`
- smart-router 플러그인 소스: `MyOpenClawRepo/extensions/smart-router`
- 기본 local LLM 런타임: `LM Studio` (`http://127.0.0.1:1235/v1`)
- 기본 local 모델: `lmstudio-community/LFM2-24B-A2B-MLX-4bit`
- Docker Ollama(`MyOpenClawRepo/infra/docker/docker-compose.yml`)는 대체/실험 프로필

## 관련 파일

- compose: [infra/docker/docker-compose.yml](infra/docker/docker-compose.yml)
- compose env 예시: [infra/docker/.env.example](infra/docker/.env.example)
- 모델 pull 스크립트: [infra/scripts/pull-ollama-models.sh](infra/scripts/pull-ollama-models.sh)
- 상태 확인 스크립트: [infra/scripts/check-ollama.sh](infra/scripts/check-ollama.sh)
- OpenClaw 설정 예시: [configs/openclaw-hybrid.json5](configs/openclaw-hybrid.json5)

## 1. 최초 준비

```bash
cd /Volumes/ExtData/MyOpenClawRepo
cp infra/docker/.env.example infra/docker/.env
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml up -d
bash infra/scripts/pull-ollama-models.sh
```

기본 저장 경로는 `/Volumes/ExtData/ollama-models` 이고, 이 경로는 Docker 안에서 `/root/.ollama/models` 로 마운트된다.

## 2. OpenClaw 설정 반영

`~/.openclaw/openclaw.json` 에 아래 기준이 반영돼야 한다.

- `plugins.load.paths` 에 `MyOpenClawRepo/extensions/smart-router`
- `plugins.entries.smart-router.config.localProvider = "lmstudio"`
- `plugins.entries.smart-router.config.localModel = "lmstudio-community/LFM2-24B-A2B-MLX-4bit"`
- `plugins.entries.smart-router.config.localBaseUrl = "http://127.0.0.1:1235/v1"`
- `plugins.entries.smart-router.config.localApi = "openai"`
- `plugins.entries.smart-router.config.evaluationMode = "llm"` (선택)
- `plugins.entries.smart-router.config.evaluationTimeoutMs = 3000`
- `plugins.entries.smart-router.config.evaluationTimeoutRetryCount = 1`
- `plugins.entries.smart-router.config.evaluationTimeoutFallbackTarget = "nano"`

Ollama 대체 프로필을 쓰는 경우에만 아래를 추가한다.

- `plugins.entries.smart-router.config.localProvider = "ollama"`
- `plugins.entries.smart-router.config.localModel = "gemma3:4b"`
- `plugins.entries.smart-router.config.localBaseUrl = "http://127.0.0.1:11435"`
- `plugins.entries.smart-router.config.localApi = "ollama"`
- `models.providers.ollama` 에 `gemma3:4b`, `qwen2.5:14b-instruct` 등록

직접 예시는 [configs/openclaw-hybrid.json5](configs/openclaw-hybrid.json5) 를 따른다.

## 3. 실행 및 재시작

### Ollama 시작

```bash
cd /Volumes/ExtData/MyOpenClawRepo
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml up -d
```

### Ollama 중지

```bash
cd /Volumes/ExtData/MyOpenClawRepo
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml down
```

### 모델 상태 확인

```bash
cd /Volumes/ExtData/MyOpenClawRepo
bash infra/scripts/check-ollama.sh
```

### OpenClaw 재시작

글로벌 설치본을 계속 쓰므로, 런타임 재반영은 OpenClaw 게이트웨이 재시작으로 마무리한다.

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

## 4. 운영 정책

- 기본 local 모델은 `lmstudio-community/LFM2-24B-A2B-MLX-4bit` 다.
- Docker Ollama는 대체/실험 프로필로 유지한다.
- smart-router의 일반 remote 기본 tier 는 계속 `mini` 다.
- `nano` 는 짧고 경량인 비교/요약 요청, `llm` 분류 모델, local 상태 불량 시 1차 fallback tier 로 유지한다.
- 분류 실패 fallback 최종 정책은 아래를 따른다.
	- timeout이 `3초 이상`이면 `full`
	- JSON 파싱 실패, 연결 실패, HTTP 실패면 `nano`

권장 분류 설정 예시:

```json
{
	"evaluationMode": "llm",
	"evaluationTimeoutMs": 3000,
	"evaluationTimeoutRetryCount": 1,
	"evaluationTimeoutFallbackTarget": "nano"
}
```

## 5. 검증 절차

### Docker 쪽 검증

```bash
cd /Volumes/ExtData/MyOpenClawRepo
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml ps
bash infra/scripts/check-ollama.sh
```

### OpenClaw 쪽 검증

```bash
which openclaw
openclaw --version
openclaw models list | rg 'LFM2|lmstudio|smart-router|gemma3:4b|qwen2.5:14b-instruct'
tail -n 50 /tmp/openclaw-gateway.log | grep smart-router
```

### 직접 모델 전환 예시

```bash
openclaw models set lmstudio/lmstudio-community/LFM2-24B-A2B-MLX-4bit

# (대체 프로필) Ollama 후보 모델 전환
openclaw models set ollama/gemma3:4b
openclaw models set ollama/qwen2.5:14b-instruct
```

## 6. 주의사항

- Docker Ollama published port 는 현재 `11435` 다. 호스트에 기존 Ollama가 `11434` 를 쓰고 있어 충돌을 피하기 위해 분리했다.
- Ollama provider base URL 은 `http://127.0.0.1:11435` 처럼 native API 기준으로 써야 한다. `/v1` 를 붙이지 않는다.
- LM Studio 기본 경로는 `localApi = "openai"`, `localBaseUrl = "http://127.0.0.1:1235/v1"` 이다.
- Ollama 대체 프로필을 쓸 때만 `localApi = "ollama"`, `localBaseUrl = "http://127.0.0.1:11435"` 로 바꾼다.
- 이 저장소는 OpenClaw source repo 가 아니라 플러그인/설정/로컬 infra 저장소다. 실제 실행 binary 는 글로벌 `openclaw` 설치본일 수 있으므로 source 변경과 runtime 반영을 혼동하지 않는다.
- fallback 세부 정책은 [extensions/smart-router/README.md](../extensions/smart-router/README.md)의 `LLM 분류 운영 프로필 (최종)`을 source of truth로 본다.