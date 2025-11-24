import Fastify from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { z } from "zod";
import { pool, migrate } from "./db.js";
import { embed } from "./embeddings.js";
import { ensureCollection, upsertCapability, searchCapabilities, deleteByAgent, qdrant } from "./qdrant.js";
import { randomUUID } from "crypto";
import pino from "pino";

dotenv.config();

const API_KEY = process.env.REGISTRY_API_KEY;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);

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
  description: z.string().min(1).max(500),
  tags: z.array(z.string().max(64)).max(10).optional(),
});

const registerSchema = z.object({
  did: z.string(),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  capabilities: z.array(capabilitySchema).min(1).max(25),
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
      id: randomUUID(),
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
});

app.post("/v1/agent/discovery", { preHandler: [rateLimitGuard, apiGuard] }, async (request, reply) => {
  const parse = searchSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.status(400).send({ error: parse.error.flatten(), message: "Invalid search payload" });
  }
  const { query, limit = 5 } = parse.data;
  const vector = await embed(query);
  const hits = await searchCapabilities(vector, limit);

  const agents: Record<string, { did: string; name: string | null; endpoint: string | null; reputation: number | null }> = {};
  if (hits.length) {
    const dids = hits
      .map((h: any) => h.payload?.agentDid)
      .filter((v: unknown): v is string => typeof v === "string");
    if (dids.length) {
      const rows = await pool.query<{ did: string; name: string | null; endpoint: string | null; reputation: number | null }>(
        `select did, name, endpoint, reputation from agents where did = any($1::text[])`,
        [dids]
      );
      rows.rows.forEach((row) => {
        agents[row.did] = { did: row.did, name: row.name, endpoint: row.endpoint ?? null, reputation: row.reputation ?? null };
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
    const reputation =
      typeof hit.payload?.reputation === "number"
        ? hit.payload.reputation
        : hit.payload?.rep || (agentDid ? agents[agentDid]?.reputation ?? null : null);

    return {
      score: hit.score,
      agentDid,
      capabilityId,
      description,
      tags,
      reputation: reputation ?? null,
      agent: agentDid ? agents[agentDid] || null : null,
    };
  });

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
