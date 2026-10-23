'use strict';
/*
 * Коннект: сервер без внешних библиотек (только Node.js 18+).
 * Хранит данные в файле data/db.json, отдаёт сайт из папки public/ и API по адресу /api/*.
 *
 * Переменные окружения (все необязательные):
 *   PORT      порт сервера (по умолчанию 3000)
 *   MOD_CODE  секретный код модератора. Если не задан, сервер придумает его сам и напечатает в консоли
 *   DATA_DIR  папка для db.json (по умолчанию ./data)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  внешнее хранилище, чтобы данные не стирались на хостинге
 *   NO_SEED   поставьте 1, чтобы не создавать стартовые приглашения от команды
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CATS = ['sport', 'cinema', 'expo', 'theatre', 'study', 'walk'];

/* ---------------- хранилище ---------------- */
function fresh() {
  return { seq: { user: 0, event: 0, msg: 0, report: 0 }, users: [], tokens: {}, events: [], messages: [], reports: [], meta: {} };
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign(fresh(), d);
  } catch (e) { return fresh(); }
}
let db = fresh();
let saveTimer = null;

/* Внешнее хранилище (Upstash Redis по HTTPS). Нужно на хостингах, где диск стирается при перезапуске. */
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(R_URL && R_TOK);
const R_KEY = process.env.DB_KEY || 'connect_db';
const MAX_MSGS = REMOTE ? 5000 : 20000;
async function rcmd(args) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
  return d.result;
}
let remoteBusy = false, remoteDirty = false;
async function pushRemote() {
  if (!REMOTE) return;
  if (remoteBusy) { remoteDirty = true; return; }
  remoteBusy = true;
  try {
    do { remoteDirty = false; await rcmd(['SET', R_KEY, JSON.stringify(db)]); } while (remoteDirty);
  } catch (e) {
    console.error('Не удалось сохранить во внешнее хранилище:', e.message);
    setTimeout(pushRemote, 5000).unref();
  } finally { remoteBusy = false; }
}
function writeLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Не удалось сохранить данные:', e.message); }
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeLocal();
  pushRemote();
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, REMOTE ? 1500 : 250); }
async function shutdown() {
  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeLocal();
    if (REMOTE) await Promise.race([rcmd(['SET', R_KEY, JSON.stringify(db)]), new Promise((r) => setTimeout(r, 4000))]);
  } catch (e) { /* ничего */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
async function loadDb() {
  if (!REMOTE) return load();
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const v = await rcmd(['GET', R_KEY]);
      if (v == null) { console.log('Внешнее хранилище пусто, начинаем с нуля'); return load(); }
      return Object.assign(fresh(), JSON.parse(v));
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw new Error('Внешнее хранилище недоступно: ' + (last && last.message));
}

let MOD_CODE = '';
function initMod() {
  MOD_CODE = process.env.MOD_CODE || db.meta.modCode || (db.meta.modCode = crypto.randomBytes(5).toString('hex'));
  if (!process.env.MOD_CODE) save();
}

/* ---------------- утилиты ---------------- */
const now = () => new Date().toISOString();
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function ipOf(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : req.socket.remoteAddress) || 'x';
}
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k); }, 600000).unref();

function nameFromEmail(email) {
  const n = email.split('@')[0].replace(/[._\-+0-9]+/g, ' ').trim().split(' ')[0] || 'Студент';
  return n.charAt(0).toUpperCase() + n.slice(1, 20);
}
const publicUsers = () => db.users.filter((u) => !u.system && !u.archived);
const liveEvents = () => db.events.filter((e) => !e.deleted);
const PAST_MS = 3 * 3600000;
const isPast = (e) => new Date(e.when).getTime() < Date.now() - PAST_MS;
function normSid(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().slice(0, 30);
  return /^[0-9A-ZА-ЯЁ\-\/]{4,20}$/.test(s) ? s : '';
}

/* ---------------- сериализация ---------------- */
function userView(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, course: u.course || 0, fac: u.fac || '' };
}
function eventView(e, viewer) {
  const host = db.users.find((u) => u.id === e.hostId);
  return {
    id: e.id, cat: e.cat, title: e.title, when: e.when, place: e.place, desc: e.desc, total: e.total,
    host: host ? host.name : 'Участник', hostId: e.hostId, taken: e.people.length,
    joined: !!viewer && e.people.includes(viewer.id), mine: !!viewer && e.hostId === viewer.id,
    course: host ? host.course || 0 : 0, fac: host ? host.fac || '' : '',
    people: e.people.map((id) => { const p = db.users.find((u) => u.id === id); return { name: p ? p.name : 'Участник', me: !!viewer && id === viewer.id }; }),
  };
}
function msgView(m, viewer) {
  return { id: m.id, a: m.name, t: m.t, ts: m.ts, mine: !!viewer && m.userId === viewer.id };
}

/* ---------------- ответы ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS));
  res.end(body);
}
const fail = (res, status, msg) => send(res, status, { error: msg });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('Неверный формат запроса'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function authUser(req, url) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
  if (!tok) return null;
  const id = db.tokens[tok];
  const u = id ? db.users.find((x) => x.id === id) || null : null;
  return u && !u.archived ? u : null;
}

/* ---------------- чаты ---------------- */
function chatKey(raw) { return raw === 'general' ? 'general' : Number(raw); }
function canChat(u, key) {
  if (key === 'general') return true;
  if (u.role === 'moderator') return db.events.some((e) => e.id === key);
  const e = db.events.find((x) => x.id === key);
  return !!e && e.people.includes(u.id);
}

/* ---------------- стартовые приглашения ---------------- */
function seed() {
  if (process.env.NO_SEED || db.events.length || db.users.length) return;
  const team = { id: ++db.seq.user, email: 'team@connect.local', name: 'Команда «Импульс»', course: 1, fac: '', role: 'user', created: now(), system: true };
  db.users.push(team);
  const day = (d, h, m) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  [
    ['walk', 'Первая встреча: прогулка и кофе', day(2, 17, 0), 'Место сбора обсудим в чате', 6, 'Знакомимся с ребятами с разных курсов. Приходите, будем рады каждому.'],
    ['expo', 'Идём на выставку вместе', day(4, 14, 0), 'Музей, точное место в чате встречи', 5, 'Ищем компанию на выставку. После можно выпить кофе и обсудить увиденное.'],
    ['sport', 'Волейбол для всех уровней', day(3, 18, 30), 'Спортзал, адрес в чате встречи', 10, 'Играем для удовольствия. Форму и воду берите с собой.'],
  ].forEach(([cat, title, when, place, total, desc]) => {
    db.events.push({ id: ++db.seq.event, cat, title, when, place, total, desc, hostId: team.id, people: [team.id], created: now() });
  });
  save();
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const ip = ipOf(req);
  if (limited('all:' + ip, 300, 60000)) return fail(res, 429, 'Слишком много запросов, подождите минуту');
  let b;

  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
  if (m === 'GET' && p === '/api/stats') return send(res, 200, { users: publicUsers().length, events: liveEvents().length, messages: db.messages.length });

  if (m === 'POST' && p === '/api/register') {
    if (limited('reg:' + ip, 20, 3600000)) return fail(res, 429, 'Слишком много попыток, попробуйте позже');
    b = await readBody(req);
    const email = clean(b.email, 100).toLowerCase();
    const sid = normSid(b.sid);
    if (!email && !b.sid) return fail(res, 400, 'Введите почту или номер студенческого билета');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, 'Введите корректную почту');
    if (b.sid && !sid) return fail(res, 400, 'Номер студенческого: от 4 до 20 символов, буквы и цифры');
    const byE = email ? db.users.find((x) => x.email === email) : null;
    const bySid = sid ? db.users.find((x) => x.sid === sid) : null;
    if (byE && bySid && byE !== bySid) return fail(res, 409, 'Почта и номер студенческого относятся к разным аккаунтам');
    let u = byE || bySid;
    if (u) {
      if (u.system) return fail(res, 409, 'Эти данные уже используются');
      if (u.archived) return fail(res, 403, 'Аккаунт отправлен в архив модератором');
      if (u.role === 'moderator') {
        /* в аккаунт модератора по одной почте не войти: нужен секретный код */
        if (limited('modlogin:' + ip, 8, 600000)) return fail(res, 429, 'Слишком много попыток, подождите 10 минут');
        if (!b.code) return send(res, 403, { error: 'Это аккаунт модератора. Введите секретный код.', needCode: true });
        if (!safeEq(clean(b.code, 100), MOD_CODE)) return send(res, 403, { error: 'Неверный код', needCode: true });
      }
      if (email && !u.email) u.email = email;
      if (sid && !u.sid) u.sid = sid;
    } else {
      const course = Math.max(0, Math.min(4, Number(b.course) || 0));
      u = { id: ++db.seq.user, email: email || '', sid: sid || '', name: clean(b.name, 40) || (email ? nameFromEmail(email) : 'Студент'), course, fac: clean(b.fac, 40), role: 'user', created: now() };
      db.users.push(u);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    db.tokens[token] = u.id;
    const tkeys = Object.keys(db.tokens);
    if (tkeys.length > 3000) for (const k of tkeys.slice(0, tkeys.length - 3000)) delete db.tokens[k];
    save();
    return send(res, 200, { token, user: userView(u) });
  }

  const user = authUser(req, url);

  if (m === 'GET' && p === '/api/me') return user ? send(res, 200, { user: userView(user) }) : fail(res, 401, 'Нужно войти');
  if (!user) return fail(res, 401, 'Нужно войти');
  const isMod = user.role === 'moderator';

  if (m === 'POST' && p === '/api/mod/claim') {
    if (limited('mod:' + ip, 5, 600000) || limited('mod:u' + user.id, 5, 600000)) return fail(res, 429, 'Слишком много попыток, подождите 10 минут');
    b = await readBody(req);
    if (!safeEq(clean(b.code, 100), MOD_CODE)) return fail(res, 403, 'Неверный код');
    user.role = 'moderator'; save();
    return send(res, 200, { user: userView(user) });
  }

  if (m === 'GET' && p === '/api/events') {
    return send(res, 200, { events: liveEvents().filter((e) => !isPast(e)).map((e) => eventView(e, user)) });
  }
  if (m === 'GET' && p === '/api/archive') {
    const list = liveEvents().filter(isPast).sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, 200);
    return send(res, 200, { events: list.map((e) => eventView(e, user)) });
  }
  if (m === 'POST' && p === '/api/events') {
    if (limited('ev:u' + user.id, 10, 3600000)) return fail(res, 429, 'Слишком много приглашений за час');
    b = await readBody(req);
    const title = clean(b.title, 80), place = clean(b.place, 80), desc = clean(b.desc, 500);
    const when = new Date(b.when);
    const total = Math.round(Number(b.total));
    if (!title || !place) return fail(res, 400, 'Заполните название и место');
    if (!CATS.includes(b.cat)) return fail(res, 400, 'Выберите категорию');
    if (isNaN(when) || when.getTime() < Date.now() - 86400000) return fail(res, 400, 'Укажите будущую дату');
    if (!(total >= 2 && total <= 31)) return fail(res, 400, 'Число участников от 2 до 31');
    const e = { id: ++db.seq.event, cat: b.cat, title, when: when.toISOString(), place, total, desc: desc || 'Подробности обсудим в чате встречи.', hostId: user.id, people: [user.id], created: now() };
    db.events.push(e); save();
    return send(res, 200, { event: eventView(e, user) });
  }
  let mm;
  if ((mm = p.match(/^\/api\/events\/(\d+)\/join$/)) && m === 'POST') {
    const e = liveEvents().find((x) => x.id === Number(mm[1]));
    if (!e) return fail(res, 404, 'Встреча не найдена');
    if (isPast(e)) return fail(res, 409, 'Встреча уже прошла');
    const i = e.people.indexOf(user.id);
    if (i >= 0) {
      if (e.hostId === user.id) return fail(res, 400, 'Организатор не может отменить участие');
      e.people.splice(i, 1);
    } else {
      if (e.people.length >= e.total) return fail(res, 409, 'Мест нет');
      e.people.push(user.id);
    }
    save();
    return send(res, 200, { event: eventView(e, user) });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)\/report$/)) && m === 'POST') {
    if (limited('rep:u' + user.id, 10, 3600000)) return fail(res, 429, 'Слишком много жалоб');
    const e = liveEvents().find((x) => x.id === Number(mm[1]));
    if (!e) return fail(res, 404, 'Встреча не найдена');
    b = await readBody(req);
    db.reports.push({ id: ++db.seq.report, eventId: e.id, text: clean(b.text, 200) || 'Жалоба на содержание события', by: user.name, ts: now() });
    save();
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)$/)) && m === 'DELETE') {
    const e = db.events.find((x) => x.id === Number(mm[1]));
    if (!e) return fail(res, 404, 'Встреча не найдена');
    if (!isMod && e.hostId !== user.id) return fail(res, 403, 'Нет доступа');
    e.deleted = true; e.deletedAt = now();
    db.reports = db.reports.filter((x) => x.eventId !== e.id);
    save();
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/chats\/([A-Za-z0-9]+)\/messages$/))) {
    const key = chatKey(mm[1]);
    if (key !== 'general' && !Number.isInteger(key)) return fail(res, 404, 'Чат не найден');
    if (key !== 'general' && !db.events.some((e) => e.id === key && (!e.deleted || isMod))) return fail(res, 404, 'Чат не найден');
    if (!canChat(user, key)) return fail(res, 403, 'Присоединитесь к встрече, чтобы видеть чат');
    if (m === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      const list = db.messages.filter((x) => x.chat === key && x.id > after);
      return send(res, 200, { messages: list.slice(-200).map((x) => msgView(x, user)) });
    }
    if (m === 'POST') {
      b = await readBody(req);
      const t = clean(b.t, 500);
      if (!t) return fail(res, 400, 'Пустое сообщение');
      if (limited('msg:u' + user.id, 8, 10000)) return fail(res, 429, 'Слишком быстро, подождите секунду');
      const msg = { id: ++db.seq.msg, chat: key, userId: user.id, name: user.name, t, ts: now() };
      db.messages.push(msg);
      if (db.messages.length > MAX_MSGS) db.messages.splice(0, db.messages.length - MAX_MSGS);
      save();
      return send(res, 200, { message: msgView(msg, user) });
    }
  }
  if ((mm = p.match(/^\/api\/messages\/(\d+)$/)) && m === 'DELETE') {
    if (!isMod) return fail(res, 403, 'Только для модератора');
    db.messages = db.messages.filter((x) => x.id !== Number(mm[1]));
    save();
    return send(res, 200, { ok: true });
  }

  /* --- модератор --- */
  if (p.startsWith('/api/mod/') || p.startsWith('/api/users/') || p.startsWith('/api/reports/') || /^\/api\/events\/\d+\/restore$/.test(p)) {
    if (!isMod) return fail(res, 403, 'Только для модератора');
    if (m === 'GET' && p === '/api/mod/overview') {
      return send(res, 200, {
        counts: { users: publicUsers().length, events: liveEvents().length, messages: db.messages.length, reports: db.reports.length },
        users: publicUsers().slice().reverse().map((u) => ({ id: u.id, name: u.name, email: u.email, sid: u.sid || '', role: u.role, course: u.course || 0, fac: u.fac || '', created: u.created })),
        archivedUsers: db.users.filter((u) => u.archived && !u.system).map((u) => ({ id: u.id, name: u.name, email: u.email, sid: u.sid || '', course: u.course || 0, created: u.created, archivedAt: u.archivedAt || '' })),
        events: liveEvents().filter((e) => !isPast(e)).map((e) => eventView(e, user)),
        archivedEvents: db.events.filter((e) => e.deleted).map((e) => Object.assign(eventView(e, user), { deletedAt: e.deletedAt || '' })),
        reports: db.reports.map((r) => { const e = db.events.find((x) => x.id === r.eventId); return { id: r.id, eventId: r.eventId, eventTitle: e ? e.title : '(удалено)', text: r.text, by: r.by, ts: r.ts }; }),
      });
    }
    if ((mm = p.match(/^\/api\/users\/(\d+)$/)) && m === 'DELETE') {
      const u = db.users.find((x) => x.id === Number(mm[1]));
      if (!u || u.system) return fail(res, 404, 'Аккаунт не найден');
      if (u.role === 'moderator') return fail(res, 400, 'Модератора в архив отправить нельзя');
      u.archived = true; u.archivedAt = now();
      for (const t of Object.keys(db.tokens)) if (db.tokens[t] === u.id) delete db.tokens[t];
      save();
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/users\/(\d+)\/restore$/)) && m === 'POST') {
      const u = db.users.find((x) => x.id === Number(mm[1]));
      if (!u) return fail(res, 404, 'Аккаунт не найден');
      u.archived = false; delete u.archivedAt; save();
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/events\/(\d+)\/restore$/)) && m === 'POST') {
      const e = db.events.find((x) => x.id === Number(mm[1]));
      if (!e) return fail(res, 404, 'Встреча не найдена');
      e.deleted = false; delete e.deletedAt; save();
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/reports\/(\d+)$/)) && m === 'DELETE') {
      db.reports = db.reports.filter((x) => x.id !== Number(mm[1]));
      save();
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Не найдено');
}

/* ---------------- статика и запуск ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => fail(res, e.status || 500, e.status ? e.message : 'Ошибка сервера'));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('index.html не найден в папке public'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
});
loadDb().then((d) => {
  db = d;
  initMod();
  seed();
  server.listen(PORT, () => {
    console.log('Коннект запущен: http://localhost:' + PORT);
    console.log('Хранилище: ' + (REMOTE ? 'внешнее (Upstash Redis)' : 'файл ' + DB_FILE));
    console.log('Код модератора: ' + MOD_CODE + (process.env.MOD_CODE ? '  (из переменной MOD_CODE)' : '  (создан автоматически)'));
  });
}).catch((e) => { console.error(e.message); process.exit(1); });
