/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { startBridge } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { getConfig } from '../config.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, type InputArgs, type InputEntry } from './input.js';

async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await the existing status authority before browser work; local admission is already durable.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new Error(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  signal?.throwIfAborted();
  if (!await startBridge()) throw new Error('The browser bridge could not start.');
  signal?.throwIfAborted();
}
async function deliver(entry: InputEntry, controller: AbortController, retry = false): Promise<InputEntry | null> {
  const { id, sessionId, conversationId } = entry;
  const live = () => !stopped && !controller.signal.aborted && starting.get(id) === controller;
  const current = async (): Promise<boolean> => {
    if (!live()) return false;
    const row = (await listInputs()).find(value => value.id === id);
    // The process probe and this outbox read both yield. Cancellation, claim and
    // rebind must retire the old URL before the OS handoff, including on retry.
    return live() && !!row && row.state === 'queued' && row.owner === null && row.sendAuthorizedAt === undefined &&
      row.sessionId === sessionId && row.conversationId === conversationId && row.purpose !== 'decision' &&
      row.transportIntent !== 'tool' && row.attachmentDelivery !== 'tool';
  };
  try {
    const marker = `cos-input=${encodeURIComponent(id)}`;
    await wakeBrowserUrl(conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`,
      retry, getConfig().ui.backgroundChats === true, {
        current, allowRunning: (entry.requestedMode ?? entry.mode) === 'auto' && entry.dueAt <= Date.now()
      });
    if (!await current()) return null;
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    if (!await current()) return null;
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
let stopped = false;
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}
async function startAcceptedInput(entry: InputEntry, controller: AbortController): Promise<void> {
  try {
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const current = (await listInputs()).find(row => row.id === entry.id);
    controller.signal.throwIfAborted();
    if (current?.state === 'queued') await deliver(current, controller);
  } catch (error) {
    if (!controller.signal.aborted) await noteInputStartupError(entry.id,
      'Message queued. Browser startup failed: ' + (error as Error).message);
  } finally {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
  }
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (input.mode === 'finish' || starting.has(input.id)) return enqueueInput(input);
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    // Replaying durable admission is not a new user opening, even after restart
    // forgets transient startup state. A known startup failure has its own retry action.
    const accepted = (await listInputs()).some(row => row.id === input.id);
    const entry = await enqueueInput(input);
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    if (accepted || entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool') {
      starting.delete(input.id); return entry;
    }
    // Return after durable admission, not after connection startup or native delivery.
    void startAcceptedInput(entry, controller).catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === controller) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!(entry.error?.startsWith('Message queued. Browser startup failed:') || entry.error?.startsWith('Local chat setup failed:'));
  if (!eligible((await listInputs()).find(entry => entry.id === id)) || stopped || starting.has(id)) return null;
  const controller = new AbortController(); starting.set(id, controller);
  try {
    const repaired = await noteInputStartupError(id, null);
    if (repaired?.error?.startsWith('Local chat setup failed:')) return repaired;
    await ready(controller.signal);
    const entry = (await listInputs()).find(row => row.id === id);
    controller.signal.throwIfAborted();
    return entry?.state === 'queued' ? await deliver(entry, controller, true) : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    return await noteInputStartupError(id, 'Message queued. Browser startup failed: ' + (error as Error).message);
  } finally { if (starting.get(id) === controller) starting.delete(id); }
}
export function resetInputStartupForTests(): void { stopInputStartup(); stopped = false; resetBrowserStartupForTests(); }
