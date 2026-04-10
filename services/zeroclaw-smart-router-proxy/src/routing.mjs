const COMPLEX_KEYWORDS = [
  "refactor", "리팩토링", "architecture", "아키텍처", "debug", "디버그",
  "optimize", "최적화", "implement", "구현", "algorithm", "알고리즘",
  "security", "보안", "performance", "성능", "migration", "마이그레이션",
  "analyze", "분석", "compare", "비교", "evaluate", "평가",
  "review", "리뷰", "threshold", "임계값", "p95", "error rate",
  "generate", "생성", "build", "step by step", "자세히 설명"
];

const ADVANCED_KEYWORDS = [
  "rollout", "런북", "runbook", "migration strategy", "threat model",
  "failure mode", "capacity planning", "slo", "sla", "alert", "경보",
  "observability", "관측성", "운영 정책", "로드맵", "governance", "compliance"
];

export function extractLastUserText(messages = []) {
  const reversed = [...messages].reverse();
  for (const message of reversed) {
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => typeof item?.text === "string" ? item.text : typeof item === "string" ? item : "")
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export function decideRoute({ model, messages }) {
  const explicit = parseExplicitTier(model);
  if (explicit) {
    return {
      tier: explicit,
      level: explicit === "full" ? "advanced" : explicit === "mini" ? "complex" : explicit === "nano" ? "moderate" : "simple",
      reason: `explicit model alias: ${explicit}`,
      score: 0
    };
  }

  const text = extractLastUserText(messages).trim();
  const lower = text.toLowerCase();
  const lengthScore = scoreLength(text);
  const codeScore = scoreCode(text);
  const keywordScore = scoreKeywords(lower);
  const advancedSignals = ADVANCED_KEYWORDS.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
  const total = lengthScore + codeScore + keywordScore + Math.min(advancedSignals, 3);

  if (advancedSignals >= 2 || total >= 10) {
    return { tier: "full", level: "advanced", reason: "advanced signals detected", score: total };
  }
  if (total >= 6) {
    return { tier: "mini", level: "complex", reason: "complex request", score: total };
  }
  if (shouldUseNano(lower, text)) {
    return { tier: "nano", level: "moderate", reason: "short compare/summary request", score: total };
  }
  return { tier: "local", level: "simple", reason: "default local route", score: total };
}

function parseExplicitTier(model) {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (["local", "nano", "mini", "full"].includes(normalized)) {
    return normalized;
  }
  return normalized === "auto" || normalized === "" ? null : null;
}

function scoreLength(text) {
  const length = text.length;
  if (length < 80) return 0;
  if (length < 220) return 1;
  if (length < 600) return 2;
  if (length < 1500) return 3;
  return 4;
}

function scoreCode(text) {
  let score = 0;
  if ((text.match(/```/g) ?? []).length >= 2) score += 2;
  if (/\b(function|class|import|export|const|let|var|def|async|await|return|interface|type|struct|enum)\b/i.test(text)) {
    score += 2;
  }
  return Math.min(score, 4);
}

function scoreKeywords(lower) {
  let score = 0;
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) score += 1;
  }
  return Math.min(score, 4);
}

function shouldUseNano(lower, text) {
  return text.length <= 220 && /(요약|summary|비교|compare|차이|difference|짧게|간단히|한 줄|한문장|brief)/i.test(lower);
}