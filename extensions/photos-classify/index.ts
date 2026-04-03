/**
 * Photos Classify – OpenClaw 플러그인 엔트리
 *
 * photo-ranker / photo-source MCP 서버를 OpenClaw에 연결하여
 * 사진 분류, 랭킹, 앨범 정리 기능을 제공한다.
 *
 * MCP 서버:
 *   - photo-ranker: 품질 분석, VLM 장면 묘사, 이벤트 분류, 얼굴 인식, 중복 감지, 랭킹
 *   - photo-source: Apple Photos, Google Photos, GCS, 로컬 폴더 소스 접근
 */

import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  PHOTOS_CLASSIFY_ROUTE_BASE,
  createPhotosReviewHttpHandler,
  fetchRecentReviewJobs,
  fetchReviewJobSummary,
  type ReviewJobSummary,
} from "./src/review-http.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PhotosClassifyConfig {
  photoRankerDir: string;
  photoSourceDir: string;
  reviewAppUrl: string;
  reviewAppAutoStart: boolean;
  reviewAccessToken: string;
  reviewAllowTailscale: boolean;
  reviewTailscaleUserLogins: string[];
  defaultSource: "local" | "apple" | "google" | "gcs";
}

const DEFAULTS: PhotosClassifyConfig = {
  photoRankerDir: "./mcp-servers/photo-ranker",
  photoSourceDir: "./mcp-servers/photo-source",
  reviewAppUrl: "http://127.0.0.1:8765",
  reviewAppAutoStart: true,
  reviewAccessToken: "",
  reviewAllowTailscale: false,
  reviewTailscaleUserLogins: [],
  defaultSource: "apple",
};

function parseTailscaleUserLogins(rawValue: unknown): string[] {
  if (typeof rawValue === "string") {
    return rawValue
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(rawValue)) {
    return rawValue
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function resolveConfig(raw: Record<string, unknown>): PhotosClassifyConfig {
  return {
    photoRankerDir:
      (raw.photoRankerDir as string) || DEFAULTS.photoRankerDir,
    photoSourceDir:
      (raw.photoSourceDir as string) || DEFAULTS.photoSourceDir,
    reviewAppUrl: (raw.reviewAppUrl as string) || DEFAULTS.reviewAppUrl,
    reviewAppAutoStart:
      typeof raw.reviewAppAutoStart === "boolean"
        ? raw.reviewAppAutoStart
        : DEFAULTS.reviewAppAutoStart,
    reviewAccessToken:
      (raw.reviewAccessToken as string) || DEFAULTS.reviewAccessToken,
    reviewAllowTailscale:
      typeof raw.reviewAllowTailscale === "boolean"
        ? raw.reviewAllowTailscale
        : DEFAULTS.reviewAllowTailscale,
    reviewTailscaleUserLogins: parseTailscaleUserLogins(raw.reviewTailscaleUserLogins),
    defaultSource:
      (raw.defaultSource as PhotosClassifyConfig["defaultSource"]) ||
      DEFAULTS.defaultSource,
  };
}

function normalizeSelectionProfile(rawValue: string): "general" | "person" | "landscape" {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "person" || normalized === "landscape") {
    return normalized;
  }
  return "general";
}

function extractSelectionProfile(args: string): {
  cleanedArgs: string;
  selectionProfile: "general" | "person" | "landscape";
} {
  const match = args.match(/(?:^|\s)--profile\s+(general|person|landscape)(?=\s|$)/i);
  if (!match) {
    return {
      cleanedArgs: args.trim(),
      selectionProfile: "general",
    };
  }

  return {
    cleanedArgs: args.replace(match[0], " ").replace(/\s+/g, " ").trim(),
    selectionProfile: normalizeSelectionProfile(match[1] ?? "general"),
  };
}

function formatStage(stage: string): string {
  if (stage === "filter") {
    return "1단계 필터";
  }
  if (stage === "vlm") {
    return "2단계 VLM";
  }
  if (!stage) {
    return "대기 중";
  }
  return stage;
}

function formatJobSummary(job: ReviewJobSummary): string {
  const requestOptions = job.request_options ?? {};
  const selectionProfile = String(requestOptions.selection_profile ?? "general");
  const progress = job.progress;
  const resultSummary = job.result_summary ?? {};
  const lines = [
    `- ${job.job_id} · ${job.status} · ${progress.percent}% (${progress.completed}/${progress.total})`,
    `  profile=${selectionProfile} · stage=${formatStage(progress.stage)} · source=${job.source}`,
  ];

  if (job.source_path) {
    lines.push(`  path=${job.source_path}`);
  }
  if (progress.current_file) {
    lines.push(`  current=${progress.current_file}`);
  }
  if (typeof resultSummary.ranked_count === "number") {
    lines.push(`  ranked=${resultSummary.ranked_count} · selected=${job.selected_count}`);
  } else if (job.photo_count > 0) {
    lines.push(`  photos=${job.photo_count} · selected=${job.selected_count}`);
  }
  if (job.error_message) {
    lines.push(`  error=${job.error_message}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "photos-classify",
  name: "Photos Classify",
  description:
    "MCP 기반 사진 분류/랭킹/앨범 정리 (photo-ranker + photo-source)",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});

    // MCP 서버는 openclaw.plugin.json의 mcpServers 설정으로 자동 등록된다.
    api.registerHttpRoute({
      path: PHOTOS_CLASSIFY_ROUTE_BASE,
      auth: "plugin",
      match: "prefix",
      handler: createPhotosReviewHttpHandler({
        reviewBaseUrl: config.reviewAppUrl,
        reviewAppAutoStart: {
          enabled: config.reviewAppAutoStart,
          cwd: config.photoRankerDir,
        },
        reviewAccessToken: config.reviewAccessToken,
        reviewTailscaleAccess: {
          enabled: config.reviewAllowTailscale,
          allowedUserLogins: config.reviewTailscaleUserLogins,
        },
        logger: api.logger,
      }) as (req: unknown, res: unknown) => Promise<boolean>,
    });

    // /classify [source] [path] — 사진 분류 워크플로우 실행
    api.registerCommand({
      name: "classify",
      description:
        "사진을 분류하고 랭킹합니다. 사용법: /classify [source] [path]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const parsedArgs = extractSelectionProfile(ctx.args?.trim() ?? "");
        const tokens = parsedArgs.cleanedArgs.split(/\s+/).filter(Boolean);
        const source = tokens[0] || config.defaultSource;
        const sourcePath = tokens.slice(1).join(" ") || "";
        const selectionProfile = parsedArgs.selectionProfile;

        if (!sourcePath) {
          return {
            text: [
              "📷 **Photos Classify**",
              "",
              "사용법: `/classify <source> <path> [--profile general|person|landscape]`",
              "",
              "소스:",
              "- `apple` — Apple Photos 앨범",
              "- `local` — 로컬 디렉터리",
              "",
              "선택 프로필:",
              "- `general` — 기본 균형형",
              "- `person` — 인물/가족 중심",
              "- `landscape` — 풍경/배경 중심",
              "",
              "예시:",
              "- `/classify apple \"여행 사진\" --profile landscape`",
              "- `/classify local /Users/me/Pictures/2026-03 --profile person`",
              "",
              "MCP 도구를 직접 사용하려면:",
              "- `classify_and_organize` — E2E 워크플로우",
              "- `curate_best_photos` — 최신 N장 기준 상위 quality 퍼센트 선별 + review/album 반영",
              "- `start_classify_job` — 백그라운드 Job 실행",
              "- `score_quality` — 단일 사진 품질 분석",
              "- `describe_scene` — VLM 장면 묘사",
            ].join("\n"),
          };
        }

        return {
          text: [
            `사진 분류를 시작합니다: source=${source}, path=${sourcePath}, profile=${selectionProfile}`,
            "",
            "classify_and_organize 도구를 호출하여 분류를 진행합니다.",
            `\`classify_and_organize(source="${source}", source_path="${sourcePath}", selection_profile="${selectionProfile}")\``,
          ].join("\n"),
        };
      },
    });

    // /classify-status [job_id] — Job 상태 조회
    api.registerCommand({
      name: "classify-status",
      description: "분류 Job 상태를 조회합니다. 사용법: /classify-status [job_id]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const jobId = ctx.args?.trim() ?? "";

        if (!jobId) {
          const jobs = await fetchRecentReviewJobs({
            reviewBaseUrl: config.reviewAppUrl,
            limit: 5,
            autoStart: {
              enabled: config.reviewAppAutoStart,
              cwd: config.photoRankerDir,
            },
            logger: api.logger,
          });

          return {
            text: [
              "사용법: `/classify-status <job_id>`",
              "",
              jobs.length > 0 ? "최근 job 상태:" : "최근 job 상태를 불러오지 못했습니다.",
              ...(jobs.length > 0 ? jobs.map((job) => formatJobSummary(job)) : ["review app 연결 실패 또는 최근 job 없음"]),
              "",
              `최근 job 포털: ${PHOTOS_CLASSIFY_ROUTE_BASE}/`,
              "세부 상태는 `/classify-status <job_id>` 로 확인하세요.",
            ].join("\n"),
          };
        }

        const summary = await fetchReviewJobSummary({
          reviewBaseUrl: config.reviewAppUrl,
          jobId,
          autoStart: {
            enabled: config.reviewAppAutoStart,
            cwd: config.photoRankerDir,
          },
          logger: api.logger,
        });

        if (summary) {
          return {
            text: [
              "📷 **Photos Classify Status**",
              "",
              formatJobSummary(summary),
              "",
              `Review route: ${PHOTOS_CLASSIFY_ROUTE_BASE}/review/${jobId}`,
              `Portal: ${PHOTOS_CLASSIFY_ROUTE_BASE}/`,
            ].join("\n"),
          };
        }

        return {
          text: [
            `Job ${jobId} 상태를 직접 조회합니다.`,
            `\`get_job_status(job_id="${jobId}")\``,
            `Review route: ${PHOTOS_CLASSIFY_ROUTE_BASE}/review/${jobId}`,
            `Portal: ${PHOTOS_CLASSIFY_ROUTE_BASE}/`,
          ].join("\n"),
        };
      },
    });

    api.registerCommand({
      name: "classify-review",
      description:
        "분류 결과 검토 흐름을 안내합니다. 사용법: /classify-review [job_id]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const jobId = ctx.args?.trim() ?? "";

        if (!jobId) {
          return {
            text: [
              "사용법: `/classify-review [job_id]`",
              "",
              `포털: ${PHOTOS_CLASSIFY_ROUTE_BASE}/`,
              "job_id 없이 열면 최근 job 목록과 review 진입 링크를 볼 수 있습니다.",
              "검토 단계에서 사용할 도구:",
              "- `get_review_items` — preview/선택/태그 포함 결과 조회",
              "- `set_photo_review` — selected/tags/note 저장",
              "- `list_photo_faces` — 얼굴 crop/bbox 조회",
              "- `label_face_in_job` — 얼굴 이름 지정 + known face 등록",
              "- `export_selected_photos` — selected=true 사진만 내보내기",
              "- `organize_results_to_directory` — 로컬 결과 디렉터리 정리",
              `- review route 접근 시 review app auto-start=${config.reviewAppAutoStart ? "on" : "off"}`,
              `- tailscale access=${config.reviewAllowTailscale ? "on" : "off"}`,
              "- auto-start 실패 시 `photoRankerDir` 설정과 uv 환경을 확인",
            ].join("\n"),
          };
        }

        return {
          text: [
            `Job ${jobId} 검토 도구를 안내합니다.`,
            `포털: ${PHOTOS_CLASSIFY_ROUTE_BASE}/`,
            `리뷰 UI(OpenClaw route): ${PHOTOS_CLASSIFY_ROUTE_BASE}/review/${jobId}`,
            `로컬 review app: ${config.reviewAppUrl}/review/${jobId}`,
            `auto-start: ${config.reviewAppAutoStart ? "enabled" : "disabled"}`,
            `tailscale access: ${config.reviewAllowTailscale ? "enabled" : "disabled"}`,
            `\`get_review_items(job_id="${jobId}")\``,
            `\`list_photo_faces(job_id="${jobId}", photo_id="...")\``,
            `\`set_photo_review(job_id="${jobId}", photo_id="...", tags_json='["selected"]', selected=true)\``,
            `\`label_face_in_job(job_id="${jobId}", photo_id="...", face_idx=0, name="홍길동")\``,
            `\`export_selected_photos(job_id="${jobId}", output_dir="...")\``,
          ].join("\n"),
        };
      },
    });

    api.logger.info?.(
      `photos-classify: registered with source=${config.defaultSource}, reviewRoute=${PHOTOS_CLASSIFY_ROUTE_BASE}, autoStart=${config.reviewAppAutoStart ? "on" : "off"}, remoteAccess=${config.reviewAccessToken ? "token" : config.reviewAllowTailscale ? "tailscale" : "loopback"}`,
    );
  },
});
