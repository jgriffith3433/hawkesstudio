// Unseen messages in Talk (talk.ts markSeen, dashboard/talk.js): Claude's and Studio's messages J hasn't had on screen
// count on the conversation and on the Talk tab; J's own don't; seeing a conversation clears it, and never moves back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STUDIO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talkseen-'));

const talk = await import('../src/talk.ts');
const unseenOf = (id: string) => talk.listConversations().find((c) => c.id === id)?.unseen;

test('only assistant and Studio messages count, until J has seen them', async () => {
  const before = talk.unseenConversations();
  const id = talk.postNotice('Seen test', 'A result came in');
  assert.equal(unseenOf(id), 1, "Studio's notice is new");
  assert.equal(talk.unseenConversations(), before + 1, 'the Talk tab counts the conversation');

  const c = talk.getConversation(id)!;
  const t = c.messages[0].at + 1;
  c.messages.push({ role: 'user', text: 'thanks', at: t }, { role: 'tool', text: 'studio_backlog', tool: 'studio_backlog', at: t + 1 }, { role: 'assistant', text: 'Here it is', at: t + 2 });
  talk.saveConversation(c);
  assert.equal(unseenOf(id), 2, "J's own message and tool lines don't count");

  await new Promise((r) => setTimeout(r, 20)); // markSeen never goes past now
  const r = talk.markSeen(id, t + 2);
  assert.deepEqual(r, { unseen: 0, conversations: before });
  assert.equal(unseenOf(id), 0);

  talk.markSeen(id, 1);
  assert.equal(unseenOf(id), 0, 'seen never moves back');

  const c2 = talk.getConversation(id)!;
  c2.messages.push({ role: 'user', text: 'and?', at: t + 3 });
  talk.saveConversation(c2);
  assert.equal(unseenOf(id), 0, 'J writing adds nothing');
  assert.equal(talk.unseenConversations(), before);
});
