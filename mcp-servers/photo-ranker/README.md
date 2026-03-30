# photo-ranker MCP Server

사진 품질 분석, 분류, 랭킹을 수행하는 MCP(Model Context Protocol) 서버입니다.
VLM(Vision Language Model), CLIP 기반 미적 평가, 얼굴 인식, 중복 감지 엔진을 결합하여 대량의 사진을 자동으로 분류하고 최적의 사진을 선별합니다.

## 주요 기능

- **품질 점수 산정** — 해상도, 노출, 선명도 등 기술적 품질 분석
- **VLM 기반 장면 묘사** — Qwen2.5-VL 모델을 사용한 자연어 장면 설명
- **이벤트 자동 분류** — 여행, 가족 모임, 음식, 풍경 등 이벤트 타입 자동 분류
- **얼굴 인식** — 사진 속 얼굴 수 및 위치 감지
- **중복 감지** — perceptual hash 기반 유사 사진 그룹핑
- **베스트 샷 랭킹** — 다차원 점수를 종합하여 최고의 사진 선별
- **백그라운드 Job 시스템** — 대량 분류 작업을 비동기 Job으로 관리
- **SQLite 영속성** — Job 상태와 분류 결과를 DB에 저장
- **배치 CLI** — 커맨드라인에서 직접 분류 작업 실행

## 요구 사항

- Python 3.12 이상
- [uv](https://docs.astral.sh/uv/) (권장 패키지 매니저)

## 설치

```bash
cd mcp-servers/photo-ranker

# 기본 의존성 설치
uv sync

# 모든 엔진 포함 설치
uv sync --all-extras

# 또는 필요한 엔진만 선택 설치
uv sync --extra vlm          # VLM 장면 묘사 (mlx-vlm, Apple Silicon 전용)
uv sync --extra aesthetic     # CLIP 미적 평가 (open-clip-torch + torch)
uv sync --extra face          # 얼굴 인식 (face-recognition)
```

> **참고:** VLM 엔진(`mlx-vlm`)은 Apple Silicon Mac에서만 동작합니다. 다른 플랫폼에서는 VLM 없이도 나머지 엔진이 정상 동작합니다.

## 의존성 구성

| 그룹 | 패키지 | 용도 |
|---|---|---|
| 기본 | `mcp>=1.0.0`, `pillow>=10.0`, `numpy>=1.26`, `pydantic>=2.0`, `imagehash>=4.3` | 핵심 서버, 이미지 처리, 해시 |
| `vlm` | `mlx-vlm>=0.1` | VLM 장면 묘사 (Apple Silicon) |
| `aesthetic` | `open-clip-torch>=2.24`, `torch>=2.0` | CLIP 미적 품질 평가 |
| `face` | `face-recognition>=1.3` | 얼굴 감지 |

## MCP 도구 목록

### 분석 도구 (6개)

| 도구 | 설명 | 주요 파라미터 |
|---|---|---|
| `score_quality` | 사진의 기술적 품질 점수 산정 | `image_b64` (base64 이미지), `photo_id?` |
| `detect_faces` | 사진 속 얼굴 감지 | `image_b64` |
| `describe_scene` | VLM으로 장면을 자연어로 묘사 | `image_b64`, `prompt?` |
| `classify_event` | 이벤트 타입 자동 분류 | `image_b64` |
| `find_duplicates` | 해시 기반 중복 사진 그룹핑 | `photo_hashes_json` (해시 딕셔너리), `threshold?` |
| `rank_best_shots` | 종합 점수로 베스트 샷 랭킹 | `photo_scores_json` (점수 배열), `top_n?` |

### Job 관리 도구 (5개)

| 도구 | 설명 | 주요 파라미터 |
|---|---|---|
| `start_classify_job` | 백그라운드 분류 작업 시작 | `source` ("local"/"apple"/"gcs"), `source_path` |
| `get_job_status` | 작업 상태 조회 | `job_id` |
| `get_job_result` | 완료된 작업의 랭킹 결과 조회 | `job_id`, `top_n?` (기본 20) |
| `cancel_job` | 실행/대기 중인 작업 취소 | `job_id` |
| `list_jobs` | 작업 목록 조회 | `status?` ("pending"/"running"/"completed"/"failed"/"cancelled") |

## 점수 체계

최종 랭킹은 4가지 차원의 가중 합산으로 결정됩니다:

| 항목 | 가중치 | 설명 |
|---|---|---|
| 품질 (quality) | 0.25 | 해상도, 노출, 선명도 등 기술적 품질 |
| 가족 (family) | 0.30 | 얼굴 수, 인물 관련 점수 |
| 이벤트 (event) | 0.25 | 이벤트 분류 신뢰도 |
| 고유성 (uniqueness) | 0.20 | 중복이 적을수록 높은 점수 |

## 2단계 파이프라인

대량 분류 시 효율을 위해 2단계 파이프라인으로 동작합니다:

1. **Stage 1 (필터)** — 품질 점수 + 얼굴 감지 + 중복 검사 (~180ms/장)
2. **Stage 2 (VLM)** — 상위 사진만 VLM 정밀 분석 (~5s/장)

## 배치 CLI

```bash
# 기본 실행
uv run batch_classify.py --source local --path /photos/2025

# 옵션 지정
uv run batch_classify.py \
  --source local \
  --path /photos \
  --min-quality 15 \
  --vlm-top-n 10 \
  --limit 500 \
  --output results.json
```

## 디렉터리 구조

```
photo-ranker/
├── server.py           # MCP 서버 엔트리포인트 (11개 도구)
├── engines/
│   ├── vlm.py          # Qwen2.5-VL 장면 묘사 엔진
│   ├── aesthetic.py    # CLIP + 기술적 품질 엔진
│   ├── face.py         # 얼굴 인식 엔진
│   └── dedup.py        # perceptual hash 중복 감지 엔진
├── models.py           # 데이터 모델 (EventType, QualityScore, …)
├── scoring.py          # 가중 점수 산정 로직
├── jobs.py             # 비동기 Job 큐
├── pipeline.py         # 2단계 분류 파이프라인
├── db.py               # SQLite 영속성 (WAL 모드)
├── batch_classify.py   # 배치 CLI
├── pyproject.toml
└── tests/              # 87개 테스트
```

## 테스트

```bash
# 전체 테스트
uv run pytest

# 커버리지 포함
uv run pytest --cov=. --cov-report=term-missing
```

---

## MCP 클라이언트 연동 가이드

이 서버는 [MCP(Model Context Protocol)](https://modelcontextprotocol.io/) 표준을 따르며, stdio 전송을 사용합니다. MCP를 지원하는 모든 클라이언트에서 사용할 수 있습니다.

### 서버 실행 명령

```bash
uv run --directory /path/to/mcp-servers/photo-ranker server.py
```

### OpenClaw

`openclaw.json` 또는 OpenClaw 설정 파일에 추가:

```json
{
  "mcpServers": {
    "photo-ranker": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/mcp-servers/photo-ranker", "server.py"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "photo-ranker": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/mcp-servers/photo-ranker", "server.py"]
    }
  }
}
```

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Cursor 설정 (`Settings > MCP Servers`)에서 추가하거나, `.cursor/mcp.json`에 작성:

```json
{
  "mcpServers": {
    "photo-ranker": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/mcp-servers/photo-ranker", "server.py"]
    }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`에 추가:

```json
{
  "servers": {
    "photo-ranker": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/mcp-servers/photo-ranker", "server.py"]
    }
  }
}
```

### 기타 MCP 클라이언트

MCP stdio 전송을 지원하는 모든 클라이언트에서 아래 정보로 연결할 수 있습니다:

| 항목 | 값 |
|---|---|
| 전송 방식 | stdio |
| 명령어 | `uv` |
| 인자 | `run --directory /path/to/mcp-servers/photo-ranker server.py` |
| 프로토콜 | MCP (Model Context Protocol) |

### 옵셔널 엔진별 설치 참고

MCP 클라이언트에서 모든 도구를 사용하려면 필요한 엔진 의존성을 사전에 설치해야 합니다.
엔진이 미설치된 경우에도 서버는 정상 시작되며, 해당 엔진이 필요한 도구 호출 시 graceful 에러 메시지를 반환합니다.

```bash
# 모든 엔진 설치 (권장)
cd /path/to/mcp-servers/photo-ranker && uv sync --all-extras

# 또는 경량 설치 (VLM/CLIP 없이 기본 분석만)
cd /path/to/mcp-servers/photo-ranker && uv sync
```

## 라이선스

MIT
