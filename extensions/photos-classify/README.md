# Photos Classify – OpenClaw Plugin

MCP 기반 사진 분류/랭킹/앨범 정리를 OpenClaw에서 사용하기 위한 플러그인.

## MCP 서버

| 서버 | 설명 |
|------|------|
| **photo-ranker** | 품질 분석, VLM 장면 묘사, 이벤트 분류, 얼굴 인식, 중복 감지, 랭킹 |
| **photo-source** | Apple Photos, Google Photos, GCS, 로컬 폴더 접근 |

## 설치

```bash
# OpenClaw 설정에서 플러그인 활성화
openclaw config set plugins.photos-classify.enabled true
```

## 설정

`openclaw.plugin.json` 의 `configSchema` 참조:

| 키 | 기본값 | 설명 |
|----|--------|------|
| `photoRankerDir` | `./mcp-servers/photo-ranker` | photo-ranker MCP 서버 디렉터리 |
| `photoSourceDir` | `./mcp-servers/photo-source` | photo-source MCP 서버 디렉터리 |
| `defaultSource` | `apple` | 기본 사진 소스 (`local`, `apple`, `google`, `gcs`) |

## 주요 도구 (photo-ranker)

- `analyze_photo` – 단일 사진 품질/장면/이벤트 분석
- `rank_photos` – 여러 사진 종합 랭킹
- `detect_duplicates` – 중복 사진 감지
- `classify_and_organize` – 분류 후 앨범 정리 E2E 워크플로우

## 주요 도구 (photo-source)

- `list_photos` – 사진 목록 조회 (날짜/앨범 필터)
- `get_metadata` – 사진 메타데이터 조회
- `get_thumbnail` – 썸네일 경로 반환
- `search_photos` – 키워드 검색 (Apple Photos, Google Photos)

## 의존성

- Python 3.11+, uv
- photo-ranker: MLX, insightface, mediapipe, pillow 등
- photo-source: osxphotos (Apple), google-api-python-client (Google)
