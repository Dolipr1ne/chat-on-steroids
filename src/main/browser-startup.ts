/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserPresent, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getConfig } from './config.js';

let waking: { url: string; lastSeenAt: number | null; selected: string; work: Promise<void>; failed: boolean; finished: boolean } | null = null;
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: { current(): boolean | Promise<boolean>; allowRunning?: boolean }): Promise<void> {
  if (authority && !await authority.current()) return;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // Recovery/discovery need process absence. A current explicit Send may also
  // hand its owned URL to a running browser with no reachable companion. A recent
  // HTTP sighting still leaves election with the extension while its socket reconnects.
  const prior = waking;
  const running = await isPreferredBrowserRunning();
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  const current = async (): Promise<boolean> => {
    if (authority && !await authority.current()) return false;
    // Both the process probe and durable authority validation may yield.
    if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return false;
    if (browserWakeConnected()) { waking = null; return false; }
    return running === false || running === true && authority?.allowRunning === true && !browserPresent();
  };
  if (!await current()) return;
  // A failed launch can retry. A successful handoff spent this URL's opening;
  // missing delivery/status receipts or a user-closed tab cannot refund it.
  if (retry && waking === prior && (waking?.failed || waking?.finished && waking.url !== url)) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.selected === selected && (waking.lastSeenAt === browser.lastSeenAt || waking.url === url)) return waking.work;
  const attempt = { url, lastSeenAt: browser.lastSeenAt, selected, work: Promise.resolve(), failed: false, finished: false };
  waking = attempt;
  const work = attempt.work = (async () => {
    const opened = await openInPreferredBrowser(url, { browser: selected, ...(backgroundStartup ? { backgroundStartup: true } : {}), current });
    // Reconnection/cancellation before dispatch is a skipped handoff, not a
    // startup error or spent opening. Never clear a newer attempt's custody.
    if (opened === null && waking === attempt) waking = null;
  })();
  try { await work; } catch (error) {
    // A wrapper timeout is not evidence that its OS handoff was skipped.
    attempt.failed = !(error && typeof error === 'object' && 'code' in error && error.code === 'BROWSER_LAUNCH_UNCONFIRMED');
    throw error;
  } finally { attempt.finished = true; }
}
export function resetBrowserStartupForTests(): void { waking = null; }
