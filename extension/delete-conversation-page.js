/** Fixed user-owned deletion UI, injected into the isolated world. No title matching,
 * account API calls or fallback to another conversation. Unknown UI stays untouched. */
export async function deleteConversationPage(args) {
  const KEY = '__cosConversationDeletion';
  const validId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
  if (args?.phase === 'cancel') {
    const state = globalThis[KEY];
    if (!validId(args.operationId) || state?.id !== args.operationId || state.conversationId !== args.conversationId) return { cancelled: false };
    state.release();
    if (!state.dispatched && Date.now() < state.expiresAt && state.popup?.isConnected && location.pathname === state.path)
      state.popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    delete globalThis[KEY]; return { cancelled: true };
  }
  if (!validId(args?.conversationId) || !validId(args?.operationId) ||
      !Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 30000)
    return { error: 'Invalid or expired deletion request.' };
  const route = () => {
    if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(location.origin)) return false;
    return location.pathname.replace(/\/$/, '') === '/c/' + args.conversationId ||
      new RegExp('^/g/[^/]+/c/' + args.conversationId + '/?$').test(location.pathname);
  };
  const native = globalThis.CLF_DOM;
  const shown = node => node?.isConnected && node.getClientRects().length > 0 &&
    !node.closest('[hidden],[aria-hidden="true"],[inert]') && getComputedStyle(node).visibility !== 'hidden';
  const outsideTranscript = node => !node.closest('.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-turn-key],.markdown,[data-message-author-role]');
  const popups = () => [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"]')].filter(shown);
  const question = () => native?.messages().findLast(item => item.role === 'user')?.id ?? null;
  // The owned native menu/dialog can make its background editor inert. Retain
  // that exact connected editor instead of treating our own popup as navigation.
  const same = state => globalThis[KEY] === state && !state.retired && route() && Date.now() < args.expiresAt && native &&
    (!native.composer() || native.composer() === state.editor) &&
    state.editor?.isConnected && !(state.editor.textContent || '').trim() && !native.hasComposerAttachments() &&
    !native.generating() && question() === state.question;
  const wait = (predicate, current) => new Promise(resolve => {
    let timer, observer;
    const finish = value => { clearTimeout(timer); observer?.disconnect(); resolve(value); };
    const check = () => {
      try {
        if (!current() || Date.now() >= args.expiresAt) { finish(null); return; }
        const value = predicate(); if (value) finish(value);
      } catch { finish(null); }
    };
    observer = new MutationObserver(check); observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(() => finish(null), Math.max(1, Math.min(5000, args.expiresAt - Date.now())));
    check();
  });
  if (args.phase === 'confirm') {
    const state = globalThis[KEY];
    if (!state || state.id !== args.operationId || state.conversationId !== args.conversationId || state.dispatched ||
        !same(state) || !shown(state.popup) || !shown(state.confirm) || state.confirm.disabled ||
        state.confirm.getAttribute('aria-disabled') === 'true' || !state.popup.contains(state.confirm) ||
        !state.heading?.isConnected || !state.popup.contains(state.heading) || state.heading.textContent !== state.headingText ||
        state.confirm.textContent !== state.confirmText || state.confirm.getAttribute('data-testid') !== state.confirmTestId ||
        !['dialog', 'alertdialog'].includes(state.popup.getAttribute('role')) ||
        popups().filter(node => ['dialog', 'alertdialog'].includes(node.getAttribute('role'))).length !== 1)
      return { error: 'The native deletion confirmation changed. No confirmation was clicked.' };
    state.dispatched = true;
    state.confirm.click();
    return { dispatched: true };
  }
  if (args.phase !== 'prepare' || !route() || !native)
    return { error: 'Open this exact ChatGPT conversation with the current companion before deleting it.' };
  if (globalThis[KEY]) return { error: 'A native deletion request is already in progress.' };
  // Reserve before the first hydration await: cancellation must retire an operation
  // that has not obtained an editor yet, not just a later open dialog.
  const state = { id: args.operationId, conversationId: args.conversationId, editor: null, question: null, path: location.pathname,
    expiresAt: args.expiresAt, dispatched: false, popup: null, confirm: null, heading: null,
    headingText: null, confirmText: null, confirmTestId: null, retired: false, timer: null, release: null };
  const retire = () => { state.retired = true; };
  const human = event => { if (event.isTrusted) retire(); };
  state.release = () => {
    state.retired = true;
    clearTimeout(state.timer);
    removeEventListener('popstate', retire); removeEventListener('hashchange', retire); removeEventListener('pagehide', retire);
    document.removeEventListener('pointerdown', human, true); document.removeEventListener('keydown', human, true);
  };
  addEventListener('popstate', retire); addEventListener('hashchange', retire); addEventListener('pagehide', retire);
  document.addEventListener('pointerdown', human, true); document.addEventListener('keydown', human, true);
  globalThis[KEY] = state;
  state.timer = setTimeout(() => { state.release(); if (globalThis[KEY] === state) delete globalThis[KEY]; }, Math.max(1, args.expiresAt - Date.now()));
  const preparing = () => globalThis[KEY] === state && !state.retired && route();
  const editor = await wait(() => native.composerSubmitReady() && native.composer(), preparing);
  if (!preparing() || !editor || native.generating() || native.hasComposerAttachments() || (editor.textContent || '').trim() || popups().length)
    return { error: 'The native chat must be idle, without a draft, attachments or another dialog.' };
  state.editor = editor; state.question = question();
  const candidates = [...document.querySelectorAll('[data-testid="conversation-options-button"],button[aria-label="More"][aria-haspopup="menu"]')]
    .filter(node => shown(node) && outsideTranscript(node) && !node.closest('nav,aside,[role="navigation"],#app-shell-sidebar'));
  if (candidates.length !== 1 || candidates[0].getAttribute('aria-expanded') === 'true')
    return { error: 'The native conversation menu was not identified. Delete it in ChatGPT manually.' };
  const trigger = candidates[0];
  trigger.click();
  const menu = await wait(() => {
    const id = trigger.getAttribute('aria-controls');
    const owned = popups().filter(node => node.getAttribute('role') === 'menu' && outsideTranscript(node) &&
      (id ? node.id === id : trigger.id && node.getAttribute('aria-labelledby') === trigger.id));
    return owned.length === 1 ? owned[0] : null;
  }, () => same(state));
  if (!menu) return { error: 'The exact native conversation menu did not open.' };
  state.popup = menu;
  const removes = [...menu.querySelectorAll('[role="menuitem"],button')].filter(node => shown(node) &&
    (node.getAttribute('data-testid') === 'delete-chat-menu-item' || /^Delete(?: chat)?$/.test((node.textContent || '').trim())));
  if (removes.length !== 1 || !same(state)) return { error: 'The native Delete action was not identified.' };
  removes[0].click();
  const confirmation = await wait(() => {
    const dialogs = popups().filter(node => ['dialog', 'alertdialog'].includes(node.getAttribute('role')) && outsideTranscript(node));
    return dialogs.length === 1 ? dialogs[0] : null;
  }, () => same(state));
  if (!confirmation) return { error: 'The native delete confirmation did not open.' };
  state.popup = confirmation;
  const buttons = [...confirmation.querySelectorAll('button')].filter(node => shown(node) &&
    (node.getAttribute('data-testid') === 'confirm-delete-button' || /^Delete(?: chat)?$/.test((node.textContent || '').trim())));
  const heading = confirmation.querySelector('h1,h2,h3,[role="heading"]');
  if (buttons.length !== 1 || !heading || !/^Delete (?:this )?chat\??$/i.test((heading.textContent || '').trim()) || !same(state))
    return { error: 'The native delete dialog is not recognized. No deletion was confirmed.' };
  state.popup = confirmation; state.confirm = buttons[0]; state.heading = heading;
  state.headingText = heading.textContent; state.confirmText = buttons[0].textContent;
  state.confirmTestId = buttons[0].getAttribute('data-testid');
  return { ready: true };
}

/** Observe the request made by the native confirmation; never send a private API request.
 * Only an exact single-conversation deletion and its accepted response establish success.
 * Credentials, headers, chat contents and arbitrary response bodies never leave this page. */
export async function nativeDeletionReceiptPage(args) {
  const KEY = '__cosNativeDeletionReceipt';
  const old = globalThis[KEY];
  if (args.phase === 'read') return old?.id === args.operationId ? old.result : { deleted: false };
  if (args.phase === 'dispose') { if (old?.id === args.operationId) old.dispose(); return { disposed: true }; }
  if (args.phase !== 'arm' || old || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(args.conversationId || '') ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(args.operationId || '') ||
      !Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 30000 ||
      !['https://chatgpt.com', 'https://chat.openai.com'].includes(location.origin)) return { armed: false };
  const previous = globalThis.fetch;
  let active = true, claimed = false, finish, timer, responseReader;
  const result = new Promise(resolve => { finish = resolve; });
  const settle = deleted => { if (!active) return; active = false; finish({ deleted, conversationId: args.conversationId }); };
  function matches(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.origin !== location.origin || url.pathname !== '/backend-api/conversation/' + args.conversationId || url.search) return false;
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'DELETE') return true;
      if (method !== 'PATCH' || typeof init?.body !== 'string' || init.body.length > 1024) return false;
      const body = JSON.parse(init.body);
      return body && typeof body === 'object' && !Array.isArray(body) && body.is_visible === false;
    } catch { return false; }
  }
  async function accepted(response) {
    if (!response?.ok) { settle(false); return; }
    if (response.status === 204) { settle(true); return; }
    const reader = response.clone().body?.getReader(); if (!reader) { settle(false); return; }
    responseReader = reader;
    let text = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
        if (bytes > 4096 || !active) { settle(false); return; } text += decoder.decode(chunk.value, { stream: true }); }
      text += decoder.decode(); const body = JSON.parse(text); settle(body?.success === true);
    } catch { settle(false); }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); if (responseReader === reader) responseReader = null; }
  }
  const wrapped = function (...values) {
    const observe = active && !claimed && Date.now() < args.expiresAt && matches(values[0], values[1]);
    const response = Reflect.apply(previous, this, values);
    if (observe) { claimed = true; void Promise.resolve(response).then(accepted, () => settle(false)).catch(() => settle(false)); }
    return response;
  };
  const dispose = () => {
    settle(false);
    clearTimeout(timer); void responseReader?.cancel().catch(() => {});
    if (globalThis.fetch === wrapped) globalThis.fetch = previous;
    if (globalThis[KEY]?.id === args.operationId) delete globalThis[KEY];
  };
  globalThis[KEY] = { id: args.operationId, result, dispose };
  globalThis.fetch = wrapped;
  timer = setTimeout(dispose, Math.max(1, args.expiresAt - Date.now()));
  return { armed: true };
}
