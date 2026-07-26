"use strict";

const crypto = require("crypto");

function readString(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function readInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : fallback;
}

function readBool(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveSecret(rootSecret, label) {
  return crypto.createHmac("sha256", rootSecret).update(label).digest("hex");
}

function loadConfig() {
  const nodeEnv = readString("NODE_ENV", "development");
  const isProduction = nodeEnv === "production";
  const databaseUrl = readString("DATABASE_URL");

  // These defaults make the project start immediately after deployment.
  // Override them in Render Environment when a persistent database is ready.
  const appSecret = readString(
    "APP_SECRET",
    "GlowUp-AI-2026-default-app-secret-change-after-deploy"
  );
  const adminEmail = normalizeEmail(readString("ADMIN_EMAIL", "admin@glowup.ai"));
  const adminPassword = readString("ADMIN_PASSWORD", "GlowUpAdmin!2026");
  const openaiApiKey = readString("OPENAI_API_KEY");

  const useMemoryDatabase =
    nodeEnv === "test" || readBool("USE_MEMORY_DATABASE", !databaseUrl);

  const config = {
    nodeEnv,
    isProduction,
    port: readInt("PORT", 3000),
    appSecret,
    adminEmail,
    adminPassword,
    databaseUrl,
    databasePoolMax: Math.max(1, Math.min(20, readInt("DATABASE_POOL_MAX", 8))),
    openaiApiKey,
    openaiVisionModel: readString("OPENAI_VISION_MODEL", "gpt-5-mini"),
    openaiTimeoutMs: Math.max(15000, readInt("OPENAI_TIMEOUT_MS", 90000)),
    requireAi: readBool("REQUIRE_AI", false),
    supportPhone: readString("SUPPORT_PHONE", "+7 918 494-34-11"),
    appName: readString("APP_NAME", "GlowUp AI"),
    allowedOrigins: readString("ALLOWED_ORIGINS")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    useMemoryDatabase
  };

  const missing = [];
  if (!config.useMemoryDatabase && !databaseUrl) missing.push("DATABASE_URL");
  if (!appSecret || appSecret.length < 32) missing.push("APP_SECRET (минимум 32 символа)");
  if (!adminEmail) missing.push("ADMIN_EMAIL");
  if (!adminPassword || adminPassword.length < 10) missing.push("ADMIN_PASSWORD (минимум 10 символов)");
  if (config.requireAi && !openaiApiKey) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    const error = new Error(`Не заданы обязательные переменные: ${missing.join(", ")}`);
    error.code = "CONFIG_MISSING";
    throw error;
  }

  config.adminJwtSecret = deriveSecret(appSecret, "glowup-admin-jwt-v9");
  config.userJwtSecret = deriveSecret(appSecret, "glowup-user-jwt-v9");
  config.ipHashSecret = deriveSecret(appSecret, "glowup-ip-hash-v9");

  return Object.freeze(config);
}

module.exports = { loadConfig, normalizeEmail };
