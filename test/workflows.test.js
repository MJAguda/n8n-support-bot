import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runCode, runItems } from './harness.js';

const dir = new URL('../workflows/', import.meta.url);
const workflows = readdirSync(dir).map((f) => JSON.parse(readFileSync(new URL(f, dir))));
const byId = Object.fromEntries(workflows.map((w) => [w.id, w]));
const seed = JSON.parse(readFileSync(new URL('../store-api/seed.json', import.meta.url)));
const order = (number) => seed.orders.find((o) => o.number === number);

// --- ingestion ----------------------------------------------------------------
test('each knowledge file is split into its sections, each starting with "Title > Section"', () => {
  const files = readdirSync(new URL('../knowledge/', import.meta.url));
  const items = files.map((f) => ({
    json: { text: readFileSync(new URL(`../knowledge/${f}`, import.meta.url), 'utf8') },
    binary: { data: { fileName: f } },
  }));
  const passages = runItems('ingest-knowledge.json', 'Prepare Documents', items).map((i) => i.json);
  assert.deepEqual([...new Set(passages.map((p) => p.source))].sort(), files.sort());
  assert.ok(passages.length > files.length);

  const window = passages.find((p) => p.source === 'returns.md' && p.section === 'Return window');
  assert.equal(window.title, 'Returns and exchanges');
  assert.match(window.text, /^Returns and exchanges > Return window\n\n/);
  assert.match(window.text, /45 days of delivery/);
  assert.doesNotMatch(window.text, /Refund timing/, 'sections stay separate');

  const pickup = passages.find((p) => p.section === 'Store and pickup');
  assert.match(pickup.text, /^About us and contact > Store and pickup/);
});

test('intro text becomes an "Overview" section, titles fall back to the file name, empty files are skipped', () => {
  const passages = runItems('ingest-knowledge.json', 'Prepare Documents', [
    { json: { text: 'Open 9 to 5 on holidays.' }, binary: { data: { fileName: 'holiday-hours.md' } } },
    { json: { text: '   ' }, binary: { data: { fileName: 'empty.md' } } },
  ]).map((i) => i.json);
  assert.equal(passages.length, 1);
  assert.equal(passages[0].title, 'holiday hours');
  assert.equal(passages[0].text, 'holiday hours > Overview\n\nOpen 9 to 5 on holidays.');
});

// --- lookup_order -------------------------------------------------------------
const format = (statusCode, body) => runCode('tool-lookup-order.json', 'Format Order', [{ statusCode, body }])[0];

test('a shipped order gives carrier, tracking and delivery estimate', () => {
  const { email, ...visible } = order('TT-10432');
  const r = format(200, visible);
  assert.equal(r.found, true);
  assert.equal(r.items, 'Ridgeline 2 Tent, 2 x Trail Lantern');
  assert.match(r.summary, /UPS, tracking number 1Z999AA10123456784/);
  assert.match(r.summary, /Wed, Oct 28/);
});

test('every order status in the demo data gets a readable summary', () => {
  for (const o of seed.orders) {
    const r = format(200, o);
    assert.doesNotMatch(r.summary, /undefined|null|Invalid/, o.status);
  }
  assert.match(format(200, order('TT-10302')).summary, /Refund processing, expected by Sat, Oct 31/);
  assert.equal(format(200, order('TT-10466')).note, order('TT-10466').note);
});

test('not found says nothing about whether the order exists', () => {
  const r = format(404, { error: 'No order found with that order number and email address.' });
  assert.equal(r.found, false);
  assert.doesNotMatch(r.message, /TT-|exists|belongs/);
});

// --- create_ticket ------------------------------------------------------------
test('ticket reply gives the number and the reply time', () => {
  const [r] = runCode('tool-create-ticket.json', 'Ticket Reply', [{ id: 'TCK-1004', email: 'maya.chen@example.com' }]);
  assert.equal(r.ticket_id, 'TCK-1004');
  assert.match(r.message, /TCK-1004.*1 business day.*maya\.chen@example\.com/);
});

// --- chat -----------------------------------------------------------------------
test('the chat reply is the agent output, after the question is logged', () => {
  const [r] = runCode('support-chat.json', 'Reply', [{ id: 1 }], { 'AI Agent': [{ output: 'Hi!' }] });
  assert.deepEqual(r, { output: 'Hi!' });
  const chat = byId.SbSupportChat01;
  assert.equal(chat.connections['AI Agent'].main[0][0].node, 'Log Question');
});

test('the agent only answers policy questions from the knowledge base tool', () => {
  const agent = byId.SbSupportChat01.nodes.find((n) => n.name === 'AI Agent');
  const prompt = agent.parameters.options.systemMessage;
  for (const tool of ['knowledge_base', 'lookup_order', 'create_ticket']) assert.ok(prompt.includes(tool), tool);
  assert.match(prompt, /do not guess/i);
});

// --- wiring -----------------------------------------------------------------------
test('every sub-workflow a node calls is in the repo, with matching inputs', () => {
  for (const wf of workflows) {
    for (const n of wf.nodes.filter((n) => n.parameters.workflowId)) {
      const sub = byId[n.parameters.workflowId.value];
      assert.ok(sub, `${wf.name} → ${n.name} calls a missing workflow`);
      const trigger = sub.nodes.find((x) => x.type === 'n8n-nodes-base.executeWorkflowTrigger');
      assert.deepEqual(Object.keys(n.parameters.workflowInputs.value).sort(), trigger.parameters.workflowInputs.values.map((v) => v.name).sort());
    }
  }
});

test('connections only reference nodes that exist', () => {
  for (const wf of workflows) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, outputs] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${wf.name}: unknown source ${from}`);
      for (const links of Object.values(outputs).flat()) for (const { node } of links) assert.ok(names.has(node), `${wf.name}: unknown target ${node}`);
    }
  }
});

test('ingestion, upload and chat all use the same collection and embedding model', () => {
  const collections = new Set(), models = new Set();
  for (const wf of workflows) {
    for (const n of wf.nodes) {
      if (n.type.endsWith('vectorStoreQdrant')) collections.add(n.parameters.qdrantCollection.value);
      if (n.type.endsWith('embeddingsOllama')) models.add(n.parameters.model);
    }
  }
  assert.deepEqual([...collections], ['store-kb']);
  assert.equal(models.size, 1);
});

test('uploaded documents are prepared exactly like a full rebuild', () => {
  const prep = (id) => byId[id].nodes.find((n) => n.name === 'Prepare Documents').parameters.jsCode;
  assert.equal(prep('SbUploadDocs001'), prep('SbIngestDocs001'));
});
