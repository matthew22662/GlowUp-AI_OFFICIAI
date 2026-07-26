"use strict";

const { Pool } = require("pg");

async function createDatabase(config) {
  if (config.useMemoryDatabase) {
    const { newDb } = require("pg-mem");
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    return { pool, mode: "memory-test" };
  }

  const isLocal = /localhost|127\.0\.0\.1/i.test(config.databaseUrl);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.isProduction && !isLocal ? { rejectUnauthorized: false } : false,
    max: config.databasePoolMax,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    keepAlive: true
  });

  pool.on("error", (error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "postgres_pool_error",
      message: error.message,
      code: error.code
    }));
  });

  await pool.query("SELECT 1");
  return { pool, mode: "postgres" };
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createDatabase, withTransaction };
