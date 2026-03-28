#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
COMPOSE_FILE="$REPO_DIR/infra/docker/docker-compose.yml"
ENV_FILE="$REPO_DIR/infra/docker/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERROR] $ENV_FILE 이 없습니다. infra/docker/.env.example 을 복사해 먼저 infra/docker/.env 를 만들어 주세요." >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d ollama

for model in gemma3:4b qwen2.5:14b-instruct; do
  echo "[INFO] pulling $model"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T ollama ollama pull "$model"
done

echo "[INFO] installed models"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T ollama ollama list