import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const source = readFileSync('extension/delete-conversation-page.js', 'utf8').replace(/^export /gm, '');
const conversationId = 'aaaaaaaa-1111-4111-8111-111111111111';
const other = 'bbbbbbbb-2222-4222-8222-222222222222';
const operationId = 'cccccccc-3333-4333-8333-333333333333';
let dom: JSDOM, win: any, clicked: ReturnType<typeof vi.fn>, originalFetch: ReturnType<typeof vi.fn>;
const request = (phase: string, extra = {}) => ({ phase, conversationId, operationId, expiresAt: Date.now() + 1000, ...extra });

beforeEach(() => {
  dom = new JSDOM('<header><button id="options" aria-label="More" aria-haspopup="menu" aria-expanded="false">More</button></header><main><form><div id="editor" contenteditable="true"></div></form></main>',
    { url: `https://chatgpt.com/c/${conversationId}`, runScripts: 'outside-only' });
  win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return [{ width: 20, height: 20 }]; } });
  Object.assign(win, { TextDecoder, TextEncoder, Request, Response });
  clicked = vi.fn(); originalFetch = vi.fn(() => Promise.resolve(new Response('{"success":true}', { headers: { 'content-type': 'application/json' } })));
  win.fetch = originalFetch;
  const doc = win.document, editor = doc.getElementById('editor');
  win.CLF_DOM = { composer: () => editor.closest('[inert]') ? null : editor,
    composerSubmitReady: () => !editor.textContent.trim(), generating: () => false,
    hasComposerAttachments: () => false, messages: () => [{ id: 'exact-question', role: 'user' }] };
  doc.getElementById('options').onclick = () => {
    editor.parentElement.setAttribute('inert', '');
    const menu = doc.createElement('div'); menu.id = 'native-menu'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', 'options');
    const remove = doc.createElement('button'); remove.textContent = 'Delete'; remove.setAttribute('role', 'menuitem');
    remove.onclick = () => {
      menu.remove(); const dialog = doc.createElement('section'); dialog.setAttribute('role', 'alertdialog');
      const title = doc.createElement('h2'); title.textContent = 'Delete chat?';
      const confirm = doc.createElement('button'); confirm.textContent = 'Delete'; confirm.onclick = clicked;
      dialog.append(title, confirm); doc.body.append(dialog);
    };
    menu.append(remove); doc.body.append(menu);
  };
  win.eval(`${source}\nglobalThis.pageAction = deleteConversationPage; globalThis.receiptAction = nativeDeletionReceiptPage;`);
});
afterEach(async () => {
  await win.pageAction(request('cancel')); await win.receiptAction(request('dispose'));
  dom.window.close(); vi.restoreAllMocks();
});

it('prepares exact native UI without confirming deletion, then clicks once under the same document', async () => {
  expect(await win.pageAction(request('prepare'))).toEqual({ ready: true });
  expect(clicked).not.toHaveBeenCalled();
  expect(await win.pageAction(request('confirm'))).toEqual({ dispatched: true });
  expect(await win.pageAction(request('confirm'))).toHaveProperty('error');
  expect(clicked).toHaveBeenCalledTimes(1); expect(originalFetch).not.toHaveBeenCalled();
});
it.each(['draft', 'working', 'attachment', 'dialog', 'foreign route', 'ambiguous menu'])('refuses unsafe preparation: %s', async reason => {
  if (reason === 'draft') win.document.getElementById('editor').textContent = 'User draft';
  if (reason === 'working') win.CLF_DOM.generating = () => true;
  if (reason === 'attachment') win.CLF_DOM.hasComposerAttachments = () => true;
  if (reason === 'dialog') { const node = win.document.createElement('div'); node.setAttribute('role', 'dialog'); win.document.body.append(node); }
  if (reason === 'foreign route') win.history.replaceState(null, '', `/c/${other}`);
  if (reason === 'ambiguous menu') win.document.querySelector('header').append(win.document.getElementById('options').cloneNode(true));
  expect(await win.pageAction(request('prepare', { expiresAt: Date.now() + 30 }))).toHaveProperty('error');
  expect(clicked).not.toHaveBeenCalled();
});
it.each(['question', 'editor', 'disabled', 'route', 'operation', 'heading', 'button', 'history'])('does not confirm after its %s owner changes', async reason => {
  expect(await win.pageAction(request('prepare'))).toEqual({ ready: true });
  if (reason === 'question') win.CLF_DOM.messages = () => [{ id: 'new-question', role: 'user' }];
  if (reason === 'editor') win.document.getElementById('editor').replaceWith(win.document.createElement('div'));
  if (reason === 'disabled') win.document.querySelector('[role="alertdialog"] button').disabled = true;
  if (reason === 'route') win.history.replaceState(null, '', `/c/${other}`);
  if (reason === 'heading') win.document.querySelector('[role="alertdialog"] h2').textContent = 'Delete all chats?';
  if (reason === 'button') win.document.querySelector('[role="alertdialog"] button').textContent = 'Delete all';
  if (reason === 'history') win.dispatchEvent(new win.PopStateEvent('popstate'));
  expect(await win.pageAction(request('confirm', reason === 'operation' ? { operationId: other } : {}))).toHaveProperty('error');
  expect(clicked).not.toHaveBeenCalled();
});
it('cancels only its own prepared dialog and never clicks Delete', async () => {
  await win.pageAction(request('prepare'));
  expect(await win.pageAction(request('cancel', { operationId: other }))).toEqual({ cancelled: false });
  expect(await win.pageAction(request('cancel'))).toEqual({ cancelled: true });
  expect(await win.pageAction(request('confirm'))).toHaveProperty('error'); expect(clicked).not.toHaveBeenCalled();
});
it('cancellation during initial hydration prevents a later composer from opening the menu', async () => {
  let ready = false; win.CLF_DOM.composerSubmitReady = () => ready;
  const open = vi.spyOn(win.document.getElementById('options'), 'click');
  const pending = win.pageAction(request('prepare'));
  expect(await win.pageAction(request('cancel'))).toEqual({ cancelled: true });
  ready = true; win.document.body.setAttribute('data-hydrated', 'true');
  expect(await pending).toHaveProperty('error'); expect(open).not.toHaveBeenCalled(); expect(clicked).not.toHaveBeenCalled();
});
it('cancellation during menu hydration retires the captured operation, not only its global marker', async () => {
  const trigger = win.document.getElementById('options'), createMenu = trigger.onclick;
  const opened = vi.fn(); trigger.onclick = opened;
  const pending = win.pageAction(request('prepare'));
  await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
  expect(await win.pageAction(request('cancel'))).toEqual({ cancelled: true });
  createMenu();
  expect(await pending).toHaveProperty('error'); expect(win.document.querySelector('[role="alertdialog"]')).toBeNull(); expect(clicked).not.toHaveBeenCalled();
});
it('a second visible editor cannot borrow the inert editor captured by the native menu', async () => {
  await win.pageAction(request('prepare'));
  const next = win.document.createElement('div'); next.contentEditable = 'true'; win.document.body.append(next);
  win.CLF_DOM.composer = () => next;
  expect(await win.pageAction(request('confirm'))).toHaveProperty('error'); expect(clicked).not.toHaveBeenCalled();
});
it('supports a native project route without following a sidebar chat with a similar title', async () => {
  win.history.replaceState(null, '', `/g/project-owned/c/${conversationId}`);
  const aside = win.document.createElement('aside'); aside.innerHTML = '<button aria-label="More" aria-haspopup="menu">Foreign</button>';
  win.document.body.append(aside); const foreign = vi.fn(); aside.firstChild.onclick = foreign;
  expect(await win.pageAction(request('prepare'))).toEqual({ ready: true }); expect(foreign).not.toHaveBeenCalled();
});
it('a deletion click is not itself a provider receipt', async () => {
  expect(await win.receiptAction(request('arm', { expiresAt: Date.now() + 30 }))).toEqual({ armed: true });
  expect(await win.receiptAction(request('read'))).toEqual({ deleted: false, conversationId });
  expect(originalFetch).not.toHaveBeenCalled(); expect(win.fetch).toBe(originalFetch);
});
it('observes the exact native deletion response without changing the response promise or sending anything itself', async () => {
  await win.receiptAction(request('arm')); expect(originalFetch).not.toHaveBeenCalled();
  const expected = Promise.resolve(new Response('{"success":true}')); originalFetch.mockReturnValueOnce(expected);
  const returned = win.fetch(`/backend-api/conversation/${conversationId}`, { method: 'PATCH', body: '{"is_visible":false}' });
  expect(returned).toBe(expected);
  expect(await win.receiptAction(request('read'))).toEqual({ deleted: true, conversationId });
  expect(originalFetch).toHaveBeenCalledTimes(1);
  await win.receiptAction(request('dispose')); expect(win.fetch).toBe(originalFetch);
});
it.each(['foreign conversation', 'foreign origin', 'archive', 'get', 'unknown body'])('ignores unrelated native traffic: %s', async reason => {
  await win.receiptAction(request('arm', { expiresAt: Date.now() + 30 }));
  const url = reason === 'foreign origin' ? `https://example.com/backend-api/conversation/${conversationId}` :
    `/backend-api/conversation/${reason === 'foreign conversation' ? other : conversationId}`;
  await win.fetch(url, { method: reason === 'get' ? 'GET' : 'PATCH',
    body: reason === 'archive' ? '{"is_archived":true}' : reason === 'unknown body' ? '{}' : '{"is_visible":false}' });
  expect(await win.receiptAction(request('read'))).toEqual({ deleted: false, conversationId });
});
it.each(['http', 'oversized', 'contradiction', 'invalid json'])('preserves uncertainty on %s receipt failure', async reason => {
  originalFetch.mockResolvedValueOnce(new Response(reason === 'oversized' ? 'x'.repeat(4100) : reason === 'contradiction' ? '{"success":false}' : 'not json',
    { status: reason === 'http' ? 403 : 200 }));
  await win.receiptAction(request('arm'));
  await win.fetch(`/backend-api/conversation/${conversationId}`, { method: 'DELETE' });
  expect(await win.receiptAction(request('read'))).toEqual({ deleted: false, conversationId });
});
it('cleanup does not replace a later page-owned fetch wrapper', async () => {
  await win.receiptAction(request('arm')); const ours = win.fetch, later = (...args: unknown[]) => ours(...args); win.fetch = later;
  await win.receiptAction(request('dispose')); expect(win.fetch).toBe(later);
  await later(`/backend-api/conversation/${conversationId}`, { method: 'DELETE' });
  expect(await win.receiptAction(request('read'))).toEqual({ deleted: false });
});
