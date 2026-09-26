import { beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
const ports = vi.hoisted(() => ({ backgroundChats: false, running: false as boolean | null, probe: vi.fn(), connect: vi.fn(), status: { state: 'connected', detail: '' },
  browser: { connected: false, present: false, lastSeenAt: null as number | null }, open: vi.fn(), bridge: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), note: vi.fn(), rows: [] as InputEntry[], listeners: new Set<() => void>() }));
vi.mock('../src/main/connection.js', () => ({ connect: ports.connect, getStatus: () => ports.status, onStatusChange: (fn: () => void) => { ports.listeners.add(fn); return () => ports.listeners.delete(fn); } }));
vi.mock('../src/main/bridge.js', () => ({ bridgeStatus: async () => ports.browser, browserPresent: () => ports.browser.present, browserWakeConnected: () => ports.browser.connected, startBridge: ports.bridge }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: ports.open, isPreferredBrowserRunning: ports.probe }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { backgroundChats: ports.backgroundChats } }) }));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: ports.enqueue, cancelInput: ports.cancel, noteInputStartupError: ports.note, listInputs: async () => ports.rows }));
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser, resetInputStartupForTests, stopInputStartup } from '../src/main/session/start-input.js';
const request: InputArgs = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'Please start', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null };
beforeEach(() => {
  vi.resetAllMocks(); resetInputStartupForTests();
  ports.rows = []; ports.listeners.clear(); ports.backgroundChats = false; ports.running = false;
  ports.status = { state: 'connected', detail: '' }; ports.browser = { connected: false, present: false, lastSeenAt: null };
  ports.bridge.mockResolvedValue(8765); ports.open.mockResolvedValue('chrome.exe');
  ports.probe.mockImplementation(async () => ports.running);
  ports.enqueue.mockImplementation(async (input: InputArgs): Promise<InputEntry> => {
    const row: InputEntry = { ...input, ...(input.delivery === 'tool' ? { transportIntent: 'tool' as const } : {}),
      state: 'queued', owner: null, createdAt: 1, conversationId: input.sessionId ? 'exact-conversation' : null };
    ports.rows.push(row); return row;
  });
  ports.cancel.mockImplementation(async id => { const row = ports.rows.find(entry => entry.id === id); if (!row) return false; row.state = 'cancelled'; return true; });
  ports.note.mockImplementation(async (id, error) => { const row = ports.rows.find(entry => entry.id === id); if (row) row.error = error ?? undefined; return row; });
});
it('accepts input before readiness, but waits for the connector before opening the browser', async () => {
  ports.status = { state: 'connecting-tunnel', detail: 'Starting tunnel' };
  const pending = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.open).not.toHaveBeenCalled();
  ports.status = { state: 'connected', detail: '' };
  for (const listener of ports.listeners) listener();
  await pending;
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.listeners.size).toBe(0);
});
it('leaves explicit tool delivery on the durable queue without browser startup', async () => {
  const row = await sendDesktopInput({ ...request, sessionId: 'session-existing', delivery: 'tool' });
  expect(row).toMatchObject({ state: 'queued', delivery: 'tool', transportIntent: 'tool' });
  await Promise.resolve();
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.open).not.toHaveBeenCalled();
});
it('retries only the failed browser wake for the same queued UUID', async () => {
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Browser startup failed'));
  await Promise.all([retryQueuedInputBrowser(request.id), retryQueuedInputBrowser(request.id)]);
  expect(ports.open).toHaveBeenCalledTimes(2);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
  expect(ports.rows[0]).toMatchObject({ id: request.id, state: 'queued', error: undefined });
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
  ports.rows[0]!.state = 'browser'; ports.rows[0]!.error = 'Message queued. Browser startup failed: old';
  expect(await retryQueuedInputBrowser(request.id)).toBeNull();
});
it('publishes before connection startup and opens exactly one marked bootstrap while Chrome starts', async () => {
  let release!: () => void;
  ports.open.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('chrome.exe'); }));
  const first = sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(1));
  const second = sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalledTimes(2));
  expect(ports.open).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
  const url = new URL(ports.open.mock.calls[0]![0]);
  expect(url.searchParams.get('cos-input')).toBe(request.id);
  expect(ports.enqueue.mock.invocationCallOrder[0]).toBeLessThan(ports.connect.mock.invocationCallOrder[0]!);
});
it('preserves setup failures on the accepted queue without opening a browser', async () => {
  ports.status = { state: 'disconnected', detail: 'Add a folder before connecting.' };
  expect(await sendDesktopInput(request)).toMatchObject({ state: 'queued' });
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Add a folder'));
  expect(ports.enqueue).toHaveBeenCalledTimes(1); expect(ports.open).not.toHaveBeenCalled();
});
it('keeps a failed browser launch queued and opens existing targets by exact identity', async () => {
  ports.open.mockRejectedValueOnce(new Error('Chrome refused startup'));
  expect(await sendDesktopInput({ ...request, sessionId: 'session-existing' })).toMatchObject({ state: 'queued' });
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledWith('https://chatgpt.com/c/exact-conversation', expect.objectContaining({ current: expect.any(Function) })));
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalled());
  expect(ports.note).toHaveBeenCalledWith(request.id, expect.stringContaining('Message queued. Browser startup failed'));
  ports.browser = { connected: true, present: true, lastSeenAt: 10 };
  const next = { ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' };
  await sendDesktopInput(next);
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalledWith(next.id, null));
  expect(ports.open).toHaveBeenCalledTimes(1);
  ports.browser = { connected: false, present: false, lastSeenAt: 10 };
  await sendDesktopInput({ ...request, id: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' });
  await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(2));
});

it('cancels accepted input while waiting for connection without opening Chrome', async () => {
  ports.status = { state: 'connecting-tunnel', detail: '' };
  expect(await sendDesktopInput(request)).toMatchObject({ state: 'queued' });
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  expect(await cancelDesktopInput(request.id)).toBe(true);
  expect(ports.rows[0]?.state).toBe('cancelled');
  await vi.waitFor(() => expect(ports.listeners.size).toBe(0));
  ports.status = { state: 'connected', detail: '' }; for (const listener of ports.listeners) listener();
  expect(ports.open).not.toHaveBeenCalled();
});
it('leaves delivery with the existing browser while its wake transport reconnects', async () => {
  ports.running = true;
  ports.browser = { connected: false, present: true, lastSeenAt: Date.now() };
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalled());
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});
it('preserves background placement for a cold authored send and its explicit retry', async () => {
  ports.backgroundChats = true;
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Browser startup failed'));
  await retryQueuedInputBrowser(request.id);
  expect(ports.open).toHaveBeenCalledTimes(2);
  for (const call of ports.open.mock.calls) expect(call[1]).toEqual(expect.objectContaining({ backgroundStartup: true }));
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});
it('cancels an enqueue that commits after the user stopped startup', async () => {
  let commit!: () => void;
  ports.enqueue.mockImplementation(() => new Promise(resolve => { commit = () => resolve({ ...request, state: 'queued' }); }));
  const pending = sendDesktopInput(request);
  const rejected = expect(pending).rejects.toThrow('Input cancelled');
  await vi.waitFor(() => expect(ports.enqueue).toHaveBeenCalled());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  commit(); await rejected;
  expect(ports.cancel).toHaveBeenCalledWith(request.id);
  expect(ports.open).not.toHaveBeenCalled();
});

it('does not treat an unknown process probe as permission to open a browser', async () => {
  ports.running = null;
  await sendDesktopInput(request);
  expect(ports.open).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalled());
  expect(ports.rows[0]).toMatchObject({ state: 'queued', error: undefined });
});

it('hands explicit Send to an already-running browser when its companion is unreachable', async () => {
  ports.running = true;
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalled());
  expect(ports.open).toHaveBeenCalledTimes(1);
  const url = new URL(ports.open.mock.calls[0]![0]);
  expect(url.searchParams.get('cos-input')).toBe(request.id);
  expect(url.hash).toBe(`#cos-input=${request.id}`);
  expect(ports.rows[0]).toMatchObject({ state: 'queued', owner: null });
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});

it.each([
  { mode: 'after-turn' as const },
  { dueAt: Date.now() + 600_000 }
])('leaves scheduled/after-turn input with a running browser: %j', async changes => {
  ports.running = true;
  await sendDesktopInput({ ...request, ...changes });
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalled());
  expect(ports.open).not.toHaveBeenCalled();
});

it.each(['cancel', 'shutdown', 'claimed', 'rebound'])('revokes a Send opening during its process probe on %s', async action => {
  let release!: (running: boolean) => void;
  ports.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.probe).toHaveBeenCalledTimes(1));
  if (action === 'cancel') await cancelDesktopInput(request.id);
  else if (action === 'shutdown') stopInputStartup();
  else if (action === 'claimed') Object.assign(ports.rows[0]!, { state: 'browser', owner: 'exact-document', sendAuthorizedAt: Date.now() });
  else ports.rows[0]!.conversationId = 'replacement-conversation';
  release(false);
  await new Promise(resolve => setImmediate(resolve));
  expect(ports.open).not.toHaveBeenCalled();
  expect(ports.note).not.toHaveBeenCalled();
});

it('does not turn a failed startup-status write into permission to repeat a successful browser handoff', async () => {
  ports.note.mockRejectedValueOnce(new Error('status write failed'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Browser startup failed'));
  expect(ports.open).toHaveBeenCalledTimes(1);
  await retryQueuedInputBrowser(request.id);
  expect(ports.open).toHaveBeenCalledTimes(1);
  expect(ports.enqueue).toHaveBeenCalledTimes(1);
});

it('does not give a replayed accepted UUID another opening after transient startup state is lost', async () => {
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.note).toHaveBeenCalledWith(request.id, null));
  expect(ports.open).toHaveBeenCalledTimes(1);
  const accepted = ports.rows[0]!;
  resetInputStartupForTests(); // Keep the durable outbox, as after a restart.
  ports.enqueue.mockResolvedValueOnce(accepted);
  expect(await sendDesktopInput(request)).toBe(accepted);
  await new Promise(resolve => setImmediate(resolve));
  expect(ports.open).toHaveBeenCalledTimes(1);
  expect(ports.rows).toHaveLength(1);
});

it.each(['cancel', 'shutdown'])('revokes explicit retry before readiness on %s', async action => {
  ports.open.mockRejectedValueOnce(new Error('startup refused'));
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.rows[0]?.error).toContain('Browser startup failed'));
  ports.status = { state: 'connecting-tunnel', detail: '' };
  const retry = retryQueuedInputBrowser(request.id);
  await vi.waitFor(() => expect(ports.listeners.size).toBe(1));
  if (action === 'cancel') await cancelDesktopInput(request.id); else stopInputStartup();
  ports.status = { state: 'connected', detail: '' }; for (const listener of ports.listeners) listener();
  expect(await retry).toBeNull();
  expect(ports.open).toHaveBeenCalledTimes(1);
  if (action === 'shutdown') await expect(sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' })).rejects.toThrow('shutting down');
});
