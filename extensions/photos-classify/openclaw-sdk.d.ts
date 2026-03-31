/**
 * Minimal type declarations for openclaw/plugin-sdk used by this plugin.
 *
 * At runtime OpenClaw resolves these imports via jiti alias.
 * This file provides development-time type checking when openclaw
 * is not installed as a dependency.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
  }

  export type PluginCommandResult = { text: string } | { error: string };

  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (
      ctx: PluginCommandContext,
    ) => PluginCommandResult | Promise<PluginCommandResult>;
  }

  export interface PluginLogger {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  }

  export interface OpenClawPluginApi {
    pluginConfig?: Record<string, unknown>;
    registerCommand: (command: OpenClawPluginCommandDefinition) => void;
    logger: PluginLogger;
  }

  export interface OpenClawPluginDefinition {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  export function definePluginEntry(
    def: OpenClawPluginDefinition,
  ): OpenClawPluginDefinition;
}
