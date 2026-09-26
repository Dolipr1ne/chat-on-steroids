import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, resetDurableForTests, readDurable, flushDurable } from '../src/main/durable.js';
import { conversationDeleted, rememberDeletedConversation, resetDeletedConversationsForTests } from '../src/main/session/deleted-conversations.js';
let directory: string;
const id = 'aaaaaaaa-1111-4111-8111-111111111111', other = 'bbbbbbbb-2222-4222-8222-222222222222';
beforeEach(async () => { directory = await makeTempDir('cos-deletion-ledger-'); initDurableStore(directory); resetDeletedConversationsForTests(); });
afterEach(async () => { vi.restoreAllMocks(); await flushDurable(); resetDurableForTests(); resetDeletedConversationsForTests(); await removeTempDir(directory); });
it('records only a validated exact conversation and retains it across restart', async () => {
  expect(await conversationDeleted(id)).toBe(false); await rememberDeletedConversation(id); resetDeletedConversationsForTests();
  expect(await conversationDeleted(id)).toBe(true); expect(await conversationDeleted(other)).toBe(false);
  expect(await readDurable('deleted-conversations')).toEqual({ version: 1, ids: [id] });
});
it('serializes separate confirmations without losing either receipt', async () => {
  await Promise.all([rememberDeletedConversation(id), rememberDeletedConversation(other), rememberDeletedConversation(id)]);
  expect((await readDurable<any>('deleted-conversations'))?.ids).toEqual([id, other]);
});
it('refuses malformed identities before creating a deletion ledger', async () => {
  await expect(rememberDeletedConversation('../../foreign')).rejects.toThrow('Invalid');
  expect(await readDurable('deleted-conversations')).toBeNull();
});
it.each(['not json', '{"version":9,"ids":[]}', '{"version":1,"ids":["not-a-chat"]}'])('does not turn corrupt receipt storage into forgotten deletions', async value => {
  await fs.mkdir(path.join(directory, 'state'), { recursive: true }); await fs.writeFile(path.join(directory, 'state/deleted-conversations.json'), value);
  await expect(conversationDeleted(id)).rejects.toThrow();
});
it('does not publish a receipt before its rename succeeds', async () => {
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Error('synthetic disk failure'));
  await expect(rememberDeletedConversation(id)).rejects.toThrow('synthetic');
  expect(await conversationDeleted(id)).toBe(false); rename.mockRestore();
  await rememberDeletedConversation(id); expect(await conversationDeleted(id)).toBe(true);
});

it('an early uninitialized read cannot hide existing receipts once storage becomes available', async () => {
  await rememberDeletedConversation(id); await flushDurable();
  resetDurableForTests(); resetDeletedConversationsForTests();
  expect(await conversationDeleted(id)).toBe(false);
  initDurableStore(directory);
  expect(await conversationDeleted(id)).toBe(true);
});
