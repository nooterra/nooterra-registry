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
      reputation numeric default 0,
      availability_score numeric default 0,
      last_seen timestamptz,
      public_key text,
      acard_version integer,
      acard_lineage text,
      acard_signature text,
      acard_raw jsonb,
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
      output_schema jsonb,
      created_at timestamptz default now()
    );
  `);

  await pool.query(`alter table agents add column if not exists reputation numeric default 0;`);
  await pool.query(`alter table agents add column if not exists availability_score numeric default 0;`);
  await pool.query(`alter table agents add column if not exists last_seen timestamptz;`);
  await pool.query(`alter table agents add column if not exists public_key text;`);
  await pool.query(`alter table agents add column if not exists acard_version integer;`);
  await pool.query(`alter table agents add column if not exists acard_lineage text;`);
  await pool.query(`alter table agents add column if not exists acard_signature text;`);
  await pool.query(`alter table agents add column if not exists acard_raw jsonb;`);
  
  // Wallet address for agent developer payments
  await pool.query(`alter table agents add column if not exists wallet_address text;`);
  await pool.query(`create index if not exists agents_wallet_idx on agents(wallet_address) where wallet_address is not null;`);
  
  // Price per capability call (in NCR cents)
  await pool.query(`alter table capabilities add column if not exists price_cents int default 10;`);
}
