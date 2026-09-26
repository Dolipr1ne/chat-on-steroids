import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const CID = 'aaaaaaaa-1111-4111-8111-111111111111', FOREIGN = 'bbbbbbbb-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ get: vi.fn(), execute: vi.fn(), remove: vi.fn(), tombstone: vi.fn(), remembered: vi.fn(),
  inputs: vi.fn(), capabilities: vi.fn(), running: vi.fn(), settling: vi.fn(), continuation: vi.fn(), goal: vi.fn(), block: vi.fn(), swarm: vi.fn() }));
vi.mock('../src/main/session/store.js', () => ({ getSession: h.get }));
vi.mock('../src/main/browser-control.js', () => ({ browserControl: { execute: h.execute } }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ multiAgent: { enabled: true } }), effectiveCapabilities: h.capabilities }));
vi.mock('../src/main/agents.js', () => ({ swarmStateForCaller: h.swarm }));
vi.mock('../src/main/mcp/call-context.js', () => ({ runningToolCalls: h.running, settlingToolCalls: h.settling, currentAgent: () => null }));
vi.mock('../src/main/session/continuation.js', () => ({ continuationForSession: h.continuation }));
vi.mock('../src/main/session/deleted-conversations.js', () => ({ conversationDeleted: h.tombstone, rememberDeletedConversation: h.remembered }));
vi.mock('../src/main/session/input.js', () => ({ listInputs: h.inputs }));
vi.mock('../src/main/session/recorder.js', () => ({ deleteRecordingAfterDrain: h.remove }));
vi.mock('../src/main/goal.js', () => ({ goalArmedFor: h.goal }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ setChatBlocked: h.block }));
const { requestSessionDeletion } = await import('../src/main/session/deletion.js');
let summary: any;
beforeEach(() => {
  vi.clearAllMocks(); summary = { id: 'session-test', startedAt: 10, conversationId: CID, chatIds: [FOREIGN, CID], activeTurnId: null };
  h.get.mockImplementation(async () => summary); h.inputs.mockResolvedValue([]); h.capabilities.mockReturnValue({ screen: true, control: true });
  h.running.mockReturnValue(0); h.settling.mockReturnValue(0); h.continuation.mockReturnValue(null); h.goal.mockReturnValue(false);
  h.tombstone.mockResolvedValue(false); h.remembered.mockResolvedValue(undefined);
  h.swarm.mockReturnValue({ agents: [] });
  h.remove.mockImplementation(async (_id, _chat, guard) => { await guard(); });
  h.execute.mockImplementation(async (_op, _args, _owner, _chat, guard) => { await guard(); return { value: { deleted: true, conversationId: CID } }; });
});
afterEach(() => vi.restoreAllMocks());

it('requires an explicit choice and does nothing after cancellation', async () => {
  const confirm = vi.fn(async () => null);
  expect(await requestSessionDeletion('session-test', confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledWith(summary, true); expect(h.execute).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
});
it('local-only deletion never invokes ChatGPT or writes a remote tombstone', async () => {
  expect(await requestSessionDeletion('session-test', async () => 'local')).toBe(true);
  expect(h.execute).not.toHaveBeenCalled(); expect(h.remembered).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledOnce();
});
it('deletes only the current provider chat and remembers its receipt before removing local history', async () => {
  expect(await requestSessionDeletion('session-test', async () => 'both')).toBe(true);
  expect(h.execute).toHaveBeenCalledWith('delete_recorded_conversation', { conversationId: CID }, 'ui-delete:session-test', CID, expect.any(Function));
  expect(h.remembered).toHaveBeenCalledExactlyOnceWith(CID);
  expect(h.remembered.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0]!);
});
it.each(['error', 'missing', 'foreign', 'false'])('preserves local history without a matching remote receipt: %s', async kind => {
  h.execute.mockResolvedValueOnce(kind === 'error' ? { error: 'transport unavailable' } : kind === 'missing' ? {} :
    { value: { deleted: kind !== 'false', conversationId: kind === 'foreign' ? FOREIGN : CID } });
  await expect(requestSessionDeletion('session-test', async () => 'both')).rejects.toThrow('not confirmed');
  expect(h.remove).not.toHaveBeenCalled(); expect(h.remembered).not.toHaveBeenCalled(); expect(h.block).not.toHaveBeenCalled();
});
it('does not repeat a previously confirmed remote deletion after local cleanup failed', async () => {
  h.tombstone.mockResolvedValueOnce(true);
  expect(await requestSessionDeletion('session-test', async () => 'both')).toBe(true);
  expect(h.execute).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledOnce();
});
it('keeps local history if the confirmed remote receipt cannot be stored', async () => {
  h.remembered.mockRejectedValueOnce(Error('disk unavailable'));
  await expect(requestSessionDeletion('session-test', async () => 'both')).rejects.toThrow('could not save'); expect(h.remove).not.toHaveBeenCalled();
});
it.each(['turn', 'tool', 'settling', 'compaction', 'goal', 'input'])('does not remove active work: %s', async kind => {
  if (kind === 'turn') summary.activeTurnId = 'live';
  if (kind === 'tool') h.running.mockReturnValue(1);
  if (kind === 'settling') h.settling.mockReturnValue(1);
  if (kind === 'compaction') h.continuation.mockReturnValue({ state: 'pending' });
  if (kind === 'goal') h.goal.mockReturnValue(true);
  if (kind === 'input') h.inputs.mockResolvedValue([{ sessionId: summary.id, state: 'queued' }]);
  const confirm = vi.fn(async () => 'both' as const);
  await expect(requestSessionDeletion('session-test', confirm)).rejects.toThrow(); expect(confirm).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled();
});
it.each(['binding', 'permission', 'new work'])('rechecks %s after the user confirmation', async kind => {
  await expect(requestSessionDeletion('session-test', async () => {
    if (kind === 'binding') summary = { ...summary, conversationId: FOREIGN };
    if (kind === 'permission') h.capabilities.mockReturnValue({ screen: true, control: false });
    if (kind === 'new work') summary = { ...summary, activeTurnId: 'new-question' };
    return 'both';
  })).rejects.toThrow(); expect(h.execute).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
});
it('coalesces repeated clicks on one recording instead of confirming or deleting twice', async () => {
  let finish!: (value: any) => void; const confirm = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const first = requestSessionDeletion('session-test', confirm);
  expect(requestSessionDeletion('session-test', confirm)).toBe(first);
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce()); finish('local'); expect(await first).toBe(true);
  expect(h.remove).toHaveBeenCalledOnce();
});
it('local cleanup failure does not clear an existing chat block', async () => {
  h.remove.mockRejectedValueOnce(Error('removal failed'));
  await expect(requestSessionDeletion('session-test', async () => 'local')).rejects.toThrow('removal failed'); expect(h.block).not.toHaveBeenCalled();
});

it('preserves an owning prime while its workers still hold live slots', async () => {
  h.swarm.mockReturnValue({ agents: [{ role: 'worker', state: 'active', conversationId: FOREIGN }] });
  await expect(requestSessionDeletion('session-test', async () => 'both')).rejects.toThrow('work');
  expect(h.swarm).toHaveBeenCalledWith({ conversationId: CID }); expect(h.execute).not.toHaveBeenCalled();
});

it('does not borrow a different family or sibling state to block a settled worker recording', async () => {
  h.swarm.mockReturnValue({ agents: [{ role: 'worker', state: 'sleeping', conversationId: CID }, { role: 'worker', state: 'active', conversationId: FOREIGN }] });
  expect(await requestSessionDeletion('session-test', async () => 'local')).toBe(true);
});

it('retires the original main-window authority before handing anything to the browser', async () => {
  let current = true;
  await expect(requestSessionDeletion('session-test', async () => { current = false; return 'both'; }, () => false,
    () => { if (!current) throw Error('Original window retired'); })).rejects.toThrow('retired');
  expect(h.execute).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
});
