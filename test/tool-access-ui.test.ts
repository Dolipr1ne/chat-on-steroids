import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FULL_LOCAL_ACCESS, type ToolAccessApi, type ToolAccessStatus } from '../src/shared/tool-access.js';
let dom: JSDOM, controller: ReturnType<typeof import('../src/renderer/tool-access.js')['initToolAccess']>;
let api: ToolAccessApi;
const status = (): ToolAccessStatus => ({ readOnly: true, enabled: ['read'], missing: ['command'], unsupported: [], approvedRootCount: 1 });
const applied = vi.fn(async () => undefined);
const button = () => dom.window.document.querySelector<HTMLButtonElement>('#access')!;
const action = (name: string) => dom.window.document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
beforeEach(async () => {
  dom = new JSDOM('<button id="access">Access</button><textarea>Original draft</textarea>', { url: 'https://fixture.invalid' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.defineProperties(dom.window.HTMLDialogElement.prototype, {
    showModal: { value: function(this: HTMLDialogElement) { this.open = true; } },
    close: { value: function(this: HTMLDialogElement) { this.open = false; queueMicrotask(() => this.dispatchEvent(new dom.window.Event('close'))); } }
  });
  applied.mockReset(); applied.mockResolvedValue(undefined);
  api = { toolAccessStatus: vi.fn(async () => ({ ok: true as const, data: status() })),
    applyToolAccessPreset: vi.fn(async () => ({ ok: true as const, data: { applied: true, status: { ...status(), readOnly: false, missing: [] } } })) };
  controller = (await import('../src/renderer/tool-access.js')).initToolAccess({ button: button(), api, onApplied: applied });
});
afterEach(() => { controller.dispose(); dom.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('opening the shared normal/project panel never changes permissions', async () => {
  await controller.open(); expect(api.toolAccessStatus).toHaveBeenCalledOnce(); expect(api.applyToolAccessPreset).not.toHaveBeenCalled();
  expect(dom.window.document.body.textContent).toContain('all normal chats and project chats');
  expect(dom.window.document.body.textContent).toContain('operating-system permissions still apply');
  expect(dom.window.document.querySelector('textarea')!.value).toBe('Original draft');
});
it.each([true, false])('only acknowledges a real application receipt (%s)', async accepted => {
  vi.mocked(api.applyToolAccessPreset).mockResolvedValueOnce({ ok: true, data: { applied: accepted, status: status() } });
  await controller.open(); action('apply').click();
  await vi.waitFor(() => expect(dom.window.document.querySelector('.tool-access-status')!.textContent).toContain(accepted ? 'saved' : 'cancelled'));
  expect(api.applyToolAccessPreset).toHaveBeenCalledExactlyOnceWith(FULL_LOCAL_ACCESS);
  expect(applied).toHaveBeenCalledTimes(accepted ? 1 : 0);
});
it('retains explicit errors instead of reporting a successful grant', async () => {
  vi.mocked(api.applyToolAccessPreset).mockResolvedValueOnce({ ok: false, error: 'Synthetic permission error' });
  await controller.open(); action('apply').click();
  await vi.waitFor(() => expect(dom.window.document.querySelector('.tool-access-status')!.textContent).toBe('Synthetic permission error'));
  expect(applied).not.toHaveBeenCalled();
});
it('does not replace a newer status with a late response to a closed panel', async () => {
  let finish!: (value: any) => void;
  vi.mocked(api.toolAccessStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const opening = controller.open(); controller.close(); await controller.open();
  finish({ ok: true, data: { ...status(), readOnly: false, missing: [] } }); await opening;
  expect(dom.window.document.querySelector('.tool-access-summary')!.textContent).toBe('Read-only');
});
it('keeps the folder warning even when all local flags are enabled', async () => {
  vi.mocked(api.toolAccessStatus).mockResolvedValueOnce({ ok: true, data: { ...status(), readOnly: false, missing: [], approvedRootCount: 0 } });
  await controller.open(); expect(action('apply').disabled).toBe(true);
  expect(dom.window.document.body.textContent).toContain('No folders are approved');
});
it('disposes the one dialog and restores focus on an ordinary close', async () => {
  await controller.open(); controller.close(); await Promise.resolve(); expect(dom.window.document.activeElement).toBe(button());
  controller.dispose(); expect(dom.window.document.querySelector('dialog')).toBeNull();
});

it('returns to the chat entry point rather than a hidden settings trigger', async () => {
  const entry = dom.window.document.createElement('button'); entry.textContent = 'Chat options';
  dom.window.document.body.append(entry);
  await controller.open(entry); controller.close(); await Promise.resolve();
  expect(dom.window.document.activeElement).toBe(entry);
});
