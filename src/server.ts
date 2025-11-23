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
    return reply
      .status(400)
      .send({ error: parse.error.flatten(), message: "Invalid register payload" });
  }
  const { did, name, endpoint, capabilities } = parse.data;

  try {
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
  } catch (err: any) {
    app.log.error({ err }, "register error");
    return reply.status(500).send({ error: err.message || "Internal error", statusCode: 500 });
  }
});

const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(50).optional(),
});

app.post("/v1/agent/discovery", async (request, reply) => {
  const parse = searchSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.status(400).send({ error: parse.error.flatten(), message: "Invalid search payload" });
  }
  const { query, limit = 5 } = parse.data;
  const vector = await embed(query);
  const hits = await searchCapabilities(vector, limit);

  const agents: Record<string, { did: string; name: string | null; endpoint: string | null }> = {};
  if (hits.length) {
    const dids = hits
      .map((h: any) => h.payload?.agentDid)
      .filter((v: unknown): v is string => typeof v === "string");
    if (dids.length) {
      const rows = await pool.query<{ did: string; name: string | null; endpoint: string | null }>(
        `select did, name, endpoint from agents where did = any($1::text[])`,
        [dids]
      );
      rows.rows.forEach((row: { did: string; name: string | null; endpoint: string | null }) => {
        agents[row.did] = { did: row.did, name: row.name, endpoint: row.endpoint ?? null };
      });
    }
  }

  const results = hits.map((hit: any) => {
    const agentDid = typeof hit.payload?.agentDid === "string" ? hit.payload.agentDid : undefined;
    const capabilityId =
      typeof hit.payload?.capabilityId === "string" ? hit.payload.capabilityId : undefined;
    const description =
      typeof hit.payload?.description === "string" ? hit.payload.description : undefined;
    const tags = Array.isArray(hit.payload?.tags) ? hit.payload.tags : undefined;

    return {
      score: hit.score,
      agentDid,
      capabilityId,
      description,
      tags,
      agent: agentDid ? agents[agentDid] || null : null,
    };
  });

  return reply.send({ results });
});

app.setErrorHandler((err, _req, reply) => {
  // Log full error and return structured JSON
  app.log.error(err);
  const status = (err as any).statusCode || 500;
  return reply.status(status).send({
    error: err.message,
    statusCode: status,
    validation: (err as any).validation,
  });
});

app.get("/health", async (_req, reply) => {
  return reply.send({ ok: true });
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Registry running on ${port}`);
});
