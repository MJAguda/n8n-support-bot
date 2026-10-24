// Checks retrieval quality without any LLM: embeds each test question with the same Ollama model the bot uses,
// searches Qdrant, and checks the document that holds the answer is in the top results.
// Needs the stack running and the knowledge base ingested. Usage: npm run eval:retrieval
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const QDRANT = process.env.QDRANT_URL || 'http://localhost:6333';
const MODEL = 'nomic-embed-text:v1.5';
const COLLECTION = 'store-kb';
const TOP_K = 3;

// Phrased the way customers write, not the way the documents do.
export const cases = [
  ['How long do I have to send something back?', 'returns.md'],
  ['Do I have to pay for return shipping?', 'returns.md'],
  ['Is shipping free?', 'shipping.md'],
  ['Can you send my order to Hawaii?', 'shipping.md'],
  ['Do you deliver to Canada?', 'shipping.md'],
  ['My boots feel tight, should I size up?', 'size-guide.md'],
  ['What size jacket fits a 40 inch chest?', 'size-guide.md'],
  ['How do I wash my down sleeping bag?', 'product-care.md'],
  ['The zipper on my Tide & Trail tent broke after a month, is that covered?', 'warranty.md'],
  ['Can I pay in installments?', 'payments-promos.md'],
  ['The jacket I bought last week is cheaper now, can I get the difference back?', 'payments-promos.md'],
  ['Can I use two discount codes?', 'payments-promos.md'],
  ['I need to cancel my order I placed 20 minutes ago', 'orders-faq.md'],
  ['My package arrived but one item is missing', 'orders-faq.md'],
  ['Can I pick up my order at your store?', 'about-contact.md'],
  ['What is your phone number?', 'about-contact.md'],
];

async function embed(text) {
  const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: MODEL, input: text }) });
  if (!res.ok) throw new Error(`Ollama: ${res.status} ${await res.text()}`);
  return (await res.json()).embeddings[0];
}

async function search(vector) {
  const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit: TOP_K, with_payload: true }),
  });
  if (!res.ok) throw new Error(`Qdrant: ${res.status} ${await res.text()} (run npm run ingest first?)`);
  return (await res.json()).result;
}

let hits = 0, firstPlace = 0;
for (const [question, expected] of cases) {
  const results = await search(await embed(question));
  const sources = results.map((r) => r.payload.metadata.source);
  const rank = sources.indexOf(expected) + 1;
  if (rank) hits++;
  if (rank === 1) firstPlace++;
  console.log(`${rank ? '✔' : '✘'} ${question}`);
  console.log(`    ${rank ? `found ${expected} at #${rank}` : `expected ${expected}, got ${sources.join(', ')}`} (score ${results[0]?.score.toFixed(3)})`);
}
console.log(`\nTop-${TOP_K} hit rate: ${hits}/${cases.length}, ranked first: ${firstPlace}/${cases.length}`);
process.exit(hits === cases.length ? 0 : 1);
