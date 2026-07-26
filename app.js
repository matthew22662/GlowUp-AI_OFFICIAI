"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const OpenAI = require("openai");

const { createDatabase, withTransaction } = require("./db");
const { runMigrations, bootstrapAdmin } = require("./migrations");
const { AppError, assert } = require("./errors");
const { normalizeEmail } = require("./config");

const PUBLIC_DIR = path.join(__dirname, "public");
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function toIsoDate(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateString, days) {
  assert(isIsoDate(dateString), 400, "Укажите корректную дату начала.", "INVALID_DATE");
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function generateAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function setCookie(res, name, token, maxAge, secure) {
  res.cookie(name, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge
  });
}

function clearCookie(res, name, secure) {
  res.clearCookie(name, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}

function hashIp(config, ip) {
  return crypto.createHmac("sha256", config.ipHashSecret).update(String(ip || "unknown")).digest("hex");
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.display_name || "",
    plan_days: Number(row.plan_days),
    start_date: toIsoDate(row.starts_on),
    expires_at: toIsoDate(row.expires_on),
    status: row.status,
    hasProfile: Boolean(row.has_profile),
    hasAnalysis: Boolean(row.has_analysis),
    analysisUpdatedAt: row.analysis_updated_at || null,
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null
  };
}

async function audit(pool, config, req, action, details = {}) {
  try {
    await pool.query(`
      INSERT INTO audit_logs(
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, ip_hash, metadata
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [
      crypto.randomUUID(),
      details.actorType || "system",
      details.actorId || null,
      action,
      details.targetType || null,
      details.targetId || null,
      req?.requestId || null,
      hashIp(config, req?.ip),
      JSON.stringify(details.metadata || {})
    ]);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "audit_write_failed", message: error.message }));
  }
}

function verifyPublicFiles() {
  const required = [
    "index.html", "admin.html", "dashboard.html", "onboarding.html",
    "site.js", "admin.js", "dashboard.js", "onboarding.js", "styles.css"
  ];
  const missing = required.filter((name) => !fs.existsSync(path.join(PUBLIC_DIR, name)));
  if (missing.length) throw new Error(`Отсутствуют файлы сайта: ${missing.join(", ")}`);
}

function createUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 6 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, callback) {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        return callback(new AppError(400, "Разрешены только JPG, PNG и WEBP.", "INVALID_IMAGE_TYPE"));
      }
      callback(null, true);
    }
  });
}

function analysisSchema() {
  const stringArray = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "presentation", "photoTips", "plan", "disclaimer"],
    properties: {
      summary: { type: "string" },
      presentation: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "observation", "action"],
          properties: {
            title: { type: "string" },
            observation: { type: "string" },
            action: { type: "string" }
          }
        }
      },
      photoTips: stringArray,
      plan: {
        type: "object",
        additionalProperties: false,
        required: ["first7Days", "habits"],
        properties: {
          first7Days: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["day", "focus", "tasks"],
              properties: {
                day: { type: "integer" },
                focus: { type: "string" },
                tasks: stringArray
              }
            }
          },
          habits: stringArray
        }
      },
      disclaimer: { type: "string" }
    }
  };
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeAnalysis(input) {
  const source = input && typeof input === "object" ? input : {};
  const presentation = Array.isArray(source.presentation) ? source.presentation.slice(0, 8) : [];
  const photoTips = Array.isArray(source.photoTips) ? source.photoTips.slice(0, 10) : [];
  const first7Days = Array.isArray(source.plan?.first7Days) ? source.plan.first7Days.slice(0, 7) : [];
  const habits = Array.isArray(source.plan?.habits) ? source.plan.habits.slice(0, 10) : [];

  return {
    summary: String(source.summary || "").slice(0, 1800),
    presentation: presentation.map((item) => ({
      title: String(item?.title || "").slice(0, 120),
      observation: String(item?.observation || "").slice(0, 700),
      action: String(item?.action || "").slice(0, 700)
    })),
    photoTips: photoTips.map((item) => String(item || "").slice(0, 420)),
    plan: {
      first7Days: first7Days.map((day, index) => ({
        day: Number(day?.day) || index + 1,
        focus: String(day?.focus || "").slice(0, 180),
        tasks: Array.isArray(day?.tasks)
          ? day.tasks.slice(0, 8).map((task) => String(task || "").slice(0, 420))
          : []
      })),
      habits: habits.map((item) => String(item || "").slice(0, 420))
    },
    disclaimer: String(source.disclaimer || "Рекомендации носят информационный характер.").slice(0, 900)
  };
}

async function createApplication(config, dependencies = {}) {
  verifyPublicFiles();
  const { pool, mode: databaseMode } = await createDatabase(config);
  await runMigrations(pool);
  await bootstrapAdmin(pool, config, crypto);

  const openai = dependencies.openai || (config.openaiApiKey ? new OpenAI({
    apiKey: config.openaiApiKey,
    timeout: config.openaiTimeoutMs,
    maxRetries: 2
  }) : null);

  const app = express();
  const upload = createUpload();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "same-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(cookieParser());
  app.use(express.static(PUBLIC_DIR, {
    extensions: ["html"],
    maxAge: 0,
    etag: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }));

  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много попыток входа. Повторите через 15 минут." }
  });
  const userLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много попыток входа. Повторите позже." }
  });
  const analysisLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много анализов за час. Повторите позже." }
  });

  function requireAdmin(req, res, next) {
    const token = req.cookies.glowup_admin;
    if (!token) return res.status(401).json({ error: "Требуется вход администратора." });
    try {
      const payload = jwt.verify(token, config.adminJwtSecret);
      if (payload.role !== "admin") throw new Error("invalid role");
      req.admin = payload;
      next();
    } catch {
      clearCookie(res, "glowup_admin", config.isProduction);
      return res.status(401).json({ error: "Сессия администратора истекла." });
    }
  }

  const requireUser = asyncRoute(async (req, res, next) => {
    const token = req.cookies.glowup_user;
    if (!token) return res.status(401).json({ error: "Требуется вход пользователя." });

    let payload;
    try {
      payload = jwt.verify(token, config.userJwtSecret);
      if (payload.role !== "user") throw new Error("invalid role");
    } catch {
      clearCookie(res, "glowup_user", config.isProduction);
      return res.status(401).json({ error: "Сессия пользователя истекла." });
    }

    const result = await pool.query(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM user_profiles p WHERE p.user_id=u.id) AS has_profile,
        EXISTS(SELECT 1 FROM photo_analyses a WHERE a.user_id=u.id) AS has_analysis,
        (SELECT MAX(created_at) FROM photo_analyses a WHERE a.user_id=u.id) AS analysis_updated_at
      FROM users u WHERE u.id=$1 LIMIT 1
    `, [payload.userId]);
    const user = result.rows[0];
    if (!user || user.status !== "active") {
      clearCookie(res, "glowup_user", config.isProduction);
      return res.status(403).json({ error: "Доступ закрыт. Свяжитесь с администратором." });
    }
    if (toIsoDate(user.expires_on) < todayIso()) {
      clearCookie(res, "glowup_user", config.isProduction);
      return res.status(403).json({ error: "Срок доступа закончился. Свяжитесь с администратором." });
    }

    req.user = payload;
    req.userRecord = user;
    next();
  });

  app.get("/health", asyncRoute(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      version: "5.0.0",
      databaseMode,
      persistentDatabase: databaseMode === "postgres",
      aiEnabled: Boolean(openai),
      aiModel: config.openaiVisionModel
    });
  }));

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      version: "5.0.0",
      persistentDatabase: databaseMode === "postgres",
      databaseMode,
      aiEnabled: Boolean(openai),
      aiModel: config.openaiVisionModel
    });
  });

  app.post("/api/admin/login", adminLimiter, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const found = await pool.query(
      "SELECT id,email,password_hash,status FROM admin_users WHERE email=$1 LIMIT 1",
      [email]
    );
    const admin = found.rows[0];
    const matches = admin ? await bcrypt.compare(password, admin.password_hash) : false;
    if (!admin || admin.status !== "active" || !matches) {
      await audit(pool, config, req, "admin.login_failed", { actorType: "system", metadata: { email } });
      throw new AppError(401, "Неверный email или пароль.", "ADMIN_LOGIN_FAILED");
    }

    await pool.query("UPDATE admin_users SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1", [admin.id]);
    const token = jwt.sign({ role: "admin", adminId: admin.id, email: admin.email }, config.adminJwtSecret, { expiresIn: "8h" });
    setCookie(res, "glowup_admin", token, 8 * 60 * 60 * 1000, config.isProduction);
    await audit(pool, config, req, "admin.login", { actorType: "admin", actorId: admin.id });
    res.json({ ok: true, email: admin.email });
  }));

  app.get("/api/admin/session", requireAdmin, (req, res) => res.json({ ok: true, email: req.admin.email }));
  app.post("/api/admin/logout", requireAdmin, asyncRoute(async (req, res) => {
    clearCookie(res, "glowup_admin", config.isProduction);
    await audit(pool, config, req, "admin.logout", { actorType: "admin", actorId: req.admin.adminId });
    res.json({ ok: true });
  }));

  app.get("/api/admin/users", requireAdmin, asyncRoute(async (_req, res) => {
    const result = await pool.query(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM user_profiles p WHERE p.user_id=u.id) AS has_profile,
        EXISTS(SELECT 1 FROM photo_analyses a WHERE a.user_id=u.id) AS has_analysis,
        (SELECT MAX(created_at) FROM photo_analyses a WHERE a.user_id=u.id) AS analysis_updated_at
      FROM users u ORDER BY u.created_at DESC, u.email ASC
    `);
    res.json({ users: result.rows.map((row) => ({
      ...publicUser(row),
      has_profile: Boolean(row.has_profile),
      has_analysis: Boolean(row.has_analysis),
      analysis_updated_at: row.analysis_updated_at || null,
      last_login_at: row.last_login_at || null,
      created_at: row.created_at,
      updated_at: row.updated_at
    })) });
  }));

  app.post("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const displayName = String(req.body.name || "").trim().slice(0, 160);
    const planDays = Number(req.body.planDays);
    const startsOn = String(req.body.startDate || "");
    const requestedCode = String(req.body.accessCode || "").trim();

    assert(validEmail(email), 400, "Введите корректный email.", "INVALID_EMAIL");
    assert([7, 30, 60, 365].includes(planDays), 400, "Допустимый тариф: бесплатный анализ, 30, 60 или 365 дней.", "INVALID_PLAN");
    assert(isIsoDate(startsOn), 400, "Укажите дату начала.", "INVALID_DATE");
    assert(!requestedCode || (requestedCode.length >= 6 && requestedCode.length <= 64), 400,
      "Пароль/код должен содержать от 6 до 64 символов.", "INVALID_ACCESS_CODE");

    const expiresOn = addDaysIso(startsOn, planDays - 1);
    const accessCode = requestedCode || generateAccessCode();
    const passwordHash = await bcrypt.hash(accessCode, 12);
    const userId = crypto.randomUUID();

    const user = await withTransaction(pool, async (client) => {
      const result = await client.query(`
        INSERT INTO users(id,email,display_name,password_hash,status,plan_days,starts_on,expires_on)
        VALUES($1,$2,$3,$4,'active',$5,$6,$7)
        ON CONFLICT(email) DO UPDATE SET
          display_name=EXCLUDED.display_name,
          password_hash=EXCLUDED.password_hash,
          status='active',
          plan_days=EXCLUDED.plan_days,
          starts_on=EXCLUDED.starts_on,
          expires_on=EXCLUDED.expires_on,
          updated_at=NOW()
        RETURNING *
      `, [userId, email, displayName, passwordHash, planDays, startsOn, expiresOn]);
      return result.rows[0];
    });

    await audit(pool, config, req, "user.upsert", {
      actorType: "admin", actorId: req.admin.adminId, targetType: "user", targetId: user.id,
      metadata: { email, planDays, startsOn, expiresOn }
    });

    res.status(201).json({
      user: publicUser({ ...user, has_profile: false, has_analysis: false }),
      accessCode,
      message: "Доступ открыт. Передайте пользователю email и пароль/код."
    });
  }));

  app.post("/api/admin/users/:id/extend", requireAdmin, asyncRoute(async (req, res) => {
    const days = Number(req.body.days || 30);
    assert([7, 30, 60, 365].includes(days), 400, "Допустимое продление: 7, 30, 60 или 365 дней.", "INVALID_EXTENSION");
    const found = await pool.query("SELECT id,expires_on FROM users WHERE id=$1 LIMIT 1", [req.params.id]);
    assert(found.rowCount, 404, "Пользователь не найден.", "USER_NOT_FOUND");
    const base = toIsoDate(found.rows[0].expires_on) >= todayIso() ? toIsoDate(found.rows[0].expires_on) : todayIso();
    const expiresOn = addDaysIso(base, days);
    const updated = await pool.query(`
      UPDATE users SET expires_on=$2,status='active',updated_at=NOW() WHERE id=$1 RETURNING id,email,expires_on,status
    `, [req.params.id, expiresOn]);
    res.json({ user: { ...updated.rows[0], expires_at: toIsoDate(updated.rows[0].expires_on) } });
  }));

  app.post("/api/admin/users/:id/toggle", requireAdmin, asyncRoute(async (req, res) => {
    const updated = await pool.query(`
      UPDATE users SET status=CASE WHEN status='active' THEN 'blocked' ELSE 'active' END,updated_at=NOW()
      WHERE id=$1 RETURNING id,email,status
    `, [req.params.id]);
    assert(updated.rowCount, 404, "Пользователь не найден.", "USER_NOT_FOUND");
    res.json({ user: updated.rows[0] });
  }));

  app.post("/api/admin/users/:id/reset-code", requireAdmin, asyncRoute(async (req, res) => {
    const requestedCode = String(req.body.accessCode || "").trim();
    assert(!requestedCode || (requestedCode.length >= 6 && requestedCode.length <= 64), 400,
      "Пароль/код должен содержать от 6 до 64 символов.", "INVALID_ACCESS_CODE");
    const accessCode = requestedCode || generateAccessCode();
    const passwordHash = await bcrypt.hash(accessCode, 12);
    const updated = await pool.query(`
      UPDATE users SET password_hash=$2,updated_at=NOW() WHERE id=$1 RETURNING id,email
    `, [req.params.id, passwordHash]);
    assert(updated.rowCount, 404, "Пользователь не найден.", "USER_NOT_FOUND");
    res.json({ user: updated.rows[0], accessCode });
  }));

  app.delete("/api/admin/users/:id", requireAdmin, asyncRoute(async (req, res) => {
    const deleted = await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    assert(deleted.rowCount, 404, "Пользователь не найден.", "USER_NOT_FOUND");
    res.json({ ok: true });
  }));

  app.post("/api/user/login", userLimiter, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const accessCode = String(req.body.accessCode || "").trim();
    assert(validEmail(email) && accessCode, 400, "Введите email и пароль/код доступа.", "INVALID_LOGIN");

    const found = await pool.query(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM user_profiles p WHERE p.user_id=u.id) AS has_profile,
        EXISTS(SELECT 1 FROM photo_analyses a WHERE a.user_id=u.id) AS has_analysis,
        (SELECT MAX(created_at) FROM photo_analyses a WHERE a.user_id=u.id) AS analysis_updated_at
      FROM users u WHERE email=$1 LIMIT 1
    `, [email]);
    const user = found.rows[0];
    const matches = user ? await bcrypt.compare(accessCode, user.password_hash) : false;
    if (!user || !matches) throw new AppError(401, "Неверный email или пароль/код доступа.", "USER_LOGIN_FAILED");
    if (user.status !== "active") throw new AppError(403, "Доступ приостановлен. Свяжитесь с администратором.", "USER_BLOCKED");
    if (toIsoDate(user.expires_on) < todayIso()) throw new AppError(403, "Срок доступа закончился. Свяжитесь с администратором.", "USER_EXPIRED");

    await pool.query("UPDATE users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1", [user.id]);
    const token = jwt.sign({ role: "user", userId: user.id }, config.userJwtSecret, { expiresIn: "7d" });
    setCookie(res, "glowup_user", token, 7 * 24 * 60 * 60 * 1000, config.isProduction);
    await audit(pool, config, req, "user.login", { actorType: "user", actorId: user.id });
    res.json({ ok: true, redirectTo: "/cabinet", user: publicUser(user) });
  }));

  app.post("/api/user/logout", (_req, res) => {
    clearCookie(res, "glowup_user", config.isProduction);
    res.json({ ok: true });
  });

  app.get("/api/me", requireUser, (req, res) => res.json({ user: publicUser(req.userRecord) }));

  app.get("/api/onboarding", requireUser, asyncRoute(async (req, res) => {
    const profile = await pool.query("SELECT profile_json FROM user_profiles WHERE user_id=$1 LIMIT 1", [req.userRecord.id]);
    const analysis = await pool.query(`
      SELECT result_json,created_at FROM photo_analyses WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1
    `, [req.userRecord.id]);
    res.json({
      profile: profile.rows[0]?.profile_json || {},
      analysis: analysis.rows[0]?.result_json || null,
      analysisUpdatedAt: analysis.rows[0]?.created_at || null
    });
  }));

  app.post("/api/onboarding/profile", requireUser, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const age = Number(body.age);
    const availableMinutes = Number(body.availableMinutes);
    assert(Number.isFinite(age) && age >= 18 && age <= 90, 400, "Укажите возраст от 18 до 90 лет.", "INVALID_AGE");
    assert(body.confirmedAdult === true, 400, "Необходимо подтвердить возраст 18+.", "ADULT_CONFIRMATION_REQUIRED");
    assert(body.consentPhotoAnalysis === true, 400, "Необходимо согласие на обработку фотографии.", "PHOTO_CONSENT_REQUIRED");

    const profile = {
      age,
      height: Number(body.height) || null,
      weight: Number(body.weight) || null,
      activity: String(body.activity || "").slice(0, 50),
      availableMinutes: [15, 30, 45, 60].includes(availableMinutes) ? availableMinutes : 30,
      goal: ["shape", "posture", "style", "routine", "all"].includes(body.goal) ? body.goal : "all",
      sleepHours: Number(body.sleepHours) || null,
      notes: String(body.notes || "").trim().slice(0, 1200),
      confirmedAdult: true,
      consentPhotoAnalysis: true
    };

    await pool.query(`
      INSERT INTO user_profiles(user_id,profile_json,consent_version,consented_at,updated_at)
      VALUES($1,$2::jsonb,'2026-07',NOW(),NOW())
      ON CONFLICT(user_id) DO UPDATE SET profile_json=EXCLUDED.profile_json,consented_at=NOW(),updated_at=NOW()
    `, [req.userRecord.id, JSON.stringify(profile)]);
    res.json({ profile });
  }));

  app.post("/api/analyze-photo", requireUser, analysisLimiter, upload.single("photo"), asyncRoute(async (req, res) => {
    assert(req.file, 400, "Добавьте фотографию.", "PHOTO_REQUIRED");
    if (!openai) throw new AppError(503, "AI-анализ не подключён. Добавьте OPENAI_API_KEY в Render и выполните Deploy.", "AI_DISABLED");

    const profileResult = await pool.query("SELECT profile_json FROM user_profiles WHERE user_id=$1 LIMIT 1", [req.userRecord.id]);
    const profile = profileResult.rows[0]?.profile_json;
    assert(profile?.confirmedAdult && profile?.consentPhotoAnalysis, 400,
      "Сначала сохраните анкету и согласие на обработку фотографии.", "PROFILE_REQUIRED");

    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const prompt = [
      "Создай безопасный, уважительный и практичный разбор внешней презентации взрослого пользователя.",
      "Не оценивай привлекательность и не делай выводы о здоровье, диагнозах, расе, происхождении, личности, интеллекте или социальном статусе.",
      "По фото описывай только нейтральные видимые аспекты: освещение, ракурс, выражение лица, аккуратность причёски/бороды, сочетание и посадку одежды, позу и композицию кадра.",
      "Спорт, сон, питание и режим рекомендуй только из анкеты, а не по внешности.",
      "Сформируй практичный план на 7 дней. Пиши по-русски.",
      `Анкета: ${JSON.stringify(profile)}`
    ].join("\n");

    try {
      // Optional safety check before analysis.
      try {
        const moderation = await openai.moderations.create({
          model: "omni-moderation-latest",
          input: [{ type: "image_url", image_url: { url: dataUrl } }]
        });
        if (moderation.results?.[0]?.flagged) {
          throw new AppError(400, "Эту фотографию нельзя обработать. Выберите нейтральное фото взрослого человека.", "IMAGE_REJECTED");
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        console.warn(JSON.stringify({ level: "warn", event: "moderation_skipped", message: error.message }));
      }

      const request = {
        model: config.openaiVisionModel,
        max_output_tokens: 3600,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl, detail: "high" }
          ]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "glowup_analysis",
            strict: true,
            schema: analysisSchema()
          }
        }
      };

      let response;
      try {
        response = await openai.responses.create(request);
      } catch (error) {
        // Compatibility fallback for accounts/models that reject structured output settings.
        if (error?.status === 400 && /schema|format|structured/i.test(String(error.message))) {
          const fallback = { ...request };
          delete fallback.text;
          fallback.input[0].content[0].text += "\nВерни только корректный JSON по указанной структуре, без markdown.";
          response = await openai.responses.create(fallback);
        } else {
          throw error;
        }
      }

      const output = extractOutputText(response).trim();
      const firstBrace = output.indexOf("{");
      const lastBrace = output.lastIndexOf("}");
      assert(firstBrace >= 0 && lastBrace > firstBrace, 502, "AI вернул ответ в неожиданном формате. Повторите анализ.", "AI_INVALID_RESPONSE");
      const parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1));
      const analysis = normalizeAnalysis(parsed);
      const analysisId = crypto.randomUUID();
      const imageHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

      await pool.query(`
        INSERT INTO photo_analyses(id,user_id,model,image_sha256,image_mime,image_bytes,result_json,openai_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      `, [analysisId, req.userRecord.id, config.openaiVisionModel, imageHash, req.file.mimetype,
        req.file.size, JSON.stringify(analysis), response?._request_id || response?.id || null]);

      await audit(pool, config, req, "analysis.created", {
        actorType: "user", actorId: req.userRecord.id, targetType: "analysis", targetId: analysisId,
        metadata: { model: config.openaiVisionModel, imageMime: req.file.mimetype, imageBytes: req.file.size }
      });
      res.json({ analysis, analysisId });
    } catch (error) {
      if (error instanceof SyntaxError) throw new AppError(502, "AI вернул повреждённый JSON. Повторите анализ.", "AI_JSON_ERROR");
      if (error instanceof AppError) throw error;
      if (error?.status === 401) throw new AppError(502, "OPENAI_API_KEY отклонён. Проверьте ключ в Render.", "OPENAI_AUTH_ERROR");
      if (error?.status === 429) throw new AppError(503, "Лимит OpenAI временно исчерпан. Повторите позже.", "OPENAI_RATE_LIMIT");
      console.error(JSON.stringify({ level: "error", event: "openai_error", requestId: req.requestId, status: error?.status, code: error?.code, message: error?.message }));
      throw new AppError(502, "AI-сервис временно недоступен. Повторите анализ позже.", "OPENAI_ERROR");
    }
  }));

  app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));
  app.get("/cabinet", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "dashboard.html")));
  app.get("/dashboard", (_req, res) => res.redirect(302, "/cabinet"));
  app.get("/onboarding", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "onboarding.html")));
  app.get("/offer", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "offer.html")));
  app.get("/privacy", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "privacy.html")));
  app.get("/payment-success", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "payment-success.html")));
  app.get("/login", (_req, res) => res.redirect(302, "/#login"));

  app.use("/api", (_req, res) => res.status(404).json({ error: "API-маршрут не найден." }));
  app.use((req, res) => {
    if (req.accepts("html")) return res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
    res.status(404).json({ error: "Маршрут не найден." });
  });

  app.use((error, req, res, _next) => {
    const status = Number(error?.status) || 500;
    const code = error?.code || "INTERNAL_ERROR";
    const message = status >= 500 ? "Внутренняя ошибка сервера." : error.message;

    console.error(JSON.stringify({
      level: status >= 500 ? "error" : "warn",
      event: "request_error",
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      code,
      message: error?.message,
      stack: config.nodeEnv === "development" ? error?.stack : undefined
    }));

    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Фотография слишком большая. Максимум 6 МБ." : "Ошибка загрузки фотографии.", code: error.code });
    }
    if (error?.code === "23505") return res.status(409).json({ error: "Пользователь с таким email уже существует.", code });
    res.status(status).json({ error: message, code, requestId: req.requestId });
  });

  return {
    app,
    pool,
    databaseMode,
    aiEnabled: Boolean(openai),
    async close() { await pool.end(); }
  };
}

module.exports = { createApplication };
