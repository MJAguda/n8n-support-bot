import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createStore, orderKey, questionKey } from '../store-api/server.js';

let server, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'store-api-'));
  server = createApp(createStore(dir)).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('order numbers match however they are typed', () => {
  for (const s of ['TT-10432', '#tt 10432', '10432', 'TT10432']) assert.equal(orderKey(s), '10432', s);
});

test('looks up an order when the number and email match', async () => {
  const { status, body } = await get('/orders/%23TT-10432?email=Maya.Chen@example.com');
  assert.equal(status, 200);
  assert.equal(body.status, 'shipped');
  assert.equal(body.tracking_number, '1Z999AA10123456784');
  assert.equal(body.email, undefined, 'the email is never echoed back');
});

test('a wrong email gets the same answer as a missing order', async () => {
  const wrongEmail = await get('/orders/TT-10432?email=someone.else@example.com');
  const missing = await get('/orders/TT-99999?email=maya.chen@example.com');
  const noEmail = await get('/orders/TT-10432');
  for (const r of [wrongEmail, missing, noEmail]) {
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, missing.body);
  }
});

test('creates tickets with sequential ids and lists them', async () => {
  const a = await post('/tickets', { session_id: 's1', category: 'refund_request', reason: 'Wants a refund over $200', question: 'Refund my tent?' });
  const b = await post('/tickets', { session_id: 's2', category: 'other', reason: 'Asked for a person' });
  assert.equal(a.status, 201);
  assert.match(a.body.id, /^TCK-\d{4}$/);
  assert.notEqual(a.body.id, b.body.id);
  const list = await get('/tickets');
  assert.ok(list.body.some((t) => t.id === a.body.id && t.status === 'open'));
});

test('stats count questions, escalations and the most common knowledge gaps', async () => {
  await post('/questions', { session_id: 's3', question: 'Do you ship to Canada?', answer: '...' });
  await post('/questions', { session_id: 's4', question: 'do you ship to canada', answer: '...' });
  await post('/tickets', { session_id: 's3', category: 'not_in_knowledge_base', question: 'Do you ship to Canada?' });
  await post('/tickets', { session_id: 's4', category: 'not_in_knowledge_base', question: 'do you ship to canada' });
  await post('/tickets', { session_id: 's5', category: 'not_in_knowledge_base', question: 'Can I pick up in store?' });
  const { body } = await get('/stats');
  assert.equal(body.questions, 2);
  assert.ok(body.conversations_escalated >= 3);
  assert.equal(body.knowledge_gaps[0].count, 2);
  assert.match(body.knowledge_gaps[0].question, /canada/i);
  assert.equal(body.tickets_by_category.not_in_knowledge_base, 3);
});

test('data survives a restart', async () => {
  const before = createStore(dir).tickets().length;
  assert.ok(before >= 5);
});

test('questionKey ignores case and punctuation', () => {
  assert.equal(questionKey('Do you ship to Canada?!'), questionKey('do you ship to   canada'));
});

test('bad JSON is a 400, unknown routes a 404', async () => {
  const bad = await fetch(base + '/tickets', { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await get('/nothing')).status, 404);
});
