import type { Capability } from './types.js';

export const TOOL_ACCESS_CHANNEL = 'toolAccess:request';
export const FULL_LOCAL_ACCESS = 'full-local-access';

/** A projection of existing settings, not another persisted permission or connectivity claim. */
export interface ToolAccessStatus {
  readOnly: boolean;
  enabled: Capability[];
  missing: Capability[];
  unsupported: Capability[];
  approvedRootCount: number;
}

export interface ToolAccessResult {
  /** False means the native confirmation was cancelled; it is never a save receipt. */
  applied: boolean;
  status: ToolAccessStatus;
}

export type ToolAccessReply<T> = { ok: true; data: T } | { ok: false; error: string };

/** Fixed preload methods. Neither method accepts a config, folder, chat or arbitrary channel. */
export interface ToolAccessApi {
  toolAccessStatus(): Promise<ToolAccessReply<ToolAccessStatus>>;
  applyToolAccessPreset(preset: typeof FULL_LOCAL_ACCESS): Promise<ToolAccessReply<ToolAccessResult>>;
}

export function hasFullLocalAccess(status: ToolAccessStatus): boolean {
  return !status.readOnly && status.missing.length === 0;
}

export const TOOL_ACCESS_COPY = {
  scope: 'This shared setting applies to all normal chats and project chats in this CoS installation.',
  command: 'Commands run as your logged-in user and are not OS-sandboxed to approved folders. They can access other files and programs available to your account.',
  boundaries: 'ChatGPT approval and operating-system permissions still apply. Approved folders, blocked chats, caller identity and terminal ownership checks remain in force.',
  unchanged: 'This preset leaves unattributed-call access, microphone and media, automatic modes, and third-party plugin permissions unchanged.'
} as const;
