import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { z } from "zod";
import { pool, migrate } from "./db.js";
import { embed } from "./embeddings.js";
import { ensureCollection, upsertCapability, searchCapabilities, deleteByAgent, qdrant } from "./qdrant.js";
import { randomUUID } from "crypto";
import pino from "pino";
import { normalizeEndpoint, verifyACARD, ACARD } from "./acard.js";

dotenv.config();

const API_KEY = process.env.REGISTRY_API_KEY;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const SIM_WEIGHT = Number(process.env.SEARCH_WEIGHT_SIM || 0.7);
const REP_WEIGHT = Number(process.env.SEARCH_WEIGHT_REP || 0.25);
const AVAIL_WEIGHT = Number(process.env.SEARCH_WEIGHT_AVAIL || 0.2);
const HEARTBEAT_TTL_MS = Number(process.env.HEARTBEAT_TTL_MS || 60_000);
const MIN_REP_DISCOVER = Number(process.env.MIN_REP_DISCOVER || 0);

function capabilityText(capabilityId: string, description?: string | null, outputSchema?: any, tags?: string[]) {
  const schemaStr =
    outputSchema && typeof outputSchema === "object" ? JSON.stringify(outputSchema) : String(outputSchema || "");
  const tagsStr = Array.isArray(tags) ? tags.join(" ") : "";
  return `${capabilityId} ${description || ""} ${schemaStr} ${tagsStr}`.trim();
}

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

const app = Fastify({
  logger,
  bodyLimit: 512 * 1024, // 512kb
});
await app.register(cors, { origin: process.env.CORS_ORIGIN || "*" });

await migrate();
await ensureCollection();

// request/trace id propagation
app.addHook("onRequest", async (request, reply) => {
  const rid =
    (request.headers["x-request-id"] as string | undefined) ||
    (request.headers["x-correlation-id"] as string | undefined) ||
    randomUUID();
  request.headers["x-request-id"] = rid;
  reply.header("x-request-id", rid);
  (request as any).startTime = Date.now();
});

app.addHook("onResponse", async (request, reply) => {
  const rid = (request.headers as any)["x-request-id"];
  const duration = (Date.now() - ((request as any).startTime || Date.now()));
  app.log.info({
    request_id: rid,
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    duration_ms: duration,
  });
});

const capabilitySchema = z.object({
  capabilityId: z.string().optional(),
  capability_id: z.string().optional(),
  description: z.string().min(1).max(500),
  tags: z.array(z.string().max(64)).max(10).optional(),
  input_schema: z.any().optional(),
  output_schema: z.any().optional(),
});

const acardCapabilitySchema = z.object({
  id: z.string(),
  description: z.string(),
  inputSchema: z.any().optional(),
  outputSchema: z.any().optional(),
  embeddingDim: z.number().optional().nullable(),
});

const acardSchema = z.object({
  did: z.string(),
  endpoint: z.string(),
  publicKey: z.string(),
  version: z.number(),
  lineage: z.string().nullable().optional(),
  capabilities: z.array(acardCapabilitySchema).min(1),
  metadata: z.record(z.any()).nullable().optional(),
});

const registerSchema = z.object({
  did: z.string(),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(), // Agent's wallet for receiving payments
  capabilities: z.array(capabilitySchema).min(1).max(25),
  acard: acardSchema.optional(),
  acard_signature: z.string().optional(),
});

const reputationSchema = z.object({
  did: z.string(),
  reputation: z.number().min(0).max(1),
});

const availabilitySchema = z.object({
  did: z.string(),
  availability: z.number().min(0).max(1),
  last_seen: z.string().datetime().optional(),
});

const apiGuard = async (request: any, reply: any) => {
  // Enforce API key on write routes when set
  const method = request.method?.toUpperCase() || "";
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!API_KEY && !isWrite) return;
  if (API_KEY && isWrite) {
    const provided = request.headers["x-api-key"];
    if (provided !== API_KEY) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  }
};

const rateBucket = new Map<string, { count: number; resetAt: number }>();
const rateLimitGuard = async (request: any, reply: any) => {
  const ip =
    (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    request.ip ||
    "unknown";
  const now = Date.now();
  const bucket = rateBucket.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBucket.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retry = Math.max(0, Math.ceil((bucket.resetAt - now) / 1000));
    reply.header("Retry-After", retry);
    return reply.status(429).send({ error: "Rate limit exceeded", retryAfterSeconds: retry });
  }
  bucket.count += 1;
};

app.post("/v1/agent/register", { preHandler: [rateLimitGuard, apiGuard] }, async (request, reply) => {
  const parse = registerSchema.safeParse(request.body);
  if (!parse.success) {
    return reply
      .status(400)
      .send({ error: parse.error.flatten(), message: "Invalid register payload" });
  }
  const { did, name, endpoint, walletAddress, capabilities, acard, acard_signature } = parse.data;

  // Normalize capability ids and schemas
  const normalizedCaps = capabilities.map((cap) => ({
    capabilityId: cap.capabilityId || (cap as any).capability_id || randomUUID(),
    description: cap.description,
    tags: cap.tags || [],
    input_schema: cap.input_schema,
    output_schema: cap.output_schema,
  }));

  // ACARD validation (optional but must verify if provided)
  let endpointToPersist = normalizeEndpoint(endpoint);
  let publicKey: string | null = null;
  let acardVersion: number | null = null;
  let acardLineage: string | null = null;
  let acardSignature: string | null = null;
  let acardRaw: ACARD | null = null;

  if (acard || acard_signature) {
    if (!acard || !acard_signature) {
      return reply.status(400).send({ error: "acard and acard_signature must both be provided" });
    }
    const acardEndpoint = normalizeEndpoint(acard.endpoint);
    endpointToPersist = endpointToPersist || acardEndpoint;
    if (!endpointToPersist) {
      return reply.status(400).send({ error: "endpoint is required when using ACARD" });
    }
    if (acard.did !== did) {
      return reply.status(400).send({ error: "ACARD did mismatch" });
    }
    if (acardEndpoint !== endpointToPersist) {
      return reply.status(400).send({ error: "ACARD endpoint mismatch" });
    }
    const ok = verifyACARD(acard, acard_signature);
    if (!ok) {
      return reply.status(401).send({ error: "Invalid ACARD signature" });
    }
    // ensure capabilities match the signed card
    const acardCapIds = new Set(acard.capabilities.map((c) => c.id));
    for (const cap of normalizedCaps) {
      if (!acardCapIds.has(cap.capabilityId)) {
        return reply.status(400).send({
          error: `Capability ${cap.capabilityId} not present in ACARD`,
        });
      }
    }
    publicKey = acard.publicKey;
    acardVersion = acard.version;
    acardLineage = acard.lineage ?? null;
    acardSignature = acard_signature;
    acardRaw = acard;
  } else {
    if (!endpointToPersist) {
      return reply.status(400).send({ error: "endpoint is required" });
    }
  }

  try {
    await pool.query(
      `insert into agents (did, name, endpoint, public_key, wallet_address, acard_version, acard_lineage, acard_signature, acard_raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (did) do update set
       name = excluded.name,
       endpoint = excluded.endpoint,
       public_key = excluded.public_key,
       wallet_address = coalesce(excluded.wallet_address, agents.wallet_address),
       acard_version = excluded.acard_version,
       acard_lineage = excluded.acard_lineage,
       acard_signature = excluded.acard_signature,
       acard_raw = excluded.acard_raw`,
      [did, name || null, endpointToPersist, publicKey, walletAddress?.toLowerCase() || null, acardVersion, acardLineage, acardSignature, acardRaw]
    );

    // replace capabilities for this agent
    await pool.query(`delete from capabilities where agent_did = $1`, [did]);
    await deleteByAgent(did);

    for (const cap of normalizedCaps) {
      const vector = await embed(
        capabilityText(cap.capabilityId, cap.description, cap.output_schema, cap.tags)
      );
      await upsertCapability({
        id: randomUUID(),
        agentDid: did,
        capabilityId: cap.capabilityId,
        description: cap.description,
        tags: cap.tags,
        vector,
      });
      await pool.query(
        `insert into capabilities (agent_did, capability_id, description, tags, output_schema)
       values ($1, $2, $3, $4, $5)`,
        [did, cap.capabilityId, cap.description, cap.tags || [], cap.output_schema || null]
      );
    }
    return reply.send({ ok: true, registered: normalizedCaps.length });
  } catch (err: any) {
    app.log.error({ err }, "register error");
    return reply.status(500).send({
      error: err.message || "Internal error",
      statusCode: 500,
      details: err?.response?.data ?? err?.stack ?? err,
    });
  }
});

const searchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(50).optional(),
  minReputation: z.number().min(0).max(1).optional(),
});

app.post(
  "/v1/agent/reputation",
  { preHandler: [rateLimitGuard, apiGuard] },
  async (request, reply) => {
    const parse = reputationSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.flatten(), message: "Invalid payload" });
    }
    const { did, reputation } = parse.data;
    const clamped = Math.max(0, Math.min(1, reputation));
    await pool.query(
      `update agents set reputation = $1 where did = $2`,
      [clamped, did]
    );
    return reply.send({ ok: true, did, reputation: clamped });
  }
);

app.post(
  "/v1/agent/availability",
  { preHandler: [rateLimitGuard, apiGuard] },
  async (request, reply) => {
    const parse = availabilitySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.flatten(), message: "Invalid payload" });
    }
    const { did, availability, last_seen } = parse.data;
    await pool.query(
      `update agents set availability_score = $1, last_seen = coalesce($2, now()) where did = $3`,
      [availability, last_seen ? new Date(last_seen) : new Date(), did]
    );
    return reply.send({ ok: true, did, availability });
  }
);

app.get("/v1/capability/:id/schema", async (request, reply) => {
  const capId = (request.params as any).id;
  const res = await pool.query(
    `select output_schema from capabilities where capability_id = $1 limit 1`,
    [capId]
  );
  if (!res.rowCount) {
    return reply.status(404).send({ error: "Not found" });
  }
  return reply.send(res.rows[0].output_schema || {});
});

app.post("/v1/agent/discovery", { preHandler: [rateLimitGuard, apiGuard] }, async (request, reply) => {
  const parse = searchSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.status(400).send({ error: parse.error.flatten(), message: "Invalid search payload" });
  }
  const { query, limit = 5, minReputation = MIN_REP_DISCOVER } = parse.data;

  let hits: any[] = [];
  try {
    const vector = await embed(query);
    hits = await searchCapabilities(vector, limit);
  } catch (err) {
    app.log.warn({ err }, "vector search failed, falling back to DB search");
  }

  // Always add keyword fallback for recall, then merge/dedupe.
  const keywordRes = await pool.query(
    `select c.capability_id as "capabilityId",
            c.description,
            c.tags,
            c.output_schema,
            c.agent_did as "agentDid",
            a.reputation,
            a.availability_score,
            a.last_seen
     from capabilities c
     join agents a on a.did = c.agent_did
     where (c.capability_id ilike $1 or c.description ilike $1)`,
    [`%${query}%`]
  );
  const keywordHits = keywordRes.rows.map((row) => ({
    score: 0.45,
    payload: {
      agentDid: row.agentDid,
      capabilityId: row.capabilityId,
      description: row.description,
      tags: row.tags,
      reputation: row.reputation,
      availability_score: row.availability_score,
      last_seen: row.last_seen,
    },
  }));
  hits = [...hits, ...keywordHits];

  const agents: Record<string, { did: string; name: string | null; endpoint: string | null; reputation: number | null; availability_score: number | null; last_seen: Date | null }> = {};
  if (hits.length) {
    const dids = hits
      .map((h: any) => h.payload?.agentDid)
      .filter((v: unknown): v is string => typeof v === "string");
    if (dids.length) {
      const rows = await pool.query<{ did: string; name: string | null; endpoint: string | null; reputation: number | null; availability_score: number | null; last_seen: Date | null }>(
        `select did, name, endpoint, reputation, availability_score, last_seen from agents where did = any($1::text[])`,
        [dids]
      );
      rows.rows.forEach((row) => {
        agents[row.did] = {
          did: row.did,
          name: row.name,
          endpoint: row.endpoint ?? null,
          reputation: row.reputation ?? null,
          availability_score: row.availability_score ?? null,
          last_seen: row.last_seen ?? null,
        };
      });
    }
  }

  const now = Date.now();

  // dedupe by agent+cap
  const seenKey = new Set<string>();
  const results = hits
    .map((hit: any) => {
      const agentDid = typeof hit.payload?.agentDid === "string" ? hit.payload.agentDid : undefined;
      const capabilityId =
        typeof hit.payload?.capabilityId === "string" ? hit.payload.capabilityId : undefined;
      const description =
        typeof hit.payload?.description === "string" ? hit.payload.description : undefined;
    const tags = Array.isArray(hit.payload?.tags) ? hit.payload.tags : undefined;
    const reputation =
      typeof hit.payload?.reputation === "number"
        ? hit.payload.reputation
        : hit.payload?.rep || (agentDid ? agents[agentDid]?.reputation ?? null : null);

    const repScore = Math.max(0, Math.min(1, Number(reputation ?? 0)));
    const vectorScore = typeof hit.score === "number" ? hit.score : 0;
      const availabilityScore =
        typeof agents[agentDid || ""]?.last_seen !== "undefined"
          ? (() => {
              const lastSeen = agents[agentDid || ""]?.last_seen as any;
              const ts = lastSeen ? new Date(lastSeen).getTime() : 0;
            const stale = now - ts > HEARTBEAT_TTL_MS * 2;
            return stale ? 0 : Math.max(0, Math.min(1, Number(agents[agentDid || ""]?.availability_score || 0)));
          })()
        : null;

    const combinedScore =
      SIM_WEIGHT * vectorScore +
      REP_WEIGHT * repScore +
      AVAIL_WEIGHT * (availabilityScore ?? 0);

    const key = `${agentDid || ""}|${capabilityId || ""}`;
    if (seenKey.has(key)) return null;
    seenKey.add(key);

    return {
      score: combinedScore,
      vectorScore,
      reputationScore: repScore,
      availabilityScore: availabilityScore ?? null,
      agentDid,
      capabilityId,
      description,
      tags,
      reputation: reputation ?? null,
      agent: agentDid ? agents[agentDid] || null : null,
    };
  })
    .filter((r: any) => r && (r.availabilityScore ?? 0) > 0 && (r.reputationScore ?? 0) >= minReputation)
    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));

  return reply.send({ results });
});

app.setErrorHandler((err, _req, reply) => {
  // Log full error and return structured JSON
  const rid = (_req as any)?.headers?.["x-request-id"];
  app.log.error({ err, request_id: rid });
  const status = (err as any).statusCode || 500;
  return reply.status(status).send({
    error: err.message,
    statusCode: status,
    validation: (err as any).validation,
    details: (err as any).stack || err,
  });
});

// Admin: reindex capabilities into Qdrant (protected by API key)
app.post("/admin/reindex", { preHandler: apiGuard }, async (_req, reply) => {
  try {
    await ensureCollection();
    const caps = await pool.query(
      `select c.capability_id, c.description, c.tags, c.output_schema, a.did as agent_did
       from capabilities c
       join agents a on a.did = c.agent_did`
    );
    for (const row of caps.rows) {
      const vector = await embed(
        capabilityText(row.capability_id, row.description, row.output_schema, row.tags)
      );
      await upsertCapability({
        id: randomUUID(),
        agentDid: row.agent_did,
        capabilityId: row.capability_id,
        description: row.description,
        tags: row.tags,
        vector,
      });
    }
    return reply.send({ ok: true, upserted: caps.rowCount });
  } catch (err: any) {
    app.log.error({ err }, "reindex failed");
    return reply.status(500).send({ error: err?.message || "reindex failed" });
  }
});

app.get("/health", async (_req, reply) => {
  try {
    await pool.query("select 1");
    await qdrant.getCollections();
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.status(503).send({ ok: false, error: err.message || "Unhealthy" });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`Registry running on ${port}`);
});
