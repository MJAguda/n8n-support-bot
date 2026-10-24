// Rebuilds the knowledge base from knowledge/*.md: clears the Qdrant collection and re-embeds every file.
// Usage: npm run ingest
const url = process.env.INGEST_URL || 'http://localhost:5678/webhook/ingest-knowledge';
const res = await fetch(url, { method: 'POST' });
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.documents) {
  console.error('Ingestion failed:', res.status, JSON.stringify(body));
  process.exit(1);
}
console.log(`Indexed ${body.documents} documents as ${body.passages} passages: ${body.files.join(', ')}`);
