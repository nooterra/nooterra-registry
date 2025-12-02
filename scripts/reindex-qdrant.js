import { pool } from '../dist/db.js';
import { embed } from '../dist/embeddings.js';
import { upsertCapability, ensureCollection } from '../dist/qdrant.js';
import { randomUUID } from 'crypto';

async function run() {
  await ensureCollection();
  const caps = await pool.query(
    `select c.capability_id, c.description, c.tags, a.did as agent_did
     from capabilities c
     join agents a on a.did = c.agent_did`
  );
  console.log(`Found ${caps.rowCount} capabilities`);
  for (const row of caps.rows) {
    const vector = await embed(row.description || row.capability_id);
    await upsertCapability({
      id: randomUUID(),
      agentDid: row.agent_did,
      capabilityId: row.capability_id,
      description: row.description,
      tags: row.tags,
      vector,
    });
    console.log('upserted', row.capability_id, 'for', row.agent_did);
  }
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
