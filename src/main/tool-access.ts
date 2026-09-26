import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { CAPABILITIES, type Capabilities, type Config } from '../shared/types.js';
import { FULL_LOCAL_ACCESS, TOOL_ACCESS_CHANNEL, TOOL_ACCESS_COPY, type ToolAccessReply,
  type ToolAccessResult, type ToolAccessStatus } from '../shared/tool-access.js';
import { effectiveCapabilities, getConfig, updateConfig } from './config.js';
import { capabilitiesForPlatform } from './platform.js';

const allCapabilities = Object.fromEntries(CAPABILITIES.map(capability => [capability, true])) as Capabilities;
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('apply'), preset: z.literal(FULL_LOCAL_ACCESS) }).strict()
]);

export function getToolAccessStatus(config: Config = getConfig(), platform: NodeJS.Platform = process.platform,
  release?: string): ToolAccessStatus {
  const supported = capabilitiesForPlatform(allCapabilities, platform, release);
  const effective = effectiveCapabilities(config, platform, release);
  return {
    readOnly: config.readOnly,
    enabled: CAPABILITIES.filter(capability => supported[capability] && effective[capability]),
    missing: CAPABILITIES.filter(capability => supported[capability] && !effective[capability]),
    unsupported: CAPABILITIES.filter(capability => !supported[capability]),
    approvedRootCount: config.roots.length
  };
}

/** Raw grants matter even while Read-only masks them; root identity matters beyond its count. */
function permissionBaseline(config: Config): string {
  return JSON.stringify([config.readOnly, CAPABILITIES.map(capability => config.capabilities[capability]),
    config.roots.map(root => [root.name, root.path])]);
}

/** Register once with the existing runtime settings publisher; no second config writer. */
export function registerToolAccessIpc(getWindow: () => BrowserWindow | null,
  afterApply: (next: Config, previous: Config) => void | Promise<void>): () => void {
  let pending = false, disposed = false;
  let retireConsent = (): void => {};
  const quitting = (): void => { disposed = true; retireConsent(); };
  app.on('before-quit', quitting);

  ipcMain.handle(TOOL_ACCESS_CHANNEL, async (event, raw: unknown): Promise<ToolAccessReply<ToolAccessStatus | ToolAccessResult>> => {
    try {
      const target = getWindow();
      if (disposed || !target || target.isDestroyed() || target.webContents.isDestroyed())
        throw new Error('The local tool access window is unavailable.');
      const owner = target.webContents, frame = owner.mainFrame;
      if (event.sender !== owner || event.senderFrame !== frame)
        throw new Error('Local tool access requires the application main window.');
      const request = requestSchema.parse(raw);
      if (request.action === 'status') return { ok: true, data: getToolAccessStatus() };
      if (pending) throw new Error('A local tool access confirmation is already open.');
      if (!target.isVisible() || !target.isFocused()) throw new Error('Focus CoS to change local tool access.');

      const baseline = permissionBaseline(getConfig());
      let retired = false;
      const retire = (): void => { retired = true; };
      const validate = (): void => {
        if (retired || disposed || getWindow() !== target || target.isDestroyed() || owner.isDestroyed() ||
            !target.isVisible() || owner.mainFrame !== frame)
          throw new Error('The window changed during confirmation. Review local tool access again.');
      };
      pending = true; retireConsent = retire;
      owner.on('did-start-loading', retire); owner.on('destroyed', retire); target.on('hide', retire); target.on('closed', retire);
      try {
        // Keep consent outside the config queue so another settings window can revoke access.
        const answer = await dialog.showMessageBox(target, {
          type: 'warning', title: 'Local tool access', message: 'Enable full local access for all chats?',
          detail: [TOOL_ACCESS_COPY.scope,
            'This turns Read-only off and enables supported local file, command, browser, desktop and clipboard permissions.',
            TOOL_ACCESS_COPY.command, TOOL_ACCESS_COPY.boundaries, TOOL_ACCESS_COPY.unchanged].join('\n\n'),
          buttons: ['Enable full local access', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
        });
        if (answer.response !== 0) return { ok: true, data: { applied: false, status: getToolAccessStatus() } };
        validate();
        let accepted: { next: Config; previous: Config } | null = null;
        try {
          await updateConfig(latest => {
            validate();
            if (permissionBaseline(latest) !== baseline)
              throw new Error('Local permissions or approved folders changed during confirmation. Review them and try again.');
            const supported = capabilitiesForPlatform(allCapabilities);
            const capabilities = { ...latest.capabilities };
            for (const capability of CAPABILITIES) if (supported[capability]) capabilities[capability] = true;
            return { ...latest, readOnly: false, capabilities };
          }, (next, previous) => { accepted = { next, previous }; });
          // Runtime refresh may enter another lifecycle/configuration queue. Do
          // not hold the config writer while waiting on that external work.
          const committed = accepted as { next: Config; previous: Config } | null;
          if (committed) await afterApply(committed.next, committed.previous);
        } catch (error) {
          if (accepted) throw new Error(`Local permissions were saved, but updating tool availability failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        return { ok: true, data: { applied: true, status: getToolAccessStatus() } };
      } finally {
        pending = false; retireConsent = () => {};
        owner.removeListener('did-start-loading', retire); owner.removeListener('destroyed', retire);
        target.removeListener('hide', retire); target.removeListener('closed', retire);
      }
    } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? 'Invalid local tool access request.'
        : error instanceof Error ? error.message : 'Local tool access could not be updated.' };
    }
  });
  return () => { quitting(); app.removeListener('before-quit', quitting); ipcMain.removeHandler(TOOL_ACCESS_CHANNEL); };
}
