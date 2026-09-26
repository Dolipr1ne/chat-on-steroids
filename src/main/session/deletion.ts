import type { SessionSummary } from '../../shared/session.js';
import { browserControl } from '../browser-control.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { runningToolCalls, settlingToolCalls } from '../mcp/call-context.js';
import { continuationForSession } from './continuation.js';
import { conversationDeleted, rememberDeletedConversation } from './deleted-conversations.js';
import { listInputs } from './input.js';
import { deleteRecordingAfterDrain } from './recorder.js';
import { getSession } from './store.js';
import { goalArmedFor } from '../goal.js';
import { setChatBlocked } from './blocked-chats.js';
import { logInfo } from '../logger.js';
import { swarmStateForCaller } from '../agents.js';

export type DeletionScope = 'local' | 'both';
type Confirm = (summary: SessionSummary, hasWebChat: boolean) => Promise<DeletionScope | null>;
const flights = new Map<string, Promise<boolean>>();
const validChat = (id: unknown): id is string => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
const identity = (s: SessionSummary) => JSON.stringify([s.id, s.startedAt, s.conversationId, s.chatIds]);

/** One explicit confirmation owns one local recording and its current provider chat.
 * Older Compact & Resume frontends are never silently bulk-deleted. */
export function requestSessionDeletion(id: string, confirm: Confirm,
  isWorking: (summary: SessionSummary) => boolean = () => false,
  validateOwner: () => void = () => {}): Promise<boolean> {
  const existing = flights.get(id);
  if (existing) return existing;
  if (flights.size) return Promise.reject(new Error('Finish the open deletion request first.'));
  const work = (async () => {
    const original = await getSession(id);
    if (!original) return false;
    const signature = identity(original), conversationId = original.conversationId;
    const busy = (current: SessionSummary): boolean => {
      if (current.activeTurnId || isWorking(current) || continuationForSession(id) ||
          (conversationId && (runningToolCalls(conversationId) || settlingToolCalls(conversationId) || goalArmedFor(conversationId)))) return true;
      if (conversationId && getConfig().multiAgent?.enabled) {
        const agents = swarmStateForCaller({ conversationId }).agents;
        const member = agents.find(agent => agent.role === 'worker' && agent.conversationId === conversationId);
        return agents.some(agent => agent.role === 'worker' && (!member || agent === member) &&
          ['invited', 'waking', 'active', 'detached'].includes(agent.state));
      }
      return false;
    };
    const guard = async (remote: boolean): Promise<SessionSummary> => {
      validateOwner();
      const current = await getSession(id);
      if (!current || identity(current) !== signature)
        throw new Error('The conversation changed during deletion. Nothing else was deleted.');
      if (busy(current))
        throw new Error('Stop this chat and its automation, then wait for local work to finish before deleting it.');
      if ((await listInputs()).some(row => (row.sessionId ?? row.deliveredSessionId) === id &&
          ['queued', 'browser', 'tool', 'decision'].includes(row.state)))
        throw new Error('This chat has pending messages. Finish or cancel them before deleting it.');
      // The reads above may have yielded to a new turn or a continuation commit.
      const latest = await getSession(id);
      validateOwner();
      if (!latest || identity(latest) !== signature || busy(latest))
        throw new Error('The chat changed while deletion was being checked. Its recording was preserved.');
      if (remote) {
        const caps = effectiveCapabilities(getConfig());
        if (!caps.screen || !caps.control)
          throw new Error('Enable browser observation and control to delete the native ChatGPT conversation. Local-only deletion is separate.');
      }
      return latest;
    };
    await guard(false);
    const scope = await confirm(original, validChat(conversationId));
    if (scope === null) return false;
    if (scope !== 'local' && scope !== 'both') throw new Error('Invalid deletion choice.');
    await guard(scope === 'both');
    if (scope === 'both') {
      if (!validChat(conversationId)) throw new Error('This recording has no current ChatGPT conversation.');
      if (!await conversationDeleted(conversationId)) {
        const result = await browserControl.execute('delete_recorded_conversation', { conversationId },
          `ui-delete:${id}`, conversationId, async () => { await guard(true); return true; });
        const value = result.value as { deleted?: boolean; conversationId?: string } | undefined;
        if (result.error || value?.deleted !== true || value.conversationId !== conversationId)
          throw new Error('ChatGPT deletion was not confirmed. The local recording was kept. Check the web chat before trying again.');
        // A crash or delayed browser journal must not recreate a successfully deleted chat.
        try { await rememberDeletedConversation(conversationId); }
        catch { throw new Error('ChatGPT confirmed deletion, but CoS could not save its receipt. The local recording was kept; check the web chat before retrying.'); }
      }
    }
    try { await deleteRecordingAfterDrain(id, conversationId, async () => { await guard(false); }); }
    catch (error) {
      if (scope === 'both') throw new Error('ChatGPT deletion was confirmed, but local cleanup did not finish. The saved receipt prevents repeating the web deletion; retry local cleanup after work has settled.');
      throw error;
    }
    if (conversationId) setChatBlocked(conversationId, false);
    logInfo(`session ${id} deleted scope=${scope}`);
    return true;
  })();
  flights.set(id, work);
  void work.finally(() => { if (flights.get(id) === work) flights.delete(id); }).catch(() => undefined);
  return work;
}
