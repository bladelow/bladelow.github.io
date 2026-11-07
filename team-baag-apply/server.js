'use strict';
/**
 * TEAM_BAAG recruitment backend (RECRUITMENT.md contract adapter).
 * - Implements /api/v1 per bot/RECRUITMENT.md (Bearer RECRUITMENT_API_KEY, Idempotency-Key, keyset pagination).
 * - Preserves existing Discord OAuth session flow and admin endpoints.
 * - Durable file-backed store in data/recruitment.json (no Supabase required for bot contract).
 * Never expose RECRUITMENT_API_KEY / BOT_API_KEY to browser code.
 */
const express = require('express');
const cookie = require('cookie-parser');
const jwt = require('jsonwebtoken');
const rl = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let createClient;
try { ({ createClient } = require('@supabase/supabase-js')); } catch { createClient = null; }

const e = process.env;
const db = (createClient && e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY)
  ? createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_KEY) : null;
const app = express();
app.use(express.json({ limit: '120kb' }), cookie(), express.static('public'));
app.use('/api', rl({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'recruitment.json');
const DISCORD_ID = /^\d{17,20}$/;
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE = new Set(['submitted', 'pending_analysis', 'review_pending', 'more_information_requested', 'approved']);
const ALLOWED_STATUS = new Set(['submitted', 'pending_analysis', 'review_pending', 'more_information_requested', 'approved', 'rejected']);
const LIST_STATUS = new Set(['pending_analysis', 'review_pending', 'active']);
const DECISIONS = new Set(['approved', 'rejected', 'more_information_requested']);

function nowIso() { return new Date().toISOString(); }
function safe(v, n) { return String(v ?? '').slice(0, n); }
function timingEq(a, b) {
  const A = Buffer.from(String(a || '')); const B = Buffer.from(String(b || ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}
function readStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') throw 0;
    d.applications ||= {}; d.idempotency ||= {}; d.audit ||= [];
    return d;
  } catch { return { applications: {}, idempotency: {}, audit: [] }; }
}
let storeCache = null;
function store() { if (!storeCache) storeCache = readStore(); return storeCache; }
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}
function mutate(fn) { storeCache = store(); const out = fn(storeCache); saveStore(); return out; }
function audit(applicationId, actor, action, meta = {}) {
  mutate(s => {
    s.audit.push({ applicationId, actor: safe(actor, 80), action: safe(action, 80), meta, at: nowIso() });
    if (s.audit.length > 2000) s.audit.splice(0, s.audit.length - 2000);
  });
}

function getBearer(req) {
  const h = String(req.get('authorization') || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function isService(req) {
  const key = e.RECRUITMENT_API_KEY || e.BOT_API_KEY || '';
  if (!key) return false;
  return timingEq(getBearer(req), key) || timingEq(req.get('x-api-key'), key);
}
function serviceAuth(req, res, next) {
  if (!e.RECRUITMENT_API_KEY && !e.BOT_API_KEY) return res.status(503).json({ error: 'recruitment_api_not_configured' });
  return isService(req) ? next() : res.status(401).json({ error: 'invalid_api_key' });
}
function getSession(req) {
  try { return jwt.verify(req.cookies.sess, e.SESSION_SECRET); } catch { return null; }
}
function user(req, res, next) { const u = getSession(req); if (!u) return res.status(401).json({ error: 'login_required' }); req.u = u; next(); }
function admin(req, res, next) {
  user(req, res, () => ((e.ADMIN_DISCORD_IDS || '').split(',').map(s => s.trim()).includes(req.u.id) ? next() : res.status(403).json({ error: 'forbidden' })));
}

function appKey(guildId, id) { return `${guildId}:${id}`; }
function findApp(guildId, id) {
  if (!DISCORD_ID.test(String(guildId)) || !APP_ID.test(String(id))) return null;
  return store().applications[appKey(guildId, id)] || null;
}
function activeForUser(guildId, discordUserId) {
  return Object.values(store().applications).find(a =>
    a.guildId === guildId && a.discordUserId === discordUserId && ACTIVE.has(a.status));
}
function ensureGuildScoped(appRec, guildId) {
  return appRec && appRec.guildId === guildId ? appRec : null;
}
function idem(key, scope, fn) {
  const k = safe(key, 240);
  if (!k) return { ok: false, status: 400, body: { error: 'idempotency_key_required' } };
  const full = `${scope}:${k}`;
  const existing = store().idempotency[full];
  if (existing) return { ok: true, status: existing.status, body: existing.body, replay: true };
  const result = fn();
  if (result && result.status >= 200 && result.status < 500) {
    mutate(s => { s.idempotency[full] = { status: result.status, body: result.body, at: nowIso() }; });
  }
  return { ok: true, status: result.status, body: result.body };
}

function toStatusView(a) {
  return { applicationId: a.id, guildId: a.guildId, discordUserId: a.discordUserId, status: a.status, updatedAt: a.updatedAt || a.submittedAt };
}
function toSummary(a) {
  const out = { id: a.id, guildId: a.guildId, discordUserId: a.discordUserId, discordUsername: a.discordUsername, status: a.status };
  if (a.analysis) out.analysis = a.analysis;
  return out;
}
function toFull(a) {
  return {
    id: a.id, guildId: a.guildId, discordUserId: a.discordUserId, discordUsername: a.discordUsername,
    status: a.status, revision: Number(a.revision || 1), ageGroup: a.ageGroup, skills: a.skills || [],
    experience: a.experience || '', portfolioLinks: a.portfolioLinks || [],
    portfolioEvidence: a.portfolioEvidence || [], answers: a.answers || {}, submittedAt: a.submittedAt,
    updatedAt: a.updatedAt, analysis: a.analysis || null
  };
}

const redir = () => `${e.BASE_URL}/api/v1/auth/callback`;
const v1 = express.Router();

// --- RECRUITMENT.MD contract (service-auth required on all routes, including health) ---
v1.get('/health', serviceAuth, (req, res) => res.json({ status: 'ok' }));

v1.post('/applications', async (req, res) => {
  // Server-side submission from website (session) OR service key. Never browser API key.
  const svc = isService(req);
  const sess = svc ? null : getSession(req);
  if (!svc && !sess) return res.status(401).json({ error: 'login_required' });
  const b = req.body || {};
  const guildId = String(b.guildId || b.guild_id || (sess && sess.guild) || '').trim();
  if (!DISCORD_ID.test(guildId)) return res.status(400).json({ error: 'invalid_guild_id' });
  if (!svc) {
    if (sess.guild !== guildId || !sess.member) return res.status(403).json({ error: 'not_a_member_of_server' });
    if (b.discordUserId && String(b.discordUserId) !== sess.id) return res.status(403).json({ error: 'identity_mismatch' });
  }
  const discordUserId = String((svc ? b.discordUserId : sess.id) || '').trim();
  const discordUsername = safe((svc ? b.discordUsername : (b.discordUsername || sess.name)) || 'unknown', 100);
  if (!DISCORD_ID.test(discordUserId)) return res.status(400).json({ error: 'invalid_discord_user_id' });
  const ageGroup = safe(b.ageGroup || b.age_group || '', 40);
  const skills = Array.isArray(b.skills) ? b.skills.slice(0, 40).map(x => safe(x, 80)).filter(Boolean) : [];
  const experience = typeof b.experience === 'string' ? safe(b.experience, 6000) : safe(JSON.stringify(b.experience || ''), 6000);
  const portfolioLinks = (Array.isArray(b.portfolioLinks) ? b.portfolioLinks : (b.portfolio && b.portfolio.links) || [])
    .filter(l => /^https?:\/\//i.test(String(l))).slice(0, 15).map(l => safe(l, 500));
  const portfolioEvidence = Array.isArray(b.portfolioEvidence) ? b.portfolioEvidence.slice(0, 20).map(x => safe(x, 1000)) : [];
  const answers = (b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers)) ? b.answers : {};
  if (!ageGroup || !skills.length || !experience.trim()) return res.status(400).json({ error: 'validation_failed' });

  const idemKey = req.get('idempotency-key') || req.get('Idempotency-Key');
  const doCreate = () => mutate(s => {
    const existing = Object.values(s.applications).find(a => a.guildId === guildId && a.discordUserId === discordUserId && ACTIVE.has(a.status));
    if (existing) return { status: 409, body: { error: 'duplicate_pending_application', application: toStatusView(existing) } };
    const id = 'BAAG-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const rec = {
      id, guildId, discordUserId, discordUsername, ageGroup, skills, experience, portfolioLinks, portfolioEvidence, answers,
      status: 'pending_analysis', revision: 1, submittedAt: b.submittedAt || nowIso(), updatedAt: nowIso(), analysis: null
    };
    s.applications[appKey(guildId, id)] = rec;
    return { status: 201, body: { application: toFull(rec) } };
  });
  const result = idemKey ? idem(idemKey, `create:${guildId}:${discordUserId}`, doCreate) : { ...doCreate(), ok: true };
  if (result.status === 201) audit(result.body.application.id, discordUserId, 'submitted', { guildId });
  return res.status(result.status).json(result.body);
});

function parseCursor(cursor) {
  if (!cursor) return 0;
  try {
    const n = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return NaN; }
}
function makeCursor(n) { return Buffer.from(String(n), 'utf8').toString('base64url'); }

v1.get('/applications/', serviceAuth, (req, res) => {
  const guildId = String(req.query.guild_id || '').trim();
  if (!DISCORD_ID.test(guildId)) return res.status(400).json({ error: 'invalid_guild_id' });
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !LIST_STATUS.has(status)) return res.status(400).json({ error: 'invalid_status_filter' });
  const duid = req.query.discord_user_id ? String(req.query.discord_user_id) : null;
  if (duid && !DISCORD_ID.test(duid)) return res.status(400).json({ error: 'invalid_discord_user_id' });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const off = parseCursor(req.query.cursor);
  if (!Number.isFinite(off)) return res.status(400).json({ error: 'invalid_cursor' });

  // Stable keyset-like ordering by numeric-ish seq derived from submittedAt+id; cursor is opaque offset token.
  let items = Object.values(store().applications)
    .filter(a => a.guildId === guildId)
    .filter(a => !duid || a.discordUserId === duid)
    .filter(a => {
      if (!status) return true;
      if (status === 'active') return ACTIVE.has(a.status);
      return a.status === status;
    })
    .sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || '') || a.id.localeCompare(b.id));
  const page = items.slice(off, off + limit);
  const next = off + limit < items.length ? makeCursor(off + limit) : null;
  return res.json({ applications: page.map(toSummary), nextCursor: next });
});

v1.get('/applications/:id', serviceAuth, (req, res) => {
  const guildId = String(req.query.guild_id || '').trim();
  const rec = ensureGuildScoped(findApp(guildId, req.params.id), guildId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json({ application: toFull(rec) });
});

v1.get('/applications/:id/status', async (req, res) => {
  // Bot (service) OR applicant session may check status; never leak cross-guild/user.
  const guildId = String(req.query.guild_id || '').trim();
  const rec = findApp(guildId, req.params.id);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (isService(req)) return res.json(toStatusView(rec));
  const sess = getSession(req);
  if (!sess || sess.id !== rec.discordUserId) return res.status(404).json({ error: 'not_found' });
  return res.json(toStatusView(rec));
});

v1.post('/applications/:id/analysis', serviceAuth, (req, res) => {
  const b = req.body || {};
  const guildId = String(b.guildId || '').trim();
  const rec = ensureGuildScoped(findApp(guildId, req.params.id), guildId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  const idemKey = req.get('idempotency-key');
  if (!idemKey) return res.status(400).json({ error: 'idempotency_key_required' });
  const attempt = Number(b.attempt || 1);
  const analysis = b.analysis && typeof b.analysis === 'object' ? b.analysis : null;
  const result = idem(idemKey, `analysis:${guildId}:${rec.id}:${attempt}`, () => mutate(s => {
    const cur = s.applications[appKey(guildId, rec.id)];
    if (!cur) return { status: 404, body: { error: 'not_found' } };
    cur.analysis = analysis ? {
      outcome: safe(analysis.outcome, 40),
      confidence: (analysis.confidence == null ? null : Number(analysis.confidence)),
      reasoning: safe(analysis.reasoning, 4000),
      strongestSkills: Array.isArray(analysis.strongestSkills) ? analysis.strongestSkills.slice(0, 20).map(x => safe(x, 120)) : [],
      weaknesses: Array.isArray(analysis.weaknesses) ? analysis.weaknesses.slice(0, 20).map(x => safe(x, 240)) : [],
      recommendedRoles: Array.isArray(analysis.recommendedRoles) ? analysis.recommendedRoles.slice(0, 15).map(x => safe(x, 120)) : [],
      analyzedAt: analysis.analyzedAt || nowIso()
    } : cur.analysis;
    // Every outcome (including unavailable/errors) -> review_pending; preserve terminal decisions.
    if (!['approved', 'rejected'].includes(cur.status) || cur.status === 'review_pending') {
      if (!['approved', 'rejected'].includes(cur.status)) cur.status = 'review_pending';
    }
    cur.updatedAt = nowIso();
    return { status: 200, body: { ok: true, application: toStatusView(cur) } };
  }));
  if (!result.replay) audit(rec.id, 'aiko', 'analysis_received', { attempt, outcome: analysis && analysis.outcome });
  return res.status(result.status).json(result.body);
});

v1.post('/applications/:id/decision', serviceAuth, (req, res) => {
  const b = req.body || {};
  const guildId = String(b.guildId || '').trim();
  const rec = ensureGuildScoped(findApp(guildId, req.params.id), guildId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  const idemKey = req.get('idempotency-key');
  if (!idemKey) return res.status(400).json({ error: 'idempotency_key_required' });
  const decision = String(b.decision || '').trim();
  // Accept bot's documented decisions plus legacy alias.
  const norm = decision === 'info_requested' ? 'more_information_requested' : decision;
  if (!DECISIONS.has(norm)) return res.status(400).json({ error: 'invalid_decision' });
  const adminDiscordId = safe(b.adminDiscordId || b.decided_by || 'bot', 40);
  const result = idem(idemKey, `decision:${guildId}:${rec.id}:${norm}:${adminDiscordId}`, () => mutate(s => {
    const cur = s.applications[appKey(guildId, rec.id)];
    if (!cur) return { status: 404, body: { error: 'not_found' } };
    // Enforce valid transitions (human-authorized by caller context; bot enforces reviewer auth).
    const from = cur.status;
    const allowed = ['pending_analysis', 'review_pending', 'more_information_requested'].includes(from) || (from === norm);
    if (!allowed && !['approved', 'rejected'].includes(from)) return { status: 409, body: { error: 'invalid_state_transition', from } };
    if (['approved', 'rejected'].includes(from) && from !== norm) return { status: 409, body: { error: 'decision_already_final', from } };
    cur.status = norm;
    cur.revision = Number(cur.revision || 1) + 1;
    cur.updatedAt = nowIso();
    cur.lastDecision = {
      decision: norm, adminDiscordId, selectedRoles: Array.isArray(b.selectedRoles) ? b.selectedRoles.slice(0, 10) : undefined,
      reason: b.reason ? safe(b.reason, 1000) : undefined, message: b.message ? safe(b.message, 2000) : undefined, at: cur.updatedAt
    };
    s.audit.push({ applicationId: cur.id, actor: adminDiscordId, action: `decision_${norm}`, meta: { selectedRoles: cur.lastDecision.selectedRoles, reason: cur.lastDecision.reason }, at: cur.updatedAt });
    if (s.audit.length > 2000) s.audit.splice(0, s.audit.length - 2000);
    return { status: 200, body: { ok: true, status: cur.status, application: toStatusView(cur) } };
  }));
  return res.status(result.status).json(result.body);
});

v1.post('/applications/:id/notify', serviceAuth, (req, res) => {
  const b = req.body || {};
  const guildId = String(b.guildId || '').trim();
  const rec = ensureGuildScoped(findApp(guildId, req.params.id), guildId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  const idemKey = req.get('idempotency-key') || `notify:${guildId}:${rec.id}:${safe(b.type, 60)}:${safe(b.adminDiscordId, 40)}:${safe(b.reasonCode, 60)}`;
  const result = idem(idemKey, 'notify', () => {
    audit(rec.id, b.adminDiscordId || 'aiko', `notify_${safe(b.type, 60) || 'event'}`, { reasonCode: b.reasonCode, message: b.message ? safe(b.message, 500) : undefined });
    return { status: 200, body: { ok: true } };
  });
  return res.status(result.status).json(result.body);
});

// --- Website/browser helpers (session-auth; do NOT expose service key) ---
v1.get('/me', user, (req, res) => res.json(req.u));
v1.post('/auth/logout', (req, res) => { res.clearCookie('sess'); res.json({ ok: true }); });
v1.get('/auth/discord', async (req, res) => {
  const g = req.query.guild ? String(req.query.guild) : null;
  if (g && !DISCORD_ID.test(g)) return res.status(400).send('Invalid server');
  const st = jwt.sign({ g }, e.SESSION_SECRET, { expiresIn: '10m' });
  res.redirect(`https://discord.com/oauth2/authorize?client_id=${e.DISCORD_CLIENT_ID}&response_type=code&scope=identify%20guilds&redirect_uri=${encodeURIComponent(redir())}&state=${st}`);
});
v1.get('/auth/callback', async (req, res) => {
  try {
    const st = jwt.verify(req.query.state, e.SESSION_SECRET);
    const t = await (await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: e.DISCORD_CLIENT_ID, client_secret: e.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redir() })
    })).json();
    if (!t.access_token) throw new Error('oauth');
    const H = { Authorization: 'Bearer ' + t.access_token };
    const me = await (await fetch('https://discord.com/api/users/@me', { headers: H })).json();
    const gs = await (await fetch('https://discord.com/api/users/@me/guilds', { headers: H })).json();
    const member = st.g ? Array.isArray(gs) && gs.some(x => x.id === st.g) : null;
    res.cookie('sess', jwt.sign({ id: me.id, name: me.username, avatar: me.avatar, guild: st.g, member }, e.SESSION_SECRET, { expiresIn: '2h' }), { httpOnly: true, secure: true, sameSite: 'lax' });
    res.redirect(st.g ? `/?guild=${encodeURIComponent(st.g)}` : '/');
  } catch { res.status(400).send('Login failed'); }
});

// Browser status lookup convenience (keeps applicant session flow; no service key)
v1.get('/my/status', user, (req, res) => {
  const guildId = String(req.query.guild_id || req.u.guild || '').trim();
  if (!DISCORD_ID.test(guildId)) return res.status(400).json({ error: 'invalid_guild_id' });
  const rec = activeForUser(guildId, req.u.id) || Object.values(store().applications).filter(a => a.guildId === guildId && a.discordUserId === req.u.id).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json(toStatusView(rec));
});

// Uploads (images/video, magic-byte check)
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const sig = b => (b && b.length > 12 && b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ? 'image/jpeg'
  : (b.slice(1, 4).toString() === 'PNG') ? 'image/png'
  : (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ? 'image/webp'
  : (b.slice(4, 8).toString() === 'ftyp') ? 'video/mp4' : null;
v1.post('/uploads', user, up.single('file'), async (req, res) => {
  const t = req.file && sig(req.file.buffer);
  if (!t) return res.status(400).json({ error: 'unsupported_file' });
  const fp = `${req.u.id}/${crypto.randomUUID()}.${t.split('/')[1]}`;
  if (db) {
    const { error } = await db.storage.from('portfolio').upload(fp, req.file.buffer, { contentType: t });
    if (error) return res.status(500).json({ error: 'upload_failed' });
  } else {
    const dir = path.join(DATA_DIR, 'uploads', req.u.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(fp)), req.file.buffer);
  }
  res.json({ path: fp, type: t, size: req.file.size });
});

// Admin (session) — reads local store; keeps prior behavior if Supabase configured
v1.get('/admin/applications', admin, async (req, res) => {
  let items = Object.values(store().applications);
  if (req.query.guild_id) items = items.filter(a => a.guildId === String(req.query.guild_id));
  if (req.query.status) items = items.filter(a => a.status === String(req.query.status));
  if (req.query.q) { const q = String(req.query.q).toLowerCase(); items = items.filter(a => a.id.toLowerCase().includes(q) || (a.discordUsername || '').toLowerCase().includes(q)); }
  items.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
  res.json(items.slice(0, 300).map(a => ({ id: a.id, guild_id: a.guildId, discord_username: a.discordUsername, age_group: a.ageGroup, skills: a.skills, status: a.status, submitted_at: a.submittedAt })));
});
v1.post('/admin/applications/:id/notes', admin, (req, res) => { audit(req.params.id, req.u.id, 'admin_note', { note: safe(req.body && req.body.note, 2000) }); res.json({ ok: true }); });
v1.get('/admin/stats', admin, (req, res) => {
  const data = Object.values(store().applications);
  const c = f => data.reduce((a, x) => { [].concat(f(x)).filter(Boolean).forEach(k => a[k] = (a[k] || 0) + 1); return a; }, {});
  res.json({ total: data.length, by_status: c(x => x.status), by_skill: c(x => x.skills), by_age: c(x => x.ageGroup), by_guild: c(x => x.guildId) });
});

app.use('/api/v1', v1);
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
if (require.main === module) app.listen(e.PORT || 3000, () => console.log('TEAM_BAAG backend listening'));
module.exports = app;
