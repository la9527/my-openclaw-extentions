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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PhotosClassifyConfig {
  photoRankerDir: string;
  photoSourceDir: string;
  defaultSource: "local" | "apple" | "google" | "gcs";
}

const DEFAULTS: PhotosClassifyConfig = {
  photoRankerDir: "./mcp-servers/photo-ranker",
  photoSourceDir: "./mcp-servers/photo-source",
  defaultSource: "apple",
};

function resolveConfig(raw: Record<string, unknown>): PhotosClassifyConfig {
  return {
    photoRankerDir:
      (raw.photoRankerDir as string) || DEFAULTS.photoRankerDir,
    photoSourceDir:
      (raw.photoSourceDir as string) || DEFAULTS.photoSourceDir,
    defaultSource:
      (raw.defaultSource as PhotosClassifyConfig["defaultSource"]) ||
      DEFAULTS.defaultSource,
  };
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

    // /classify [source] [path] — 사진 분류 워크플로우 실행
    api.registerCommand({
      name: "classify",
      description:
        "사진을 분류하고 랭킹합니다. 사용법: /classify [source] [path]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const source = tokens[0] || config.defaultSource;
        const sourcePath = tokens.slice(1).join(" ") || "";

        if (!sourcePath) {
          return {
            text: [
              "📷 **Photos Classify**",
              "",
              "사용법: `/classify <source> <path>`",
              "",
              "소스:",
              "- `apple` — Apple Photos 앨범",
              "- `local` — 로컬 디렉터리",
              "",
              "예시:",
              "- `/classify apple \"여행 사진\"`",
              "- `/classify local /Users/me/Pictures/2026-03`",
              "",
              "MCP 도구를 직접 사용하려면:",
              "- `classify_and_organize` — E2E 워크플로우",
              "- `start_classify_job` — 백그라운드 Job 실행",
              "- `score_quality` — 단일 사진 품질 분석",
              "- `describe_scene` — VLM 장면 묘사",
            ].join("\n"),
          };
        }

        return {
          text: [
            `사진 분류를 시작합니다: source=${source}, path=${sourcePath}`,
            "",
            "classify_and_organize 도구를 호출하여 분류를 진행합니다.",
            `\`classify_and_organize(source="${source}", source_path="${sourcePath}")\``,
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
          return {
            text: [
              "사용법: `/classify-status <job_id>`",
              "",
              "Job ID를 입력하세요.",
              "Job 목록 확인: `list_jobs` 도구를 사용하세요.",
            ].join("\n"),
          };
        }

        return {
          text: [
            `Job ${jobId} 상태를 확인합니다.`,
            `\`get_job_status(job_id="${jobId}")\``,
          ].join("\n"),
        };
      },
    });

    api.logger.info?.(
      `photos-classify: registered with source=${config.defaultSource}`,
    );
  },
});
