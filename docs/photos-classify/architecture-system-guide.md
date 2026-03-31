# Photos Classify — 아키텍처 및 시스템 가이드

> 최종 갱신일: 2026-04-01
> 상태: Phase 0-3 구현 완료, Phase 4-6 보류
> 플랫폼: macOS (Apple Silicon), Python 3.12+

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [시스템 아키텍처](#2-시스템-아키텍처)
3. [디렉터리 구조](#3-디렉터리-구조)
4. [컴포넌트 상세](#4-컴포넌트-상세)
   - [photo-ranker MCP Server](#41-photo-ranker-mcp-server)
   - [photo-source MCP Server](#42-photo-source-mcp-server)
   - [photos-classify OpenClaw Plugin](#43-photos-classify-openclaw-plugin)
5. [MCP Tool 목록](#5-mcp-tool-목록)
6. [엔진 모듈](#6-엔진-모듈)
7. [데이터 모델](#7-데이터-모델)
8. [점수 체계 (Scoring)](#8-점수-체계-scoring)
9. [2단계 파이프라인](#9-2단계-파이프라인)
10. [설치 및 설정](#10-설치-및-설정)
11. [실행 방법](#11-실행-방법)
12. [테스트](#12-테스트)
13. [구현 완료 현황](#13-구현-완료-현황)
14. [남은 작업 및 제약사항](#14-남은-작업-및-제약사항)

---

## 1. 프로젝트 개요

맥미니 M4 (32GB)에서 **로컬 VLM**(Vision Language Model)을 활용해 사진을 자동 분류·선별하는 시스템이다.

### 핵심 시나리오

| # | 시나리오 | 예시 |
|---|---------|------|
| 1 | 기간별 베스트 선별 | "지난 3개월 사진 중 베스트 50장 골라줘" |
| 2 | 가족 사진 필터 | "가족과 함께 찍은 사진만 모아줘" |
| 3 | 이벤트별 정리 | "생일, 여행, 졸업식 사진 태그 붙여줘" |
| 4 | 품질 필터링 | "흔들리거나 어두운 사진 제외해줘" |
| 5 | 중복 정리 | "비슷한 사진 묶고 대표컷만 남겨줘" |
| 6 | 앨범 자동 정리 | "분류 결과를 Apple Photos 앨범으로 자동 정리해줘" |

### 기술 요약

| 항목 | 값 |
|------|-----|
| VLM 모델 | Qwen2.5-VL-7B-Instruct-4bit (mlx-vlm) |
| 미적 점수 | LAION aesthetic predictor (CLIP ViT-L-14) |
| 얼굴 인식 | insightface (tier-1) → mediapipe (tier-2) → face-recognition (tier-3) |
| 중복 감지 | perceptual hash (average + phash) |
| MCP 서버 | Python, `mcp` SDK (stdio transport) |
| 패키지 관리 | uv |
| DB | SQLite (WAL 모드) |
| 대상 플랫폼 | macOS Apple Silicon (M4 32GB) |

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
│               OpenClaw Gateway                           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  photos-classify plugin (index.ts)               │    │
│  │  → "classify photos", "organize albums" 명령     │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  MCP Tool: photo-source (5 tools)                │    │
│  │  MCP Tool: photo-ranker (22 tools)               │    │
│  └─────────────────────────────────────────────────┘    │
└───────────┬───────────────────────┬─────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐   ┌───────────────────────────────┐
│  photo-source     │   │  photo-ranker                  │
│  MCP Server       │   │  MCP Server                    │
│  (Python/stdio)   │   │  (Python/stdio)                │
│                   │   │                                │
│  Sources:         │   │  Engines:                      │
│  · Apple Photos   │   │  · VLM   (Qwen2.5-VL)         │
│  · Google Photos  │   │  · Aesthetic (LAION CLIP)      │
│  · GCS Bucket     │   │  · Face  (insightface/mp)      │
│  · Local folder   │   │  · Dedup (perceptual hash)     │
│                   │   │  · EXIF  (Pillow)              │
└───────────────────┘   └───────────────────────────────┘
            │                       │
            ▼                       ▼
┌───────────────────┐   ┌───────────────────────────────┐
│  Apple Photos     │   │  ~/.photo-ranker/jobs.db       │
│  iCloud Library   │   │  (SQLite: jobs, results,       │
│  GCS / Local FS   │   │   known_faces, checkpoints)    │
└───────────────────┘   └───────────────────────────────┘
```

### 왜 MCP 2개로 분리하는가

| 관점 | 이유 |
|------|------|
| 역할 분리 | 사진 소스 접근과 이미지 분석은 독립적 관심사 |
| 확장성 | 새 소스(Dropbox, NAS 등) 추가 시 photo-source만 수정 |
| 자원 관리 | photo-ranker는 GPU/메모리 집약적 — 별도 프로세스로 격리 |
| 재사용 | photo-ranker는 사진 외 다른 이미지 분석에도 사용 가능 |
| 테스트 | 각 MCP를 독립적으로 테스트 가능 |

---

## 3. 디렉터리 구조

```
MyOpenClawRepo/
├── extensions/
│   └── photos-classify/               # OpenClaw 플러그인 (오케스트레이터)
│       ├── openclaw.plugin.json        # 플러그인 선언 + MCP 서버 설정
│       ├── package.json                # npm 패키지 메타
│       ├── index.ts                    # 플러그인 진입점 (commands)
│       ├── tsconfig.json               # TypeScript 설정
│       └── openclaw-sdk.d.ts           # SDK 타입 선언 (로컬 개발용)
│
├── mcp-servers/
│   ├── photo-ranker/                   # 사진 분석·랭킹 MCP 서버
│   │   ├── pyproject.toml              # 패키지 설정 (hatchling)
│   │   ├── server.py                   # MCP stdio 진입점 (22개 tool)
│   │   ├── models.py                   # 6개 데이터 모델 (dataclass)
│   │   ├── scoring.py                  # 통합 점수 계산 (가중치 기반)
│   │   ├── pipeline.py                 # 2단계 파이프라인 (filter → VLM)
│   │   ├── jobs.py                     # Job 큐 + 상태 관리 (asyncio)
│   │   ├── db.py                       # SQLite 영속화 (WAL 모드)
│   │   ├── batch_classify.py           # CLI 배치 실행 진입점
│   │   ├── album_writer.py             # Apple Photos 앨범 쓰기
│   │   ├── sources.py                  # 통합 소스 로더 (local/apple)
│   │   ├── engines/
│   │   │   ├── vlm.py                  # mlx-vlm Qwen2.5-VL 추론
│   │   │   ├── aesthetic.py            # LAION aesthetic + 기술 품질
│   │   │   ├── face.py                 # 얼굴 감지 (insightface/mediapipe)
│   │   │   ├── dedup.py                # perceptual hash 중복 감지
│   │   │   └── exif.py                 # EXIF 메타데이터 + 방향 보정
│   │   ├── scripts/                    # E2E 검증 스크립트
│   │   └── tests/                      # 213개 테스트 (17개 파일)
│   │       ├── conftest.py
│   │       ├── test_models.py
│   │       ├── test_scoring.py
│   │       ├── test_vlm.py
│   │       ├── test_aesthetic.py
│   │       ├── test_face.py
│   │       ├── test_dedup.py
│   │       ├── test_exif.py
│   │       ├── test_server.py
│   │       ├── test_jobs.py
│   │       ├── test_db.py
│   │       ├── test_pipeline.py
│   │       ├── test_album_writer.py
│   │       ├── test_sources.py
│   │       ├── test_batch_classify.py
│   │       └── test_integration.py
│   │
│   └── photo-source/                   # 사진 소스 접근 MCP 서버
│       ├── pyproject.toml              # 패키지 설정
│       ├── server.py                   # MCP stdio 진입점 (5개 tool)
│       ├── models.py                   # Photo, PhotoMetadata, ExportResult
│       ├── sources/
│       │   ├── apple_photos.py         # Apple Photos (osxphotos)
│       │   ├── google_photos.py        # Google Photos API
│       │   ├── gcs.py                  # Google Cloud Storage
│       │   └── local_folder.py         # 로컬 디렉터리 순회
│       └── tests/                      # 59개 테스트
│           ├── conftest.py
│           ├── test_apple_photos.py
│           ├── test_google_photos.py
│           ├── test_gcs.py
│           ├── test_local_folder.py
│           ├── test_models.py
│           └── test_server.py
│
└── docs/
    └── photos-classify/
        ├── architecture-system-guide.md  # 이 문서
        ├── implementation-plan.md        # 단계별 작업 계획서
        ├── photos-classify.md            # 초기 분석 문서
        ├── benchmark-analysis-2026-03-28.md
        └── benchmark-improvement-2026-03-30.md
```

---

## 4. 컴포넌트 상세

### 4.1 photo-ranker MCP Server

사진 분석의 핵심 서버. **22개 MCP tool**을 제공한다.

| 모듈 | 역할 |
|------|------|
| `server.py` | FastMCP 진입점. 전체 tool 등록 및 엔진 lazy 초기화 |
| `models.py` | EventType, QualityScore, FaceResult, SceneDescription, DuplicateGroup, RankedPhoto |
| `scoring.py` | 가중치 기반 통합 점수 계산 (quality×0.30 + family×0.25 + event×0.25 + uniqueness×0.20) |
| `pipeline.py` | 2단계 파이프라인 (Stage 1: filter ~180ms, Stage 2: VLM ~5s/photo) |
| `jobs.py` | asyncio 기반 Job 큐, 동시 실행 제한, 상태 관리, 진행률 보고 |
| `db.py` | SQLite WAL 모드. jobs, photo_results, known_faces, face_embeddings, stage_checkpoints 테이블 |
| `album_writer.py` | Apple Photos 앨범 생성/추가/정리 (osxphotos 활용) |
| `batch_classify.py` | CLI 배치 진입점. `--source local|apple` 지원 |
| `sources.py` | 통합 소스 로더 (local, apple) |

**의존성 (pyproject.toml):**

```toml
[project]
requires-python = ">=3.12"
dependencies = [
    "mcp>=1.0.0", "pillow>=10.0", "pillow-heif>=0.16",
    "numpy>=1.26", "pydantic>=2.0", "imagehash>=4.3",
]

[project.optional-dependencies]
vlm = ["mlx-vlm>=0.1"]
aesthetic = ["open-clip-torch>=2.24", "torch>=2.0"]
face = ["mediapipe>=0.10"]
face-legacy = ["face-recognition>=1.3"]
apple = ["osxphotos>=0.68"]
all = ["photo-ranker[vlm,aesthetic,face,apple]"]
```

### 4.2 photo-source MCP Server

사진 소스 접근을 추상화하는 서버. **5개 MCP tool**을 제공한다.

| 소스 모듈 | 라이브러리 | 비고 |
|-----------|-----------|------|
| `apple_photos.py` | osxphotos | 앨범, 인물, 키워드, 날짜 필터링 |
| `google_photos.py` | google-api-python-client | Google Photos API (정책 제한 있음) |
| `gcs.py` | google-cloud-storage | GCS 버킷 기반 |
| `local_folder.py` | pathlib + Pillow | 로컬 디렉터리 순회, EXIF 추출 |

**의존성 (pyproject.toml):**

```toml
[project]
requires-python = ">=3.12"
dependencies = [
    "mcp>=1.0.0", "pillow>=10.0", "pillow-heif>=0.16", "pydantic>=2.0",
]

[project.optional-dependencies]
apple = ["osxphotos>=0.68"]
gcs = ["google-cloud-storage>=2.14"]
google = [
    "google-api-python-client>=2.100",
    "google-auth-oauthlib>=1.2",
    "google-auth-httplib2>=0.2",
    "requests>=2.31",
]
```

### 4.3 photos-classify OpenClaw Plugin

OpenClaw gateway에 등록되는 **얇은 오케스트레이터**이다. MCP 서버를 직접 실행하지 않고, OpenClaw의 MCP 라우팅을 통해 tool을 호출한다.

**`openclaw.plugin.json` 핵심 설정:**

```json
{
  "id": "photos-classify",
  "mcpServers": {
    "photo-ranker": {
      "command": "uv",
      "args": ["run", "--directory", "${PHOTO_RANKER_DIR:-./mcp-servers/photo-ranker}", "server.py"]
    },
    "photo-source": {
      "command": "uv",
      "args": ["run", "--directory", "${PHOTO_SOURCE_DIR:-./mcp-servers/photo-source}", "server.py"]
    }
  },
  "configSchema": {
    "properties": {
      "photoRankerDir": { "type": "string", "default": "./mcp-servers/photo-ranker" },
      "photoSourceDir": { "type": "string", "default": "./mcp-servers/photo-source" },
      "defaultSource": { "enum": ["local", "apple", "google", "gcs"], "default": "apple" }
    }
  }
}
```

---

## 5. MCP Tool 목록

### 5.1 photo-ranker (22 tools)

#### 분석 도구 (6)

| Tool | 설명 | 입력 | 출력 |
|------|------|------|------|
| `score_quality` | 미적 + 기술 품질 점수 | image_b64, photo_id? | QualityScore JSON |
| `detect_faces` | 얼굴 위치, 임베딩, 표정 | image_b64 | FaceResult[] JSON |
| `describe_scene` | VLM 장면 설명 | image_b64, prompt? | SceneDescription JSON |
| `classify_event` | 이벤트 유형 분류 | image_b64 | {event_type, confidence} |
| `find_duplicates` | 유사 사진 그룹화 | photo_hashes_json, threshold? | DuplicateGroup[] JSON |
| `rank_best_shots` | 통합 점수 기반 상위 N장 | photo_scores_json, top_n? | RankedPhoto[] JSON |

#### Job 관리 (5)

| Tool | 설명 |
|------|------|
| `start_classify_job` | 백그라운드 분류 작업 시작 (source, filters, limit) |
| `get_job_status` | Job 상태 조회 (progress 포함) |
| `get_job_result` | 완료된 Job의 랭킹 결과 조회 |
| `cancel_job` | 실행 중인 Job 취소 |
| `list_jobs` | Job 목록 조회 (status 필터) |

#### Known Person (4)

| Tool | 설명 |
|------|------|
| `register_face` | 이미지에서 얼굴 감지 → known person 등록 |
| `register_face_from_job` | 이전 분류 결과의 캐시된 임베딩으로 등록 |
| `list_known_faces` | 등록된 인물 목록 조회 |
| `delete_known_face` | 등록된 인물 삭제 |

#### 앨범 관리 (6)

| Tool | 설명 |
|------|------|
| `create_album` | Apple Photos 앨범 생성 (폴더 지원) |
| `add_to_album` | 기존 사진을 앨범에 추가 (복제 없음) |
| `organize_results` | 분류 결과를 이벤트별 앨범으로 자동 정리 |
| `import_photos` | 외부 사진을 Photos 라이브러리에 가져오기 |
| `import_and_organize` | 가져오기 + 분류 결과 기반 앨범 정리 |
| `list_photo_albums` | Apple Photos 앨범 목록 |

#### E2E 워크플로우 (1)

| Tool | 설명 |
|------|------|
| `classify_and_organize` | 소스 로드 → 분류 → 앨범 정리 전체 워크플로우 |

### 5.2 photo-source (5 tools)

| Tool | 설명 | 입력 |
|------|------|------|
| `list_photos` | 조건별 사진 목록 | source, date_from?, date_to?, album?, person?, limit? |
| `get_metadata` | EXIF + Photos 메타데이터 | photo_id |
| `get_thumbnail` | 분석용 리사이즈 base64 | photo_id, max_size? |
| `search_photos` | 키워드/날짜/인물 복합 검색 | query |
| `export_photos` | 사진을 로컬 폴더로 내보내기 | photo_ids[], dest_dir, format? |

---

## 6. 엔진 모듈

### 6.1 VLM Engine (`engines/vlm.py`)

| 항목 | 값 |
|------|-----|
| 모델 | `mlx-community/Qwen2.5-VL-7B-Instruct-4bit` |
| 최대 이미지 크기 | 512px (장변 기준) |
| 최대 토큰 | 256 |
| 출력 | JSON 파싱 + regex fallback |
| 메모리 | ~5GB |
| 추론 시간 | ~5초/장 (M4 32GB) |

**주요 기능:**
- `describe_scene(image_b64)` → SceneDescription (장면, 인물 수, 가족 여부, 표정, 이벤트, 의미점수)
- `classify_event(image_b64)` → (EventType, confidence)
- VLM 인스턴스 재사용 (파이프라인 내 한 번 초기화 후 반복 사용)

### 6.2 Aesthetic Engine (`engines/aesthetic.py`)

| 항목 | 값 |
|------|-----|
| 미적 점수 | LAION aesthetic predictor (CLIP ViT-L-14 기반, 0-10 스케일) |
| 기술 품질 | Laplacian blur + histogram contrast + resolution + noise + color balance |
| Sigmoid 매핑 | steepness=1.5, center=5.5 (0-10 → 0-50) |

**기술 품질 5요소 (`score_technical_quality`):**
1. 블러 감지 (Laplacian variance, sqrt 보정)
2. 해상도 점수 (megapixel 기준, sqrt 보정)
3. 대비 (histogram spread)
4. 노이즈 (고주파 비율)
5. 색상 균형 (채널 분포)

### 6.3 Face Engine (`engines/face.py`)

3단계 fallback 구조:
1. **insightface** (SCRFD + ArcFace) — 가장 정확, GPU 가속
2. **mediapipe** — 경량, CPU 전용
3. **face-recognition** (dlib) — Python 3.14에서 빌드 불가 (graceful degradation)

얼굴 미감지 시 이미지 업스케일(1.5x) 재시도 → 그래도 없으면 빈 리스트 반환.

### 6.4 Dedup Engine (`engines/dedup.py`)

- **Average hash** + **Perceptual hash** (phash) 조합
- Hamming distance 기반 유사도 (기본 threshold: 8)
- 그룹 내 대표 사진 선택 (기술 품질 기준)

### 6.5 EXIF Engine (`engines/exif.py`)

- EXIF 메타데이터 추출: GPS 좌표, 촬영일, 카메라 정보, 방향
- 방향 보정 (orientation tag 1-8 → 자동 회전)
- GPS travel 보정: EXIF GPS + outdoor 장면 → 여행 이벤트로 상향

---

## 7. 데이터 모델

### 7.1 RankedPhoto (최종 랭킹 결과)

```python
@dataclass
class RankedPhoto:
    photo_id: str
    total_score: float       # 0-100 통합 점수
    quality_score: float     # 품질 점수 (0-100)
    family_score: float      # 가족 인물 점수 (0-100)
    event_score: float       # 이벤트 점수 (0-100)
    uniqueness_score: float  # 중복 페널티 반영 (0-100)
    scene_description: str   # VLM 생성 장면 설명
    event_type: str          # 이벤트 유형 (birthday, travel, ...)
    faces_detected: int      # 감지된 얼굴 수
    known_persons: list[str] # 식별된 가족 이름
    has_gps: bool            # GPS 좌표 유무
    meaningful_score: int    # VLM 의미 점수 (1-10)
    capture_date: str        # EXIF 촬영일 (ISO format)
```

### 7.2 SceneDescription (VLM 출력)

```python
@dataclass
class SceneDescription:
    scene: str               # 장면 설명 텍스트
    people_count: int        # 인물 수
    is_family_photo: bool    # 가족 사진 여부
    expressions: list[str]   # 표정 목록
    event_type: EventType    # 이벤트 분류
    event_confidence: float  # 분류 신뢰도 (0-1)
    quality_notes: str       # 품질 관련 메모
    meaningful_score: int    # 의미 점수 (1-10)
    raw_json: dict           # VLM 원본 JSON
```

### 7.3 QualityScore

```python
@dataclass
class QualityScore:
    photo_id: str | None
    aesthetic_score: float   # 0-50 (sigmoid 매핑)
    technical_score: float   # 0-50 (5요소 합산)
    total: float             # 0-100
    notes: str = ""
```

### 7.4 FaceResult

```python
@dataclass
class FaceResult:
    bbox: tuple[int, int, int, int]     # top, right, bottom, left
    embedding: list[float] | None       # 128-dim 벡터
    expression: str                      # unknown, happy, sad, ...
    gender: str                          # male, female
    age: int
```

### 7.5 EventType (이벤트 분류)

```python
class EventType(str, Enum):
    BIRTHDAY = "birthday"
    TRAVEL = "travel"
    GRADUATION = "graduation"
    MEAL = "meal"
    DAILY = "daily"
    CELEBRATION = "celebration"
    OUTDOOR = "outdoor"
    PORTRAIT = "portrait"
    OTHER = "other"
```

### 7.6 DuplicateGroup

```python
@dataclass
class DuplicateGroup:
    group_id: str
    photo_ids: list[str]
    representative_id: str   # 그룹 내 대표 사진
```

---

## 8. 점수 체계 (Scoring)

### 8.1 가중치

```
최종 점수 = quality × 0.30 + family × 0.25 + event × 0.25 + uniqueness × 0.20
```

| 카테고리 | 가중치 | 설명 |
|---------|--------|------|
| Quality | 30% | 미적 품질(sigmoid LAION) + 기술 품질(5요소) |
| Family | 25% | 얼굴 수, 등록 인물 매칭, 긍정 표정 |
| Event | 25% | 이벤트 유형 기본 점수 × 분류 신뢰도 |
| Uniqueness | 20% | 대표 사진 100, 중복 사진 페널티 |

### 8.2 이벤트 기본 점수

| EventType | 점수 |
|-----------|------|
| birthday | 90 |
| graduation | 90 |
| travel | 80 |
| celebration | 75 |
| outdoor | 60 |
| meal | 60 |
| portrait | 50 |
| daily | 30 |
| other | 20 |

### 8.3 품질 점수 상세

**미적 점수 (0-50):** LAION 원점수 → sigmoid 변환
```
sigmoid = 1 / (1 + exp(-1.5 × (raw - 5.5)))
aesthetic_mapped = sigmoid × 50
```

예시: raw=3→1.1, raw=5→16.0, raw=5.5→25.0, raw=6→34.0, raw=7→45.2

**기술 품질 (0-50):** 블러 + 해상도 + 대비 + 노이즈 + 색상 균형 (sqrt 보정)

### 8.4 가족 점수 상세

```
기본: 0점
2명 이상 얼굴: +20
등록된 가족 1명당: +25 (최대 100)
긍정 표정 1개당: +10
최대: 100
```

---

## 9. 2단계 파이프라인

### Stage 1: Filter (~180ms/photo)

```
사진 입력
  ↓
EXIF 추출 + 방향 보정
  ↓ (concurrent)
├─ 기술 품질 점수 (blur, resolution, contrast, noise, color)
└─ 얼굴 감지 + known person 매칭
  ↓
품질 + 가족 점수 계산
  ↓
중복 감지 (perceptual hash, group 단위)
  ↓
필터링: technical_score < min_threshold → 탈락
         is_duplicate (non-representative) → 탈락
```

### Stage 2: VLM (~5s/photo)

```
Stage1 통과 후보
  ↓
VLM 장면 설명 (describe_scene)
  ↓
이벤트 분류 + GPS travel 보정
  ↓
meaningful_score (1-10)
  ↓
최종 통합 점수 계산 + 랭킹
  ↓
결과 영속화 (SQLite)
```

### PipelineConfig (튜닝 가능)

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `min_technical_score` | 10.0 | Stage2 진입 최소 기술 점수 (0-50) |
| `skip_duplicates` | true | 중복 사진 Stage2 스킵 |
| `dedup_threshold` | 8 | Hamming distance 임계값 |
| `vlm_top_n` | 0 (전체) | Stage2 VLM 처리 상한 |
| `vlm_model_path` | (기본 모델) | 커스텀 모델 경로 |

### 체크포인트/리줌

- 각 Stage 처리 결과를 SQLite에 저장 (stage_checkpoints 테이블)
- 중단 후 재실행 시 이미 처리된 사진은 체크포인트에서 복원
- 성공 완료 시 체크포인트 자동 삭제

### 로깅/관측성

파이프라인 각 단계에 `time.perf_counter()` 기반 타이밍이 포함되어 있다.

```
Pipeline start: 50 photos
Stage1 done: 50 candidates in 9.12s
Dedup done: 3 duplicates found in 0.05s
Stage1 filter: 42 passed, 8 filtered (quality=5, dup=3)
Stage2 start: 42 candidates for VLM
VLM engine init: 18.45s          # 최초 1회
Stage2 done: 42 processed in 210.30s
Pipeline complete: 50→42 ranked in 219.47s (s1=9.12s, dedup=0.05s, s2=210.30s)
```

Job `result_summary`에도 타이밍 포함:
```json
{
  "total_input": 50,
  "passed_stage1": 42,
  "duplicates_found": 3,
  "ranked_count": 42,
  "stage1_s": 9.12,
  "dedup_s": 0.05,
  "stage2_s": 210.3,
  "total_s": 219.47
}
```

---

## 10. 설치 및 설정

### 10.1 사전 요구사항

| 항목 | 최소 버전 | 비고 |
|------|----------|------|
| macOS | Sonoma 이상 | Apple Silicon 필수 |
| Python | 3.12+ | 3.14 검증 완료 |
| uv | 0.10+ | Python 패키지 관리자 |
| RAM | 16GB | 32GB 권장 (VLM + aesthetic 동시 사용 시) |
| Disk | ~10GB | 모델 캐시 (~/.cache/huggingface/) |

### 10.2 photo-ranker 설치

```bash
cd mcp-servers/photo-ranker

# 기본 의존성 (VLM/aesthetic 없이 — 테스트/개발용)
uv sync

# VLM 추론 포함
uv sync --extra vlm

# 미적 점수 포함
uv sync --extra aesthetic

# 얼굴 인식 (mediapipe)
uv sync --extra face

# Apple Photos 연동
uv sync --extra apple

# 전체 설치
uv sync --extra all

# 개발 의존성 (pytest)
uv sync --extra dev
```

**VLM 모델 다운로드 (최초 1회):**

```bash
# mlx-vlm이 자동으로 ~/.cache/huggingface/ 에 다운로드
# 또는 수동 다운로드:
uv run python3 -c "from engines.vlm import VLMEngine; VLMEngine()"
# → ~5.65GB 다운로드, 약 20초 소요 (M4 기준)
```

### 10.3 photo-source 설치

```bash
cd mcp-servers/photo-source

# 기본 (로컬 폴더 소스만)
uv sync

# Apple Photos
uv sync --extra apple
# 또는 pyobjc 빌드 이슈 시:
uv pip install osxphotos

# Google Cloud Storage
uv sync --extra gcs

# Google Photos
uv sync --extra google
```

### 10.4 Apple Photos 권한 설정

Apple Photos 접근에는 **Full Disk Access** 권한이 필요하다:

1. 시스템 설정 → 개인정보 보호 및 보안 → Full Disk Access
2. 터미널 앱 (Terminal.app 또는 iTerm) 추가
3. 이미 추가되어 있으면 끄고 다시 켜기

### 10.5 OpenClaw 등록

```bash
# MCP 서버 개별 등록
openclaw mcp set photo-ranker "{\"command\":\"uv\",\"args\":[\"run\",\"--directory\",\"$(pwd)/mcp-servers/photo-ranker\",\"server.py\"]}"
openclaw mcp set photo-source "{\"command\":\"uv\",\"args\":[\"run\",\"--directory\",\"$(pwd)/mcp-servers/photo-source\",\"server.py\"]}"

# 또는 플러그인으로 등록 (MCP 서버 자동 포함)
openclaw plugin install ./extensions/photos-classify

# 등록 확인
openclaw mcp list
```

---

## 11. 실행 방법

### 11.1 MCP 서버 단독 실행

```bash
# photo-ranker
cd mcp-servers/photo-ranker
uv run server.py
# → stdio MCP 서버로 실행, JSON-RPC 2.0 통신

# photo-source
cd mcp-servers/photo-source
uv run server.py
```

### 11.2 CLI 배치 분류

```bash
cd mcp-servers/photo-ranker

# 로컬 폴더 사진 분류 (기본 top 10)
uv run python3 batch_classify.py --source local --path ~/Pictures/vacation/

# Apple Photos 앨범 분류
uv run python3 batch_classify.py --source apple --album "Family"

# 필터 + 제한
uv run python3 batch_classify.py \
  --source apple \
  --person "엄마" \
  --date-from 2026-01-01 \
  --date-to 2026-03-31 \
  --limit 50 \
  --top 20
```

### 11.3 OpenClaw 경유 (대화형)

```
사용자: "지난달 가족사진 베스트 20장 골라줘"

→ OpenClaw 에이전트가 자동으로:
  1. photo-source.list_photos(source="apple", date_from="2026-03-01", person="가족")
  2. photo-ranker.start_classify_job(source="apple", ...)
  3. photo-ranker.get_job_status(job_id) (진행률 확인)
  4. photo-ranker.get_job_result(job_id, top_n=20)
  5. photo-ranker.organize_results(job_id, album_prefix="AI 분류")
```

---

## 12. 테스트

### 12.1 테스트 실행

```bash
# photo-ranker (213 tests)
cd mcp-servers/photo-ranker
uv run pytest tests/ -v

# photo-source (59 tests)
cd mcp-servers/photo-source
uv run pytest tests/ -v

# 전체: 272 tests
```

### 12.2 테스트 구성

**photo-ranker (213 tests, 17 files):**

| 파일 | 테스트 수 | 범위 |
|------|----------|------|
| `test_models.py` | 데이터 모델 직렬화/역직렬화 |
| `test_scoring.py` | 가중치 계산, 이벤트 점수, 가족 점수 |
| `test_vlm.py` | VLM 엔진 mock, JSON 파싱, fallback |
| `test_aesthetic.py` | Aesthetic 엔진, sigmoid 매핑, 기술 품질 |
| `test_face.py` | 얼굴 감지, graceful degradation |
| `test_dedup.py` | 중복 감지, Hamming distance |
| `test_exif.py` | EXIF 파싱, GPS 변환, 방향 보정 |
| `test_server.py` | MCP tool 등록, 입출력 검증 |
| `test_jobs.py` | Job 큐, 상태 전이, 동시 실행 제한 |
| `test_db.py` | SQLite CRUD, WAL 모드, 마이그레이션 |
| `test_pipeline.py` | 2단계 파이프라인, 로깅, 타이밍 |
| `test_album_writer.py` | 앨범 생성/추가/정리 |
| `test_sources.py` | 통합 소스 로더 |
| `test_batch_classify.py` | CLI 배치 (local/apple source, args) |
| `test_integration.py` | E2E: source→pipeline→DB, Job lifecycle, 오류 복구 |

**photo-source (59 tests, 7 files):**

| 파일 | 범위 |
|------|------|
| `test_models.py` | Photo, PhotoMetadata 모델 |
| `test_apple_photos.py` | osxphotos 래핑, 필터링 |
| `test_google_photos.py` | Google Photos API mock |
| `test_gcs.py` | GCS SDK mock |
| `test_local_folder.py` | 로컬 순회, EXIF 추출 |
| `test_server.py` | MCP tool 등록/호출 |

---

## 13. 구현 완료 현황

### Phase 0: 환경 준비 ✅

- Python 3.14 + uv 환경 세팅
- mlx-vlm + Qwen2.5-VL-7B-Instruct-4bit 모델 설치
- osxphotos Apple Photos 접근 검증
- face-recognition 빌드 실패 → graceful degradation 처리

### Phase 1: photo-ranker MCP MVP ✅

- 6개 분석 tool (score_quality, detect_faces, describe_scene, classify_event, find_duplicates, rank_best_shots)
- 5개 엔진 모듈 (VLM, Aesthetic, Face, Dedup, EXIF)
- 6개 데이터 모델
- 가중치 기반 통합 점수 체계

### Phase 2: photo-source MCP MVP ✅

- 5개 tool (list_photos, get_metadata, get_thumbnail, search_photos, export_photos)
- 4개 소스 모듈 (Apple Photos, Google Photos, GCS, Local)

### Phase 3: Job 시스템 + 통합 ✅

- asyncio Job 큐 + SQLite 영속화
- 2단계 파이프라인 (filter → VLM)
- 체크포인트/리줌 지원
- CLI 배치 진입점 (local + apple source)
- OpenClaw 플러그인 (오케스트레이터)
- Apple Photos 앨범 자동 정리
- 날짜별 앨범 그룹화
- meaningful_score (VLM 의미 점수)
- Known Person 등록/매칭
- 기술 품질 보정 (5요소 sqrt)
- Aesthetic sigmoid 보정
- 로깅/관측성 (stage 타이밍)
- 통합 테스트 (9 tests)
- E2E 워크플로우 tool (`classify_and_organize`)
- 272 tests 전체 통과

---

## 14. 남은 작업 및 제약사항

### 14.1 남은 작업

#### Phase 4: 개인화 (보류)

- [ ] 얼굴 임베딩 클러스터링 → 자동 가족 구성원 추천
- [ ] 사용자 피드백 저장 (좋은/별로인 사진 표시)
- [ ] 피드백 기반 가중치 개인화

#### Phase 5: 자동화 (보류)

- [ ] OpenClaw cron 설정으로 주간/야간 정기 분류
- [ ] 완료 시 Telegram/기타 채널 알림
- [ ] exec + notifyOnExit 연동

#### Phase 6: 확장 (향후)

- [ ] 분산 추론 (여러 GPU/머신)
- [ ] 10,000장+ 대규모 배치 최적화
- [ ] 사용자 피드백 루프 기반 모델 미세조정

### 14.2 알려진 제약사항

| 제약 | 상세 | 우회 방안 |
|------|------|----------|
| Google Photos 정책 | 2025.03 정책 변경으로 전체 라이브러리 자동 스캔 불가 | Picker API 기반 개별 선택만 가능 |
| face-recognition (dlib) | Python 3.14 + macOS clang C23 호환성 문제 | insightface/mediapipe fallback 사용 |
| VLM 최초 로딩 | 모델 로드에 ~20초 소요 | 이후 추론은 ~5초/장, 인스턴스 재사용 |
| RAM 제한 | VLM(5GB) + Aesthetic(2GB) 동시 사용 시 ~8GB+ | 32GB에서 안정, 16GB는 순차 사용 권장 |
| Apple Photos 권한 | Full Disk Access 필요 | 시스템 설정에서 수동 허용 필요 |

### 14.3 성능 참고값 (M4 32GB 기준)

| 단계 | 시간 |
|------|------|
| Stage 1 (filter) | ~180ms/photo |
| VLM 모델 초기 로드 | ~20s (최초 1회) |
| Stage 2 (VLM 추론) | ~5s/photo |
| 50장 전체 파이프라인 | ~220s (VLM 로드 포함) |
| 100장 전체 파이프라인 | ~420s |

---

## 부록: SQLite DB 스키마

DB 경로: `~/.photo-ranker/jobs.db`

```
jobs              — Job 상태, 소스, 결과 요약
photo_results     — 사진별 랭킹 결과 (JSON blob)
known_faces       — 등록된 인물 이름 + 임베딩
face_embeddings   — 분류 시 캐시된 얼굴 임베딩
stage_checkpoints — 파이프라인 체크포인트 (리줌용)
```

모든 테이블은 WAL 모드로 동작하며, 동시 읽기/쓰기를 지원한다.
