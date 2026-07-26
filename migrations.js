"use strict";

const bcrypt = require("bcryptjs");
const { withTransaction } = require("./db");

const migrations = [
  {
    version: 1,
    name: "core_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
        plan_days INTEGER NOT NULL CHECK (plan_days IN (7, 30, 60, 90, 365)),
        starts_on DATE NOT NULL,
        expires_on DATE NOT NULL,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        consent_version TEXT NOT NULL DEFAULT '2026-07',
        consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS photo_analyses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        image_sha256 TEXT NOT NULL,
        image_mime TEXT NOT NULL,
        image_bytes INTEGER NOT NULL,
        result_json JSONB NOT NULL,
        openai_request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'user', 'system')),
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        request_id TEXT,
        ip_hash TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  },
  {
    version: 2,
    name: "indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS users_status_expires_idx ON users(status, expires_on);
      CREATE INDEX IF NOT EXISTS users_created_idx ON users(created_at DESC);
      CREATE INDEX IF NOT EXISTS analyses_user_created_idx ON photo_analyses(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_logs(target_type, target_id);
    `
  },
  {
    version: 3,
    name: "annual_plan_support",
    sql: `
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_days_check;
      ALTER TABLE users
        ADD CONSTRAINT users_plan_days_check
        CHECK (plan_days IN (7, 30, 60, 90, 365));
    `
  }
];

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const migration of migrations) {
    const exists = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [migration.version]
    );
    if (exists.rowCount) continue;

    await withTransaction(pool, async (client) => {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations(version, name) VALUES($1, $2)",
        [migration.version, migration.name]
      );
    });
  }
}

async function bootstrapAdmin(pool, config, crypto) {
  const passwordHash = await bcrypt.hash(config.adminPassword, 12);
  const adminId = crypto.createHash("sha256").update(config.adminEmail).digest("hex").slice(0, 32);

  await pool.query(`
    INSERT INTO admin_users(id, email, password_hash, status)
    VALUES($1, $2, $3, 'active')
    ON CONFLICT(email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      status = 'active',
      updated_at = NOW()
  `, [adminId, config.adminEmail, passwordHash]);
}

module.exports = { runMigrations, bootstrapAdmin };
