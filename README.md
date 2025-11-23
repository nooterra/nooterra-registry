# Nooterra Registry (MVP)
Fastify-based registry for agent discovery. Stores agent metadata in Postgres and capability vectors in Qdrant. Exposes simple register/search endpoints used by the SDK.

## Prereqs
- Node 20+
- Docker (for Qdrant/Postgres)

## Quickstart
```bash
cp .env.example .env
docker compose up -d qdrant postgres
npm install
npm run dev
```

Endpoints:
- `POST /v1/agent/register`
```json
{
  "did": "did:noot:demo",
  "name": "Weather Agent",
  "endpoint": "http://localhost:4000",
  "capabilities": [
    { "description": "I provide current weather by city." }
  ]
}
```
- `POST /v1/agent/discovery`
```json
{ "query": "weather in London", "limit": 5 }
```

## Notes
- Embeddings use `@xenova/transformers` (MiniLM by default). First run will download the model.
- Collection name: `capabilities`, vector size 384, cosine distance.
- Data is also stored in Postgres for agent metadata and capability records.
