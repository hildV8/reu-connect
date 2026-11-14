'use strict';
/*
 * Коннект: сервер без внешних библиотек (только Node.js 18+).
 * Хранит данные в файле data/db.json, отдаёт сайт из папки public/ и API по адресу /api/*.
 *
 * Переменные окружения (все необязательные):
 *   PORT      порт сервера (по умолчанию 3000)
 *   MOD_CODE  секретный код модератора. Если не задан, сервер придумает его сам и напечатает в консоли
 *   DATA_DIR  папка для db.json (по умолчанию ./data)
 *   NO_SEED   поставьте 1, чтобы не создавать стартовые приглашения от команды
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const BOT_WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET || '';
const CATS = ['sport', 'cinema', 'expo', 'theatre', 'study', 'walk'];

/* ---------------- хранилище ---------------- */
function fresh() {
  return { seq: { user: 0, event: 0, msg: 0, report: 0, community: 0, post: 0 }, users: [], tokens: {}, events: [], messages: [], reports: [], communities: [], posts: [], telegramLinks: {}, notificationSent: {}, meta: {} };
}
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Object.assign(fresh(), d);
  } catch (e) { return fresh(); }
}
let db = load();
let saveTimer = null;
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Не удалось сохранить данные:', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 250); }
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

const MOD_CODE = process.env.MOD_CODE || db.meta.modCode || (db.meta.modCode = crypto.randomBytes(5).toString('hex'));
if (!process.env.MOD_CODE) save();

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
const publicUsers = () => db.users.filter((u) => !u.system);

/* ---------------- сериализация ---------------- */
function userView(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    course: u.course || 0, fac: u.fac || '',
    about: u.about || '', interests: u.interests || '',
    skills: u.skills || '', achievements: u.achievements || '',
    telegramConnected: !!u.telegramChatId,
    notificationPrefs: Object.assign({ events: true, news: true, chats: true, reminders: true }, u.notificationPrefs || {})
  };
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
  return id ? db.users.find((u) => u.id === id) || null : null;
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
  // Каталог стартует с тематических студенческих направлений, а не с выдуманных аккаунтов.
  if (!db.communities) db.communities = [];
  if (!db.posts) db.posts = [];
  if (!db.telegramLinks) db.telegramLinks = {};
  if (!db.notificationSent) db.notificationSent = {};
  if (!db.seq.community) db.seq.community = 0;
  if (!db.seq.post) db.seq.post = 0;
  if (!db.communities.length) {
    [
      ['Карьера и стажировки','Возможности для старта карьеры: резюме, собеседования, стажировки и профессиональные встречи.','Карьера'],
      ['Предпринимательство и стартапы','Идеи, бизнес-модели, кейсы, запуск проектов и поиск единомышленников.','Бизнес'],
      ['Наука и олимпиады','Подготовка к олимпиадам, научные проекты, исследования и интеллектуальные соревнования.','Образование'],
      ['Спорт и активный отдых','Совместные тренировки, спортивные события и активный отдых.','Спорт'],
      ['Культура и творчество','Кино, театр, музыка, дизайн, фотография и творческие инициативы.','Творчество']
    ].forEach(([name, description, category]) => db.communities.push({ id: ++db.seq.community, name, description, category, members: [], createdBy: null, createdAt: now(), starter: true }));
  }
  // Существующие стартовые встречи оставляем только для действительно пустой новой базы.
  if (process.env.NO_SEED || db.events.length || db.users.length) { save(); return; }
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
seed();

/* ---------------- лента, сообщества и Telegram ---------------- */
function communityView(c, viewer) {
  const members = Array.isArray(c.members) ? c.members : [];
  return { id: c.id, name: c.name, description: c.description, category: c.category, memberCount: members.length, joined: !!viewer && members.includes(viewer.id), starter: !!c.starter };
}
function telegramSend(chatId, text) {
  if (!BOT_TOKEN || !chatId) return Promise.resolve(false);
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request({ hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', (c) => data += c); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false)); req.setTimeout(7000, () => { req.destroy(); resolve(false); }); req.write(body); req.end();
  });
}
async function notifyUsers(kind, message, userIds) {
  const ids = userIds || db.users.filter((u) => !u.system).map((u) => u.id);
  const jobs = ids.map((id) => {
    const u = db.users.find((x) => x.id === id);
    const prefs = Object.assign({ events: true, news: true, chats: true, reminders: true }, u && u.notificationPrefs || {});
    return u && u.telegramChatId && prefs[kind] ? telegramSend(u.telegramChatId, message) : Promise.resolve(false);
  });
  return Promise.all(jobs);
}
function telegramWebhook(req, res) {
  if (BOT_WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== BOT_WEBHOOK_SECRET) return send(res, 403, { error: 'Forbidden' });
  readBody(req).then(async (update) => {
    const msg = update && update.message;
    if (!msg || !msg.chat || !msg.text) return send(res, 200, { ok: true });
    const match = String(msg.text).trim().match(/^\/start(?:\s+link_([A-Za-z0-9_-]+))?/);
    if (!match) return send(res, 200, { ok: true });
    if (match[1]) {
      const link = db.telegramLinks[match[1]];
      if (!link || link.expiresAt < Date.now()) {
        await telegramSend(msg.chat.id, 'Ссылка привязки устарела. Вернитесь в REU CONNECT и создайте новую.');
      } else {
        const user = db.users.find((u) => u.id === link.userId);
        if (user) { user.telegramChatId = msg.chat.id; user.telegramUserId = msg.from && msg.from.id; user.telegramLinkedAt = now(); }
        delete db.telegramLinks[match[1]]; save();
        await telegramSend(msg.chat.id, 'Telegram подключён к REU CONNECT. Теперь здесь будут приходить выбранные вами уведомления.');
      }
    } else {
      await telegramSend(msg.chat.id, 'Привет! Это бот REU CONNECT. Откройте приложение и подключите Telegram в настройках уведомлений.');
    }
    send(res, 200, { ok: true });
  }).catch(() => send(res, 200, { ok: true }));
}
setInterval(() => {
  const nowMs = Date.now();
  db.events.forEach((event) => {
    const diff = new Date(event.when).getTime() - nowMs;
    if (diff > 0 && diff <= 24 * 3600000 && !db.notificationSent[event.id]) {
      db.notificationSent[event.id] = true;
      notifyUsers('reminders', 'Напоминание REU CONNECT: завтра/скоро мероприятие «' + event.title + '». Начало: ' + new Date(event.when).toLocaleString('ru-RU') + '.', event.people || []);
      save();
    }
  });
}, 60000).unref();

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const ip = ipOf(req);
  if (m === 'POST' && p === '/api/telegram/webhook') return telegramWebhook(req, res);
  if (limited('all:' + ip, 300, 60000)) return fail(res, 429, 'Слишком много запросов, подождите минуту');
  let b, mm;

  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
  if (m === 'GET' && p === '/api/stats') return send(res, 200, { users: publicUsers().length, events: db.events.length, messages: db.messages.length });

  if (m === 'POST' && p === '/api/register') {
    if (limited('reg:' + ip, 20, 3600000)) return fail(res, 429, 'Слишком много попыток, попробуйте позже');
    b = await readBody(req);
    const email = clean(b.email, 100).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, 'Введите корректную почту');
    let u = db.users.find((x) => x.email === email);
    if (u) {
      if (u.role === 'moderator' || u.system) return fail(res, 409, 'Эта почта уже используется');
    } else {
      const course = Math.max(0, Math.min(4, Number(b.course) || 0));
      u = { id: ++db.seq.user, email, name: clean(b.name, 40) || nameFromEmail(email), course, fac: clean(b.fac, 40), role: 'user', created: now() };
      db.users.push(u);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    db.tokens[token] = u.id;
    save();
    return send(res, 200, { token, user: userView(u) });
  }

  const user = authUser(req, url);

  if (m === 'GET' && p === '/api/me') return user ? send(res, 200, { user: userView(user) }) : fail(res, 401, 'Нужно войти');
  if (!user) return fail(res, 401, 'Нужно войти');

  if (m === 'GET' && p === '/api/feed') {
    const posts = (db.posts || []).slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 40);
    const upcoming = db.events.filter((e) => new Date(e.when).getTime() >= Date.now() - 3 * 3600000).map((e) => eventView(e, user));
    const interests = String(user.interests || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    const communities = db.communities.map(c => communityView(c, user)).sort((a,b) => {
      const ca = db.communities.find(x=>x.id===a.id), cb = db.communities.find(x=>x.id===b.id);
      const score = c => interests.some(i => (c.name+' '+c.description+' '+c.category).toLowerCase().includes(i)) ? 1 : 0;
      return score(cb)-score(ca) || b.memberCount-a.memberCount;
    }).slice(0, 6);
    return send(res, 200, { posts, events: upcoming, recommendations: communities });
  }
  if (m === 'GET' && p === '/api/communities') {
    const q = clean(url.searchParams.get('q'), 80).toLowerCase();
    const list = db.communities.filter(c => !q || (c.name+' '+c.description+' '+c.category).toLowerCase().includes(q));
    return send(res, 200, { communities: list.map(c => communityView(c, user)) });
  }
  if (m === 'POST' && p === '/api/communities') {
    b = await readBody(req);
    const name = clean(b.name, 70), description = clean(b.description, 500), category = clean(b.category, 40) || 'Другое';
    if (!name || !description) return fail(res, 400, 'Укажите название и описание сообщества');
    if (db.communities.some(c => c.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Сообщество с таким названием уже существует');
    const c = { id: ++db.seq.community, name, description, category, members: [user.id], createdBy: user.id, createdAt: now() };
    db.communities.push(c); save();
    return send(res, 201, { community: communityView(c, user) });
  }
  if ((mm = p.match(/^\/api\/communities\/(\d+)\/join$/)) && m === 'POST') {
    const c = db.communities.find(x => x.id === Number(mm[1]));
    if (!c) return fail(res, 404, 'Сообщество не найдено');
    c.members = Array.isArray(c.members) ? c.members : [];
    const idx = c.members.indexOf(user.id);
    if (idx >= 0) c.members.splice(idx, 1); else c.members.push(user.id);
    save(); return send(res, 200, { community: communityView(c, user) });
  }
  if (m === 'POST' && p === '/api/news') {
    if (user.role !== 'moderator') return fail(res, 403, 'Публиковать новости может модератор');
    b = await readBody(req);
    const title = clean(b.title, 100), body = clean(b.body, 1200);
    if (!title || !body) return fail(res, 400, 'Заполните заголовок и текст новости');
    const post = { id: ++db.seq.post, title, body, type: 'news', author: user.name, createdAt: now() };
    db.posts.push(post); save();
    notifyUsers('news', 'Новость REU CONNECT: ' + title + '\n' + body);
    return send(res, 201, { post });
  }
  if (m === 'POST' && p === '/api/me/notifications') {
    b = await readBody(req);
    user.notificationPrefs = Object.assign({ events: true, news: true, chats: true, reminders: true }, user.notificationPrefs || {}, {
      events: !!b.events, news: !!b.news, chats: !!b.chats, reminders: !!b.reminders
    });
    save(); return send(res, 200, { user: userView(user) });
  }
  if (m === 'POST' && p === '/api/telegram/link') {
    if (!BOT_USERNAME || !BOT_TOKEN) return fail(res, 503, 'Telegram-бот ещё не подключён на сервере. Нужны BOT_TOKEN и BOT_USERNAME в переменных окружения Render.');
    const code = crypto.randomBytes(18).toString('base64url');
    db.telegramLinks[code] = { userId: user.id, expiresAt: Date.now() + 10 * 60 * 1000 };
    save();
    return send(res, 200, { url: 'https://t.me/' + BOT_USERNAME + '?start=link_' + code, expiresIn: 600 });
  }
  if (m === 'POST' && p === '/api/telegram/unlink') {
    delete user.telegramChatId; delete user.telegramUserId; delete user.telegramLinkedAt; save();
    return send(res, 200, { user: userView(user) });
  }

  if (m === 'POST' && p === '/api/me/profile') {
    b = await readBody(req);
    const name = clean(b.name, 40);
    const course = Number(b.course);
    if (!name) return fail(res, 400, 'Укажите имя');
    if (!Number.isInteger(course) || course < 0 || course > 4) return fail(res, 400, 'Выберите корректный курс');
    user.name = name;
    user.course = course;
    user.fac = clean(b.fac, 60);
    user.about = clean(b.about, 300);
    user.interests = clean(b.interests, 240);
    user.skills = clean(b.skills, 240);
    user.achievements = clean(b.achievements, 300);
    save();
    return send(res, 200, { user: userView(user) });
  }
  const isMod = user.role === 'moderator';

  if (m === 'POST' && p === '/api/mod/claim') {
    if (limited('mod:' + ip, 5, 600000) || limited('mod:u' + user.id, 5, 600000)) return fail(res, 429, 'Слишком много попыток, подождите 10 минут');
    b = await readBody(req);
    if (!safeEq(clean(b.code, 100), MOD_CODE)) return fail(res, 403, 'Неверный код');
    user.role = 'moderator'; save();
    return send(res, 200, { user: userView(user) });
  }

  if (m === 'GET' && p === '/api/events') {
    const from = Date.now() - 3 * 3600000;
    return send(res, 200, { events: db.events.filter((e) => new Date(e.when).getTime() >= from).map((e) => eventView(e, user)) });
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
    notifyUsers('events', 'Новое мероприятие REU CONNECT: ' + e.title + '\n' + e.place + ' · ' + new Date(e.when).toLocaleString('ru-RU'));
    return send(res, 200, { event: eventView(e, user) });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)\/join$/)) && m === 'POST') {
    const e = db.events.find((x) => x.id === Number(mm[1]));
    if (!e) return fail(res, 404, 'Встреча не найдена');
    const i = e.people.indexOf(user.id);
    if (i >= 0) {
      if (e.hostId === user.id) return fail(res, 400, 'Организатор не может отменить участие');
      e.people.splice(i, 1);
    } else {
      if (e.people.length >= e.total) return fail(res, 409, 'Мест нет');
      e.people.push(user.id);
    }
    save();
    if (i < 0) { const host = db.users.find(x => x.id === e.hostId); if (host && host.id !== user.id) notifyUsers('events', user.name + ' присоединился к мероприятию «' + e.title + '».', [host.id]); }
    return send(res, 200, { event: eventView(e, user) });
  }
  if ((mm = p.match(/^\/api\/events\/(\d+)\/report$/)) && m === 'POST') {
    if (limited('rep:u' + user.id, 10, 3600000)) return fail(res, 429, 'Слишком много жалоб');
    const e = db.events.find((x) => x.id === Number(mm[1]));
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
    db.events = db.events.filter((x) => x.id !== e.id);
    db.messages = db.messages.filter((x) => x.chat !== e.id);
    db.reports = db.reports.filter((x) => x.eventId !== e.id);
    save();
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/chats\/([A-Za-z0-9]+)\/messages$/))) {
    const key = chatKey(mm[1]);
    if (key !== 'general' && !Number.isInteger(key)) return fail(res, 404, 'Чат не найден');
    if (key !== 'general' && !db.events.some((e) => e.id === key)) return fail(res, 404, 'Чат не найден');
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
      if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
      save();
      if (key !== 'general') { const ev = db.events.find(x => x.id === key); if (ev) notifyUsers('chats', 'Новое сообщение в чате мероприятия «' + ev.title + '» от ' + user.name + ': ' + t, ev.people.filter(id => id !== user.id)); }
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
  if (p.startsWith('/api/mod/') || p.startsWith('/api/users/') || p.startsWith('/api/reports/')) {
    if (!isMod) return fail(res, 403, 'Только для модератора');
    if (m === 'GET' && p === '/api/mod/overview') {
      return send(res, 200, {
        counts: { users: publicUsers().length, events: db.events.length, messages: db.messages.length, reports: db.reports.length },
        users: publicUsers().slice().reverse().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, course: u.course || 0, fac: u.fac || '', created: u.created })),
        events: db.events.map((e) => eventView(e, user)),
        reports: db.reports.map((r) => { const e = db.events.find((x) => x.id === r.eventId); return { id: r.id, eventId: r.eventId, eventTitle: e ? e.title : '(удалено)', text: r.text, by: r.by, ts: r.ts }; }),
      });
    }
    if ((mm = p.match(/^\/api\/users\/(\d+)$/)) && m === 'DELETE') {
      const u = db.users.find((x) => x.id === Number(mm[1]));
      if (!u || u.system) return fail(res, 404, 'Аккаунт не найден');
      if (u.role === 'moderator') return fail(res, 400, 'Модератора удалить нельзя');
      db.users = db.users.filter((x) => x.id !== u.id);
      for (const t of Object.keys(db.tokens)) if (db.tokens[t] === u.id) delete db.tokens[t];
      const mine = db.events.filter((e) => e.hostId === u.id).map((e) => e.id);
      db.events = db.events.filter((e) => e.hostId !== u.id);
      db.events.forEach((e) => { e.people = e.people.filter((id) => id !== u.id); });
      db.messages = db.messages.filter((x) => x.userId !== u.id && !mine.includes(x.chat));
      db.reports = db.reports.filter((x) => !mine.includes(x.eventId));
      save();
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
server.listen(PORT, () => {
  console.log('Коннект запущен: http://localhost:' + PORT);
  console.log('Код модератора: ' + MOD_CODE + (process.env.MOD_CODE ? '  (из переменной MOD_CODE)' : '  (создан автоматически, сохранён в data/db.json)'));
});
