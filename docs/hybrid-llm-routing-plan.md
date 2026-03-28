# OpenClaw 하이브리드 LLM 라우팅 구성 작업 방안

> 현재 운영 기준 아님. 이 문서는 초기 구상 기록이며, 현재 실제 운영 기준은 [docs/ollama-docker-operations.md](docs/ollama-docker-operations.md) 와 [configs/openclaw-hybrid.json5](configs/openclaw-hybrid.json5) 를 따른다.

> 작성일: 2026-03-24  
> 대상 환경: Mac mini M4 (32GB) / macOS / OpenClaw 2026.3.13  
> 목적: 기본 요청은 로컬 LLM(Ollama)으로 처리하고, 복잡한 요청은 외부 LLM으로 전달하는 하이브리드 구조 구현

---

## 1. 현재 상태 분석

### 1.1 하드웨어

| 항목 | 값 |
|------|------|
| 모델 | Mac mini (Mac16,10) |
| 칩 | Apple M4 |
| 메모리 | 32 GB 통합메모리 |
| 저장소 | ExtData 외장 볼륨 사용 |

### 1.2 현재 OpenClaw 설정

- **primary 모델**: `openai-codex/gpt-5.4` (OAuth 인증)
- **로컬 Ollama**: 설치됨, `qwen3:8b` 모델 보유 (5.2 GB)
- **채널**: Telegram 활성화
- **웹 검색**: Gemini 기반 활성화
- **게이트웨이**: 로컬 모드 (포트 18789, Tailscale serve)

### 1.3 문제점

1. 모든 요청이 외부 LLM(`openai-codex/gpt-5.4`)으로만 전달됨
2. 로컬 Ollama가 설치되어 있지만 OpenClaw과 연결되지 않음
3. 단순 질문(인사, 번역, 요약 등)도 외부 API 호출 → 불필요한 비용/지연 발생
4. 복잡한 작업(코드 생성, 분석, 멀티턴 추론)은 로컬 LLM으로 품질 부족 가능

---

## 2. 목표 아키텍처

```
사용자 요청
    │
    ▼
┌─────────────────────────────┐
│   OpenClaw Gateway          │
│   (모델 선택 & 폴백)         │
│                             │
│  primary: ollama/qwen3:8b   │  ← 기본 (로컬, 무료, 빠름)
│  fallback: openai-codex/... │  ← 복잡한 요청 또는 로컬 실패 시
│  fallback: anthropic/...    │  ← 추가 폴백 (선택)
└─────────────────────────────┘
         │              │
         ▼              ▼
   ┌──────────┐   ┌──────────────┐
   │  Ollama   │   │ 외부 LLM API │
   │ (로컬)    │   │ (클라우드)    │
   │ qwen3:8b  │   │ GPT-5.4 등  │
   └──────────┘   └──────────────┘
```

### 2.1 라우팅 전략

OpenClaw은 **thinking level** 과 **model fallback** 메커니즘을 내장하고 있다. 이를 활용한 2단계 전략:

| 전략 | 방식 | 설명 |
|------|------|------|
| **Phase 1** (설정 기반) | `primary` + `fallbacks` 설정 | 로컬 우선, 실패 시 외부 폴백 |
| **Phase 2** (확장 기반) | 커스텀 플러그인 | 요청 복잡도 판별 후 모델 자동 선택 |

---

## 3. Phase 1: 설정 기반 하이브리드 라우팅

> 난이도: 낮음 | 소요: 설정 변경만으로 즉시 적용 가능

### 3.1 Ollama 프로바이더 등록

OpenClaw에 Ollama를 프로바이더로 연결한다.

#### 3.1.1 Ollama 준비

```bash
# Ollama 실행 확인
ollama list

# 추천 로컬 모델 (M4 32GB 기준)
ollama pull qwen3:8b          # 이미 설치됨 (5.2GB, 범용 대화)
ollama pull qwen3:14b         # 14B 모델 (더 높은 품질, ~9GB)
ollama pull devstral:24b      # 코딩 특화 (선택, ~16GB)
```

> **M4 32GB 권장 모델**: 8B~14B급이 응답 속도와 품질의 균형점. 24B 이상은 가능하지만 응답 지연이 커진다.

#### 3.1.2 OpenClaw 설정 변경

`~/.openclaw/openclaw.json` 의 `agents.defaults` 섹션을 수정한다:

```json5
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/qwen3:8b",
        "fallbacks": [
          "openai-codex/gpt-5.4"
        ]
      },
      "models": {
        "ollama/qwen3:8b": {},
        "openai-codex/gpt-5.4": {}
      },
      "workspace": "/Users/byoungyoungla/.openclaw/workspace",
      "compaction": {
        "mode": "safeguard"
      }
    }
  }
}
```

#### 3.1.3 Ollama 인증 프로필 등록

```bash
# 방법 A: 환경변수 설정 (~/.zshrc 또는 ~/.profile)
export OLLAMA_API_KEY=ollama-local

# 방법 B: onboard 재실행으로 Ollama 추가
openclaw onboard
# → "Add another provider" → Ollama 선택 → Cloud+Local 모드
```

#### 3.1.4 동작 확인

```bash
# 모델 목록 확인
openclaw models list --all

# 로컬 모델 응답 테스트
openclaw message send "안녕하세요, 오늘 날씨 어때요?"

# 게이트웨이 상태 확인
openclaw status --all
```

### 3.2 폴백 동작 원리

OpenClaw의 기본 폴백 로직:

1. `primary` 모델(`ollama/qwen3:8b`)로 요청 시도
2. 실패 시 (타임아웃, 오류, 컨텍스트 초과) → `fallbacks` 순서대로 시도
3. 쿨다운: 실패한 모델은 1분 → 5분 → 25분 → 1시간 쿨다운 후 재시도

### 3.3 Phase 1 한계

- 로컬 LLM이 "실패"해야만 외부로 넘어감 (품질 저하 시 자동 전환 불가)
- 사용자가 수동으로 `/model openai-codex/gpt-5.4` 명령으로 전환 가능하지만 불편
- 복잡한 작업을 자동 감지하여 라우팅하는 기능 없음

---

## 4. Phase 2: 커스텀 플러그인 기반 스마트 라우팅

> 난이도: 중간 | 소요: 플러그인 개발 필요

### 4.1 개요

OpenClaw 플러그인 SDK를 활용하여 요청 복잡도를 판별하고 적절한 모델로 라우팅하는 확장을 개발한다.

### 4.2 디렉토리 구조

```
MyOpenClawRepo/
├── docs/
│   └── hybrid-llm-routing-plan.md    ← 이 문서
├── extensions/
│   └── smart-router/
│       ├── package.json
│       ├── openclaw.plugin.json
│       ├── index.ts                  ← 플러그인 엔트리
│       ├── router.ts                 ← 라우팅 로직
│       ├── complexity.ts             ← 복잡도 판별기
│       └── config.ts                 ← 라우팅 설정 타입
└── configs/
    └── openclaw-hybrid.json5         ← 하이브리드 설정 예시
```

### 4.3 복잡도 판별 기준

| 구분 | 기준 | 라우팅 대상 |
|------|------|------------|
| **단순** | 인사, 날씨, 단순 질의, 번역(짧은 문장), 계산 | 로컬 LLM |
| **보통** | 요약, 긴 번역, 간단한 코드 질문, 일상 대화 | 로컬 LLM |
| **복잡** | 코드 생성/리뷰, 멀티턴 추론, 장문 분석, 도구 사용 | 외부 LLM |
| **고급** | 복합 에이전트 작업, 대규모 코드베이스 분석 | 외부 LLM |

판별 신호:

```typescript
// 복잡도 판별 요소
interface ComplexitySignals {
  tokenCount: number;         // 입력 토큰 수
  hasCodeBlock: boolean;      // 코드 블록 포함 여부
  hasToolUse: boolean;        // 도구 사용 요청 여부
  conversationDepth: number;  // 대화 턴 수
  languageComplexity: string; // 자연어 복잡도
  explicitModel: string;      // 사용자 명시 모델 (/model 명령)
}
```

### 4.4 플러그인 구현 스켈레톤

#### 4.4.1 `extensions/smart-router/index.ts`

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { evaluateComplexity } from "./complexity.js";

export default definePluginEntry({
  id: "smart-router",
  name: "Smart LLM Router",
  description: "요청 복잡도에 따라 로컬/외부 LLM을 자동 선택",
  register(api: OpenClawPluginApi) {
    // 슬래시 명령 등록: /route 로 현재 라우팅 상태 확인
    api.registerCommand({
      name: "route",
      description: "현재 LLM 라우팅 설정 확인",
      run: async (ctx) => {
        // 라우팅 상태 출력 로직
      },
    });

    // 서비스 등록: 요청 전처리 훅
    api.registerService({
      id: "smart-router-service",
      start: async (ctx) => {
        // 라우팅 로직 초기화
      },
    });
  },
});
```

#### 4.4.2 `extensions/smart-router/complexity.ts`

```typescript
export type ComplexityLevel = "simple" | "moderate" | "complex" | "advanced";

export interface RoutingDecision {
  level: ComplexityLevel;
  model: string;           // "ollama/qwen3:8b" | "openai-codex/gpt-5.4"
  reason: string;          // 판별 근거
}

export function evaluateComplexity(input: string, context?: {
  turnCount?: number;
  hasTools?: boolean;
}): RoutingDecision {
  const tokenEstimate = input.length / 4; // 대략적 토큰 추정
  const hasCode = /```[\s\S]*?```/.test(input) || /\b(function|class|import|def|const)\b/.test(input);
  const isLong = tokenEstimate > 500;
  const isDeep = (context?.turnCount ?? 0) > 5;
  const needsTools = context?.hasTools ?? false;

  if (needsTools || (hasCode && isLong) || isDeep) {
    return {
      level: "complex",
      model: "openai-codex/gpt-5.4",
      reason: needsTools ? "도구 사용 필요" : hasCode ? "코드 분석 필요" : "깊은 대화",
    };
  }

  if (hasCode || isLong) {
    return {
      level: "moderate",
      model: "ollama/qwen3:8b",
      reason: "로컬 처리 가능한 수준",
    };
  }

  return {
    level: "simple",
    model: "ollama/qwen3:8b",
    reason: "단순 질의",
  };
}
```

### 4.5 Phase 2 구현 시 고려사항

1. **OpenClaw 플러그인 SDK 제약**: 현재 SDK는 프로바이더 등록, 명령 등록, 서비스 등록을 지원하지만, 요청 전처리 훅(pre-request hook)으로 모델을 동적 변경하는 공식 API가 제한적일 수 있음
2. **대안 접근**: `resolveDynamicModel` 훅을 활용하여 프로바이더 레벨에서 모델 재지정
3. **thinking level 활용**: OpenClaw의 기존 `adaptive` thinking 모드와 연계 가능

---

## 5. Phase 1.5: 중간 단계 — 에이전트별 모델 분리

> Phase 1과 2 사이의 실용적 중간 단계

OpenClaw은 에이전트별로 다른 모델을 지정할 수 있다. 용도별 에이전트를 나누어 운영:

### 5.1 에이전트 설정

```json5
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/qwen3:8b",
        "fallbacks": ["openai-codex/gpt-5.4"]
      }
    },
    "list": [
      {
        "id": "local-chat",
        "name": "로컬 대화",
        "model": {
          "primary": "ollama/qwen3:8b"
        },
        "thinkingDefault": "low"
      },
      {
        "id": "power-coder",
        "name": "코딩 어시스턴트",
        "model": {
          "primary": "openai-codex/gpt-5.4"
        },
        "thinkingDefault": "high"
      }
    ]
  }
}
```

### 5.2 사용 방법

```bash
# 기본(로컬) 에이전트 사용
openclaw message send "오늘 일정 알려줘"

# 코딩 에이전트로 전환
openclaw agent switch power-coder
openclaw message send "이 함수를 리팩토링해줘: ..."

# 또는 Telegram에서 슬래시 명령으로 전환
# /agent local-chat
# /agent power-coder
```

---

## 6. 추천 로컬 모델

M4 32GB 환경 기준 추천 모델:

| 모델 | 크기 | 용도 | 장점 | 단점 |
|------|------|------|------|------|
| `qwen3:8b` | 5.2 GB | 범용 대화 | 빠른 응답, 한국어 양호 | 코드/추론 제한 |
| `qwen3:14b` | ~9 GB | 범용 + 코드 | 균형 잡힌 성능 | 응답 약간 느림 |
| `devstral:24b` | ~16 GB | 코딩 특화 | 코드 품질 우수 | 대용량, 대화 약함 |
| `llama3.3:latest` | ~4.7 GB | 영어 범용 | 빠른 추론 | 한국어 약함 |
| `gemma3:12b` | ~8 GB | 범용 | 멀티모달 지원 | 도구 호출 약함 |

**권장 조합**: `qwen3:14b` (기본) + 외부 LLM (폴백)

---

## 7. 구현 로드맵

### 7.1 즉시 실행 (Phase 1)

- [ ] Ollama 환경변수 설정 (`OLLAMA_API_KEY=ollama-local`)
- [ ] `openclaw onboard` 재실행하여 Ollama 프로바이더 등록
- [ ] `~/.openclaw/openclaw.json`에서 `agents.defaults.model` 수정
  - `primary`: `ollama/qwen3:8b`
  - `fallbacks`: `["openai-codex/gpt-5.4"]`
- [ ] `openclaw models list --all` 로 모델 등록 확인
- [ ] Telegram 채널에서 기본 대화 테스트
- [ ] 폴백 동작 테스트 (Ollama 중지 후 요청 → 외부 전환 확인)

### 7.2 단기 (Phase 1.5)

- [ ] 추가 로컬 모델 설치 (`qwen3:14b` 또는 `devstral:24b`)
- [ ] 에이전트별 모델 분리 설정 (`local-chat`, `power-coder`)
- [ ] 채널별 기본 에이전트 매핑 설정
- [ ] 설정 백업 스크립트 작성 (`configs/` 디렉토리)

### 7.3 중기 (Phase 2) ✅ 구현 완료

- [x] `extensions/smart-router/` 플러그인 프로젝트 초기화
- [x] 복잡도 판별 로직 구현 (`complexity.ts` — 5개 카테고리 17점 만점 스코어링)
- [x] OpenClaw 플러그인 SDK 연동 (`index.ts` — provider + wrapStreamFn 훅)
- [x] 설정 예시 작성 (`configs/openclaw-hybrid.json5`)
- [ ] OpenClaw extensions에 심볼릭 링크 연결
- [ ] 게이트웨이 재시작 후 E2E 테스트
- [ ] Telegram 채널에서 자동 라우팅 검증
- [ ] 라우팅 통계 수집 및 모니터링

### 7.4 장기

- [ ] AI_Assistant(FastAPI) 프로젝트와 연동 (공유 로컬 LLM 풀)
- [ ] 모델 성능 벤치마크 자동화
- [ ] 비용 최적화 대시보드
- [ ] 커스텀 파인튜닝 모델 로컬 배포

---

## 8. 설정 파일 위치 정리

| 파일 | 경로 | 용도 |
|------|------|------|
| OpenClaw 메인 설정 | `~/.openclaw/openclaw.json` | 프로바이더, 에이전트, 채널 설정 |
| 인증 프로필 | `~/.openclaw/auth/profiles/` | API 키, OAuth 토큰 |
| 모델 카탈로그 캐시 | `~/.openclaw/agents/<id>/models.json` | 자동 생성 |
| 작업 방안 문서 | `MyOpenClawRepo/docs/` | 이 문서 및 관련 계획 |
| 설정 백업 | `MyOpenClawRepo/configs/` | 설정 예시 및 백업 |
| 커스텀 플러그인 | `MyOpenClawRepo/extensions/` | smart-router 등 |

---

## 9. 참고 자료

- OpenClaw 프로바이더 설정: `docs/concepts/model-providers.md`
- Ollama 연동 가이드: `docs/providers/ollama.md`
- 모델 폴백 동작: `docs/concepts/model-failover.md`
- 플러그인 SDK: `src/plugin-sdk/plugin-entry.ts`
- 플러그인 아키텍처: `docs/plugins/architecture.md`

---

## 10. 비용 절감 효과 예상

| 시나리오 | 월 예상 요청 | 외부 API 비용 (전량 외부) | 하이브리드 비용 |
|----------|------------|--------------------------|----------------|
| 일상 대화 | ~500회 | ~$5-10 | $0 (로컬) |
| 코드 질문 | ~200회 | ~$10-20 | ~$5-10 (50% 로컬) |
| 복잡한 분석 | ~50회 | ~$5-15 | ~$5-15 (전량 외부) |
| **합계** | **~750회** | **~$20-45** | **~$10-25** |

> 로컬 LLM 처리 비율이 높을수록 비용 절감 효과 증가. 전력 비용(M4 유휴 ~5W, 추론 ~15W)은 무시 가능 수준.
