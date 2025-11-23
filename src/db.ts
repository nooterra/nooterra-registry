import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || "postgres://postgres:postgres@localhost:5432/nooterra",
});

export async function migrate() {
  await pool.query(`
    create table if not exists agents (
      did text primary key,
      name text,
      endpoint text,
      created_at timestamptz default now()
    );
  `);

  await pool.query(`
    create table if not exists capabilities (
      id serial primary key,
      agent_did text references agents(did) on delete cascade,
      capability_id text,
      description text,
      tags text[],
      created_at timestamptz default now()
    );
  `);
}
