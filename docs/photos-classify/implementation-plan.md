# Photos Classify — 작업 계획서

> 작성일: 2026-03-29
> 상태: Phase 0-3 구현 완료 — Phase 4-6 보류
> 위치: `docs/photos-classify/implementation-plan.md`

---

## 1. 프로젝트 목표

맥미니 M4 (32GB)에서 로컬 VLM을 활용해 iCloud / GCS 사진을 자동 분류·선별하는 시스템을 구축한다.
OpenClaw 게이트웨이를 통해 사용자 요청("지난달 가족사진 베스트 20장")을 처리하고,
실제 이미지 분석은 별도 MCP 서버에서 수행한다.

### 핵심 사용 시나리오

| # | 시나리오 | 예시 |
|---|---------|------|
| 1 | 기간별 베스트 선별 | "지난 3개월 사진 중 베스트 50장 골라줘" |
| 2 | 가족 사진 필터 | "가족과 함께 찍은 사진만 모아줘" |
| 3 | 이벤트별 정리 | "생일, 여행, 졸업식 사진 태그 붙여줘" |
| 4 | 품질 필터링 | "흔들리거나 어두운 사진 제외해줘" |
| 5 | 중복 정리 | "비슷한 사진 묶고 대표컷만 남겨줘" |

---

## 2. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                       사용자 요청                         │
│           (Telegram / Web UI / CLI)                      │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│               OpenClaw Gateway (v2026.3.24)              │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  smart-router/auto → 요청 라우팅                  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  MCP Tool: photo-source                          │    │
│  │  MCP Tool: photo-ranker                          │    │
│  │  (에이전트가 필요에 따라 MCP tool 호출)             │    │
│  └─────────────────────────────────────────────────┘    │
└───────────┬───────────────────────┬─────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐   ┌───────────────────────────────┐
│  photo-source     │   │  photo-ranker                  │
│  MCP Server       │   │  MCP Server                    │
│  (Python/stdio)   │   │  (Python/stdio)                │
│                   │   │                                │
│  Tools:           │   │  Tools:                        │
│  · list_photos    │   │  · score_quality               │
│  · get_metadata   │   │  · detect_faces                │
│  · get_thumbnail  │   │  · describe_scene              │
│  · export_photo   │   │  · find_duplicates             │
│  · search_photos  │   │  · rank_best_shots             │
│                   │   │  · classify_event              │
│  Sources:         │   │                                │
│  · Apple Photos   │   │  Engines:                      │
│  · GCS Bucket     │   │  · MLX-VLM (Qwen2.5-VL)       │
│  · Local folder   │   │  · LAION aesthetic predictor   │
│                   │   │  · face-recognition lib        │
│                   │   │  · perceptual hash (중복)       │
└───────────────────┘   └───────────────────────────────┘
```

### 왜 MCP 2개로 분리하는가

| 관점 | 이유 |
|------|------|
| 역할 분리 | 사진 소스 접근과 이미지 분석은 독립적 관심사 |
| 확장성 | GCS 외 Dropbox, NAS 등 소스 추가 시 photo-source만 수정 |
| 자원 관리 | photo-ranker는 GPU/메모리 집약적 — 별도 프로세스로 격리 |
| 재사용 | photo-ranker는 사진 외 다른 이미지 분석 작업에도 활용 가능 |
| 테스트 | 각 MCP를 독립적으로 테스트 가능 |

---

## 3. 기술 스택 선정

### 3.1 로컬 비전 모델

| 모델 | 용도 | 메모리 | 비고 |
|------|------|--------|------|
| **Qwen2.5-VL-7B-Instruct (4bit)** | 장면 설명, 이벤트 분류, 가족 여부 판단 | ~5GB | 1차 메인 모델, JSON 출력 유도 가능 |
| Qwen2.5-VL-14B-Instruct (4bit) | 고정밀 장면 분석 (선택) | ~9GB | 32GB에서 여유 있게 작동, 정확도 향상 시 교체 가능 |
| LAION aesthetic predictor | 미적 품질 점수 (0-10) | ~200MB | 빠른 1차 필터, CLIP 기반 |
| face-recognition (dlib) | 얼굴 감지 + 임베딩 | ~100MB | 가족 구성원 그룹화용 |

**모델 선택 근거:**
- Qwen2.5-VL-7B는 mlx-vlm에서 지원되며, 4bit 양자화 시 M4 32GB에서 매우 안정 작동
- 32GB 메모리 여유가 있으므로 14B 4bit(~9GB)도 동시 운용 가능 — 7B로 시작한 뒤 정확도 비교 후 교체 검토
- 미적 점수와 얼굴 인식은 VLM 단독보다 전용 모델이 더 정확하고 빠름

### 3.2 사진 소스 라이브러리

| 소스 | 라이브러리 | 비고 |
|------|-----------|------|
| Apple Photos / iCloud | **osxphotos** (Python) | 앨범, 얼굴/사람, 키워드, 파일 경로, export 지원 |
| Google Cloud Storage | **google-cloud-storage** (Python) | 공식 SDK, 버킷 기반 |
| 로컬 폴더 | pathlib + Pillow | 디렉터리 순회, EXIF 메타데이터 |

> **Google Photos 주의사항:** 2025년 3월 정책 변경으로 전체 라이브러리 자동 스캔 불가.
> Picker API 기반으로 사용자가 선택한 사진만 가져올 수 있음 → 1차 MVP 범위에서 제외 권장

### 3.3 MCP 서버 구현

| 항목 | 선택 |
|------|------|
| 언어 | Python 3.12+ |
| MCP SDK | `mcp` (공식 Python SDK, stdio transport) |
| 패키지 관리 | uv (빠른 설치·실행) |
| 이미지 처리 | Pillow, numpy |
| VLM 추론 | mlx-vlm |
| DB (선택) | SQLite (점수/태그 캐시, 임베딩 인덱스) |

### 3.4 OpenClaw 연동

```bash
# MCP 서버 등록 (OpenClaw CLI)
openclaw mcp set photo-source '{"command":"uv","args":["run","--directory","/path/to/photo-source","server.py"]}'
openclaw mcp set photo-ranker '{"command":"uv","args":["run","--directory","/path/to/photo-ranker","server.py"]}'
```

---

## 4. MCP Tool 상세 설계

### 4.1 photo-source MCP

| Tool | 입력 | 출력 | 설명 |
|------|------|------|------|
| `list_photos` | `source`, `date_from?`, `date_to?`, `album?`, `person?`, `limit?` | `Photo[]` | 조건에 맞는 사진 목록 |
| `get_metadata` | `photo_id` | `PhotoMetadata` | EXIF, GPS, 날짜, 앨범, 사람 태그 |
| `get_thumbnail` | `photo_id`, `max_size?` | `base64 string` | 분석용 리사이즈 썸네일 |
| `export_photos` | `photo_ids[]`, `dest_dir`, `format?` | `ExportResult` | 선택한 사진을 로컬 폴더로 내보내기 |
| `search_photos` | `query` (자연어) | `Photo[]` | 키워드/날짜/사람 복합 검색 |

```typescript
// Photo 스키마 예시
type Photo = {
  id: string;
  filename: string;
  date_taken: string;       // ISO 8601
  source: "apple_photos" | "gcs" | "local";
  path: string;
  width: number;
  height: number;
  albums: string[];
  persons: string[];        // Apple Photos 인물 태그
  gps?: { lat: number; lon: number };
};
```

### 4.2 photo-ranker MCP

| Tool | 입력 | 출력 | 설명 |
|------|------|------|------|
| `score_quality` | `image_b64`, `photo_id?` | `QualityScore` | 미적 품질 + 기술 품질 점수 |
| `detect_faces` | `image_b64` | `FaceResult[]` | 얼굴 위치, 임베딩, 표정 |
| `describe_scene` | `image_b64`, `prompt?` | `SceneDescription` | VLM 기반 장면 설명 (JSON) |
| `classify_event` | `image_b64` | `EventType` | 생일/여행/식사/졸업/일상 등 분류 |
| `find_duplicates` | `photo_ids[]`, `threshold?` | `DuplicateGroup[]` | 유사 사진 그룹화 |
| `rank_best_shots` | `photo_ids[]`, `criteria?`, `top_n?` | `RankedPhoto[]` | 최종 점수 기반 상위 N장 추천 |

```typescript
// 최종 랭킹 점수 구조
type RankedPhoto = {
  photo_id: string;
  total_score: number;      // 0-100 통합 점수
  quality_score: number;    // 미적 + 기술 품질
  family_score: number;     // 가족 인물 포함 가중치
  event_score: number;      // 의미 있는 이벤트 가중치
  uniqueness_score: number; // 중복 페널티 적용 후
  scene_description: string;
  event_type: string;
  faces_detected: number;
  known_persons: string[];
};
```

### 4.3 점수 체계 설계

```
최종 점수 = (품질 × 0.25) + (가족 × 0.30) + (이벤트 × 0.25) + (대표컷 × 0.20) - 중복 페널티

품질 점수 (0-100):
  - aesthetic_score: LAION predictor (0-10 → 0-50)
  - technical_score: 흔들림·초점·노출·눈감음 (0-50)

가족 점수 (0-100):
  - face_count_bonus: 2명 이상 → +20
  - known_person_bonus: 등록된 가족 1명당 +25 (최대 100)
  - expression_bonus: 웃는 표정 → +10

이벤트 점수 (0-100):
  - event_type_weight: 생일(90), 여행(80), 졸업(90), 식사(60), 일상(30)
  - scene_relevance: VLM 판단 기반 가중치

대표컷 점수 (0-100):
  - group_best: 유사 사진 그룹 내 최고 품질이면 100, 아니면 0-50

중복 페널티 (0-30):
  - 동일 그룹 내 2번째 이후 사진은 -20~-30
```

---

## 5. 디렉터리 구조

```
MyOpenClawRepo/
├── extensions/
│   └── photos-classify/           # OpenClaw 플러그인 (얇은 오케스트레이터, 향후)
│       ├── openclaw.plugin.json
│       ├── package.json
│       └── index.ts
│
├── mcp-servers/                   # MCP 서버 (Python)
│   ├── photo-source/
│   │   ├── pyproject.toml
│   │   ├── server.py              # MCP stdio 진입점 (5개 tool)
│   │   ├── models.py              # Photo, PhotoMetadata, ExportResult
│   │   ├── sources/
│   │   │   ├── __init__.py
│   │   │   ├── apple_photos.py    # osxphotos 래핑
│   │   │   ├── gcs.py             # GCS SDK 래핑
│   │   │   └── local_folder.py    # 로컬 폴더 순회
│   │   └── tests/                 # 44개 테스트
│   │       ├── conftest.py
│   │       ├── test_models.py
│   │       ├── test_apple_photos.py
│   │       ├── test_gcs.py
│   │       ├── test_local_folder.py
│   │       └── test_server.py
│   │
│   └── photo-ranker/
│       ├── pyproject.toml
│       ├── server.py              # MCP stdio 진입점 (11개 tool: 6 분석 + 5 Job)
│       ├── models.py              # RankedPhoto, SceneDescription 등 6개 dataclass
│       ├── scoring.py             # 통합 점수 계산 (가중치 기반)
│       ├── jobs.py                # Job 큐 + 상태 관리 (asyncio)
│       ├── pipeline.py            # 2단계 파이프라인 (Stage 1 필터 → Stage 2 VLM)
│       ├── db.py                  # SQLite 캐시 + Job 상태 영속화
│       ├── batch_classify.py      # CLI 배치 실행 진입점 (exec용)
│       ├── engines/
│       │   ├── __init__.py
│       │   ├── vlm.py             # mlx-vlm Qwen2.5-VL 추론
│       │   ├── aesthetic.py       # LAION aesthetic predictor + technical quality
│       │   ├── face.py            # face-recognition 감지/임베딩
│       │   └── dedup.py           # perceptual hash 중복 감지
│       └── tests/                 # 87개 테스트
│           ├── conftest.py
│           ├── test_models.py
│           ├── test_scoring.py
│           ├── test_vlm.py
│           ├── test_aesthetic.py
│           ├── test_face.py
│           ├── test_dedup.py
│           ├── test_server.py
│           ├── test_jobs.py
│           ├── test_db.py
│           └── test_pipeline.py
│
└── docs/
    └── photos-classify/
        ├── photos-classify.md      # 기존 분석 문서
        └── implementation-plan.md  # 이 문서
```

---

## 6. 단계별 작업 계획

### Phase 0: 환경 준비 (1일) ✅ 완료

- [x] Python 3.14.3 / uv 0.10.9 설치 확인
- [x] mlx-vlm 0.4.2 설치 + Qwen2.5-VL-7B-Instruct 4bit 다운로드 (5.65GB, ~/.cache/huggingface/)
- [x] mlx-vlm CLI 추론 확인 — 모델 로드 ~20s, 추론 ~12s/장 (M4 32GB)
- [x] engines/vlm.py generate() API 수정 (mlx-vlm 0.4.2 호환: apply_chat_template + GenerationResult)
- [x] pipeline.py 수정 (scene.scene vs scene.description 속성명 픽스)
- [x] photo-ranker 87/87 테스트 통과 확인
- [ ] face-recognition: dlib 20.0.0 빌드 실패 (Python 3.14 + macOS clang C23 호환성 이슈, fp.h + K&R 선언)
  - graceful degradation 구현됨 — 미설치 시 빈 결과 반환, 런타임 영향 없음
  - 해결 방법: Python 3.12 venv 사용 또는 dlib 패치 대기
- [x] osxphotos 0.75.6 설치 + Photos 라이브러리 경로 감지 확인
  - DB 접근에는 터미널 앱에 Full Disk Access 권한 필요 (시스템 설정 > 개인정보 보호)
  - `uv sync --extra apple` 대신 `uv pip install osxphotos`로 설치 (pyobjc 9.2 빌드 이슈 회피)

**검증 기준:**
```bash
# VLM 추론 테스트 (photo-ranker venv)
cd mcp-servers/photo-ranker
uv run python3 -c "from engines.vlm import VLMEngine; print('VLM engine OK')"

# osxphotos 접근 테스트 (photo-source venv)
cd mcp-servers/photo-source
uv run python3 -c "import osxphotos; print(osxphotos.__version__)"

# face-recognition 테스트 — 현재 Python 3.14에서 빌드 불가
# graceful degradation으로 대체 동작 확인:
cd mcp-servers/photo-ranker
uv run python3 -c "from engines.face import FaceEngine; e = FaceEngine(); print('faces:', e.detect_faces(b''))"
```

### Phase 1: photo-ranker MCP MVP (3-4일) ✅ 완료

> **결정 사항:** 랭커를 먼저 만들어 테스트 이미지로 VLM 파이프라인을 검증한다.

- [x] `mcp-servers/photo-ranker/` 프로젝트 초기화 (pyproject.toml, hatchling 빌드)
- [x] VLM 엔진 구현 (`engines/vlm.py`)
  - `describe_scene`: 사진 설명 + JSON 구조화 출력
  - `classify_event`: 이벤트 유형 분류
  - `parse_scene_output`: JSON 파싱 + regex fallback
- [x] 품질 점수 엔진 (`engines/aesthetic.py`)
  - `AestheticEngine`: CLIP ViT-L-14 기반 (optional)
  - `score_technical_quality`: Laplacian + histogram 기반 (ML 불필요)
- [x] 얼굴 감지 엔진 (`engines/face.py`)
  - graceful degradation: face-recognition 미설치 시 빈 리스트 반환
- [x] 중복 감지 엔진 (`engines/dedup.py`) — perceptual hash (average + phash)
- [x] 통합 점수 계산 (`scoring.py`) — 가중치: quality 0.25, family 0.30, event 0.25, uniqueness 0.20
- [x] 데이터 모델 (`models.py`) — EventType, QualityScore, FaceResult, SceneDescription, DuplicateGroup, RankedPhoto
- [x] MCP 서버 진입점 (`server.py`) — FastMCP, 6개 tool (score_quality, detect_faces, describe_scene, classify_event, find_duplicates, rank_best_shots)
- [x] **테스트: 57/57 통과** (7개 테스트 파일, pytest 0.30s)

**검증 기준:**
```bash
# VLM 추론 속도 확인 (M4 32GB 기준 목표: 이미지당 3-8초)
time python3 -c "from engines.vlm import describe_scene; describe_scene('/path/to/test.jpg')"

# 점수 산출 확인
uv run server.py  # MCP 서버로 rank_best_shots 호출
```

### Phase 2: photo-source MCP MVP (2-3일) ✅ 완료

- [x] `mcp-servers/photo-source/` 프로젝트 초기화
- [x] `pyproject.toml` + 의존성 설정 (mcp, pillow, pydantic + optional: osxphotos, google-cloud-storage)
- [x] 데이터 모델 (`models.py`) — Photo, PhotoMetadata, ExportResult
- [x] Apple Photos 소스 구현 (`sources/apple_photos.py`)
  - `list_photos`: 날짜/앨범/인물 필터링
  - `get_metadata`: EXIF + Photos 메타데이터
  - `get_thumbnail`: 리사이즈 base64 반환
  - `search_photos`: 키워드 검색
- [x] GCS 소스 구현 (`sources/gcs.py`)
  - GCS 버킷 목록/오브젝트 순회
  - EXIF 메타데이터 추출
  - 썸네일 생성 + base64 반환
- [x] 로컬 폴더 소스 구현 (`sources/local_folder.py`)
  - 디렉터리 순회, EXIF 추출, 썸네일 생성
- [x] MCP stdio 서버 진입점 (`server.py`) — FastMCP, 5개 tool (list_photos, get_metadata, get_thumbnail, search_photos, export_photos)
- [x] **테스트: 44/44 통과** (5개 테스트 파일, pytest 0.25s)

**검증 기준:**
```bash
# MCP 서버 단독 테스트
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | uv run server.py

# OpenClaw 등록 후 테스트
openclaw mcp set photo-source '{"command":"uv","args":["run","--directory","mcp-servers/photo-source","server.py"]}'
openclaw mcp list
```

### Phase 3: 백그라운드 Job 시스템 + 통합 테스트 (3-4일) ✅ 완료

- [x] photo-ranker에 Job 큐 구현 (`jobs.py` — asyncio 기반, JobQueue, JobStatus, JobProgress)
- [x] `start_classify_job` / `get_job_status` / `get_job_result` / `cancel_job` / `list_jobs` tool 추가 (server.py)
- [x] 2단계 파이프라인 구현 (`pipeline.py` — Stage 1 필터 → Stage 2 VLM)
  - Stage 1: technical quality + face detection + dedup (hash 기반)
  - Stage 2: VLM scene description + event classification (optional heavy deps)
  - 구성 가능한 PipelineConfig (min_technical_score, skip_duplicates, dedup_threshold, vlm_top_n)
- [x] SQLite 기반 Job 상태 영속화 (`db.py` — jobs, photo_results 테이블, WAL 모드)
- [x] CLI 배치 실행 진입점 (`batch_classify.py` — 로컬 폴더 스캔, argparse, JSON 출력)
- [x] **photo-ranker 전체 테스트: 87/87 통과** (test_jobs, test_db, test_pipeline 포함, 0.72s)
- [ ] OpenClaw 에이전트에서 photo-source → start_classify_job → get_job_status → get_job_result 연쇄 테스트 (실서비스 연동 시 진행)
- [ ] "지난달 사진 중 베스트 10장" 시나리오 End-to-End 테스트 (실서비스 연동 시 진행)
- [ ] 처리 시간 벤치마크 (VLM 모델 로드 후 진행)
- [ ] 메모리 사용량 모니터링 (VLM 모델 로드 후 진행)

### Phase 4: 중복 제거 + 가족 개인화 (2-3일)

- [ ] perceptual hash 기반 중복 감지 (`engines/dedup.py`)
- [ ] 얼굴 임베딩 클러스터링 → 가족 구성원 매핑
- [ ] SQLite 캐시 (점수, 임베딩, 태그) 추가
- [ ] 사용자 피드백 저장 (좋은 사진 / 의미 있는 사진 표시)

### Phase 5: cron 기반 정기 실행 + 알림 (향후)

> **결정 사항:** 1차 MVP 범위에서 제외, 핵심 파이프라인 안정화 후 추가한다.

- [ ] OpenClaw cron 설정으로 주간/야간 정기 분류 등록
- [ ] 완료 시 Telegram 알림 (announce 또는 `openclaw message send`)
- [ ] exec + notifyOnExit 연동 테스트

### Phase 6: OpenClaw 플러그인 (향후)

- [ ] `extensions/photos-classify/` OpenClaw 플러그인 구현
- [ ] 사용자 명령어 프리셋 등록
- [ ] Telegram 채널에서 사진 분류 결과 공유

---

## 7. 문서에서 보완한 사항

기존 `photos-classify.md` 분석 대비 추가/보완한 내용:

### 7.1 MCP 분리 구조 구체화

기존 문서에서 "photo-source MCP + photo-ranker MCP" 방향을 제시했으나,
각 MCP의 tool 목록, 입출력 스키마, 점수 체계 가중치까지 구체화했다.

### 7.2 OpenClaw 연동 경로 명확화

OpenClaw의 MCP 연동은 `openclaw mcp set` CLI로 stdio 서버를 등록하는 방식이다.
`McpServerConfig`는 `command`, `args`, `env`, `cwd`를 지원하므로
uv 기반 Python MCP 서버를 바로 연결할 수 있다.

플러그인(`extensions/`)은 TypeScript 기반이고 `definePluginEntry` 패턴을 따르므로,
이미지 분석 같은 무거운 처리를 직접 넣기보다 MCP를 먼저 만들고,
필요 시 플러그인은 MCP 위에 사용자 경험(명령어 프리셋 등)만 얹는 방향이 맞다.

### 7.3 OpenClaw media-understanding SDK 활용 가능성

OpenClaw의 plugin-sdk에 `ImageDescriptionRequest`, `describeImageWithModel` 등
이미지 설명 API가 이미 존재한다. 그러나 이 API는 모델 기반 1장 설명 용도이고,
배치 처리·점수화·그룹화에는 맞지 않으므로 별도 MCP가 더 적절하다.

다만 향후 photo-ranker에서 OpenClaw의 media-understanding을 fallback 경로로
사용할 수 있다 (예: 로컬 VLM 불가 시 remote 모델 호출).

### 7.4 M4 32GB 메모리 활용 전략

Qwen2.5-VL-7B 4bit ≈ 5GB + 얼굴 모델 ~100MB + aesthetic ~200MB = **~5.3GB 상시**
M4 32GB 기준으로 OpenClaw 게이트웨이(~500MB) + OS + 기타 앱을 고려해도
**~20GB 이상의 여유**가 있으므로 메모리 압박 없이 안정적으로 운용 가능하다.

14B 4bit(~9GB) 모델을 사용하더라도 총 ~10GB 수준이므로,
다른 로컬 모델(LFM2 등)과 동시 운용도 현실적이다.

**권장 운용 패턴:**
- photo-ranker 시작 시 VLM 상주 로드 → 배치 처리 → 유지 (언로드 불필요)
- 7B로 시작, 정확도 불만 시 14B로 교체 — 메모리 여유 충분
- LM Studio / Ollama의 다른 모델과 동시 실행 가능 (합산 ~20GB 이하 유지 권장)

### 7.5 Google Photos 대안 경로

Google Photos 전체 스캔 제약에 대한 현실적 대안:
1. **Google Takeout**: 전체 라이브러리를 로컬/GCS로 먼저 내보낸 뒤 로컬 폴더 소스로 분석
2. **Google Drive 연동**: Photos가 Drive로 동기화되는 설정이면 Drive API로 접근
3. **Picker API**: 사용자가 웹에서 직접 사진을 선택 → 선택된 사진만 분석 (인터랙티브)

1번(Takeout)이 자동 분류 파이프라인에 가장 적합하다.

### 7.6 VLM 프롬프트 설계 초안

photo-ranker의 `describe_scene` / `classify_event` tool에서 사용할 VLM 프롬프트 예시:

```
당신은 사진 분석 전문가입니다. 아래 사진을 분석하고 반드시 JSON으로만 답하세요.

{
  "scene": "장면을 한 문장으로 설명",
  "people_count": 사진 속 사람 수,
  "is_family_photo": true/false,
  "expressions": ["happy", "neutral", "sad", ...],
  "event_type": "birthday|travel|graduation|meal|daily|celebration|outdoor|portrait|other",
  "event_confidence": 0.0-1.0,
  "quality_notes": "흐릿함, 역광, 눈감음 등 품질 이슈가 있으면 기술",
  "meaningful_score": 1-10 (이 사진이 앨범에 남길 가치가 있는 정도)
}
```

---

## 8. 백그라운드 실행 설계

사진 분류는 수백~수천 장을 처리하므로 수분에서 수시간이 소요될 수 있다.
MCP tool 호출은 동기적이므로, 대량 배치를 직접 MCP tool 하나로 끝내려 하면
에이전트 턴 타임아웃에 걸리거나 사용자 대화가 블로킹된다.

이를 해결하기 위해 **비동기 Job 패턴**으로 설계한다.

### 8.1 OpenClaw이 제공하는 백그라운드 메커니즘

OpenClaw에는 장시간 작업을 처리할 수 있는 메커니즘이 여러 가지 있다.

| 메커니즘 | 설명 | 기본 타임아웃 | 적합도 |
|----------|------|-------------|--------|
| **exec + background** | 셸 명령을 백그라운드로 실행, `process poll`로 상태 조회 | 30분 (최대 무제한) | ★★★ 가장 적합 |
| **sessions_spawn (subagent)** | 독립 에이전트 세션 생성, 완료 후 결과 전달 | 무제한 (설정 가능) | ★★★ 오케스트레이션에 적합 |
| **cron** | 정기 스케줄 실행, webhook/announce 배달 | 설정 가능 | ★★☆ 정기 배치에 적합 |
| **exec notifyOnExit** | 백그라운드 프로세스 종료 시 시스템 이벤트 발생 | - | ★★☆ 완료 알림용 보조 |

### 8.2 권장 아키텍처: 비동기 Job 패턴

MCP 서버 자체에 Job 큐를 내장하고, OpenClaw 에이전트는 job을 제출·조회·수거하는 방식을 택한다.

```
┌─────────────┐     ① start_classify_job       ┌──────────────────────┐
│  OpenClaw   │ ──────────────────────────────▶ │   photo-ranker MCP   │
│  에이전트    │     ← job_id 즉시 반환           │                      │
│             │                                 │  ┌────────────────┐  │
│             │     ② get_job_status(job_id)    │  │  Job Queue     │  │
│  (다른 대화 │ ──────────────────────────────▶ │  │  (asyncio)     │  │
│   계속 가능) │     ← progress: 127/500        │  │                │  │
│             │                                 │  │ job-1: running │  │
│             │     ③ get_job_result(job_id)    │  │ job-2: done    │  │
│             │ ──────────────────────────────▶ │  └────────────────┘  │
│             │     ← RankedPhoto[] 결과         │                      │
└─────────────┘                                 │  Engines:            │
                                                │  · VLM · aesthetic   │
                                                │  · face · dedup      │
                                                └──────────────────────┘
```

### 8.3 photo-ranker에 추가할 Job 관리 Tool

| Tool | 입력 | 출력 | 설명 |
|------|------|------|------|
| `start_classify_job` | `photo_ids[]`, `criteria?`, `top_n?` | `{ job_id, status: "queued" }` | 분류 작업 제출, 즉시 반환 |
| `get_job_status` | `job_id` | `{ status, progress, total, elapsed_sec, eta_sec? }` | 진행 상황 조회 |
| `get_job_result` | `job_id` | `{ status: "done", results: RankedPhoto[] }` | 완료된 결과 수거 |
| `cancel_job` | `job_id` | `{ status: "cancelled" }` | 실행 중인 작업 취소 |
| `list_jobs` | `status?` | `Job[]` | 전체 Job 목록 조회 |

```python
# Job 상태 머신
# queued → running → done
#                 → failed
#       → cancelled
```

### 8.4 실행 시나리오별 연동 방식

#### 시나리오 A: 사용자 대화 중 요청 (가장 일반적)

```
사용자: "지난달 사진 중 베스트 20장 골라줘"

에이전트 (turn 1):
  1. photo-source/list_photos(date_from="2026-02", date_to="2026-03") → 487장
  2. photo-ranker/start_classify_job(photo_ids=[...487개], top_n=20) → job_id="j-abc123"
  3. 사용자에게 응답: "487장 분석을 시작했습니다. 약 20-30분 소요 예상입니다."

에이전트 (turn 2, 사용자가 "결과 나왔어?"라고 물으면):
  1. photo-ranker/get_job_status(job_id="j-abc123") → { progress: 487/487, status: "done" }
  2. photo-ranker/get_job_result(job_id="j-abc123") → RankedPhoto[20]
  3. 사용자에게 결과 응답
```

#### 시나리오 B: exec + 백그라운드 실행 (CLI 친화)

```
에이전트가 exec tool로 배치 스크립트를 백그라운드 실행:

exec({
  command: "python3 /path/to/mcp-servers/photo-ranker/batch_classify.py \
    --input /tmp/photo-list.json --output /tmp/results.json --top-n 20",
  background: true,
  timeout: 7200  // 2시간
})

→ sessionId 반환, 이후 process({ action: "poll", sessionId }) 로 확인
→ 완료 후 /tmp/results.json 읽어서 사용자에게 전달
```

#### 시나리오 C: cron 기반 정기 실행

```json
// openclaw.json cron 설정
{
  "cron": {
    "jobs": [
      {
        "id": "weekly-photo-classify",
        "schedule": "0 3 * * 0",
        "payload": {
          "kind": "agentTurn",
          "prompt": "지난 1주일 새로 추가된 사진을 분석해서 베스트 20장을 /photos/weekly-best/ 폴더에 정리해줘"
        },
        "delivery": { "mode": "announce" }
      }
    ]
  }
}
```

#### 시나리오 D: subagent 기반 병렬 처리

대량 사진(1000장+)을 빠르게 처리해야 할 때, 에이전트가 배치를 나눠 subagent를 생성:

```
메인 에이전트:
  1. photo-source/list_photos → 1200장
  2. 300장씩 4개 배치로 분할
  3. sessions_spawn × 4 (각 배치 처리 subagent)
  4. 각 subagent가 photo-ranker/start_classify_job 호출
  5. 결과 수거 및 병합
```

> **주의:** subagent는 최대 5개(기본값)까지 동시 생성 가능.
> 각 subagent가 VLM을 사용하면 메모리 경합이 발생하므로,
> 병렬 처리는 VLM 이외 단계(중복 감지, 얼굴 감지)에만 적용하고
> VLM 추론은 단일 큐로 직렬화하는 것을 권장한다.

### 8.5 처리 시간 추정

VLM 추론이 병목이므로, 이미지당 처리 시간 기준으로 추정:

| 단계 | 이미지당 시간 | 비고 |
|------|-------------|------|
| 썸네일 리사이즈 | ~10ms | Pillow, CPU |
| aesthetic 점수 | ~50ms | CLIP 기반, 가벼움 |
| 얼굴 감지 + 임베딩 | ~100ms | dlib/face-recognition |
| perceptual hash | ~20ms | 중복 감지용 |
| **VLM 추론 (장면+이벤트)** | **3-8초** | mlx-vlm, M4 기준 병목 |
| 총합 | **~4-9초/장** | VLM이 지배적 |

| 사진 수 | 예상 시간 | 비고 |
|---------|----------|------|
| 100장 | 7-15분 | 빠른 일상 정리 |
| 500장 | 35-75분 | 한 달치 |
| 1,000장 | 70-150분 | 분기 정리 |
| 5,000장 | 6-12시간 | 연간 정리, 야간 실행 권장 |

### 8.6 최적화 전략: 2단계 파이프라인

대량 처리 시 모든 사진에 VLM을 돌리면 시간이 과다하므로, 2단계로 나눈다.

```
Stage 1: 빠른 필터 (전체 사진, ~180ms/장)
  ├── aesthetic score → 하위 20% 제외
  ├── perceptual hash → 중복 그룹화, 대표컷만 잔류
  └── 얼굴 감지 → 인물 포함 사진 우선순위 상향

Stage 2: VLM 정밀 분석 (Stage 1 통과분만, ~5초/장)
  ├── 장면 설명
  ├── 이벤트 분류
  └── 최종 점수 산출 + 랭킹
```

**효과:** 1000장 기준
- 전체 VLM 적용: ~83분
- 2단계 파이프라인 (Stage 1에서 40% 필터): ~54분 (**35% 단축**)

### 8.7 진행 상황 알림

MCP 프로토콜에는 네이티브 스트리밍 progress가 없으므로, 아래 방식으로 보완:

1. **SQLite 상태 테이블**: Job별 progress / total / current_photo 기록
2. **get_job_status poll**: 에이전트가 주기적으로 조회 (사용자 질문 시)
3. **exec notifyOnExit**: 백그라운드 실행 완료 시 시스템 이벤트 발생 → 에이전트가 결과 알림
4. **Telegram 직접 알림** (향후): 완료 시 `openclaw message send` CLI로 결과 요약 전송

```python
# photo-ranker 내부 Job 상태 관리 예시
class JobStatus:
    job_id: str
    status: Literal["queued", "running", "done", "failed", "cancelled"]
    progress: int        # 처리 완료 사진 수
    total: int           # 전체 사진 수
    stage: str           # "filter" | "vlm_analysis" | "ranking"
    started_at: datetime
    eta_seconds: float   # 남은 시간 추정
    error: str | None
```

### 8.8 디렉터리 구조 변경

Job 관리를 위해 photo-ranker에 파일 추가:

```
mcp-servers/photo-ranker/
├── server.py
├── engines/
│   ├── vlm.py
│   ├── aesthetic.py
│   ├── face.py
│   └── dedup.py
├── scoring.py
├── models.py
├── jobs.py              # ← 추가: Job 큐 + 상태 관리 (asyncio.Queue)
├── pipeline.py          # ← 추가: 2단계 파이프라인 오케스트레이션
├── batch_classify.py    # ← 추가: CLI 배치 실행 진입점 (exec용)
└── db.py                # ← 추가: SQLite 캐시 + Job 상태 영속화
```

---

## 구현 현황 요약

| Phase | 상태 | 테스트 | 비고 |
|-------|------|--------|------|
| Phase 0 | ✅ 완료 | - | Python 3.14.3, uv 0.10.9 |
| Phase 1 | ✅ 완료 | 57/57 pass | photo-ranker: 6 tools, 4 engines, scoring |
| Phase 2 | ✅ 완료 | 44/44 pass | photo-source: 5 tools, 3 sources |
| Phase 3 | ✅ 완료 | 87/87 pass (누적) | jobs, pipeline, db, batch CLI, 5 Job tools |
| Phase 4 | 보류 | - | 가족 개인화, 임베딩 클러스터링 |
| Phase 5 | 보류 | - | cron 정기 실행 |
| Phase 6 | 보류 | - | OpenClaw 플러그인 (TypeScript) |

**총 테스트: photo-ranker 87개 + photo-source 44개 = 131개 모두 통과**

### 구현 패턴 요약

- **빌드 시스템**: hatchling + `[tool.hatch.build.targets.wheel] packages = ["."]` (flat layout)
- **MCP 서버**: FastMCP(name, `instructions`=...) — `description` 아님 주의
- **Heavy deps**: optional deps 그룹으로 분리 (vlm, aesthetic, face, apple, gcs)
- **Graceful degradation**: mlx-vlm, face-recognition, osxphotos, google-cloud-storage 미설치 시도 핵심 기능 작동
- **테스트 mock**: sys.modules 직접 주입 패턴 (osxphotos, google.cloud.storage, face_recognition)
- **DB**: SQLite + WAL 모드, `~/.photo-ranker/jobs.db` 기본 경로

---

## 9. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| VLM 추론 속도 부족 | 대량 사진 처리 시간 과다 | 썸네일 리사이즈 (512px) + 배치 처리 + 1차 필터(aesthetic) 후 VLM 분석 |
| 메모리 경합 (32GB) | 다수 모델 동시 실행 시 성능 저하 | VLM + 기타 모델 합산 ~20GB 이하 유지, 불필요 모델 정리 |
| osxphotos iCloud 동기화 | 로컬에 없는 사진 접근 불가 | `--download-missing` 옵션, 또는 분석 가능한 사진만 우선 처리 |
| 얼굴 인식 정확도 | 어린이, 측면, 마스크 등 오인식 | 사용자 확인 단계 추가, 임계값 조정 |
| VLM JSON 출력 불안정 | 파싱 실패 | retry + regex fallback parser |
| 장시간 Job 중 프로세스 재시작 | Job 상태 유실 | SQLite 영속화 + 체크포인트 (처리 완료분 저장) |
| 백그라운드 메모리 경합 | VLM + 게이트웨이 + 다른 모델 동시 실행 시 성능 저하 | 합산 ~20GB 이하 유지, 단일 VLM 큐 직렬화 |
| MCP 서버 비정상 종료 | 실행 중 Job 소실 | SQLite 체크포인트에서 재개 가능하도록 설계 |

---

## 10. 확정된 결정 사항

| # | 항목 | 결정 | 비고 |
|---|------|------|------|
| 1 | M4 메모리 사양 | **32GB** | 7B/14B 모델 모두 여유 있게 운용 가능 |
| 2 | 1차 MVP 사진 소스 | **Apple Photos + GCS** | Phase 2에서 함께 구현 |
| 3 | MCP 서버 위치 | **MyOpenClawRepo 내 `mcp-servers/`** | 별도 저장소 분리 없음 |
| 4 | Google Photos 대응 | **미정** | 추후 검토 (Takeout 또는 Picker API) |
| 5 | 얼굴 개인화 | **Phase 4로 이연** | 1차 MVP 범위 외 |
| 6 | 작업 우선순위 | **랭커(Phase 1) → 소스(Phase 2)** | 테스트 이미지로 VLM 파이프라인 먼저 검증 |
| 7 | 백그라운드 실행 | **Job 큐(MCP 내장)** | exec 백그라운드는 보조 참고용으로만 유지 |
| 8 | 정기 실행(cron) | **향후 반영** | 1차 MVP 범위 외, Phase 5로 이연 |

---

## 11. 참고 자료

| 이름 | URL / 경로 | 용도 |
|------|-----------|------|
| mlx-vlm | https://github.com/Blaizzy/mlx-vlm | Apple Silicon VLM 추론 |
| osxphotos | https://github.com/RhetTbull/osxphotos | Apple Photos 라이브러리 접근 |
| MCP Python SDK | https://github.com/modelcontextprotocol/python-sdk | MCP 서버 구현 |
| LAION aesthetic predictor | https://github.com/LAION-AI/aesthetic-predictor | 미적 품질 점수 |
| face-recognition | https://github.com/ageitgey/face_recognition | 얼굴 감지/임베딩 |
| OpenClaw MCP 설정 | `~/.openclaw/openclaw.json` → `mcp.servers` | MCP 서버 등록 |
| OpenClaw plugin-sdk media | `openclaw/plugin-sdk/media-understanding` | 이미지 설명 API |
| OpenClaw MCP CLI | `openclaw mcp set/list/show` | MCP 관리 |
| OpenClaw 백그라운드 실행 | `docs/gateway/background-process.md` | exec + process tool |
| OpenClaw Subagents | `docs/tools/subagents.md` | 병렬 에이전트 세션 |
| OpenClaw Cron | `openclaw.json` → `cron.jobs[]` | 정기 실행 |
| 기존 분석 문서 | `docs/photos-classify/photos-classify.md` | 초기 검토 결과 |
