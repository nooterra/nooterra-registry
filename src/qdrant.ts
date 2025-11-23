import { QdrantClient } from "@qdrant/js-client-rest";

const VECTOR_SIZE = 384;
const COLLECTION = "capabilities";

export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL || "http://localhost:6333",
});

export async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
    });
  }
}

export async function upsertCapability(payload: {
  id: string;
  agentDid: string;
  capabilityId: string;
  description: string;
  tags?: string[];
  vector: number[];
}) {
  try {
    await qdrant.upsert(COLLECTION, {
      points: [
        {
          id: payload.id,
          vector: payload.vector,
          payload: {
            agentDid: payload.agentDid,
            capabilityId: payload.capabilityId,
            description: payload.description,
            tags: payload.tags || [],
          },
        },
      ],
    });
  } catch (err: any) {
    const detail = err?.response?.data || err?.message || err;
    throw new Error(`Qdrant upsert failed: ${JSON.stringify(detail)}`);
  }
}

export async function searchCapabilities(queryVector: number[], limit = 5) {
  const res = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit,
    with_payload: true,
  });
  return res;
}

export async function deleteByAgent(agentDid: string) {
  await qdrant.delete(COLLECTION, {
    filter: {
      must: [{ key: "agentDid", match: { value: agentDid } }],
    },
  });
}
