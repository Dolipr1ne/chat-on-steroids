import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { rememberDeletedConversation } from '../src/main/session/deleted-conversations.js';
import { deleteRecordingAfterDrain, liveConversations, recordChatObservations, recordRequestEvidence,
  resetRecorderForTests, restoreRecordedConversation, sessionForConversation } from '../src/main/session/recorder.js';
import { initSessionStore, getSession, readEvents, resetSessionStoreForTests, flushSessions, findSessionByConversation } from '../src/main/session/store.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';

const CID = 'aaaaaaaa-1111-4111-8111-111111111111', OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-delete-recording-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetRecorderForTests();
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks(); await flushSessions(); await flushDurable(); resetRecorderForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
const message = (id = 'question', text = 'Synthetic original question') => ({ kind: 'user_message' as const, time: Date.now(), messageId: id, text });

it.each([false, true])('does not resurrect a confirmed web deletion from late transcript or ownership evidence (restart=%s)', async restart => {
  const original = await recordChatObservations(CID, [message()]);
  expect(original.sessionId).toBeTruthy();
  await rememberDeletedConversation(CID);
  await deleteRecordingAfterDrain(original.sessionId!, CID, async () => { expect(await getSession(original.sessionId!)).not.toBeNull(); });
  if (restart) { await flushSessions(); await flushDurable(); resetRecorderForTests(); resetSessionStoreForTests(); }
  expect(await recordChatObservations(CID, [message('late', 'Delayed browser journal')])).toMatchObject({ sessionId: null, stored: 0 });
  expect(await recordRequestEvidence(CID, [])).toBeNull();
  expect(await sessionForConversation(CID)).toBeNull(); expect(await restoreRecordedConversation(CID)).toBeNull();
  expect(await findSessionByConversation(CID)).toBeNull();
  expect(liveConversations().some(item => item.conversationId === CID)).toBe(false);
  expect((await recordChatObservations(OTHER, [message()])).stored).toBeGreaterThan(0);
});

it('local-only removal can be recorded anew from the still-existing web chat, without recreating a half-session', async () => {
  const original = await recordChatObservations(CID, [message()]);
  await deleteRecordingAfterDrain(original.sessionId!, CID, async () => {});
  const later = await recordChatObservations(CID, [message()]);
  expect(later.sessionId).not.toBe(original.sessionId);
  expect(await getSession(later.sessionId!)).toMatchObject({ conversationId: CID, userMessages: 1 });
  expect(await getSession(original.sessionId!)).toBeNull();
});

it('joins the exact in-flight transcript before removing its recording', async () => {
  const original = await recordChatObservations(CID, [message()]);
  const gate = faultGate(), rename = fs.rename.bind(fs); let once = true;
  const messages = path.join(directory, 'sessions', original.sessionId!, 'messages') + path.sep;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (once && String(to).startsWith(messages)) { once = false; await gate.hold(); }
    return rename(from, to);
  });
  const pending = recordChatObservations(CID, [message('before-deletion', 'Accepted before deletion')]);
  await gate.entered;
  await rememberDeletedConversation(CID);
  let removed = false; const deletion = deleteRecordingAfterDrain(original.sessionId!, CID, async () => {}).then(() => { removed = true; });
  await Promise.resolve(); expect(removed).toBe(false);
  const late = recordChatObservations(CID, [message('after-deletion', 'Not new history')]);
  gate.release(); await pending; await deletion; spy.mockRestore();
  expect(await late).toMatchObject({ sessionId: null, stored: 0 });
  expect(await getSession(original.sessionId!)).toBeNull();
  await expect(fs.stat(path.join(directory, 'sessions', original.sessionId!))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('failed removal does not forget the live mapping or unblock new recording into a different session', async () => {
  const original = await recordChatObservations(CID, [message()]);
  const remove = fs.rm.bind(fs), target = path.join(directory, 'sessions', original.sessionId!);
  const spy = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === target) throw Error('Synthetic local removal failure');
    return remove(file, options);
  });
  await expect(deleteRecordingAfterDrain(original.sessionId!, CID, async () => {})).rejects.toThrow('Synthetic'); spy.mockRestore();
  expect(await sessionForConversation(CID)).toBe(original.sessionId);
  expect(await getSession(original.sessionId!)).not.toBeNull();
  expect((await readEvents(original.sessionId!, { kinds: ['user_message'] }))[0]).toMatchObject({ message: { text: 'Synthetic original question' } });
});
