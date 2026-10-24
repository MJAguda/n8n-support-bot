#!/usr/bin/env bash
# Starts the stack, downloads the embedding model, loads credentials and workflows, and indexes the knowledge base.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Copy .env.example to .env and fill it in first."; exit 1; }
set -a; source .env; set +a

docker compose up -d --build
echo "Downloading the embedding model (first run only, about 270 MB)..."
docker compose wait ollama-pull >/dev/null
echo "Waiting for n8n..."
until curl -sf http://localhost:5678/healthz >/dev/null; do sleep 2; done

# Credentials are written to a git-ignored folder, imported, then deleted.
mkdir -p .setup
trap 'rm -rf .setup' EXIT
node -e '
const e = process.env;
const creds = [
  { id: "sbQdrant0001", name: "Qdrant", type: "qdrantApi", data: { qdrantUrl: "http://qdrant:6333", apiKey: "" } },
  { id: "sbOllama0001", name: "Ollama", type: "ollamaApi", data: { baseUrl: "http://ollama:11434" } },
  e.GROQ_API_KEY && { id: "sbGroq000001", name: "Groq", type: "groqApi", data: { apiKey: e.GROQ_API_KEY } },
].filter(Boolean);
require("fs").writeFileSync(".setup/credentials.json", JSON.stringify(creds));
console.log("Credentials:", creds.map((c) => c.name).join(", "));
'
docker compose exec -T n8n n8n import:credentials --input=/project/.setup/credentials.json
docker compose exec -T n8n n8n import:workflow --separate --input=/project/workflows

# n8n only runs published workflows, and only calls published sub-workflows.
for id in SbToolOrder0001 SbToolTicket001 SbIngestDocs001 SbUploadDocs001 SbSupportChat01; do
  docker compose exec -T n8n n8n publish:workflow --id=$id
done
docker compose restart n8n >/dev/null
until curl -sf http://localhost:5678/healthz >/dev/null; do sleep 2; done
sleep 5

node scripts/ingest.js

cat <<MSG

Done.
  Store site with chat:  http://localhost:8081
  n8n editor:            http://localhost:5678
  Add a document:        http://localhost:5678/form/add-document
  Knowledge-gap stats:   http://localhost:3002/stats
MSG
