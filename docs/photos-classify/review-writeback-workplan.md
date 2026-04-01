# Photos Classify — 저장, 얼굴 태깅, WebUI 검토 작업방안

> 작성일: 2026-04-01
> 대상: photo-ranker, photo-source, photos-classify OpenClaw plugin
> 상태: 1차 백엔드 확장 반영, standalone review WebUI 반영, OpenClaw plugin route 프록시 1차 반영

---

## 1. 목적

현재 photos-classify는 "분류"와 "Apple Photos 앨범 정리"까지는 가능하지만, 실제 운영 관점에서는 아래 흐름이 추가로 필요하다.

1. 분류 후 저장 위치를 명확히 제어해야 한다.
2. Apple Photos 외에 로컬 디렉터리 기반 write-back이 가능해야 한다.
3. 얼굴 감지 결과를 사람이 검토하고 이름을 붙여 known person으로 등록할 수 있어야 한다.
4. WebUI에서 선택된 사진, preview, 태그, 얼굴 crop을 볼 수 있어야 한다.
5. 특정 사진에 대해 사용자가 수동 태깅하고 후속 분류에 반영할 수 있어야 한다.

이번 작업에서 1차로 백엔드 준비를 추가했다.

---

## 2. 저장 전략

### 2.1 Apple Photos write-back

Apple Photos는 원본을 다시 복사하지 않고 라이브러리 내 사진을 특정 앨범에 참조로 추가하는 방식이 기본이다.

- 기존 기능: `organize_results`
- 장점: 라이브러리 중복 증가 없음
- 적합한 경우: iCloud Photos를 계속 기준 저장소로 쓸 때

### 2.2 로컬 디렉터리 write-back

로컬 소스는 분류 후 아래 구조로 내보내는 것이 현실적이다.

```text
<output_dir>/
  travel/
    IMG_1001.jpg
    IMG_1002.jpg
  birthday/
    2026-03/
      IMG_2001.jpg
```

- 신규 기능: `organize_results_to_directory`
- 지원 방식:
  - `mode="copy"` : 파일 복사
  - `mode="hardlink"` : 같은 볼륨 내 하드링크
- 날짜 그룹핑: `group_by_date=true` 이면 `event_type/YYYY-MM`

### 2.3 소스별 권장 전략

| 소스 | 저장 전략 | 권장 도구 |
|------|-----------|-----------|
| Apple Photos | 라이브러리 앨범 추가 | `organize_results` |
| Local folder | 이벤트별 디렉터리 복사/링크 | `organize_results_to_directory` |
| GCS | 1차는 로컬 export 후 재배치 | 후속 작업 |
| Google Photos | 정책 제약으로 별도 검토 필요 | 후속 작업 |

---

## 3. 얼굴 분류 및 이름 태깅 방안

### 3.1 왜 얼굴 감지만으로는 부족한가

현재 얼굴 엔진은 얼굴 존재, embedding, 표정, 성별, 연령 추정까지는 가능하지만 "이 사람이 누구인지"는 자동으로 확정할 수 없다.

이 문제는 다음 2단계로 해결해야 한다.

1. 시스템이 얼굴 후보를 crop으로 보여준다.
2. 사용자가 이름을 붙여 known face로 등록한다.

### 3.2 1차 구현된 흐름

이번 작업에서 아래가 추가되었다.

1. 분류 시 preview 이미지 저장
2. 얼굴 bbox 저장
3. 얼굴 crop 이미지 저장
4. 얼굴 검토 목록 조회
5. 얼굴에 이름 붙이기
6. 이름 붙인 얼굴을 known face DB에 등록

### 3.3 사용 흐름

#### Step 1. 분류 실행

```text
start_classify_job(...)
```

#### Step 2. 검토용 결과 조회

```text
get_review_items(job_id="...")
```

반환값에는 다음이 포함된다.

- 점수 정보
- preview_path
- source_photo_path
- selected
- review_tags
- note

#### Step 3. 특정 사진의 얼굴 후보 조회

```text
list_photo_faces(job_id="...", photo_id="...")
```

반환값에는 다음이 포함된다.

- `face_idx`
- `bbox`
- `crop_path`
- `gender`
- `age`
- `expression`
- `label_name`

#### Step 4. 사람이 이름 붙이기

```text
label_face_in_job(
  job_id="...",
  photo_id="...",
  face_idx=0,
  name="홍길동"
)
```

이 호출은 두 가지를 수행한다.

1. 해당 face review 레코드에 `label_name` 저장
2. embedding을 `known_faces`에 등록

### 3.4 재분류 전략

얼굴 이름을 붙인 뒤 기존 결과를 즉시 재계산하지는 않는다. 운영상 더 안전한 흐름은 아래다.

1. 몇 장의 대표 얼굴에 이름을 붙인다.
2. known face 데이터가 충분해지면 같은 앨범/기간을 다시 분류한다.
3. family score와 known_persons 매칭이 개선된다.

이 방식이 필요한 이유는 기존 점수와 새 known face 매칭이 섞여 결과가 불안정해지는 것을 막기 위해서다.

---

## 4. WebUI 검토 흐름

### 4.1 백엔드 준비 상태

이번 작업에서 WebUI가 쓸 수 있도록 아래 메타가 저장된다.

- photo preview 파일 경로
- source photo 경로(로컬 작업일 때)
- review tags
- selected 여부
- note
- 얼굴 crop 파일 경로

### 4.2 WebUI에서 필요한 화면

#### 결과 그리드 화면

각 카드에 아래를 노출한다.

- preview 이미지
- total_score
- event_type
- known_persons
- meaningful_score
- selected 토글
- tags 편집
- note 편집

#### 얼굴 검토 모달

특정 카드에서 얼굴 검토 모달을 열어 아래를 노출한다.

- 얼굴 crop 썸네일 목록
- 추정 속성(성별/연령/표정)
- 이름 입력 필드
- known face 등록 버튼

### 4.3 현재 가능한 MCP 기반 검토 API

| 목적 | 도구 |
|------|------|
| 결과 조회 | `get_review_items` |
| 사진 선택/태그/메모 저장 | `set_photo_review` |
| 얼굴 후보 조회 | `list_photo_faces` |
| 얼굴 이름 지정 및 등록 | `label_face_in_job` |

### 4.4 현재 Web 계층 상태

이제 아래 경로가 동작한다.

1. standalone review app
  - `uv run review_app.py`
  - `http://127.0.0.1:8765/review/<job_id>`
2. OpenClaw plugin route 프록시
  - `/plugins/photos-classify/review/<job_id>`
  - `/plugins/photos-classify/`
  - `/plugins/photos-classify/api/*`
  - `/plugins/photos-classify/artifacts/*`

현재 구현 특징:

- review app HTML은 `base_path`를 받아 OpenClaw prefix 아래에서도 동작한다.
- `/plugins/photos-classify/` root 는 recent jobs 와 review 진입 링크를 보여주는 lightweight portal 이다.
- OpenClaw plugin은 local review app(`reviewAppUrl`, 기본 `http://127.0.0.1:8765`)으로 프록시한다.
- 기본 보안은 프록시 헤더가 없는 로컬 브라우저 요청만 허용한다.
- `reviewAccessToken` 을 설정하면 query/header token 기반 원격 접근을 허용할 수 있다.

---

## 5. 이번에 추가된 구현 항목

### 5.1 photo-ranker

- `artifacts.py`
  - 분류 결과 preview 저장
  - 얼굴 crop 저장
- `local_writer.py`
  - 로컬 디렉터리 이벤트별 분류 write-back
- `db.py`
  - `job_assets` 테이블 추가
  - `face_reviews` 테이블 추가
  - face bbox 저장 확장
- `server.py`
  - `organize_results_to_directory`
  - `get_review_items`
  - `set_photo_review`
  - `list_photo_faces`
  - `label_face_in_job`
  - 분류 완료 후 preview/face crop 캐시 저장

### 5.2 OpenClaw plugin

- `/classify-review <job_id>` 명령 추가
- 검토 단계에서 어떤 tool을 호출해야 하는지 안내
- `/plugins/photos-classify/*` HTTP route 추가
- `/plugins/photos-classify/` recent jobs portal 추가
- review app 미실행 시 안내 HTML 반환
- review page/API/artifact 경로를 OpenClaw 아래로 프록시

---

## 6. 실제 운영 플로우 제안

### 6.1 Apple Photos 기반

1. `start_classify_job(source="apple", ...)`
2. `get_review_items(job_id)`
3. 사용자가 selected/tag/note 보정
4. 필요 시 `list_photo_faces` → `label_face_in_job`
5. 필요한 얼굴 라벨링이 끝나면 동일 범위를 재분류
6. 최종 결과를 `organize_results`로 Apple Photos 앨범에 정리

### 6.2 로컬 폴더 기반

1. `start_classify_job(source="local", source_path="...")`
2. `get_review_items(job_id)`
3. 선택/태그/얼굴 이름 보정
4. 필요 시 브라우저에서 `/plugins/photos-classify/review/<job_id>` 열기
5. `export_selected_photos(job_id, output_dir="...")` 또는 `organize_results_to_directory(job_id, output_dir="...")`

---

## 7. 다음 단계

### 7.1 바로 다음 구현 권장

1. OpenClaw 정식 web UI 탭/메뉴에 photos-classify review 진입점 추가
2. reverse proxy/Tailscale 환경에서도 안전하게 열 수 있도록 gateway auth 또는 signed token 전략 추가
3. photo-source 쪽 원본 export 경로와 photo-ranker review 메타 연결 고도화
4. re-label 후 재분류 단축 액션 추가

### 7.2 이후 확장

1. 얼굴 라벨 후보 추천
2. 사용자 태그 기반 개인화 가중치
3. GCS write-back 정책 추가
4. Google Photos 정책 범위 내 선택식 import 지원

---

## 8. MCP 예시 호출

### 검토 목록 조회

```text
get_review_items(job_id="a1b2c3d4", top_n=30)
```

### 특정 사진 선택 + 태그 저장

```text
set_photo_review(
  job_id="a1b2c3d4",
  photo_id="/Users/me/Pictures/IMG_0001.jpg",
  tags_json='["best", "family", "print"]',
  selected=true,
  note="액자 후보"
)
```

### 얼굴 후보 조회

```text
list_photo_faces(
  job_id="a1b2c3d4",
  photo_id="/Users/me/Pictures/IMG_0001.jpg"
)
```

### 얼굴 이름 붙이기

```text
label_face_in_job(
  job_id="a1b2c3d4",
  photo_id="/Users/me/Pictures/IMG_0001.jpg",
  face_idx=0,
  name="엄마"
)
```

### 로컬 디렉터리로 정리

```text
organize_results_to_directory(
  job_id="a1b2c3d4",
  output_dir="/Users/me/Pictures/Classified",
  min_score=60,
  group_by_date=true,
  mode="copy"
)
```

---

## 9. 정리

이번 단계의 핵심은 "자동 분류"만 하는 시스템에서 "사람이 검토하고 보정한 뒤 저장하는 시스템"으로 옮겨가는 기반을 넣는 것이다.

즉, 구조는 아래처럼 바뀐다.

1. photo-source: 원본 접근
2. photo-ranker: 점수화 + preview/crop 생성 + review metadata 저장
3. WebUI/OpenClaw plugin: 결과 표시 + 수동 선택/태깅/이름 부여
4. write-back: Apple Photos 앨범 또는 로컬 디렉터리 정리

이 흐름으로 가야 "누구인지 분류", "어떤 사진을 실제로 남길지 선택", "저장 위치 제어"가 모두 연결된다.