import { CAPABILITY_LABELS } from '../shared/types.js';
import { FULL_LOCAL_ACCESS, TOOL_ACCESS_COPY, hasFullLocalAccess, type ToolAccessApi,
  type ToolAccessStatus } from '../shared/tool-access.js';
import { t, ui } from './i18n.js';

let nextDialog = 0;

export interface ToolAccessOptions {
  button: HTMLButtonElement;
  api: ToolAccessApi;
  onStatus?: (status: ToolAccessStatus) => void;
  onApplied?: (status: ToolAccessStatus) => void | Promise<void>;
  openSettings?: () => void;
}

/** The main process owns confirmation and saving. This panel only displays its receipts. */
export function initToolAccess(options: ToolAccessOptions): {
  open(returnFocus?: HTMLElement): Promise<void>; close(): void; refresh(): Promise<void>; dispose(): void;
} {
  const { button, api } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className;
    if (text) ui(node, 'textContent', () => t(text));
    return node;
  };
  const control = (label: string, action: string): HTMLButtonElement => {
    const node = make('button', 'tool-access-button', label); node.type = 'button'; node.dataset.action = action; return node;
  };
  const modal = make('dialog', 'tool-access-dialog'); modal.id = `toolAccessDialog${++nextDialog}`;
  const title = make('h2', '', 'Local tool access'); title.id = `${modal.id}Title`;
  const scope = make('p', 'tool-access-note', TOOL_ACCESS_COPY.scope); scope.id = `${modal.id}Scope`;
  modal.setAttribute('aria-labelledby', title.id); modal.setAttribute('aria-describedby', scope.id);
  const closeButton = control('Close', 'close'), head = make('div', 'tool-access-head'); head.append(title, closeButton);
  const summary = make('p', 'tool-access-summary'), facts = make('p', 'tool-access-note');
  const details = make('details', 'tool-access-details');
  const enabled = make('p'), missing = make('p'), unsupported = make('p');
  details.append(make('summary', '', 'Permission details'), enabled, missing, unsupported);
  const roots = make('p', 'tool-access-note');
  const feedback = make('p', 'tool-access-status'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const apply = control('Enable full local access', 'apply'); apply.classList.add('is-primary');
  const refreshButton = control('Refresh', 'refresh'), settings = control('Permissions settings', 'settings');
  settings.hidden = !options.openSettings;
  const actions = make('div', 'tool-access-actions'); actions.append(settings, refreshButton, apply);
  modal.append(head, scope, summary, facts, details, roots,
    make('p', 'tool-access-command', TOOL_ACCESS_COPY.command),
    make('p', 'tool-access-note', TOOL_ACCESS_COPY.boundaries),
    make('p', 'tool-access-note', TOOL_ACCESS_COPY.unchanged), feedback, actions);
  document.body.append(modal);
  button.type = 'button'; button.classList.add('tool-access-trigger');
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', modal.id); button.setAttribute('aria-expanded', 'false');

  let status: ToolAccessStatus | null = null, disposed = false, applying = false, loading = false, version = 0;
  let focusOwner: HTMLElement = button;
  const message = (text: string, error = false): void => {
    ui(feedback, 'textContent', () => t(text)); feedback.setAttribute('role', error ? 'alert' : 'status');
    modal.dataset.error = String(error);
  };
  const label = (): string => !status ? t('Local permissions unknown') : status.readOnly ? t('Read-only')
    : hasFullLocalAccess(status) ? t('Full local permissions') : t('Limited local permissions');
  const paint = (): void => {
    ui(button, 'title', () => `${t('Local tool access')}: ${label()}`);
    ui(button, 'aria-label', () => `${t('Local tool access')}: ${label()}`);
    ui(summary, 'textContent', label);
    ui(facts, 'textContent', () => status ? t('Read-only: {0}. Enabled permissions: {1} of {2}.',
      [status.readOnly ? t('On') : t('Off'), status.enabled.length, status.enabled.length + status.missing.length]) : '');
    ui(enabled, 'textContent', () => status ? t('Enabled: {0}', [status.enabled.map(capability => t(CAPABILITY_LABELS[capability])).join(', ') || t('None')]) : '');
    ui(missing, 'textContent', () => status ? t('Missing or limited by Read-only: {0}', [status.missing.map(capability => t(CAPABILITY_LABELS[capability])).join(', ') || t('None')]) : '');
    ui(unsupported, 'textContent', () => status ? t('Unsupported on this platform: {0}', [status.unsupported.map(capability => t(CAPABILITY_LABELS[capability])).join(', ')]) : '');
    details.hidden = !status; unsupported.hidden = !status?.unsupported.length;
    ui(roots, 'textContent', () => status ? status.approvedRootCount === 0
      ? t('No folders are approved. Approve a folder in Settings before using file tools or starting commands.')
      : t('Approved folders: {0}. This preset keeps the current folders.', [status.approvedRootCount]) : '');
    apply.disabled = applying || loading || !status || hasFullLocalAccess(status);
    refreshButton.disabled = settings.disabled = closeButton.disabled = applying;
    ui(apply, 'textContent', () => status && hasFullLocalAccess(status) ? t('Full local permissions enabled') : t('Enable full local access'));
    modal.setAttribute('aria-busy', String(applying || loading));
  };
  const accept = (value: ToolAccessStatus): void => { status = value; options.onStatus?.(value); };
  const refresh = async (): Promise<void> => {
    if (disposed || applying) return;
    const request = ++version; loading = true; message('Reading local permissions…'); paint();
    try {
      const reply = await api.toolAccessStatus();
      if (disposed || version !== request) return;
      if (!reply.ok) throw new Error(reply.error);
      accept(reply.data); message('');
    } catch (error) {
      if (disposed || version !== request) return;
      status = null; message(error instanceof Error ? error.message : 'Could not read local permissions.', true);
    } finally { if (!disposed && version === request) { loading = false; paint(); } }
  };
  const open = async (returnFocus: HTMLElement = button): Promise<void> => {
    if (disposed || modal.open) return;
    focusOwner = returnFocus;
    modal.showModal(); button.setAttribute('aria-expanded', 'true'); closeButton.focus(); await refresh();
  };
  const close = (): void => {
    if (applying) return; // Cancel the pending approval in the native dialog.
    version++; loading = false;
    if (modal.open) modal.close();
    button.setAttribute('aria-expanded', 'false'); if (!disposed && focusOwner.isConnected) focusOwner.focus();
  };
  const applyPreset = async (): Promise<void> => {
    if (disposed || applying || loading || !status || hasFullLocalAccess(status)) return;
    const request = ++version; applying = true; message('Confirm the change in the system dialog…'); paint();
    try {
      const reply = await api.applyToolAccessPreset(FULL_LOCAL_ACCESS);
      if (disposed || version !== request) return;
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.data || typeof reply.data.applied !== 'boolean') throw new Error('No valid local permission save receipt was received.');
      accept(reply.data.status);
      if (!reply.data.applied) { message('Permission change cancelled.'); return; }
      message('Local permissions saved.');
      try { await options.onApplied?.(reply.data.status); }
      catch (error) { if (!disposed && version === request) message(`Local permissions were saved, but refreshing the app failed: ${error instanceof Error ? error.message : String(error)}`, true); }
    } catch (error) {
      if (!disposed && version === request) { status = null; message(error instanceof Error ? error.message : 'Could not update local permissions.', true); }
    } finally { if (!disposed && version === request) { applying = false; paint(); } }
  };
  const click = (): void => { void open(); }; button.addEventListener('click', click);
  closeButton.onclick = close; refreshButton.onclick = () => { void refresh(); }; apply.onclick = () => { void applyPreset(); };
  settings.onclick = () => { close(); options.openSettings?.(); };
  modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
  paint();
  return { open, close, refresh, dispose: () => {
    disposed = true; version++; button.removeEventListener('click', click); modal.remove();
    button.removeAttribute('aria-controls'); button.setAttribute('aria-expanded', 'false');
  } };
}
