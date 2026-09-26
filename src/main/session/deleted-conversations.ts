import { durableStoreReady, readDurable, writeDurableNow } from '../durable.js';

/** Confirmed provider deletions only. This never grants tool or browser authority. */
const STATE = 'deleted-conversations';
const MAX_IDS = 20_000;
const valid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
let ids = new Set<string>();
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let epoch = 0;

export function restoreDeletedConversations(): Promise<void> {
  // An early diagnostic/test read must not cache "no ledger" before startup has
  // attached the real durable directory.
  if (!durableStoreReady()) return Promise.resolve();
  if (!loading) {
    const generation = epoch;
    loading = (async () => {
      const saved = await readDurable<{ version: number; ids: unknown }>(STATE, { strict: true });
      if (generation !== epoch) throw new Error('Deletion receipt storage changed.');
      if (saved === null) { ids = new Set(); return; }
      if (saved.version !== 1 || !Array.isArray(saved.ids) || saved.ids.length > MAX_IDS || !saved.ids.every(valid))
        throw new Error('The deletion receipt ledger is invalid. Existing recordings were left unchanged.');
      ids = new Set(saved.ids);
    })();
  }
  return loading;
}

export async function conversationDeleted(conversationId: string): Promise<boolean> {
  await restoreDeletedConversations();
  return ids.has(conversationId);
}

/** Publish only after the durable barrier. Failure retains the local recording. */
export function rememberDeletedConversation(conversationId: string): Promise<void> {
  if (!valid(conversationId)) return Promise.reject(new Error('Invalid deleted conversation identity.'));
  const generation = epoch;
  const work = writes.then(async () => {
    await restoreDeletedConversations();
    if (generation !== epoch || !durableStoreReady()) throw new Error('Deletion receipt storage is unavailable.');
    if (ids.has(conversationId)) return;
    if (ids.size >= MAX_IDS) throw new Error('Deletion receipt storage is full. The local recording was preserved.');
    const next = new Set(ids); next.add(conversationId);
    await writeDurableNow(STATE, { version: 1, ids: [...next] });
    if (generation !== epoch) throw new Error('Deletion receipt storage changed.');
    ids = next;
  });
  writes = work.catch(() => undefined);
  return work;
}

export function resetDeletedConversationsForTests(): void {
  epoch++; ids = new Set(); loading = null; writes = Promise.resolve();
}
