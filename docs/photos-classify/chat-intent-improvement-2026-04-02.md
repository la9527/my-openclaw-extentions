# Photos Classify 채팅 의도 처리 개선안

작성일: 2026-04-02

## 배경

OpenClaw 채팅에서 아래 요청을 보냈을 때 `photos-classify` 가 기대한 작업을 끝까지 수행하지 못했다.

```text
photos-classify 를 이용해 apple photos 사진을 마지막 30개 사진에서 잘 찍힌 사진들만 가져와서 '잘나온사진1' 앨범을 하나 만들고, 그곳에 잘 나온 사진들을 분류해줘.
```

확인 대상은 두 가지였다.

1. `마지막 30개 사진` 이라는 자연어 범위를 현재 파이프라인이 정확히 이해하는가
2. `잘나온사진1` Apple Photos 앨범 생성 및 사진 추가까지 현재 오케스트레이션이 가능한가

## 로그 기반 재현 결과

OpenClaw 세션 로그 `~/.openclaw/agents/main/sessions/5664d097-7516-4d1a-bb87-2efdff8c659c.jsonl` 에서 아래 흐름이 확인됐다.

1. 사용자가 자연어 요청을 보냈다.
2. 에이전트는 `photos-classify` 명령과 README 를 확인했지만, 실제 실행 경로를 확정하지 못했다.
3. `/classify apple "최근 30장"` 을 보냈지만, 실제 MCP job 실행이 아니라 설명 텍스트가 되돌아왔다.
4. 최종적으로 `apple "앨범명"` 형태만 안전하다고 판단하고, 최근 30장 처리와 앨범 생성/추가를 수행하지 못했다.

즉, 실패 원인은 모델 성능 자체보다도 현재 플러그인 오케스트레이션이 자연어 의도를 구조화하지 못하는 데 있다.

## 현재 코드 기준 확인된 사실

### 1. `photos-classify` 플러그인 명령은 실제 도구 호출을 수행하지 않는다

`extensions/photos-classify/index.ts` 의 `/classify` 명령은 실제로 `classify_and_organize(...)` 를 호출하지 않고, 해당 도구 사용 예시를 텍스트로 반환한다.

결과적으로 채팅에서 `/classify apple "최근 30장"` 을 보내도, job 생성까지 이어지는 보장이 없다.

### 2. Apple Photos 최근 N장 로딩 능력은 서버 쪽에 이미 있다

`mcp-servers/photo-ranker/sources.py` 의 Apple Photos loader 는 아래 동작을 이미 지원한다.

- `date_from`, `date_to`, `album`, `person`, `limit` 필터 지원
- 촬영일 기준 내림차순 정렬
- `limit` 만큼 잘라 최신 사진만 반환

즉 `최근 30장` 자체는 백엔드 레벨에서 구현 가능한 상태다.

### 3. Apple Photos 앨범 생성/추가 도구도 이미 있다

`mcp-servers/photo-ranker/server.py` 에는 다음 도구가 구현돼 있다.

- `create_album`
- `add_to_album`
- `organize_results`
- `classify_and_organize`

또한 `mcp-servers/photo-ranker/album_writer.py` 는 `photoscript` 기반으로 실제 Apple Photos 앨범 생성과 사진 추가를 수행한다.

즉 `앨범 생성 자체가 불가능한 것` 이 아니라, 현재 `photos-classify` 플러그인이 그 write-back 도구를 채팅 의도에 맞게 연결하지 못하고 있다.

### 4. 현재 사용자 요청과 도구 표면 사이에 구조화 레이어가 없다

현재 요청은 사실상 아래 구조를 의미한다.

```json
{
  "source": "apple",
  "selection": {
    "mode": "latest",
    "limit": 30
  },
  "curation": {
    "quality": "best_only"
  },
  "writeback": {
    "targetAlbumName": "잘나온사진1",
    "createIfMissing": true,
    "mode": "add_existing_photos"
  }
}
```

하지만 현재 플러그인 명령 표면은 사실상 아래 수준에 가깝다.

```text
/classify [source] [path]
```

이 차이 때문에 자연어 의도에서 필요한 매개변수를 MCP 도구 호출 형태로 바꾸지 못한다.

## 이번 요청이 실패한 직접 원인

### 원인 1. `최근 30장` 이 Apple album/path 로 잘못 취급됐다

현재 `/classify` 인터페이스는 `source_path` 중심이며, Apple Photos 쪽 예시도 앨범명을 path 자리에 넣는 방식이다.
그래서 `최근 30장` 같은 시간/개수 기반 조건은 별도 필터로 분리되지 못했다.

### 원인 2. `잘 찍힌 사진들만` 이 selection policy 로 구조화되지 않았다

현재 시스템에는 랭킹 점수와 review/selected 개념은 있지만, 채팅에서 말한 `잘 찍힌 사진들만` 을 곧바로

- 상위 N장
- 특정 최소 점수 이상
- selected=true 자동 마킹

같은 정책으로 바꾸는 레이어가 없다.

### 원인 3. 단일 대상 앨범에 결과를 넣는 동선이 플러그인 레벨에서 빠져 있다

현재 `classify_and_organize` 는 이벤트 유형별 앨범 정리에 가깝다. 반면 이번 요청은 `잘나온사진1` 이라는 단일 앨범에 curated result 를 넣는 방식이다.

즉 이번 요청에는 `organize by event` 가 아니라 `create target album + add curated photo uuids` 흐름이 필요하다.

### 원인 4. 채팅 명령이 실제 실행과 안내를 구분하지 못했다

현재 `/classify` 는 사용자 입장에서는 실행 명령처럼 보이지만, 구현은 안내 메시지에 가깝다. 이 때문에 OpenClaw 세션에서 `/classify ...` 를 보내도 실제 job 생성이 일어나지 않았다.

## 개선 방향

## 방향 A. 자연어 요청을 구조화된 classify intent 로 변환

채팅에서 아래 항목을 우선 추출해야 한다.

- 소스: `apple`
- 범위 유형: `latest`
- 범위 수량: `30`
- 품질 선택 정책: `best_only`
- 결과 write-back 방식: `target_album`
- 대상 앨범명: `잘나온사진1`

이 단계가 있어야 기존 MCP 도구를 제대로 조합할 수 있다.

## 방향 B. `photos-classify` 명령을 실제 실행형으로 변경

현재 `/classify` 는 설명을 반환한다. 이를 실제 도구 호출형 동작으로 바꿔야 한다.

최소 요구사항:

1. Apple source 에서 `source_path` 없이도 `limit`, `date_from`, `album`, `person` 필터로 실행 가능
2. 실행 시 `start_classify_job(...)` 또는 동등한 백엔드 워크플로우를 실제 호출
3. job_id 와 review URL, 후속 write-back 경로를 반환

## 방향 C. `최근 N장 curated -> 단일 앨범` 워크플로우 추가

이번 요청은 이벤트별 앨범 분리가 아니라 단일 결과 앨범이 필요하다.

필요한 실행 흐름은 아래와 같다.

1. Apple Photos 최신 30장 조회
2. 분류/랭킹 실행
3. `best_only` 기준으로 결과 선별
4. `잘나온사진1` 앨범 생성 또는 확인
5. 선별된 photo UUID 들을 해당 앨범에 추가

이 흐름은 현재 도구만으로도 조합 가능하지만, 매번 에이전트가 수동 오케스트레이션하지 않도록 전용 helper 가 필요하다.

권장안은 둘 중 하나다.

1. `photo-ranker` 에 `curate_to_album(...)` 같은 E2E helper 추가
2. `photos-classify` 플러그인에서 `start_classify_job -> get_job_result -> create_album -> add_to_album` 을 순차 호출

운영 안정성 측면에서는 1번이 더 낫다.

## 방향 D. selection policy 를 명시적으로 도입

`잘 찍힌 사진들만` 은 모호하다. 최소한 아래 중 하나로 정책을 고정해야 한다.

1. `top_n`
2. `min_score`
3. `score >= X and not duplicate`
4. `review selected=true` 를 거친 뒤 add_to_album

초기 구현은 아래 조합이 현실적이다.

- 기본: `min_score` + `limit` 기반 자동 선별
- 필요 시 `top_n` 보조 옵션
- review 후 확정 반영을 위한 수동 override 유지

## 권장 구현 순서

### 1단계. 채팅 의도 파서를 추가

목표:

- `최근 30장`
- `잘 나온 사진`
- `앨범 만들고 넣어줘`

같은 표현을 구조화된 파라미터로 바꾼다.

예시 결과:

```json
{
  "source": "apple",
  "limit": 30,
  "selectionPolicy": {
    "mode": "min_score",
    "minScore": 0.72
  },
  "targetAlbumName": "잘나온사진1",
  "writeback": true
}
```

### 2단계. `/classify` 를 실행형 명령으로 변경

현재 텍스트 안내형 동작을 실제 job 생성형으로 바꾼다.

추가 후보:

- `/classify apple --latest 30`
- `/classify apple --album "여행 사진" --limit 30`
- `/classify-curate apple --latest 30 --target-album "잘나온사진1"`

### 3단계. Apple Photos 단일 앨범 write-back helper 추가

새 helper 예시:

```text
curate_to_album(
  source="apple",
  latest_limit=30,
  target_album_name="잘나온사진1",
  min_score=0.72,
  create_album_if_missing=true
)
```

이 helper 는 내부에서 아래를 수행한다.

1. 최신 사진 조회
2. 분류 job 실행
3. score 기반 선별
4. 대상 앨범 생성
5. 선별 UUID add_to_album

### 4단계. README 와 채팅 사용 예시 보강

문서에는 아래를 분리해서 적어야 한다.

1. `앨범명 기준 분류`
2. `최근 N장 기준 분류`
3. `단일 대상 앨범에 curated result 쓰기`
4. `review 후 수동 확정`

## 확정된 정책

이 문서 작성 이후 아래 정책을 구현 기본값으로 확정했다.

### 1. `잘 나온 사진` 기준

- `quality_score` 기준 상위 30%
- 구현은 고정 `top 30%` count 가 아니라, 해당 컷오프의 `quality_min_score` 를 계산한 뒤
  그 이상인 사진을 selected 로 본다
- 동점이 있으면 selected 수가 30%를 조금 넘을 수 있다

### 2. 결과 반영 방식

두 모드를 모두 지원한다.

1. `review`
  selected=true 로 표시만 하고 review route 에서 검토
2. `album`
  대상 Apple Photos 앨범을 생성 또는 재사용한 뒤 selected 결과를 바로 추가

즉 채팅 또는 MCP 호출에서 사용자가 둘 중 하나를 선택할 수 있어야 한다.

## 제안하는 구현 범위

이번 개선은 아래 범위로 자르는 것이 적절하다.

### P0

- `/classify` 실행형 전환 또는 별도 실행형 command 추가
- `latest N` 파라미터 지원
- `target album` 기반 Apple Photos write-back 지원

### P1

- 자연어 의도 파서 정교화
- `잘 나온 사진` selection policy 튜닝
- review-selected 결과를 앨범 반영하는 후속 명령 추가

### P2

- 사람 필터, 날짜 범위, 기존 앨범 조합 요청 확장
- `최근 30장 중 가족 사진만` 같은 복합 질의 지원

## 구현 전 결정이 필요한 사항

아래 두 가지는 먼저 고정하는 것이 좋다.

### 1. `잘 나온 사진` 기본 정책

권장 기본값:

- 최신 30장 로드
- 중복 억제 후 score 상위 10장 또는 `min_score` 이상만 선택
- 필요 시 review 에서 수동 수정 가능

### 2. write-back 방식

선택지:

1. 자동으로 `잘나온사진1` 앨범 생성 후 바로 추가
2. 먼저 review selected 로 보여주고, 확정 시 추가

이번 요청 성격상 1번이 맞지만, 운영 안전성을 생각하면 2번도 옵션으로 남기는 것이 좋다.

## 권장 결론

현재 문제의 본질은 `photos-classify` 백엔드 기능 부족이 아니라, 채팅 요청을 실행 가능한 도구 조합으로 바꾸는 플러그인 오케스트레이션 부족이다.

따라서 다음 구현은 아래 순서가 가장 효율적이다.

1. 채팅 의도를 구조화한다.
2. `/classify` 또는 신규 command 를 실제 실행형으로 바꾼다.
3. Apple Photos 최신 N장 curated 결과를 단일 앨범에 넣는 helper 를 추가한다.
4. README 와 운영 검증 절차를 갱신한다.

이 방향이면 이번 사용자 요청인 `최근 30장 -> 잘 나온 사진 선별 -> 잘나온사진1 앨범 생성 및 추가` 를 안정적으로 처리할 수 있다.