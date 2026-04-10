# ZeroClaw photos-classify / smart-router 전환 메모

기준 시점: 2026-04-10

## 요약

- `photos-classify` 는 ZeroClaw에서 1차 이관이 가능하다.
- 핵심 경로는 OpenClaw 플러그인 포팅이 아니라 `photo-ranker`, `photo-source` MCP 서버를 ZeroClaw `[mcp]` 설정에 직접 등록하는 방식이다.
- `smart-router` 는 현재 OpenClaw plugin SDK 의존이 강해서 직접 포팅보다 외부 OpenAI-compatible 라우팅 프록시로 재구성하는 편이 현실적이다.

## photos-classify 현재 판단

### 바로 재사용 가능한 요소

1. `mcp-servers/photo-ranker`
2. `mcp-servers/photo-source`
3. `uv run --directory ... server.py` 형태의 stdio MCP 기동 방식
4. ZeroClaw의 `[mcp]` / `[[mcp.servers]]` 등록 방식

### OpenClaw 전용 요소

1. `/classify`, `/classify-status`, `/classify-review` 슬래시 명령
2. `registerHttpRoute()` 기반 review 프록시 경로 (`/plugins/photos-classify/*`)
3. OpenClaw 플러그인 설정 스키마와 auto registration

### 이번 작업에서 반영한 상태

1. ZeroClaw 활성 설정에 `photo_ranker`, `photo_source` MCP 서버 등록
2. 사진 관련 요청에서만 MCP 스키마를 노출하도록 `agent.tool_filter_groups` 추가
3. `photo-source/server.py` 에 누락된 `mcp.run()` 엔트리포인트 복구

### 2026-04-10 live 검증 결과

1. `photo_source__list_photos` 로 Apple Photos 최근 사진 3장 조회 성공
2. `photo_source__get_metadata` 로 Apple Photos 단일 사진 메타데이터 조회 성공
3. Apple Photos 기반 `get_thumbnail -> score_quality` 연계는 ZeroClaw 실행 프로세스의 macOS Photos/TCC 권한 때문에 실패
4. 로컬 폴더 기반 `list_photos` 는 성공
5. 로컬 폴더 기반 `get_thumbnail -> score_quality` 는 작은 JPEG 썸네일(`max_size=64`)에서는 성공
6. 팔레트 PNG 또는 큰 base64 payload 경로는 추가 보정이 필요함

즉, 현재 1차 이관 상태는 "조회/목록/메타데이터는 운영 가능, 분석 파이프라인은 입력 형식과 권한 조건을 더 다듬어야 함" 으로 판단한다.

### 아직 남은 photos-classify 작업

1. review UI 진입 경로 재설계
2. ZeroClaw 대시보드에서 review 링크를 노출할 별도 UX 결정
3. Apple Photos / Google Photos / export 계열 도구의 승인 정책 세분화
4. `photo-ranker` 고비용 도구와 read-only 도구를 분리한 tool group 추가
5. `photo_source` 썸네일 생성 시 PNG/JPEG 호환성과 large base64 전달 경계 재검토

## ZeroClaw에서의 photos-classify 권장 구조

### 1단계

- ZeroClaw 기본 agent가 MCP 도구를 직접 호출한다.
- 대표 호출 대상:
  - `photo_source__list_photos`
  - `photo_source__get_metadata`
  - `photo_source__get_thumbnail`
  - `photo_ranker__start_classify_job`
  - `photo_ranker__get_job_status`
  - `photo_ranker__get_review_items`
  - `photo_ranker__curate_best_photos`

### 2단계

- 로컬 review 앱은 `http://127.0.0.1:8765` 를 직접 쓰거나 별도 reverse proxy로 노출한다.
- OpenClaw처럼 ZeroClaw 내부 route에 review UI를 매달기보다 외부 로컬 앱으로 두는 편이 구현 비용이 낮다.
- 다만 이번 검증 기준으로는 사용자가 요구한 것처럼 "ZeroClaw 웹 UI 안에서 다시 적용" 하는 방향을 별도로 재검토해야 한다.
- 즉, 단순 reverse proxy 여부만이 아니라 ZeroClaw dashboard 안에서 review 상태와 링크를 어떻게 노출할지부터 다시 설계해야 한다.
- 상세 설계 메모는 `docs/zeroclaw-photos-review-ui-design-2026-04-10.md` 에 분리했다.

### 3단계

- 필요하면 ZeroClaw skill 또는 SOP cookbook로 사진 작업 프롬프트를 정형화한다.
- 예: "최근 Apple Photos 30장 중 quality 상위 30%를 review selected로 표시" 같은 작업 템플릿.

## smart-router 현재 판단

### 현재 구현이 의존하는 OpenClaw 고유 지점

1. custom provider 등록 (`providers: ["smart-router"]`)
2. `resolveDynamicModel` 훅
3. `wrapStreamFn` 훅
4. footer model alias 주입 (`local`, `nano`, `mini`, `full`)
5. `/route`, `/local`, `/remote` 같은 슬래시 명령

위 5개는 ZeroClaw 기본 설정만으로는 동일하게 재현되지 않는다.

### ZeroClaw에서 바로 활용 가능한 요소

1. 내장 local provider (`llamacpp`, `ollama`)
2. 내장 remote provider (`openai` 등)
3. `fallback_providers`
4. `custom:<url>` OpenAI-compatible endpoint
5. MCP 기반 보조 도구

### 권장 전환 방향

`smart-router` 를 ZeroClaw 내부 플러그인으로 포팅하지 말고, 별도 OpenAI-compatible 라우팅 프록시로 분리한다.

예시 구조:

1. ZeroClaw
   - `default_provider = "custom:http://127.0.0.1:4310/v1"`
   - `default_model = "auto"`
2. `zeroclaw-smart-router-proxy`
   - 입력 메시지 복잡도 평가
   - local / nano / mini / full 결정
   - llama.cpp 또는 OpenAI로 실제 요청 전달
   - route 로그와 fallback 기록

### 이 구조가 맞는 이유

1. ZeroClaw의 provider 설정을 그대로 활용할 수 있다.
2. OpenClaw plugin SDK 에 묶인 stream wrapping 코드를 독립 서비스로 옮기기 쉽다.
3. ZeroClaw 업데이트와 분리되어 유지보수하기 쉽다.
4. 나중에 다른 런타임에서도 같은 라우터를 재사용할 수 있다.

### 남는 차이점

1. OpenClaw footer의 route alias 표시와 같은 UI 노출은 바로 옮길 수 없다.
2. 대신 route 결과는 프록시 로그, ZeroClaw trace, 응답 헤더 또는 별도 상태 endpoint 로 노출하는 편이 현실적이다.

## smart-router 구현 단계 제안

### Phase 1

- 현재 `complexity.ts` 규칙과 tier 정책을 독립 모듈로 추출
- `auto -> local|nano|mini|full` 만 결정하는 단일 라우터 서비스 구현

현재 초안 코드는 `services/zeroclaw-smart-router-proxy/` 에 추가했다.

### Phase 2

- OpenAI-compatible `/v1/chat/completions` 또는 `/v1/responses` 프록시 추가
- local/remote timeout, first-token timeout, fallback 정책 반영

### Phase 3

- route 로그 JSONL 저장
- ZeroClaw runtime trace 와 연결 가능한 메타 출력 형식 확정

### Phase 4

- 필요 시 `evaluationMode=llm` 분류를 외부 프록시 안에서만 유지
- ZeroClaw 본체에는 일반 provider 하나처럼 보이도록 유지

## 우선순위

1. `photos-classify` 1차 운영 안정화
2. review UI 접근 방식 확정
3. `smart-router` 프록시 초안 작성
4. ZeroClaw 기본 모델 경로를 프록시로 전환

## 권장 다음 액션

1. `photos-classify` 실제 분류/목록 조회 프롬프트를 2~3개 선정해 실호출 검증
2. review 앱을 직접 URL 방식으로 둘지 reverse proxy 를 둘지 결정
3. `smart-router` 를 Rust로 할지 Node.js로 할지 먼저 선택

---

## 미완료 항목 (2026-04-11 기준)

### mlx-vlm 미설치 — VLM 품질 평가 비활성화 상태

**현재 증상**

모든 ZeroClaw 에이전트 실행 시 아래 경고가 반복된다.

```
WARNING VLM not available for ...: mlx-vlm is not installed. Install with: uv pip install mlx-vlm
```

이로 인해 다음 분석 항목이 전부 skip 된다.

- `scene_description` (자연어 장면 설명)
- `event_type` (여행, 가족 모임, 음식 등 자동 분류)
- VLM 기반 quality scoring (기술적 품질 점수만 남은 상태)

**조건**

- Apple Silicon Mac 전용 (`mlx` 백엔드)
- `photo-ranker` MCP 서버 `.venv` 에 설치 필요 (uv 관리)
- Python 3.14 환경 (`/Volumes/ExtData/MyOpenClawRepo/mcp-servers/photo-ranker/.venv`)

**설치 방법**

```bash
cd /Volumes/ExtData/MyOpenClawRepo/mcp-servers/photo-ranker

# 권장: pyproject.toml extras 경유
uv sync --extra vlm

# 또는 직접 설치
uv pip install mlx-vlm
```

`uv sync --extra vlm` 이 더 권장된다. `pyproject.toml` 의 `[project.optional-dependencies]` vlm 그룹을 그대로 반영하기 때문이다.

**설치 후 후속 작업**

1. ZeroClaw 데몬 재시작: `zeroclaw-launchd restart`
2. 검증 명령 예시:
   ```
   zeroclaw agent -m 'Apple Photos 최근 3장을 review 해줘. scene_description 도 포함해서 알려줘.'
   ```
3. 로그에서 `scene_description` 값이 채워지는지, VLM WARNING 이 사라지는지 확인

**주의사항**

- `mlx-vlm` 패키지는 설치 용량이 크다 (모델 가중치 포함 시 수 GB 가능)
- 첫 실행 시 Qwen2.5-VL 모델 가중치를 `~/.cache/huggingface/` 또는 mlx 캐시에 다운로드한다
- 디스크 여유 공간 확인 후 진행 권장