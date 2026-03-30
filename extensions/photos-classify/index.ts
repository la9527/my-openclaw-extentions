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
    const _config = resolveConfig(api.pluginConfig ?? {});

    // MCP 서버는 openclaw.plugin.json의 mcpServers 설정으로 자동 등록된다.
    // 이 엔트리에서는 추가 슬래시 명령이나 훅을 등록할 수 있다.

    api.registerSlashCommand({
      command: "classify",
      description: "사진 폴더를 분류하고 랭킹합니다",
      handler: async (_args, ctx) => {
        await ctx.displayMessage(
          "photo-ranker MCP 도구를 사용하여 사진을 분류합니다.\n" +
            "예: `analyze_photo`, `rank_photos`, `classify_and_organize`",
        );
      },
    });
  },
});
