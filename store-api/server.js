// Stand-in for the store's order system and helpdesk, so the demo runs without Shopify or Zendesk accounts.
// In a client build, the n8n HTTP nodes point at the real APIs instead.
//   GET  /orders/:number?email=   order status, only when the email matches
//   POST /tickets, GET /tickets   support tickets created by the bot
//   POST /questions               every question the bot was asked
//   GET  /stats                   answered vs escalated, and the most common questions the docs don't cover
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SEED = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8'));

// "#TT-10432", "tt 10432" and "10432" are the same order.
export const orderKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^TT/, '');
const emailKey = (s) => String(s ?? '').trim().toLowerCase();
// Groups questions that differ only in case, punctuation or spacing.
export const questionKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function createStore(dataDir) {
  const file = dataDir && join(dataDir, 'store.json');
  const state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { tickets: [], questions: [] };
  const save = () => {
    if (!file) return;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  };

  return {
    findOrder(number, email) {
      const order = SEED.orders.find((o) => orderKey(o.number) === orderKey(number));
      // Same answer for "no such order" and "wrong email", so order numbers can't be probed.
      if (!order || !email || emailKey(order.email) !== emailKey(email)) return null;
      const { email: _hidden, ...visible } = order;
      return visible;
    },
    addTicket(body) {
      const ticket = {
        id: 'TCK-' + String(state.tickets.length + 1001),
        created_at: new Date().toISOString(),
        status: 'open',
        session_id: body.session_id ?? null,
        name: body.name ?? null,
        email: body.email ?? null,
        category: body.category ?? 'other',
        reason: body.reason ?? '',
        question: body.question ?? '',
        transcript: body.transcript ?? '',
      };
      state.tickets.push(ticket);
      save();
      return ticket;
    },
    tickets: () => state.tickets,
    addQuestion(body) {
      const entry = { at: new Date().toISOString(), session_id: body.session_id ?? null, question: body.question ?? '', answer: body.answer ?? '' };
      state.questions.push(entry);
      save();
      return entry;
    },
    stats() {
      const questions = state.questions.length;
      const escalated = new Set(state.tickets.map((t) => t.session_id)).size;
      const gaps = {};
      for (const t of state.tickets.filter((t) => t.category === 'not_in_knowledge_base')) {
        const key = questionKey(t.question);
        gaps[key] ??= { question: t.question, count: 0 };
        gaps[key].count++;
      }
      return {
        questions,
        tickets: state.tickets.length,
        conversations_escalated: escalated,
        tickets_by_category: state.tickets.reduce((acc, t) => ({ ...acc, [t.category]: (acc[t.category] ?? 0) + 1 }), {}),
        knowledge_gaps: Object.values(gaps).sort((a, b) => b.count - a.count).slice(0, 10),
      };
    },
  };
}

const MAX_BODY = 256 * 1024;

export function createApp(store) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw Object.assign(new Error('Body must be JSON'), { status: 400 });
    }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

      const order = url.pathname.match(/^\/orders\/([^/]+)$/);
      if (req.method === 'GET' && order) {
        const found = store.findOrder(decodeURIComponent(order[1]), url.searchParams.get('email'));
        return found ? send(res, 200, found) : send(res, 404, { error: 'No order found with that order number and email address.' });
      }
      if (req.method === 'POST' && url.pathname === '/tickets') return send(res, 201, store.addTicket(await readJson(req)));
      if (req.method === 'GET' && url.pathname === '/tickets') return send(res, 200, store.tickets());
      if (req.method === 'POST' && url.pathname === '/questions') return send(res, 201, store.addQuestion(await readJson(req)));
      if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, store.stats());
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || 3000);
  createApp(createStore(process.env.DATA_DIR || '/data')).listen(port, () => console.log(`store-api listening on :${port}`));
}
