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
| `/classify-review [job_id]` | review app 및 OpenClaw review route 안내 |

## 채팅 입력 가이드

직접 채팅에서 요청할 때는 아래 두 가지 방식이 가장 안정적이다.

1. 플러그인 슬래시 명령을 직접 입력한다.
2. 자연어로 요청하되 source, path, job_id, 원하는 동작을 같이 명시한다.

권장 예시:

```text
/classify local /Users/me/Pictures/2026-03
/classify apple "여행 사진"
/classify-status 003d0bc1
/classify-review 003d0bc1
```

고수준 MCP 도구를 직접 쓰는 예시:

```text
Apple Photos 최신 30장 중 잘 나온 사진만 골라 review selected 로 표시해줘.

Apple Photos 최신 30장 중 잘 나온 사진만 골라서 "잘나온사진1" 앨범에 넣어줘.
```

자연어 요청 예시:

```text
local 폴더 /Users/me/Pictures/2026-03 을 photos-classify로 분류해줘.

Apple Photos 앨범 "여행 사진"을 photos-classify로 분류해줘.

job_id 003d0bc1 상태를 확인해줘.

job_id 003d0bc1 review 링크를 열 수 있게 안내해줘.

job_id 003d0bc1 에 대해 get_review_items 결과를 보여줘.

job_id 003d0bc1 의 selected 사진만 /Users/me/Pictures/Selected 로 export 해줘.

Apple Photos 최신 30장 중 quality 상위 30% 사진만 골라 review 대상으로 표시해줘.

Apple Photos 최신 30장 중 quality 상위 30% 사진만 골라서 잘나온사진1 앨범을 만들고 추가해줘.
```

잘 되는 요청 형태:

- source를 명확히 쓴다: `local`, `apple`, `google`, `gcs`
- local이면 실제 디렉터리 경로를 함께 쓴다
- review/상태 조회는 `job_id`를 함께 쓴다
- export/정리는 출력 경로를 같이 쓴다

피하는 것이 좋은 요청 형태:

- `사진 좀 정리해줘` 처럼 source/path 없이 너무 짧은 요청
- 어떤 앨범이나 폴더를 뜻하는지 없는 요청
- review 대상 job_id 없이 `검토해줘` 만 보내는 요청

운영 팁:

- 최초 분류는 `/classify ...` 또는 `photos-classify로 분류해줘` 형태가 가장 단순하다.
- 결과 확인은 `/classify-status <job_id>` 나 `/classify-review <job_id>` 가 가장 안정적이다.
- review UI가 필요하면 `/plugins/photos-classify/` 포털이나 `/plugins/photos-classify/review/<job_id>` 경로를 사용한다.
- 최신 N장 + 잘 나온 사진 선별 + 단일 앨범 write-back 은 `curate_best_photos` 도구 호출이 가장 직접적이다.

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
| `reviewAppUrl` | `http://127.0.0.1:8765` | `review_app.py` 로컬 HTTP 주소 |
| `reviewAppAutoStart` | `true` | review route/API 접근 시 `review_app.py` 자동 기동 |
| `reviewAccessToken` | `` | 원격 review route 접근용 선택 토큰. 비워두면 로컬 브라우저만 허용 |
| `reviewAllowTailscale` | `false` | Tailscale Serve identity header 를 신뢰해 `ts.net` 프록시 접근 허용 |
| `reviewTailscaleUserLogins` | `[]` | 허용할 Tailscale login allowlist. 비워두면 tailnet 인증 사용자 전체 허용 |
| `defaultSource` | `apple` | 기본 사진 소스 (`local`, `apple`, `google`, `gcs`) |

## Review Route

기본값으로 review route 또는 review API를 처음 열 때 plugin 이 `review_app.py` 자동 기동을 시도한다.

권장:

- 글로벌 설치 환경에서는 `photoRankerDir` 를 실제 절대 경로로 설정한다.
- 예: `/Volumes/ExtData/MyOpenClawRepo/mcp-servers/photo-ranker`

auto-start 를 끄거나 수동 확인이 필요할 때는 아래처럼 직접 실행할 수 있다.

```bash
cd mcp-servers/photo-ranker
uv run python review_app.py
```

브라우저 접속 경로:

- `/plugins/photos-classify/`
- `/plugins/photos-classify/review/<job_id>`

Tailscale Serve 경유 접근이 필요하면 아래처럼 설정한다.

```bash
openclaw config set plugins.entries.photos-classify.config.reviewAllowTailscale true
openclaw config set plugins.entries.photos-classify.config.reviewTailscaleUserLogins '["your-login@example.com"]'
openclaw gateway restart
```

운영 메모:

- plugin 은 backend 요청이 loopback 에서 들어오고 `Tailscale-User-Login` 또는 `Tailscale-User-Name` header 가 있을 때만 Tailscale 요청으로 신뢰한다.
- `reviewTailscaleUserLogins` 를 비워두면 tailnet 인증이 끝난 모든 사용자 요청을 허용한다.
- 더 좁게 열고 싶으면 allowlist 를 반드시 채운다.
- Tailscale Serve 와 token 접근을 같이 써도 된다.

## 운영 절차

글로벌 설치된 `openclaw` 기준 권장 순서:

1. `photoRankerDir` 와 `photoSourceDir` 를 실제 절대 경로로 설정한다.
2. 설정 변경 뒤 `openclaw gateway restart` 로 게이트웨이를 재시작한다.
3. `http://127.0.0.1:18789/plugins/photos-classify/` 에서 recent jobs 포털이 열리는지 확인한다.
4. review app 이 내려가 있는 상태에서 `http://127.0.0.1:18789/plugins/photos-classify/review/<job_id>` 를 열어 auto-start 가 동작하는지 확인한다.
5. 필요하면 `http://127.0.0.1:18789/plugins/photos-classify/api/jobs/<job_id>/items` 로 review API 응답까지 확인한다.
6. Tailscale Serve 를 쓰는 경우 `https://byoungyoung-macmini.tail53bcc7.ts.net/plugins/photos-classify/` 와 review URL 에서 동일하게 열리는지 확인한다.

검증에 유용한 명령:

```bash
openclaw config get plugins.entries.photos-classify
openclaw gateway status
openclaw gateway restart
lsof -iTCP:8765 -sTCP:LISTEN -n -P
```

현재 검증된 동작:

- 게이트웨이 재시작 후 `photos-classify: registered ... autoStart=on` 로그가 남는다.
- `127.0.0.1:8765` 가 비어 있는 상태에서 review route 첫 요청이 들어오면 plugin 이 `uv run python review_app.py` 를 자동 기동한다.
- auto-start 뒤 review HTML 과 `/api/jobs/*` 프록시 응답이 모두 정상 반환된다.

## MCP 점검 절차

`photos-classify` 는 아래 두 MCP 서버를 사용한다.

- `photo-ranker`
- `photo-source`

글로벌 설치본 기준 최소 점검 순서:

1. 플러그인 로드 확인

```bash
openclaw plugins inspect photos-classify
```

2. review route / review API 확인

```bash
python3 - <<'PY'
from urllib.request import urlopen

for url in [
	'http://127.0.0.1:18789/plugins/photos-classify/',
	'http://127.0.0.1:18789/plugins/photos-classify/api/jobs?limit=3',
]:
	with urlopen(url, timeout=15) as r:
		print(url, r.status)
		print(r.read(200).decode('utf-8', 'replace'))
PY
```

3. `photo-source` 서버 최소 실행 확인

```bash
cd /Volumes/ExtData/MyOpenClawRepo/mcp-servers/photo-source
uv run python - <<'PY'
from server import list_photos, get_metadata

photos = list_photos(source='local', path_or_bucket='/tmp/photos-classify-demo', limit=5)
print(photos)
if photos:
	print(get_metadata(source='local', path_or_bucket='/tmp/photos-classify-demo', photo_id=photos[0]['id']))
PY
```

4. `photo-ranker` 서버 최소 실행 확인

```bash
cd /Volumes/ExtData/MyOpenClawRepo/mcp-servers/photo-ranker
uv run python - <<'PY'
import asyncio
from server import list_jobs, get_review_items

print(asyncio.run(list_jobs()))
print(asyncio.run(get_review_items('fbe8cad2', top_n=5, selected_only=False)))
PY
```

현재 검증 결과:

- `photo-source` 의 `list_photos`, `get_metadata` 실행 확인
- `photo-ranker` 의 `list_jobs`, `get_review_items` 실행 확인
- 실제 job `fbe8cad2` 에 대해 review item 반환 확인

## 운영 로그 추적

`openclaw agent` 경유로 `photos-classify` 호출을 추적할 때는 글로벌 설치본 로그를 같이 본다.

기본 확인 순서:

```bash
openclaw logs --plain --limit 200
```

실시간 추적이 필요하면:

```bash
openclaw logs --follow --plain
```

주요 확인 포인트:

- `photos-classify: registered ...` 로 플러그인 로드 확인
- `review proxy failed ...` 와 `starting review app automatically ...` 로 auto-start 경로 확인
- `openclaw plugins inspect photos-classify` 결과와 로그 시점을 비교해 최신 설치본이 반영됐는지 확인

`openclaw agent` 로 slash command 또는 review 유도 메시지를 보낼 때는 아래처럼 최소 확인을 할 수 있다.

```bash
openclaw agent --session-id photos-classify-check --message "/classify-review <job_id>" --thinking minimal --json
```

이 경우 응답 payload 와 `openclaw logs` 출력을 함께 봐야 실제 플러그인/route 반영 상태를 빠르게 판단할 수 있다.

주의:

- 기본값은 프록시 헤더가 없는 로컬 브라우저 요청만 허용한다.
- 기본값은 review route/API 접근 시 `review_app.py` 자동 기동을 시도한다.
- `reviewAccessToken` 을 설정하면 `?token=...` 또는 `x-photos-classify-token` 헤더로 원격 접근을 허용할 수 있다.
- `reviewAllowTailscale=true` 이면 Tailscale Serve identity header 가 있는 `ts.net` 프록시 요청을 허용할 수 있다.
- `reviewTailscaleUserLogins` 를 채우면 허용 대상 Tailscale 로그인만 통과시킨다.
- `/plugins/photos-classify/` 포털에서 recent jobs 와 review 링크를 볼 수 있다.
- auto-start 가 실패하면 `photoRankerDir` 경로와 `uv` 실행 가능 여부를 먼저 확인한다.

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
