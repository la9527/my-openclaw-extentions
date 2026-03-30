# Photo-Ranker 벤치마크 분석 보고서

**실행일:** 2026-06-28 | **이미지:** 10장 (Unsplash 다운로드) | **총 소요:** 83.5초

## 1. 실행 결과 요약

| Stage | 항목 | 소요시간 | 평균/장 | 비고 |
|-------|------|---------|---------|------|
| 1 | 품질 평가 (CLIP + Laplacian) | 5.3s | 532ms | 첫 이미지 3,493ms (모델 로드) |
| 1 | 얼굴 감지 | 0.0s | 0ms | face-recognition 미설치 |
| 1 | 중복 감지 (pHash) | 0.0s | 1ms | 매우 빠름 |
| 2 | VLM 추론 (Qwen2.5-VL-7B-4bit) | 71.5s | 7.2s | 워밍업 6.6s 별도 |
| **합계** | | **83.5s** | **8.4s** | |

## 2. 각 엔진별 상세 분석

### 2.1 AestheticEngine (품질 평가) — ⚠️ 심각한 문제

| 이미지 | Aesthetic (0-50) | Technical (0-50) | Total (0-100) |
|--------|-----------------|-----------------|----------------|
| blurry_night.jpg | **0.02** | 42.09 | 42.11 |
| daily_coffee.jpg | **0.01** | 46.46 | 46.47 |
| daily_workspace.jpg | **0.05** | 49.08 | 49.13 |
| family_park.jpg | **0.01** | 48.10 | 48.11 |
| food_cake.jpg | **0.00** | 48.32 | 48.32 |
| food_dinner.jpg | **0.02** | 46.15 | 46.17 |
| group_friends.jpg | **0.01** | 46.79 | 46.80 |
| landscape_mountain.jpg | **0.00** | 47.69 | 47.69 |
| portrait_woman.jpg | **0.05** | 46.71 | 46.76 |
| travel_beach.jpg | **0.01** | 49.79 | 49.80 |

**문제점:**
- **Aesthetic score가 모두 ≈0.0** — 10점 만점에서 0.00~0.01 범위
  - 원인: `AestheticEngine._model`이 `nn.Sequential(Linear, ReLU, Dropout, Linear)`로 **랜덤 초기화** 상태
  - 코드 주석: `# In production, load pretrained weights from LAION`
  - LAION 사전훈련 가중치를 로드하지 않아 사실상 랜덤 예측
- **Technical score 범위가 좁음** (42~50/50) — Laplacian blur + histogram exposure 분석
  - blurry_night만 42.1로 약간 낮은 것은 정상이지만 변별력 부족
  - 모든 이미지가 동일한 해상감 (Unsplash 이미지 특성)으로 분산이 작음

**타이밍:** 첫 호출 3.5s (CLIP ViT-L-14 로드), 이후 ~200ms/장 → 양호

### 2.2 FaceEngine (얼굴 감지) — ❌ 미작동

- face-recognition (dlib) 미설치로 모든 이미지에서 faces=0 반환
- Python 3.14 + macOS clang C23 호환 문제로 dlib 20.0.0 빌드 불가
- family_score 계산이 전면 0 → ranking 왜곡

### 2.3 DedupEngine (중복 감지) — ✅ 정상

- 1~2ms/장, 매우 빠름
- 10장 모두 서로 다른 이미지이므로 중복 그룹 0 → 정상
- average_hash 결과 모두 상이 확인

### 2.4 VLMEngine (장면 묘사 + 이벤트 분류) — ⚠️ 개선 필요

| 이미지 | Expected | Got | Match | Conf | 장면 묘사 |
|--------|----------|-----|-------|------|-----------|
| blurry_night | daily | outdoor | ✗ | 0.80 | 야간 도시 거리 조명 |
| daily_coffee | daily | celebration | ✗ | 0.80 | 세 명이 커피를 들고 있음 |
| daily_workspace | daily | daily | ✓ | 0.80 | 현대적 실내 환경 |
| family_park | outdoor | celebration | ✗ | 0.80 | 해변 일몰 + 가족 모임 |
| food_cake | meal | celebration | ✗ | 0.80 | 초콜릿 디저트 케이크 |
| food_dinner | meal | meal | ✓ | 0.80 | 식당에서 식사 장면 |
| group_friends | celebration | travel | ✗ | 0.80 | 해변가에서 친구들 모임 |
| landscape_mountain | outdoor | outdoor | ✓ | 1.00 | 산과 숲 자연 풍경 |
| portrait_woman | portrait | celebration | ✗ | 0.80 | 외부 화려한 분위기 초상화 |
| travel_beach | travel | outdoor | ✗ | 0.90 | 해변 일몰 풍경 |

**정확도:** 3/10 (30%)

**문제 패턴:**
1. **`celebration` 과편향:** 4/10 이미지를 celebration으로 분류 (portrait, cake, coffee, family)
   - 사람이 있거나 화려한 분위기면 celebration으로 기울어짐
2. **`outdoor` 과사용:** 블러리 야경, 해변까지 outdoor로
   - travel과 outdoor 구분이 안 됨
3. **confidence가 거의 고정:** 0.80이 8/10, 0.90이 1개, 1.00이 1개
   - 모델이 실제 불확실성을 반영하지 못함
4. **portrait 미분류:** 인물 사진을 celebration으로

**장면 묘사 품질:** 한글 묘사 자체는 비교적 정확 (커피 들고 있는 사람들, 산과 숲 등)

**Expected labels에 대한 참고:** Unsplash 이미지의 실제 내용과 기대값이 일부 불일치:
- family_park → 실제로 해변 일몰 + 다수 인원 → celebration이 더 적절할 수 있음
- daily_coffee → 3인 커피 → daily보다 social 느낌

**타이밍:** 5.0~10.7s/장 (평균 7.2s), 워밍업 6.6s

### 2.5 Ranking (종합 랭킹) — ⚠️ 변별력 부족

| 순위 | 이미지 | Total | Quality | Family | Event | Uniqueness |
|------|--------|-------|---------|--------|-------|------------|
| 1 | family_park.jpg | 67.0 | 48.1 | 50.0 | 80.0 | 100.0 |
| 2 | landscape_mountain.jpg | 56.9 | 47.7 | 0.0 | 100.0 | 100.0 |
| 3 | travel_beach.jpg | 55.0 | 49.8 | 0.0 | 90.0 | 100.0 |
| 10 | blurry_night.jpg | 50.5 | 42.1 | 0.0 | 80.0 | 100.0 |

**문제:**
- family_park만 family_score가 50 (VLM is_family=True), 나머지 모두 0
- Quality score 범위: 42~50 → 변별력 매우 부족 (aesthetic ≈ 0 때문)
- Event score: 대부분 80 → confidence 고정 문제 반영
- 1위 (67.0) vs 10위 (50.5) 차이가 16.5점밖에 안 됨

## 3. 핵심 문제점 우선순위

| # | 문제 | 심각도 | 원인 | 영향 |
|---|------|--------|------|------|
| 1 | Aesthetic score ≈ 0 | 🔴 심각 | LAION 가중치 미로드 (랜덤 초기화) | Quality score 50% 무효화 |
| 2 | 이벤트 분류 30% 정확도 | 🔴 심각 | 프롬프트 불충분, celebration 편향 | Ranking 왜곡 |
| 3 | Confidence 고정 (0.80) | 🟡 중간 | VLM이 불확실성 미반영 | Event score 변별력 부재 |
| 4 | 얼굴 감지 미작동 | 🟡 중간 | dlib/Python 3.14 비호환 | Family score 전면 0 |
| 5 | VLM 7.2s/장 (목표 5s) | 🟡 중간 | max_tokens=512, 이미지 미리사이즈 | 처리량 미달 |
| 6 | Technical score 좁은 범위 | 🟢 경미 | Unsplash 이미지 고품질 편향 | 실 사진에선 문제 적을 가능성 |

## 4. 개선 방안

### P0 — 즉시 수정 필요

#### 4.1 LAION Aesthetic Predictor 가중치 적용
```
현재: nn.Sequential(Linear(768,256), ReLU, Dropout, Linear(256,1)) 랜덤 초기화
개선: LAION aesthetic-predictor-v2-5 사전훈련 가중치 다운로드 + 로드
```
- `improved-aesthetic-predictor` 프로젝트에서 `sac+logos+ava1-l14-linearMSE.pth` 다운로드
- `_ensure_loaded()`에서 `state_dict`로 로드
- 기대 효과: aesthetic score가 정상 분포 (2~8 범위)로 변환 → quality score 변별력 대폭 향상

#### 4.2 이벤트 분류 프롬프트 개선
```
현재: event_type 종류만 나열
개선: 각 type의 명확한 판단 기준 추가 + few-shot 예시
```
- `portrait`: 1인 인물이 주제, 배경보다 인물 비중이 큼
- `meal`: 음식이 주요 피사체, 식탁/접시 보임
- `daily`: 특별한 이벤트 없음, 일상적 공간/활동
- `travel`: 관광지, 랜드마크, 여행 맥락 단서
- `celebration` → birthday와 celebration 분리 기준 명확화
- confidence 0.80 고정 방지: "event_confidence는 해당 분류에 대한 확신도를 0.0~1.0으로 정밀하게 조절하세요" 추가

#### 4.3 Face Detection 대체 엔진
```
현재: face-recognition (dlib 의존) → Python 3.14 빌드 불가
대안 1: mediapipe (Google, pip install mediapipe)
대안 2: insightface + onnxruntime (ONNX 기반)
대안 3: ultralytics YOLO-Face
```
- mediapipe가 가장 경량이고 Python 3.14 호환 가능성 높음
- fallback 체인: mediapipe → insightface → face-recognition

### P1 — 성능 최적화

#### 4.4 VLM 추론 속도 개선
- `max_tokens` 512→256 (JSON 응답은 150~200 토큰이면 충분)
- 이미지 전처리: 입력 전 최대 1024px로 리사이즈
- 기대: 7.2s → 4~5s/장

#### 4.5 CLIP 모델 초기 로드 최적화
- 첫 호출 3.5s → MCP 서버 시작 시 pre-load 옵션
- lazy load를 default로 유지하되 `--preload` 플래그 추가

### P2 — 정밀도 향상

#### 4.6 Confidence 보정 (calibration)
- VLM 출력 confidence를 그대로 사용하지 않고, 후처리 보정
- 방안: temperature scaling 또는 프롬프트에 "0.5 이하도 적극 사용" 명시

#### 4.7 Technical Quality 개선
- 현재 Laplacian + histogram만 사용 (blur + exposure)
- 추가 지표: 노이즈 수준 (고ISO 감지), 해상도 점수, 구도 분석
- 실 사진 적용 시 저해상도/고ISO 이미지에서 더 높은 변별력 예상

#### 4.8 Ranking 가중치 튜닝
- 현재: Quality 25%, Family 30%, Event 25%, Uniqueness 20%
- face detection 미작동 상태에서는 Family 30%가 사실상 낭비
- 동적 가중치: 사용 가능한 엔진에 따라 자동 재배분

## 5. 요약

| 지표 | 현재 값 | 목표 값 | 상태 |
|------|---------|---------|------|
| Stage 1 평균 | 533ms/장 (로드 후 ~200ms) | <500ms | ✅ (로드 후) |
| Stage 2 VLM 평균 | 7.2s/장 | <5s | ⚠️ 개선 필요 |
| Aesthetic score 유효성 | 0 (무효) | 2~8 범위 정상 분포 | 🔴 P0 |
| 이벤트 분류 정확도 | 30% | >60% | 🔴 P0 |
| 얼굴 감지 | 미작동 | 작동 | 🟡 P0 |
| Confidence 변별력 | 고정 0.80 | 0.3~0.95 분산 | 🟡 P1 |
| Ranking 변별력 | 16.5점 범위 | >30점 범위 | ⚠️ 상위 수정 후 자동 개선 |
