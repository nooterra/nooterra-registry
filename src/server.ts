import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { z } from "zod";
import { pool, migrate } from "./db.js";
import { embed } from "./embeddings.js";
import { ensureCollection, upsertCapability, searchCapabilities, deleteByAgent } from "./qdrant.js";
import { randomUUID, createHash } from "crypto";

dotenv.config();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

await migrate();
await ensureCollection();

const capabilitySchema = z.object({
  capabilityId: z.string().optional(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
});

const registerSchema = z.object({
  did: z.string(),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  capabilities: z.array(capabilitySchema).min(1),
});

app.post("/v1/agent/register", async (request, reply) => {
  const parse = registerSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.status(400).send({ error: parse.error.flatten() });
  }
  const { did, name, endpoint, capabilities } = parse.data;

  await pool.query(
    `insert into agents (did, name, endpoint) values ($1, $2, $3)
     on conflict (did) do update set name = excluded.name, endpoint = excluded.endpoint`,
    [did, name || null, endpoint || null]
  );

  // replace capabilities for this agent
  await pool.query(`delete from capabilities where agent_did = $1`, [did]);
  await deleteByAgent(did);

  for (const cap of capabilities) {
    const capId = cap.capabilityId || randomUUID();
    const vector = await embed(cap.description);
    await upsertCapability({
      id: createHash("sha256").update(did + capId).digest("hex"),
      agentDid: did,
      capabilityId: capId,
      description: cap.description,
      tags: cap.tags,
      vector,
    });
    await pool.query(
      `insert into capabilities (agent_did, capability_id, description, tags)
       values ($1, $2, $3, $4)`,
      [did, capId, cap.description, cap.tags || []]
    );
  }

  return reply.send({ ok: true, registered: capabilities.length });
});

const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(50).optional(),
});

app.post("/v1/agent/discovery", async (request, reply) => {
  const parse = searchSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.status(400).send({ error: parse.error.flatten() });
  }
  const { query, limit = 5 } = parse.data;
  const vector = await embed(query);
  const hits = await searchCapabilities(vector, limit);

  const agents: Record<string, { did: string; name: string | null; endpoint: string | null }> = {};
  if (hits.length) {
    const dids = hits.map((h) => h.payload?.agentDid).filter(Boolean) as string[];
    if (dids.length) {
      const rows = await pool.query(
        `select did, name, endpoint from agents where did = any($1::text[])`,
        [dids]
      );
      rows.rows.forEach((row) => {
        agents[row.did] = { did: row.did, name: row.name, endpoint: row.endpoint };
      });
    }
  }

  const results = hits.map((hit) => ({
    score: hit.score,
    agentDid: hit.payload?.agentDid,
    capabilityId: hit.payload?.capabilityId,
    description: hit.payload?.description,
    tags: hit.payload?.tags,
    agent: hit.payload?.agentDid ? agents[hit.payload.agentDid] || null : null,
  }));

  return reply.send({ results });
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Registry running on ${port}`);
});
