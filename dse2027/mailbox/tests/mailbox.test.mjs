import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailboxHarness, ONE_PIXEL_PNG} from './helpers.mjs';

function fresh(t, options) {
  // Invitations intentionally expire after the 2027 admissions season. Keep the
  // test clock inside the supported cohort so these checks remain reproducible.
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-18T07:34:00.000Z')});
  const h = createMailboxHarness(options);
  t.after(() => h.close());
  return h;
}
const owner = h => h.env.OWNER_API_KEY;
const agent = h => h.env.AGENT_API_KEY;
const sql = (h, query, ...values) => h.DB.sqlite.prepare(query).all(...values).map(row => ({...row}));
const scalar = (h, query, ...values) => Object.values(h.DB.sqlite.prepare(query).get(...values))[0];
async function student(h) {
  const result = await h.request('/api/invitations', {method: 'POST', token: owner(h), body: {role: 'student'}});
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const token = new URLSearchParams(new URL(result.data.url).hash.slice(1)).get('k');
  assert.ok(token);
  return {token, id: result.data.id, url: result.data.url};
}
async function question(h, token, fields = {}) {
  const result = await h.request('/api/threads', {method: 'POST', token, body: {title: '數學複習', category: '備考', body: '這題第二步應該怎樣做？', idempotency_key: crypto.randomUUID(), ...fields}});
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function followup(h, token, threadId, fields = {}) {
  const result = await h.request(`/api/threads/${threadId}/messages`, {method: 'POST', token, body: {body: '可以解釋得再詳細一點嗎？', idempotency_key: crypto.randomUUID(), ...fields}});
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function reply(h, q, fields = {}) {
  return h.request('/api/agent/replies', {method: 'POST', token: agent(h), body: {thread_id: q.id, through_message_id: q.message_id, body: '先展開括號，再合併同類項。', ...fields}});
}
async function upload(h, token, {bytes = ONE_PIXEL_PNG, name = '題目.png', type = 'image/png'} = {}) {
  const form = new FormData();
  form.set('file', new File([bytes], name, {type}));
  return h.request('/api/attachments', {method: 'POST', token, body: form});
}
const rpc = (h, token, method, params) => h.request('/mcp', {method: 'POST', token, body: {jsonrpc: '2.0', id: 7, method, ...(params ? {params} : {})}});

test('protected endpoints reject missing or invalid credentials with 401', async t => {
  const h = fresh(t);
  for (const path of ['/api/bootstrap', '/api/profile', '/api/sync', '/api/agent/pending', '/api/agent/sync', '/api/attachments/missing']) {
    assert.equal((await h.request(path)).status, 401, path);
    assert.equal((await h.request(path, {token: 'wrong-key'})).status, 401, path);
  }
  for (const path of ['/api/threads', '/api/invitations', '/api/agent/replies', '/api/agent/sync/ack', '/api/attachments']) {
    assert.equal((await h.request(path, {method: 'POST', body: {}})).status, 401, path);
  }
  assert.equal((await h.request('/api/health')).status, 200);
});

test('raw identity headers are untrusted by default, including beside a student credential', async t => {
  const h = fresh(t);
  const headers = {'oai-authenticated-user-email': h.env.OWNER_EMAIL};
  assert.equal((await h.request('/api/bootstrap', {headers})).status, 401);
  const s = await student(h);
  const attempt = await h.request('/api/invitations', {method: 'POST', token: s.token, headers, body: {role: 'student'}});
  assert.equal(attempt.status, 403);
});

test('verified Sites identity requires the explicit trusted-dispatch configuration', async t => {
  const h = fresh(t, {env: {TRUST_SITES_IDENTITY: 'true'}});
  assert.equal((await h.request('/api/bootstrap', {headers: {'oai-authenticated-user-email': 'other@example.test'}})).status, 401);
  const result = await h.request('/api/bootstrap', {headers: {'oai-authenticated-user-email': 'OWNER@EXAMPLE.TEST'}});
  assert.equal(result.status, 200);
  assert.equal(result.data.role, 'owner');
});

test('owner invitation gives a separate student client shared reading and posting access', async t => {
  const h = fresh(t);
  const s = await student(h);
  const invitation = sql(h, 'SELECT * FROM invitations WHERE id=?', s.id)[0];
  assert.equal(invitation.role, 'student');
  assert.notEqual(invitation.token_hash, s.token);
  assert.equal(invitation.token_hash.length, 64);
  assert.equal(new URL(s.url).origin, 'https://mailbox.test');
  const boot = await h.request('/api/bootstrap', {token: s.token});
  assert.equal(boot.data.role, 'student');
  assert.equal(boot.data.profile.exam_year, 2027);
  const q = await question(h, s.token, {role: 'assistant'});
  const fromOwner = await h.request(`/api/threads/${q.id}`, {token: owner(h)});
  assert.equal(fromOwner.status, 200);
  assert.equal(fromOwner.data.messages[0].role, 'student', 'client cannot choose its author role');
  await followup(h, owner(h), q.id, {body: '【哥哥意見】可以先解釋概念。'});
  const fromSecondDevice = await h.request(`/api/threads/${q.id}`, {token: s.token});
  assert.deepEqual(fromSecondDevice.data.messages.map(m => m.role), ['student', 'owner']);
  assert.equal(fromSecondDevice.data.thread.status, 'pending');
});

test('students cannot reply as AI, read or acknowledge sync, invite others, or change owner settings', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  const attempts = [
    ['/api/agent/replies', 'POST', {thread_id: q.id, through_message_id: q.message_id, body: '假回答'}],
    ['/api/agent/pending', 'GET'], ['/api/agent/sync', 'GET'], ['/api/sync', 'GET'],
    ['/api/agent/sync/ack', 'POST', {sync_id: 1, delivery_reference: 'fake'}],
    ['/api/invitations', 'POST', {role: 'student'}],
    [`/api/invitations/${s.id}`, 'DELETE'],
    ['/api/profile', 'PUT', {exam_year: 2027, version: 2}],
    ['/api/agent/config', 'PUT', {active: true, schedule: 'hourly', schedule_id: 'fake'}],
    ['/api/agent/heartbeat', 'POST', {}],
  ];
  for (const [path, method, body] of attempts) {
    assert.equal((await h.request(path, {method, token: s.token, body})).status, 403, path);
  }
  assert.equal((await h.request('/api/threads', {method: 'POST', token: agent(h), body: {title: 'AI偽裝真人', body: '問題', idempotency_key: 'agent-human'}})).status, 403);
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 0);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 0);
});

test('revoked and expired invitation tokens cease granting access', async t => {
  const h = fresh(t);
  const first = await student(h);
  assert.equal((await h.request(`/api/invitations/${first.id}`, {method: 'DELETE', token: owner(h)})).status, 200);
  assert.equal((await h.request('/api/bootstrap', {token: first.token})).status, 401);
  const second = await student(h);
  h.DB.sqlite.prepare('UPDATE invitations SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00Z', second.id);
  assert.equal((await h.request('/api/bootstrap', {token: second.token})).status, 401);
});

test('repeated human submissions are idempotent and preserve the first accepted text', async t => {
  const h = fresh(t);
  const s = await student(h);
  const first = await question(h, s.token, {idempotency_key: 'same-question', body: '原問題'});
  const repeated = await question(h, s.token, {idempotency_key: 'same-question', body: '重送不應改寫'});
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.message_id, first.message_id);
  assert.equal(repeated.duplicate, true);
  const one = await followup(h, s.token, first.id, {idempotency_key: 'same-followup'});
  const two = await followup(h, s.token, first.id, {idempotency_key: 'same-followup'});
  assert.equal(two.message_id, one.message_id);
  assert.equal(two.duplicate, true);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM threads'), 1);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM messages'), 2);
  assert.equal(scalar(h, 'SELECT body FROM messages WHERE id=?', first.message_id), '原問題');
});

test('concurrent retries of a new question return the same result without orphan threads', async t => {
  const h = fresh(t);
  const s = await student(h);
  const payload = {title: '手機重試', body: '同一問題只提交一次', idempotency_key: 'concurrent-question'};
  let competing;
  h.DB.beforeBatch = async () => {
    competing = await h.request('/api/threads', {method: 'POST', token: s.token, body: payload});
  };
  const original = await h.request('/api/threads', {method: 'POST', token: s.token, body: payload});
  assert.equal(competing.status, 201, JSON.stringify(competing.data));
  assert.equal(original.status, 201, JSON.stringify(original.data));
  assert.equal(original.data.id, competing.data.id);
  assert.equal(original.data.message_id, competing.data.message_id);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM threads'), 1);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM messages'), 1);
});

test('AI reply atomically creates a sync item containing complete questions and the complete answer', async t => {
  const h = fresh(t);
  const s = await student(h);
  const original = '我的原問題第一行\n第二行，數學 67/100。';
  const q = await question(h, s.token, {body: original});
  const ownerNote = '哥哥補充：先處理她不懂的步驟，不改變她的目標。';
  const latest = await followup(h, owner(h), q.id, {body: ownerNote});
  const completeAnswer = '【AI 建議】\n' + '這是完整解釋，包含步驟與下一題。\n'.repeat(500) + '最後一段也必須同步。';
  const result = await reply(h, {...q, message_id: latest.message_id}, {body: completeAnswer});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const thread = (await h.request(`/api/threads/${q.id}`, {token: s.token})).data;
  assert.equal(thread.thread.status, 'replied');
  assert.equal(thread.thread.answered_through_id, latest.message_id);
  assert.equal(thread.messages.at(-1).body, completeAnswer);
  assert.equal(thread.messages.at(-1).role, 'assistant');
  const pendingSync = (await h.request('/api/agent/sync', {token: agent(h)})).data.items;
  assert.equal(pendingSync.length, 1);
  assert.equal(pendingSync[0].question_text, `【妹妹原文】\n${original}\n\n【哥哥補充】\n${ownerNote}`);
  assert.deepEqual(pendingSync[0].question_messages.map(m => m.body), [original, ownerNote]);
  assert.equal(pendingSync[0].answer_text, completeAnswer);
  assert.equal(pendingSync[0].reply_message_id, result.data.message_id);
  assert.equal(pendingSync[0].notified_at, null);
  assert.equal(pendingSync[0].delivery_reference, null);
  assert.equal((await h.request('/api/agent/pending', {token: agent(h)})).data.threads.length, 0);
});

test('a real SQL outbox failure rolls back both the reply and answered marker', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  h.DB.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END");
  assert.equal((await reply(h, q)).status, 500);
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 0);
  assert.equal(scalar(h, 'SELECT answered_through_id FROM threads WHERE id=?', q.id), 0);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 0);
  assert.equal((await h.request(`/api/threads/${q.id}`, {token: s.token})).data.thread.status, 'pending');
  h.DB.exec('DROP TRIGGER reject_outbox');
  assert.equal((await reply(h, q)).status, 200);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 1);
});

test('reply retries do not duplicate answers or sync records, including after a new follow-up', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  const first = await reply(h, q);
  const repeated = await reply(h, q, {body: '重試不能替換已回覆內容'});
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.duplicate, true);
  assert.equal(repeated.data.message_id, first.data.message_id);
  assert.equal(repeated.data.sync_id, first.data.sync_id);
  await followup(h, s.token, q.id);
  const afterFollowup = await reply(h, q);
  assert.equal(afterFollowup.status, 200);
  assert.equal(afterFollowup.data.duplicate, true);
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 1);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 1);
  assert.equal((await h.request(`/api/threads/${q.id}`, {token: s.token})).data.thread.status, 'pending');
});

test('a concurrent duplicate reply preserves the first accepted reply status and text', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  let firstAccepted;
  h.DB.beforeBatch = async () => {
    firstAccepted = await reply(h, q, {status: 'needs_info', body: '請補充試卷類型。'});
  };
  const slowDuplicate = await reply(h, q, {status: 'replied', body: '較慢的另一份回答不應覆蓋。'});
  assert.equal(firstAccepted.status, 200);
  assert.equal(slowDuplicate.status, 200);
  assert.equal(slowDuplicate.data.duplicate, true);
  assert.equal(slowDuplicate.data.message_id, firstAccepted.data.message_id);
  const data = (await h.request(`/api/threads/${q.id}`, {token: s.token})).data;
  assert.equal(data.thread.status, 'needs_info');
  assert.equal(data.messages.at(-1).body, '請補充試卷類型。');
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 1);
});

test('an older in-flight reply retry cannot move the answered cursor backwards after a newer answer', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  let latest, latestAnswer;
  h.DB.beforeBatch = async () => {
    assert.equal((await reply(h, q, {body: '第一輪已接受的回答'})).status, 200);
    latest = await followup(h, s.token, q.id, {body: '第二輪新問題'});
    latestAnswer = await reply(h, {...q, message_id: latest.message_id}, {body: '第二輪已接受的回答'});
    assert.equal(latestAnswer.status, 200);
  };
  const oldAttempt = await reply(h, q, {body: '第一輪較慢的重試'});
  assert.equal(oldAttempt.status, 200);
  assert.equal(oldAttempt.data.duplicate, true);
  const data = (await h.request(`/api/threads/${q.id}`, {token: s.token})).data;
  assert.equal(data.thread.answered_through_id, latest.message_id);
  assert.equal(data.thread.status, 'replied');
  assert.equal(data.messages.at(-1).id, latestAnswer.data.message_id);
  assert.equal(data.messages.at(-1).body, '第二輪已接受的回答');
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 2);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 2);
  assert.equal((await h.request('/api/agent/pending', {token: agent(h)})).data.threads.length, 0);
});

test('needs_info pauses the queue until a new human follow-up, then only the new question is synced', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  assert.equal((await reply(h, q, {status: 'needs_info', body: '請問這次是校內考試還是模擬試？'})).status, 200);
  assert.equal((await h.request(`/api/threads/${q.id}`, {token: s.token})).data.thread.status, 'needs_info');
  assert.equal((await h.request('/api/agent/pending', {token: agent(h)})).data.threads.length, 0);
  const latest = await followup(h, s.token, q.id, {body: '是十月校內考試，滿分100。'});
  const pending = (await h.request('/api/agent/pending', {token: agent(h)})).data;
  assert.equal(pending.profile.exam_year, 2027);
  assert.equal(pending.threads[0].thread.status, 'pending');
  assert.equal(pending.threads[0].messages.length, 3);
  assert.equal((await reply(h, {...q, message_id: latest.message_id})).status, 200);
  const outbox = (await h.request('/api/agent/sync', {token: agent(h)})).data.items;
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].question_text, '【妹妹原文】\n是十月校內考試，滿分100。');
  assert.equal(outbox[0].question_messages.length, 1);
});

test('stale through_message_id is rejected before any answer or outbox is written', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  const latest = await followup(h, s.token, q.id);
  assert.equal((await reply(h, q)).status, 409);
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 0);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 0);
  assert.equal(scalar(h, 'SELECT last_human_id FROM threads WHERE id=?', q.id), latest.message_id);
  assert.equal((await reply(h, {...q, message_id: latest.message_id})).status, 200);
});

test('a human write arriving after reply preflight prevents the stale reply inside the SQL transaction', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  let latest;
  h.DB.beforeBatch = async () => { latest = await followup(h, s.token, q.id, {body: '剛補充：題目第二個條件抄錯了。'}); };
  const result = await reply(h, q);
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(scalar(h, "SELECT COUNT(*) FROM messages WHERE role='assistant'"), 0);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM sync_outbox'), 0);
  assert.equal(scalar(h, 'SELECT answered_through_id FROM threads WHERE id=?', q.id), 0);
  assert.equal(scalar(h, 'SELECT last_human_id FROM threads WHERE id=?', q.id), latest.message_id);
});

test('notification delivery has a separate idempotent acknowledgement and never marks a new question answered', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  const answer = await reply(h, q);
  const syncId = answer.data.sync_id;
  await h.request('/api/sync', {token: owner(h)});
  await h.request('/api/agent/sync', {token: agent(h)});
  assert.equal(scalar(h, 'SELECT notified_at FROM sync_outbox WHERE id=?', syncId), null, 'reading is not delivery');
  const badAck = await h.request('/api/agent/sync/ack', {method: 'POST', token: agent(h), body: {sync_id: syncId, delivery_reference: ''}});
  assert.equal(badAck.status, 400);
  assert.equal(scalar(h, 'SELECT notified_at FROM sync_outbox WHERE id=?', syncId), null);
  const latest = await followup(h, s.token, q.id);
  const goodAck = await h.request('/api/agent/sync/ack', {method: 'POST', token: agent(h), body: {sync_id: syncId, delivery_reference: 'dot:owner-thread:delivered-message-42'}});
  assert.equal(goodAck.status, 200);
  const saved = sql(h, 'SELECT * FROM sync_outbox WHERE id=?', syncId)[0];
  assert.ok(saved.notified_at);
  assert.equal(saved.delivery_reference, 'dot:owner-thread:delivered-message-42');
  const repeat = await h.request('/api/agent/sync/ack', {method: 'POST', token: agent(h), body: {sync_id: syncId, delivery_reference: 'must-not-overwrite'}});
  assert.equal(repeat.status, 200);
  assert.equal(scalar(h, 'SELECT delivery_reference FROM sync_outbox WHERE id=?', syncId), saved.delivery_reference);
  assert.equal((await h.request('/api/agent/sync', {token: agent(h)})).data.items.length, 0);
  assert.equal((await h.request('/api/sync', {token: owner(h)})).data.items.length, 1);
  const thread = (await h.request(`/api/threads/${q.id}`, {token: s.token})).data.thread;
  assert.equal(thread.status, 'pending');
  assert.equal(thread.answered_through_id, q.message_id);
  assert.equal(thread.last_human_id, latest.message_id);
});

test('image uploads require auth, private drafts are isolated, attached images are shared and included in sync', async t => {
  const h = fresh(t);
  const s = await student(h);
  const another = await student(h);
  assert.equal((await upload(h)).status, 401);
  const file = await upload(h, s.token, {name: '../題目.png', type: 'text/plain'});
  assert.equal(file.status, 201);
  const imagePath = file.data.url;
  assert.equal((await h.request(imagePath)).status, 401);
  assert.equal((await h.request(imagePath, {token: another.token})).status, 404);
  assert.equal((await h.request(imagePath, {token: owner(h)})).status, 404);
  const draft = await h.request(imagePath, {token: s.token});
  assert.equal(draft.status, 200);
  assert.equal(draft.response.headers.get('content-type'), 'image/png', 'server detects magic bytes, not the supplied MIME');
  assert.deepEqual(draft.data, ONE_PIXEL_PNG);
  const theft = await h.request('/api/threads', {method: 'POST', token: another.token, body: {title: '偷用附件', body: '問題', idempotency_key: 'foreign-image', attachment_ids: [file.data.id]}});
  assert.equal(theft.status, 403);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM threads'), 0);
  const q = await question(h, s.token, {attachment_ids: [file.data.id]});
  assert.equal((await h.request(imagePath, {token: another.token})).status, 200);
  assert.equal((await h.request(imagePath, {token: owner(h)})).status, 200);
  const thread = (await h.request(`/api/threads/${q.id}`, {token: owner(h)})).data;
  assert.equal(thread.messages[0].attachments.length, 1);
  assert.equal(thread.messages[0].attachments[0].url, imagePath);
  assert.ok(!thread.messages[0].attachments[0].name.includes('/'));
  const reuse = await h.request('/api/threads', {method: 'POST', token: s.token, body: {title: '重用圖片', body: '問題', idempotency_key: 'reused-image', attachment_ids: [file.data.id]}});
  assert.equal(reuse.status, 403);
  assert.equal((await reply(h, q)).status, 200);
  const sync = (await h.request('/api/agent/sync', {token: agent(h)})).data.items[0];
  assert.equal(sync.question_messages[0].attachments[0].id, file.data.id);
  assert.equal(sync.question_messages[0].attachments[0].url, imagePath);
});

test('fake image content and oversized uploads are rejected without stored objects', async t => {
  const h = fresh(t);
  const s = await student(h);
  assert.equal((await upload(h, s.token, {bytes: new TextEncoder().encode('<html>not an image</html>'), name: 'fake.png'})).status, 415);
  assert.equal((await upload(h, s.token, {bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), name: 'fake.svg'})).status, 415);
  const huge = new Uint8Array(5 * 1024 * 1024 + 1);
  huge.set(ONE_PIXEL_PNG);
  assert.equal((await upload(h, s.token, {bytes: huge})).status, 413);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM attachments'), 0);
  assert.equal(h.env.BUCKET.objects.size, 0);
  const tooMany = await h.request('/api/threads', {method: 'POST', token: s.token, body: {title: '太多圖', body: '問題', idempotency_key: 'too-many-images', attachment_ids: ['1','2','3','4']}});
  assert.equal(tooMany.status, 400);
});

test('MCP discovery is public metadata only; every tool invocation needs agent or owner authorization', async t => {
  const h = fresh(t);
  const s = await student(h);
  const secret = 'PRIVATE_STUDENT_RECORD_2027_MATH_67';
  const q = await question(h, s.token, {body: secret});
  for (const method of ['initialize', 'tools/list']) {
    const discovery = await rpc(h, undefined, method);
    assert.equal(discovery.status, 200);
    const serialized = JSON.stringify(discovery.data);
    for (const privateValue of [secret, s.token, owner(h), agent(h), q.id]) assert.ok(!serialized.includes(privateValue), method);
  }
  const list = (await rpc(h, undefined, 'tools/list')).data.result.tools;
  for (const definition of list) {
    const params = {name: definition.name, arguments: {}};
    assert.equal((await rpc(h, undefined, 'tools/call', params)).status, 401, definition.name);
    assert.equal((await rpc(h, s.token, 'tools/call', params)).status, 403, definition.name);
  }
  const allowed = await rpc(h, agent(h), 'tools/call', {name: 'mailbox_read_pending', arguments: {}});
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.result.structuredContent.threads[0].messages[0].body, secret);
  const read = await rpc(h, owner(h), 'tools/call', {name: 'mailbox_read_thread', arguments: {thread_id: q.id}});
  assert.equal(read.status, 200);
  assert.equal(read.data.result.structuredContent.messages[0].body, secret);
});

test('MCP image reading requires attached images and returns the actual uploaded bytes', async t => {
  const h = fresh(t);
  const s = await student(h);
  const file = await upload(h, s.token);
  const params = {name: 'mailbox_read_image', arguments: {attachment_id: file.data.id}};
  assert.equal((await rpc(h, agent(h), 'tools/call', params)).status, 404);
  await question(h, s.token, {attachment_ids: [file.data.id]});
  const result = await rpc(h, agent(h), 'tools/call', params);
  assert.equal(result.status, 200);
  assert.equal(result.data.result.content[0].type, 'image');
  assert.equal(result.data.result.content[0].mimeType, 'image/png');
  assert.deepEqual(new Uint8Array(Buffer.from(result.data.result.content[0].data, 'base64')), ONE_PIXEL_PNG);
});

test('MCP publish and acknowledgement operate the same durable outbox as the HTTP API', async t => {
  const h = fresh(t);
  const s = await student(h);
  const q = await question(h, s.token);
  const publication = await rpc(h, agent(h), 'tools/call', {name: 'mailbox_publish_reply', arguments: {thread_id: q.id, through_message_id: q.message_id, body: '【AI 建議】完整回答'}});
  assert.equal(publication.status, 200);
  const syncId = publication.data.result.structuredContent.sync_id;
  const unsent = await rpc(h, agent(h), 'tools/call', {name: 'mailbox_read_unsent_sync', arguments: {}});
  assert.equal(unsent.data.result.structuredContent.items[0].answer_text, '【AI 建議】完整回答');
  assert.equal(unsent.data.result.structuredContent.items[0].notified_at, null);
  const receipt = await rpc(h, agent(h), 'tools/call', {name: 'mailbox_acknowledge_sync', arguments: {sync_id: syncId, delivery_reference: 'dot:delivered-message'}});
  assert.equal(receipt.status, 200);
  assert.equal((await h.request('/api/agent/sync', {token: agent(h)})).data.items.length, 0);
});

test('profile versions reject stale updates and preserve the preceding confirmed record', async t => {
  const h = fresh(t);
  const first = (await h.request('/api/profile', {token: owner(h)})).data;
  const updated = {...first, version: 2, updated_at: '2026-10-18', subjects: ['數學'], source: '妹妹確認'};
  assert.equal((await h.request('/api/profile', {method: 'PUT', token: owner(h), body: updated})).status, 200);
  assert.deepEqual(JSON.parse(scalar(h, "SELECT value FROM settings WHERE key='profile:1'")), first);
  assert.equal((await h.request('/api/profile', {method: 'PUT', token: owner(h), body: updated})).status, 409);
  assert.equal((await h.request('/api/profile', {method: 'PUT', token: owner(h), body: {...updated, version: 3, exam_year: 2028}})).status, 400);
  assert.deepEqual((await h.request('/api/profile', {token: owner(h)})).data, updated);
});

test('a heartbeat reports a check without inventing an active scheduled task', async t => {
  const h = fresh(t);
  const initial = (await h.request('/api/bootstrap', {token: owner(h)})).data.agent;
  assert.equal(initial.active, false);
  assert.equal(initial.last_checked_at, null);
  const beat = await h.request('/api/agent/heartbeat', {method: 'POST', token: agent(h)});
  assert.equal(beat.status, 200);
  assert.ok(beat.data.last_checked_at);
  assert.equal(beat.data.active, false);
  assert.equal(beat.data.schedule, null);
  const config = await h.request('/api/agent/config', {method: 'PUT', token: owner(h), body: {active: true}});
  assert.equal(config.status, 400);
});

test('CORS permits the configured frontend and rejects an unrelated origin before mutation', async t => {
  const h = fresh(t);
  const denied = await h.request('/api/invitations', {method: 'POST', token: owner(h), origin: 'https://untrusted.test', body: {role: 'student'}});
  assert.equal(denied.status, 403);
  assert.equal(scalar(h, 'SELECT COUNT(*) FROM invitations'), 0);
  const allowed = await h.request('/api/bootstrap', {token: owner(h), origin: 'https://mailbox.test'});
  assert.equal(allowed.status, 200);
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'https://mailbox.test');
  assert.equal(allowed.response.headers.get('cache-control'), 'no-store');
});
