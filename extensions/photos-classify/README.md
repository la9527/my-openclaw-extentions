# Photos Classify – OpenClaw Plugin

MCP 기반 사진 분류/랭킹/앨범 정리를 OpenClaw에서 사용하기 위한 플러그인.

## MCP 서버

| 서버 | 설명 |
|------|------|
| **photo-ranker** | 품질 분석, VLM 장면 묘사, 이벤트 분류, 얼굴 인식, 중복 감지, 랭킹 |
| **photo-source** | Apple Photos, Google Photos, GCS, 로컬 폴더 접근 |

## 슬래시 명령

| 명령 | 설명 |
|------|------|
| `/classify [source] [path]` | 사진 분류 워크플로우 실행 (기본 소스: apple) |
| `/classify-status [job_id]` | 백그라운드 분류 Job 상태 조회 |

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

- `score_quality` – 단일 사진 품질 분석
- `describe_scene` – VLM 장면 묘사
- `classify_event` – 이벤트 유형 분류
- `detect_faces` – 얼굴 감지
- `register_face` – 인물 등록
- `start_classify_job` – 백그라운드 분류 Job 실행
- `classify_and_organize` – 분류 후 앨범 정리 E2E 워크플로우
- `organize_results` – 분류 결과 앨범 정리 (날짜별 그룹핑 지원)

## 주요 도구 (photo-source)

- `list_photos` – 사진 목록 조회 (날짜/앨범 필터)
- `get_metadata` – 사진 메타데이터 조회
- `get_thumbnail` – 썸네일 경로 반환
- `search_photos` – 키워드 검색 (Apple Photos, Google Photos)

## 의존성

- Python 3.11+, uv
- photo-ranker: MLX, insightface, mediapipe, pillow 등
- photo-source: osxphotos (Apple), google-api-python-client (Google)
