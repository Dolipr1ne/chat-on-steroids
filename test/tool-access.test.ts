import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FULL_LOCAL_ACCESS, TOOL_ACCESS_CHANNEL } from '../src/shared/tool-access.js';
import { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig, updateConfig } from '../src/main/config.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), app: new Map<string, Function>(),
  consent: vi.fn(async () => ({ response: 0 })) }));
vi.mock('electron', () => ({
  app: { on: (name: string, fn: Function) => h.app.set(name, fn), removeListener: (name: string) => h.app.delete(name) },
  dialog: { showMessageBox: h.consent },
  ipcMain: { handle: (name: string, fn: Function) => h.handlers.set(name, fn), removeHandler: (name: string) => h.handlers.delete(name) }
}));
const { getToolAccessStatus, registerToolAccessIpc } = await import('../src/main/tool-access.js');
let directory: string, owner: any, target: any, dispose: () => void;
const published = vi.fn(async () => undefined);
const apply = { action: 'apply', preset: FULL_LOCAL_ACCESS };
const invoke = (payload: unknown, sender?: unknown) => h.handlers.get(TOOL_ACCESS_CHANNEL)!(sender ?? { sender: owner, senderFrame: owner.mainFrame }, payload);

beforeEach(async () => {
  vi.clearAllMocks(); h.handlers.clear(); h.app.clear(); h.consent.mockResolvedValue({ response: 0 });
  directory = await makeTempDir('cos-tool-access-'); initConfigPath(directory);
  const config = defaultConfig(); config.readOnly = true; config.capabilities.command = false;
  config.multiAgent.allowUnattributedCalls = false; config.goal.enabled = false;
  await saveConfig({ ...config, roots: [{ name: 'project', path: directory }] });
  owner = Object.assign(new EventEmitter(), { mainFrame: { url: 'file:///app/index.html' }, isDestroyed: () => false });
  target = Object.assign(new EventEmitter(), { webContents: owner, isDestroyed: () => false, isFocused: () => true, isVisible: () => true });
  published.mockResolvedValue(undefined); dispose = registerToolAccessIpc(() => target, published);
});
afterEach(async () => { dispose(); vi.restoreAllMocks(); await removeTempDir(directory); });

it('projects masked and platform-supported permissions without exposing folder paths', () => {
  const windows = getToolAccessStatus(getConfig(), 'win32');
  expect(windows.missing).toContain('command'); expect(windows.approvedRootCount).toBe(1);
  expect(JSON.stringify(windows)).not.toContain(directory);
  const linux = getToolAccessStatus(getConfig(), 'linux');
  expect(linux.unsupported).toEqual(expect.arrayContaining(['clipboardRead', 'clipboardWrite']));
  expect(linux.missing).not.toContain('clipboardRead'); expect(linux.unsupported).not.toContain('control');
});

it('only widens the explicit local flags and publishes after actual persistence', async () => {
  const previous = getConfig(), gate = faultGate(), rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(directory, 'config.json')) await gate.hold();
    return rename(from, to);
  });
  const pending = invoke(apply); await gate.entered;
  expect(getConfig()).toBe(previous); expect(published).not.toHaveBeenCalled();
  gate.release(); const result = await pending; spy.mockRestore();
  expect(result).toMatchObject({ ok: true, data: { applied: true, status: { readOnly: false, missing: [] } } });
  expect(published).toHaveBeenCalledOnce();
  expect(getConfig().roots).toEqual(previous.roots);
  expect(getConfig().multiAgent).toEqual(previous.multiAgent); expect(getConfig().goal).toEqual(previous.goal);
  expect(getConfig().ui).toEqual(previous.ui); expect(getConfig().tunnel).toEqual(previous.tunnel);
  expect((await loadConfig()).readOnly).toBe(false);
});

it('native cancellation changes nothing and defaults to the safe button', async () => {
  const before = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
  h.consent.mockResolvedValueOnce({ response: 1 });
  expect(await invoke(apply)).toMatchObject({ ok: true, data: { applied: false } });
  expect(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).toBe(before);
  expect(published).not.toHaveBeenCalled();
  expect(h.consent.mock.calls[0]).toEqual([target, expect.objectContaining({ defaultId: 1, cancelId: 1 })]);
});

it.each(['frame', 'sender', 'hidden', 'unfocused', 'payload'])('rejects unowned or invalid grants: %s', async kind => {
  const event = { sender: owner, senderFrame: owner.mainFrame };
  if (kind === 'frame') event.senderFrame = {};
  if (kind === 'sender') event.sender = {};
  if (kind === 'hidden') target.isVisible = () => false;
  if (kind === 'unfocused') target.isFocused = () => false;
  expect((await invoke(kind === 'payload' ? { ...apply, allowUnattributed: true } : apply, event)).ok).toBe(false);
  expect(h.consent).not.toHaveBeenCalled(); expect(getConfig().readOnly).toBe(true);
});

it.each(['permissions', 'roots', 'navigate', 'hide', 'quit', 'replace'])('retires an old consent after %s changes', async change => {
  const gate = faultGate(); h.consent.mockImplementationOnce(async () => { await gate.hold(); return { response: 0 }; });
  const pending = invoke(apply); await gate.entered;
  if (change === 'permissions') await updateConfig(config => ({ ...config, capabilities: { ...config.capabilities, read: false } }));
  if (change === 'roots') await updateConfig(config => ({ ...config, roots: [] }));
  if (change === 'navigate') owner.emit('did-start-loading');
  if (change === 'hide') target.emit('hide');
  if (change === 'quit') h.app.get('before-quit')!();
  if (change === 'replace') target = { ...target };
  gate.release(); expect((await pending).ok).toBe(false);
  expect(getConfig().readOnly).toBe(true); expect(published).not.toHaveBeenCalled();
});

it('retains unrelated settings accepted while consent was open', async () => {
  const gate = faultGate(); h.consent.mockImplementationOnce(async () => { await gate.hold(); return { response: 0 }; });
  const pending = invoke(apply); await gate.entered;
  await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } }));
  gate.release(); expect((await pending).ok).toBe(true); expect(getConfig().ui.theme).toBe('light');
});

it('refuses duplicate confirmation instead of dispatching two independent writes', async () => {
  const gate = faultGate(); h.consent.mockImplementationOnce(async () => { await gate.hold(); return { response: 1 }; });
  const pending = invoke(apply); await gate.entered;
  expect((await invoke(apply)).ok).toBe(false); expect(h.consent).toHaveBeenCalledOnce();
  gate.release(); expect(await pending).toMatchObject({ ok: true, data: { applied: false } });
});

it('reports disk failure without publishing a broader grant', async () => {
  const previous = getConfig(); vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic rename failure'));
  expect((await invoke(apply)).ok).toBe(false); expect(getConfig()).toBe(previous); expect(published).not.toHaveBeenCalled();
});

it('distinguishes saved settings from a failed runtime publication', async () => {
  published.mockRejectedValueOnce(new Error('Synthetic runtime failure'));
  const reply = await invoke(apply);
  expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('permissions were saved') });
  expect(getConfig().readOnly).toBe(false);
  expect(getToolAccessStatus().missing).toEqual([]);
});

it('does not hold the configuration queue while publishing runtime availability', async () => {
  published.mockImplementationOnce(async () => { await updateConfig(config => ({ ...config, ui: { ...config.ui, theme: 'light' } })); });
  expect(await invoke(apply)).toMatchObject({ ok: true, data: { applied: true } });
  expect(getConfig().ui.theme).toBe('light');
});
