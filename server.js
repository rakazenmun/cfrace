const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const PORT = process.env.PORT || 3000;
const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';
const { SupabaseStore, FileStore } = require('./storage');
const storage = process.env.STORAGE_BACKEND === 'file' && !process.env.RENDER
  ? new FileStore(process.env.STATE_FILE || path.join(__dirname, 'state.json'))
  : new SupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY });
if (!PUBLISHABLE_KEY) { console.error('Set CLERK_PUBLISHABLE_KEY in .env'); process.exit(1); }
const FRONTEND_API = Buffer.from(PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, ''), 'base64').toString().replace(/\$$/, '');
const ISSUER = 'https://' + FRONTEND_API;

const MIN_PTS = 1000, MAX_PTS = 3500;
const WRONG_MIN = 5;
const POLL_MS = 6000;
const GRACE_MS = 5 * 60000;
const MAX_CODE = 20000;
const K_FACTOR = 32;
const UNRATED_START = 1000;
const CF_ID = process.env.CF_CLIENT_ID || '', CF_SECRET = process.env.CF_CLIENT_SECRET || '';
const CF_ISSUER = (process.env.CF_ISSUER || 'https://codeforces.com').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED_HANDLE === '1';
const ADMIN_USER_ID = process.env.ADMIN_CLERK_USER_ID || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const HANDLE_COOLDOWN = 7 * 864e5, CARRY_PER = 600, CARRY_BASE = 10;

const basePts = r => Math.round(Math.min(MAX_PTS, Math.max(MIN_PTS, MIN_PTS + (r - 800) / 8)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const buckets = new Map(), sseCount = new Map();
const rl = (key, max, win) => { const t = Date.now(); let b = buckets.get(key); if (!b || t > b.reset) { b = { n: 0, reset: t + win }; buckets.set(key, b); } return ++b.n <= max; };
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';

let users = {};
const saveUsers = () => saveRooms();
const byHandle = h => Object.values(users).find(u => u.handle.toLowerCase() === h.toLowerCase());

let jwks = null, jwksAt = 0;
async function signingKey(kid) {
  if (!jwks || Date.now() - jwksAt > 36e5 || (!jwks.some(k => k.kid === kid) && Date.now() - jwksAt > 60000)) {
    jwks = (await (await fetch(ISSUER + '/.well-known/jwks.json')).json()).keys;
    jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === kid);
  if (!jwk) throw new Error('Unknown signing key');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}
async function authenticate(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!s) throw new Error('Sign in first.');
  const head = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), await signingKey(head.kid), Buffer.from(s, 'base64url'));
  const t = Date.now() / 1000;
  if (!ok || claims.iss !== ISSUER || claims.exp < t || (claims.nbf && claims.nbf > t + 5)) throw new Error('Session expired. Sign in again.');
  return claims.sub;
}

let nextSlot = 0;
async function cf(method, params = {}) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + 2100;
  if (wait) await sleep(wait);
  const res = await fetch('https://codeforces.com/api/' + method + '?' + new URLSearchParams(params));
  const j = await res.json();
  if (j.status !== 'OK') throw new Error(j.comment || 'Codeforces API error');
  return j.result;
}

let bank = null, bankAt = 0;
async function problemBank() {
  if (!bank || Date.now() - bankAt > 36e5) {
    bank = (await cf('problemset.problems')).problems.filter(p => p.rating && p.contestId);
    bankAt = Date.now();
  }
  return bank;
}

const rooms = new Map();
const LOBBY_TTL = 2 * 36e5;
function serializedRooms() {
  return [...rooms.values()].map(r => ({ ...r, subs: undefined, timer: undefined,
    players: [...r.players], ready: [...r.ready], forfeit: [...r.forfeit] }));
}
function saveRooms() { return storage.save(users, serializedRooms()); }
function background(task) {
  Promise.resolve(task).catch(() => console.error('Background operation failed; check persistent storage availability.'));
}
const pasteDeadline = room => room.pasteEndsAt ?? (room.endAt + GRACE_MS);
const eligiblePlayers = room => [...room.players].filter(h => !room.forfeit.has(h));
function everyoneSolved(room) {
  const players = eligiblePlayers(room);
  return players.length > 0 && room.problems.length > 0 && players.every(h =>
    room.problems.every(p => room.scores[h]?.[key(p)]?.solved));
}
function everyonePasted(room) {
  return eligiblePlayers(room).every(h => Object.entries(room.scores[h] || {}).every(([k, o]) =>
    !o.solved || typeof room.codes[h]?.[k] === 'string'));
}
async function advanceRoom(room) {
  if (room.finalized || room.deleted) return;
  if (Date.now() < room.endAt && everyoneSolved(room)) endEarly(room);
  if (Date.now() >= room.endAt && !room.pendingJudging && everyonePasted(room) &&
      (everyoneSolved(room) || room.lastPollAt >= room.endAt)) {
    room.pasteEndsAt = Date.now();
    clearTimeout(room.timer);
    await finalize(room);
  } else await push(room);
}
function schedule(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => background(finalize(room)), Math.max(0, pasteDeadline(room) - Date.now()) + 30000);
}
function endEarly(room) {
  const t = Date.now();
  if (room.startAt > t) room.startAt = t;
  room.endAt = t;
  room.pasteEndsAt = t + GRACE_MS;
  schedule(room);
}
function restoreRooms(list) {
  list.forEach(r => {
    const players = r.finalized ? r.players : r.players.filter(h => byHandle(h));
    if (!players.length) return;
    const room = { ...r, players: new Set(players), ready: new Set(r.ready), forfeit: new Set(r.forfeit || []),
      subs: new Set(), starting: !!r.startAt, touched: Date.now() };
    if (!players.includes(room.host)) room.host = players[0];
    rooms.set(room.code, room);
    if (room.startAt && !room.finalized && !room.deleted) { schedule(room); background(pollLoop(room)); }
  });
  console.log('Restored ' + rooms.size + ' room(s)');
}
setInterval(() => {
  if (!storage.revision && !(storage instanceof FileStore) || storage.error) return;
  const t = Date.now();
  for (const [c, r] of rooms) {
    const dead = !r.startAt && !r.starting && t - (r.touched || 0) > LOBBY_TTL;
    if (dead) rooms.delete(c);
  }
  background(saveRooms());
}, 10 * 60000).unref();
const key = p => p.contestId + p.index;

function inRace(room, s) {
  const t = s.creationTimeSeconds * 1000;
  return t >= room.startAt && t <= room.endAt && room.problems.some(p => p.contestId === s.problem.contestId && p.index === s.problem.index);
}

function score(room, subs) {
  const out = {};
  subs.slice().sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds).forEach(s => {
    if (!inRace(room, s)) return;
    const t = s.creationTimeSeconds * 1000;
    const p = room.problems.find(p => p.contestId === s.problem.contestId && p.index === s.problem.index);
    const o = out[key(p)] || (out[key(p)] = { wrong: 0, solved: false });
    if (o.solved) return;
    if (s.verdict === 'OK') {
      o.solved = true; o.at = t;
      o.pts = Math.max(0, Math.round(p.pts * (1 - ((t - room.startAt) + o.wrong * WRONG_MIN * 60000) / (room.cfg.minutes * 60000))));
    } else if (s.verdict && s.verdict !== 'COMPILATION_ERROR' && s.verdict !== 'TESTING') o.wrong++;
  });
  return out;
}

function standings(room) {
  return [...room.players].map(h => {
    const v = Object.entries(room.scores[h] || {}).filter(([k, o]) => o.solved && !room.invalidCodes?.[h]?.[k] && room.codes[h] && room.codes[h][k]).map(([, o]) => o);
    return { handle: h, f: room.forfeit.has(h), pts: v.reduce((a, o) => a + o.pts, 0) + (room.bonus?.[h] || 0), t: v.reduce((a, o) => a + o.at - room.startAt, 0) };
  });
}

const beats = (a, b) => a.f !== b.f ? !a.f : a.pts !== b.pts ? a.pts > b.pts : a.t < b.t;
const tied = (a, b) => a.f === b.f && a.pts === b.pts && (a.pts === 0 || a.t === b.t);

function applyResults(room, correction = false) {
  const st = standings(room), n = st.length, old = room.eloResult || {}, delta = {};
  const before = h => correction && old[h] ? old[h].before : byHandle(h).elo;
  if (room.cfg.ranked && n >= 2) {
    st.forEach(a => {
      let sum = 0;
      st.forEach(b => {
        if (a === b) return;
        const sc = tied(a, b) ? 0.5 : beats(a, b) ? 1 : 0;
        const e = 1 / (1 + Math.pow(10, (before(b.handle) - before(a.handle)) / 400));
        sum += sc - e;
      });
      delta[a.handle] = Math.round(K_FACTOR / (n - 1) * sum);
    });
    room.eloResult = {};
    st.forEach(a => {
      const u = byHandle(a.handle), base = before(a.handle);
      const oldDelta = old[a.handle] ? old[a.handle].after - old[a.handle].before : 0;
      u.elo += delta[a.handle] - (correction ? oldDelta : 0);
      if (!correction) u.games = (u.games || 0) + 1;
      room.eloResult[a.handle] = { before: base, after: base + delta[a.handle] };
    });
  }
  st.forEach(a => {
    const u = byHandle(a.handle);
    u.history = u.history || [];
    const result = { code: room.code, at: room.endAt, ranked: room.cfg.ranked && n >= 2,
      rank: 1 + st.filter(b => b !== a && beats(b, a)).length, of: n, pts: a.pts,
      forfeit: a.f, opp: st.filter(b => b !== a).map(b => b.handle),
      elo: room.eloResult?.[a.handle] || null, reviewedAt: correction ? Date.now() : undefined };
    const i = u.history.findIndex(g => g.code === room.code && g.at === room.endAt);
    if (i >= 0) u.history[i] = result; else u.history.unshift(result);
  });
}
async function finalize(room) {
  if (storage.error) throw storage.error;
  if (room.finalized || room.deleted || !room.startAt) return;
  room.finalized = true;
  applyResults(room);
  await push(room);
}

function view(room, viewer) {
  const live = room.startAt && Date.now() >= room.startAt;
  const open = room.endAt && Date.now() >= pasteDeadline(room);
  const scores = {}, codes = {};
  for (const h of Object.keys(room.scores)) {
    scores[h] = {};
    for (const k of Object.keys(room.scores[h])) {
      const has = room.codes[h] && room.codes[h][k];
      scores[h][k] = { ...room.scores[h][k], claimed: !!has && !room.invalidCodes?.[h]?.[k], invalidated: !!room.invalidCodes?.[h]?.[k] };
      if (has) {
        codes[h] = codes[h] || {};
        codes[h][k] = (open || h === viewer) ? has : true;
      }
    }
  }
  return {
    code: room.code, host: room.host, cfg: room.cfg, now: Date.now(), startAt: room.startAt, endAt: room.endAt, pasteEndsAt: pasteDeadline(room),
    players: [...room.players].map(h => ({ handle: h, elo: (byHandle(h) || {}).elo, ready: room.ready.has(h), forfeit: room.forfeit.has(h) })),
    problems: live ? room.problems : null, scores, codes, log: room.log, eloResult: room.eloResult || null,
    bonus: room.bonus || {}, error: room.error || null, rules: { WRONG_MIN }
  };
}
async function push(room) {
  room.touched = Date.now(); await saveRooms();
  room.subs.forEach(r => r.write('data: ' + JSON.stringify(view(room, r.handle)) + '\n\n'));
}

async function startRoom(room) {
  room.starting = true;
  try {
    const solved = new Set();
    for (const h of room.players) {
      const subs = await cf('user.status', { handle: h });
      subs.forEach(s => { if (s.verdict === 'OK') solved.add(key(s.problem)); });
    }
    const { minRating, maxRating, tag, n } = room.cfg;
    let pool = (await problemBank()).filter(p => p.rating >= minRating && p.rating <= maxRating &&
      (!tag || p.tags.includes(tag)) && !solved.has(key(p)));
    if (pool.length < n) throw new Error('Only ' + pool.length + ' unsolved problems match. Loosen the filters.');
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    room.problems = pool.slice(0, n).sort((a, b) => a.rating - b.rating)
      .map(p => ({ contestId: p.contestId, index: p.index, name: p.name, rating: p.rating, tags: p.tags, pts: basePts(p.rating) }));
    room.startAt = Date.now() + 5000;
    room.endAt = room.startAt + room.cfg.minutes * 60000;
    room.pasteEndsAt = room.endAt + GRACE_MS;
    await push(room);
    setTimeout(() => background(push(room)), 5100);
    schedule(room);
    background(pollLoop(room));
  } catch (e) { if (storage.error) throw storage.error; room.error = e.message; room.starting = false; await push(room); }
}

async function pollLoop(room) {
  const generation = room.pollGeneration = (room.pollGeneration || 0) + 1;
  await sleep(Math.max(0, room.startAt - Date.now()));
  while (room.pollGeneration === generation && !storage.error && !room.deleted && !room.finalized && rooms.get(room.code) === room) {
    const last = Date.now() >= pasteDeadline(room);
    let completePoll = true; room.pendingJudging = false;
    for (const h of [...room.players]) {
      try {
        const subs = await cf('user.status', { handle: h, from: 1, count: 100 });
        if (room.finalized || room.deleted || room.pollGeneration !== generation) return;
        if (subs.some(s => inRace(room, s) && (!s.verdict || s.verdict === 'TESTING'))) room.pendingJudging = true;
        room.scores[h] = score(room, subs);
        room.log[h] = subs.filter(s => s.verdict && s.verdict !== 'TESTING' && inRace(room, s)).map(s => ({
          id: s.id, key: key(s.problem), contestId: s.problem.contestId, verdict: s.verdict,
          t: s.creationTimeSeconds * 1000, lang: s.programmingLanguage
        })).sort((a, b) => a.t - b.t);
      } catch (e) { completePoll = false; }
    }
    if (completePoll) room.lastPollAt = Date.now();
    await advanceRoom(room);
    if (last) break;
    await sleep(POLL_MS);
  }
  if (rooms.get(room.code) === room && room.pollGeneration === generation && !room.deleted) await finalize(room);
}

const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 100000) { req.destroy(); r({}); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
const send = async (res, code, obj) => {
  if (code < 400) {
    try { await storage.flush(); }
    catch { code = 503; obj = { error: 'Persistent storage is unavailable. Please try again after recovery.' }; }
  }
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj));
};
const fail = (res, code, msg) => send(res, code, { error: msg });

async function newHost(room) {
  const next = [...room.players][0];
  if (!next) { rooms.delete(room.code); await saveRooms(); return; }
  room.host = next;
}

const oidcStates = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of oidcStates) if (t > v.exp) oidcStates.delete(k); }, 60000).unref();
let oidcCache = null, oidcAt = 0;
async function oidcConf() {
  if (!oidcCache || Date.now() - oidcAt > 36e5) { oidcCache = await (await fetch(CF_ISSUER + '/.well-known/openid-configuration')).json(); oidcAt = Date.now(); }
  return oidcCache;
}
const activeRoomsFor = handle => [...rooms.values()].filter(r => r.players.has(handle) && !r.finalized && !r.deleted);
function changeBlock(u) {
  if (u.handleChangedAt && Date.now() - u.handleChangedAt < HANDLE_COOLDOWN)
    return 'You can change your handle again on ' + new Date(u.handleChangedAt + HANDLE_COOLDOWN).toISOString().slice(0, 10) + '.';
  if (activeRoomsFor(u.handle).length) return 'Leave or finish your active races before changing your handle.';
  return null;
}
function carryElo(u, newBase) {
  const oldBase = u.cfRating || UNRATED_START, earned = u.elo - oldBase;
  return Math.max(0, Math.round(newBase + earned * Math.pow(CARRY_BASE, -(newBase - oldBase) / CARRY_PER)));
}
function renameHandle(oldHandle, newHandle) {
  if (oldHandle === newHandle) return;
  for (const r of rooms.values()) {
    for (const field of ['players', 'ready', 'forfeit']) if (r[field].delete(oldHandle)) r[field].add(newHandle);
    if (r.host === oldHandle) r.host = newHandle;
    for (const client of r.subs) if (client.handle === oldHandle) client.handle = newHandle;
    for (const field of ['scores', 'codes', 'log', 'invalidCodes', 'bonus', 'eloResult']) {
      if (r[field] && Object.hasOwn(r[field], oldHandle)) { r[field][newHandle] = r[field][oldHandle]; delete r[field][oldHandle]; }
    }
  }
  for (const u of Object.values(users)) for (const g of u.history || []) g.opp = g.opp.map(h => h === oldHandle ? newHandle : h);
}
async function applyLink(userId, info) {
  const u = users[userId], base = info.rating || UNRATED_START, other = byHandle(info.handle);
  if (other && other !== u) throw new Error('That Codeforces account is already linked to another user.');
  if (!u) {
    users[userId] = { handle: info.handle, cfRating: base, elo: base, games: 0, verified: true, history: [] };
    await saveUsers(); return 'Linked ' + info.handle + '.';
  }
  if (u.handle.toLowerCase() === info.handle.toLowerCase()) { renameHandle(u.handle, info.handle); u.handle = info.handle; u.verified = true; await saveUsers(); return 'Verified ' + u.handle + '.'; }
  const b = changeBlock(u);
  if (b) throw new Error(b);
  const before = u.elo;
  u.elo = carryElo(u, base); u.cfRating = base; renameHandle(u.handle, info.handle); u.handle = info.handle; u.verified = true; u.handleChangedAt = Date.now();
  await saveUsers();
  return 'Handle changed to ' + info.handle + '. Elo ' + before + ' -> ' + u.elo + '.';
}
async function verifyIdToken(tok, conf, nonce) {
  const [h, p, sig] = String(tok).split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url')), c = JSON.parse(Buffer.from(p, 'base64url'));
  if (head.alg === 'RS256' && conf.jwks_uri) {
    const keys = (await (await fetch(conf.jwks_uri)).json()).keys, jwk = keys.find(k => k.kid === head.kid) || keys[0];
    if (!jwk || !crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url')))
      throw new Error('Codeforces login could not be verified.');
  }
  const iss = String(c.iss || '').replace(/\/$/, ''), want = String(conf.issuer || CF_ISSUER).replace(/\/$/, '');
  if ((iss && iss !== want) || ![].concat(c.aud).includes(CF_ID) || c.exp < Date.now() / 1000 || c.nonce !== nonce) throw new Error('Codeforces login was rejected.');
  return c;
}
async function oidcCallback(url, res) {
  const back = q => { res.writeHead(302, { Location: '/?' + q }); res.end(); };
  const sk = url.searchParams.get('state') || '', st = oidcStates.get(sk);
  oidcStates.delete(sk);
  try {
    if (!st || Date.now() > st.exp) throw new Error('That login link expired. Try again.');
    if (url.searchParams.get('error')) throw new Error('Codeforces login was cancelled.');
    const conf = await oidcConf();
    const tr = await fetch(conf.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: PUBLIC_URL + '/auth/codeforces/callback', client_id: CF_ID, client_secret: CF_SECRET }) });
    const tj = await tr.json();
    if (!tj.id_token) throw new Error('Codeforces did not return an identity token.');
    const c = await verifyIdToken(tj.id_token, conf, st.nonce);
    const handle = c.handle || c.preferred_username || c.name;
    if (!handle) throw new Error('Codeforces did not return a handle.');
    let info = { handle, rating: +c.rating || 0 };
    try { info = (await cf('user.info', { handles: handle }))[0]; } catch (e) {}
    back('oidc=' + encodeURIComponent(await applyLink(st.userId, info)));
  } catch (e) { back('oidc_error=' + encodeURIComponent(e.message)); }
}

async function main() {
const state = await storage.load();
users = state.users;
restoreRooms(state.rooms);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  try {
    if (storage.error) return fail(res, 503, 'Persistent storage is unavailable. Restart after recovery.');
    if (!rl('ip:' + clientIp(req), 300, 60000)) return fail(res, 429, 'Too many requests. Slow down.');
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      let adminId;
      try {
        const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('__session='));
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '') || (cookie && decodeURIComponent(cookie.slice(10)));
        adminId = await authenticate(token);
      } catch {}
      if (!ADMIN_USER_ID || adminId !== ADMIN_USER_ID || url.pathname !== '/admin') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found');
      }
      res.setHeader('Cache-Control', 'private, no-store');
    }
    if (req.method === 'GET' && url.pathname === '/auth/codeforces/callback') return oidcCallback(url, res);
    if (['GET', 'HEAD'].includes(req.method) && (['/', '/leaderboard', '/history', '/archive', '/admin'].includes(url.pathname) || /^\/(race|watch|archive)\/[A-Za-z]{5}$/.test(url.pathname))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { publishableKey: PUBLISHABLE_KEY, frontendApi: FRONTEND_API });

    // Only finalized races whose paste window is closed are publicly readable.
    const archived = r => !r.deleted && r.finalized && r.endAt && Date.now() >= pasteDeadline(r);
    if (req.method === 'GET' && url.pathname === '/api/archive') {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
      const all = [...rooms.values()].filter(archived).sort((a, b) => b.endAt - a.endAt || a.code.localeCompare(b.code));
      return send(res, 200, { rooms: all.slice(offset, offset + 50).map(r => ({
        code: r.code, endAt: r.endAt, ranked: r.cfg.ranked, players: [...r.players]
      })), next: offset + 50 < all.length ? offset + 50 : null });
    }
    const archiveMatch = url.pathname.match(/^\/api\/archive\/([A-Za-z]{5})$/);
    if (req.method === 'GET' && archiveMatch) {
      const room = rooms.get(archiveMatch[1].toUpperCase());
      if (!room || !archived(room)) return fail(res, 404, 'Finished room not available. The paste window may still be open.');
      return send(res, 200, { ...view(room, null), codes: room.codes });
    }

    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
    let userId;
    try { userId = await authenticate(bearer); } catch (e) { return url.pathname.startsWith('/api/admin') ? fail(res, 404, 'Not found') : fail(res, 401, e.message); }
    const user = users[userId];
    if (!rl('u:' + userId, 240, 60000)) return fail(res, 429, 'Too many requests. Slow down.');

    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, user ? { handle: user.handle, elo: user.elo, games: user.games || 0, verified: !!user.verified, changeBlock: changeBlock(user), oidc: !!(CF_ID && CF_SECRET), admin: !!ADMIN_USER_ID && userId === ADMIN_USER_ID } : { handle: null, oidc: !!(CF_ID && CF_SECRET), dev: ALLOW_UNVERIFIED, admin: !!ADMIN_USER_ID && userId === ADMIN_USER_ID });

    if (req.method === 'POST' && url.pathname === '/api/handle') {
      if (!ALLOW_UNVERIFIED) return fail(res, 400, 'Verify your handle with Codeforces.');
      if (user) return fail(res, 400, 'Your handle is already set.');
      const b = await readBody(req);
      let info;
      try { info = (await cf('user.info', { handles: String(b.handle || '').trim() }))[0]; } catch (e) { return fail(res, 400, 'Codeforces handle not found.'); }
      if (byHandle(info.handle)) return fail(res, 400, 'That handle is already linked to another account.');
      users[userId] = { handle: info.handle, cfRating: info.rating || null, elo: info.rating || UNRATED_START, games: 0, verified: false };
      await saveUsers();
      return send(res, 200, { handle: info.handle, elo: users[userId].elo, games: 0 });
    }

    if (req.method === 'POST' && url.pathname === '/api/oidc/start') {
      if (!CF_ID || !CF_SECRET) return fail(res, 400, 'Codeforces login is not configured.');
      if (!rl('oidc:' + userId, 10, 36e5)) return fail(res, 429, 'Too many verification attempts. Try later.');
      if (user && user.verified) { const b = changeBlock(user); if (b) return fail(res, 400, b); }
      const conf = await oidcConf(), state = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
      oidcStates.set(state, { userId, nonce, exp: Date.now() + 10 * 60000 });
      return send(res, 200, { url: conf.authorization_endpoint + '?' + new URLSearchParams({ response_type: 'code', client_id: CF_ID,
        redirect_uri: PUBLIC_URL + '/auth/codeforces/callback', scope: 'openid', state, nonce }) });
    }
    if (url.pathname.startsWith('/api/admin')) {
      if (!ADMIN_USER_ID || userId !== ADMIN_USER_ID) return fail(res, 404, 'Not found');
      if (req.method === 'GET' && url.pathname === '/api/admin/users')
        return send(res, 200, { users: Object.entries(users).map(([id, u]) => ({ id, handle: u.handle, elo: u.elo, games: u.games || 0, cfRating: u.cfRating, verified: !!u.verified, handleChangedAt: u.handleChangedAt || 0 })) });
      if (req.method === 'POST' && url.pathname === '/api/admin/profile') {
        const b = await readBody(req), id = String(b.userId || '').trim(), handle = String(b.handle || '').trim();
        const reason = String(b.reason || '').trim().slice(0, 500);
        if (!/^user_[A-Za-z0-9]+$/.test(id) || !/^[A-Za-z0-9_.-]{1,24}$/.test(handle) || !reason)
          return fail(res, 400, 'Provide a Clerk user ID, valid handle, and reason.');
        for (const field of ['elo', 'cfRating', 'games', 'handleChangedAt'])
          if (!Number.isSafeInteger(b[field]) || b[field] < 0) return fail(res, 400, 'Ratings, games and cooldown timestamp must be nonnegative integers.');
        if (typeof b.verified !== 'boolean') return fail(res, 400, 'Verification must be true or false.');
        const existing = Object.hasOwn(users, id) ? users[id] : null;
        if (b.create ? !!existing : !existing) return fail(res, 400, b.create ? 'Clerk account already has a profile.' : 'Profile not found.');
        const other = byHandle(handle);
        if (other && other !== existing) return fail(res, 400, 'Handle belongs to another account.');
        const before = existing ? { handle: existing.handle, elo: existing.elo, cfRating: existing.cfRating,
          games: existing.games || 0, verified: !!existing.verified, handleChangedAt: existing.handleChangedAt || 0 } : null;
        const restart = [];
        if (existing && existing.handle !== handle) {
          for (const r of rooms.values()) if (r.players.has(existing.handle) && r.startAt && !r.finalized && !r.deleted) {
            r.pollGeneration = (r.pollGeneration || 0) + 1; restart.push(r);
          }
          renameHandle(existing.handle, handle);
        }
        const u = existing || { history: [] };
        Object.assign(u, { handle, elo: b.elo, cfRating: b.cfRating, games: b.games, verified: b.verified, handleChangedAt: b.handleChangedAt });
        u.adminReviews = u.adminReviews || [];
        u.adminReviews.push({ at: Date.now(), action: b.create ? 'createProfile' : 'editProfile', before,
          after: { handle, elo: b.elo, cfRating: b.cfRating, games: b.games, verified: b.verified, handleChangedAt: b.handleChangedAt }, reason });
        users[id] = u;
        await saveUsers();
        for (const r of restart) background(pollLoop(r));
        for (const r of rooms.values()) if (r.players.has(handle))
          r.subs.forEach(client => client.write('data: ' + JSON.stringify(view(r, client.handle)) + '\n\n'));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/user') {
        const b = await readBody(req), u = byHandle(String(b.handle || ''));
        if (!u) return fail(res, 404, 'Linked account not found.');
        const reason = String(b.reason || '').trim().slice(0, 500);
        if (!reason || !Number.isInteger(b.elo) || b.elo < 0 || b.elo > 100000)
          return fail(res, 400, 'Provide a reason and an Elo between 0 and 100000.');
        u.adminReviews = u.adminReviews || [];
        u.adminReviews.push({ at: Date.now(), before: u.elo, after: b.elo, reason });
        u.elo = b.elo;
        await saveUsers();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/rooms')
        return send(res, 200, { rooms: [...rooms.values()].map(r => ({ code: r.code, players: [...r.players],
          endAt: r.endAt, finalized: !!r.finalized, deleted: !!r.deleted })) });
      if (req.method === 'GET' && url.pathname === '/api/admin/room') {
        const r = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
        if (!r) return fail(res, 404, 'No such room.');
        return send(res, 200, { ...view(r, null), codes: r.codes, invalidCodes: r.invalidCodes || {},
          audit: r.audit || [], problemChanges: r.problemChanges || [], deleted: !!r.deleted, finalized: !!r.finalized });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/action') {
        const b = await readBody(req), r = rooms.get(String(b.code || '').toUpperCase());
        if (!r) return fail(res, 404, 'No such room.');
        const reason = String(b.reason || '').trim().slice(0, 500);
        if (!reason) return fail(res, 400, 'Provide a reason for the review.');
        if (b.action === 'problem') {
          const slot = Number(b.slot), contestId = Number(b.contestId), index = String(b.index || '').toUpperCase();
          if (!Number.isInteger(slot) || slot < 0 || slot >= r.problems.length) return fail(res, 400, 'Invalid problem slot.');
          const problem = (await problemBank()).find(p => p.contestId === contestId && p.index === index);
          if (!problem) return fail(res, 400, 'Rated Codeforces problem not found.');
          if (r.problems.some((p, i) => i !== slot && p.contestId === contestId && p.index === index)) return fail(res, 400, 'Problem already in room.');
          const submissions = {};
          for (const h of r.players) submissions[h] = await cf('user.status', { handle: h });
          const oldKey = key(r.problems[slot]);
          r.problemChanges = r.problemChanges || [];
          r.problemChanges.push({ at: Date.now(), slot, problem: r.problems[slot],
            codes: Object.fromEntries([...r.players].map(h => [h, r.codes[h]?.[oldKey] || null])) });
          r.problems[slot] = { contestId, index, name: problem.name, rating: problem.rating, tags: problem.tags, pts: basePts(problem.rating) };
          for (const h of r.players) {
            if (r.codes[h]) delete r.codes[h][oldKey];
            if (r.invalidCodes?.[h]) delete r.invalidCodes[h][oldKey];
            r.scores[h] = score(r, submissions[h]);
            r.log[h] = submissions[h].filter(s => s.verdict && s.verdict !== 'TESTING' && inRace(r, s))
              .map(s => ({ id: s.id, key: key(s.problem), contestId: s.problem.contestId, verdict: s.verdict,
                t: s.creationTimeSeconds * 1000, lang: s.programmingLanguage }));
          }
          if (r.finalized) applyResults(r, true);
        } else if (b.action === 'settings') {
          if (r.startAt || r.starting) return fail(res, 400, 'Lobby settings can only change before the race starts. Use timing/problem controls after starting.');
          const c = b.cfg || {};
          if (!Number.isInteger(c.n) || c.n < 1 || c.n > 8 || !Number.isInteger(c.minutes) || c.minutes < 1 || c.minutes > 1440 ||
              !Number.isInteger(c.minRating) || !Number.isInteger(c.maxRating) || c.minRating < 800 || c.maxRating > 4000 || c.minRating > c.maxRating)
            return fail(res, 400, 'Invalid lobby settings.');
          r.cfg = { n: c.n, minutes: c.minutes, minRating: c.minRating, maxRating: c.maxRating, tag: String(c.tag || '').slice(0, 100), ranked: !!c.ranked };
        } else if (b.action === 'timing') {
          if (!r.startAt || r.finalized) return fail(res, 400, 'Timing changes require an unfinished race.');
          if (!Number.isInteger(b.seconds) || b.seconds < 1 || b.seconds > 86400) return fail(res, 400, 'Enter 1–86400 seconds remaining.');
          r.endAt = Date.now() + b.seconds * 1000; r.pasteEndsAt = r.endAt + GRACE_MS; schedule(r);
        } else if (b.action === 'finish') {
          if (!r.startAt || r.finalized) return fail(res, 400, 'Race is not running.');
          r.endAt = Math.min(r.endAt, Date.now()); r.pasteEndsAt = Date.now(); clearTimeout(r.timer);
        } else if (b.action === 'addPlayer' || b.action === 'removePlayer') {
          if (r.finalized || r.starting && !r.startAt) return fail(res, 400, 'Cannot edit players now.');
          const u = byHandle(String(b.handle || ''));
          if (!u) return fail(res, 400, 'Linked player not found.');
          if (b.action === 'addPlayer') r.players.add(u.handle);
          else {
            if (r.players.size <= 1) return fail(res, 400, 'Delete the room instead of removing the last player.');
            r.players.delete(u.handle); r.ready.delete(u.handle); r.forfeit.delete(u.handle);
            if (r.host === u.handle) r.host = [...r.players][0];
            for (const client of [...r.subs]) if (client.handle === u.handle) { client.end(); r.subs.delete(client); }
          }
        } else if (b.action === 'delete' || b.action === 'restore') {
          r.deleted = b.action === 'delete';
          if (r.deleted) { r.pollGeneration = (r.pollGeneration || 0) + 1; clearTimeout(r.timer); for (const client of r.subs) client.end(); r.subs.clear(); }
          else if (r.startAt && !r.finalized) { schedule(r); background(pollLoop(r)); }
        } else {
          if (r.deleted) return fail(res, 400, 'Restore the room first.');
          if (!r.players.has(b.handle)) return fail(res, 400, 'Player not in room.');
          if (b.action === 'elo') {
            if (!Number.isInteger(b.elo) || b.elo < 0 || b.elo > 100000) return fail(res, 400, 'Elo must be 0–100000.');
            byHandle(b.handle).elo = b.elo;
          } else if (b.action === 'points') {
            if (!Number.isInteger(b.points) || Math.abs(b.points) > 1000000) return fail(res, 400, 'Points must be an integer between -1000000 and 1000000.');
            r.bonus = r.bonus || {}; r.bonus[b.handle] = b.points;
          } else if (b.action === 'invalidate' || b.action === 'validate') {
            if (typeof r.codes[b.handle]?.[b.key] !== 'string') return fail(res, 400, 'No pasted code for that problem.');
            r.invalidCodes = r.invalidCodes || {}; r.invalidCodes[b.handle] = r.invalidCodes[b.handle] || {};
            r.invalidCodes[b.handle][b.key] = b.action === 'invalidate';
          } else return fail(res, 400, 'Unknown admin action.');
          if (r.finalized && b.action !== 'elo') applyResults(r, true);
        }
        r.audit = r.audit || [];
        r.audit.push({ at: Date.now(), action: b.action, handle: b.handle, key: b.key, points: b.points, elo: b.elo, slot: b.slot, contestId: b.contestId, index: b.index, cfg: b.cfg, seconds: b.seconds, reason });
        if (b.action === 'finish') await finalize(r); else await push(r);
        return send(res, 200, { ok: true });
      }
      return fail(res, 404, 'Unknown admin endpoint.');
    }
    if (!user) return fail(res, 403, 'Set your Codeforces handle first.');
    const me = user.handle;
    if (req.method === 'GET' && url.pathname === '/api/history') return send(res, 200, { history: user.history || [] });
    if (req.method === 'GET' && url.pathname === '/api/active') {
      const t = Date.now();
      return send(res, 200, { rooms: [...rooms.values()].filter(r => r.players.has(me) && !r.finalized && !r.deleted && !r.forfeit.has(me))
        .map(r => ({ code: r.code, cfg: r.cfg, players: r.players.size, status: !r.startAt ? 'Waiting in lobby' : t < r.endAt ? 'In progress' : 'Finished, paste window open' })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard')
      return send(res, 200, { top: Object.values(users).filter(u => u.games).sort((a, b) => b.elo - a.elo).slice(0, 5).map(u => ({ handle: u.handle, elo: u.elo, games: u.games })) });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase()), spectate = url.searchParams.get('spectate') === '1';
      if (!room || room.deleted || (!spectate && !room.players.has(me))) return fail(res, 404, 'No such room');
      const n = sseCount.get(userId) || 0;
      if (n >= 5) return fail(res, 429, 'Too many open race views.');
      sseCount.set(userId, n + 1);
      res.handle = spectate ? null : me;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      room.subs.add(res); res.write('data: ' + JSON.stringify(view(room, res.handle)) + '\n\n');
      return req.on('close', () => { room.subs.delete(res); sseCount.set(userId, Math.max(0, (sseCount.get(userId) || 1) - 1)); });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/create') {
        const c = b.cfg || {};
        const cfg = { n: Math.min(8, Math.max(1, +c.n || 3)), minRating: +c.minRating || 800, maxRating: +c.maxRating || 1400,
          tag: String(c.tag || ''), minutes: Math.min(180, Math.max(5, +c.minutes || 30)), ranked: !c.practice };
        if ([...rooms.values()].filter(r => !r.finalized && !r.deleted).length >= 500) return fail(res, 503, 'The server is full. Try again later.');
        if (!rl('create:' + me, 10, 36e5)) return fail(res, 429, 'You are creating rooms too quickly.');
        if (activeRoomsFor(me).length >= 5) return fail(res, 400, 'You have too many active rooms. Leave one first.');
        let code;
        do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms.has(code));
        rooms.set(code, { code, host: me, cfg, players: new Set([me]), ready: new Set(), problems: [], scores: {}, codes: {}, log: {},
          subs: new Set(), forfeit: new Set(), touched: Date.now(), startAt: null, endAt: null });
        await saveRooms();
        return send(res, 200, { code });
      }
      const room = rooms.get(String(b.code || '').toUpperCase());
      if (!room || room.deleted) return fail(res, 404, 'No room with that code.');
      if (url.pathname === '/api/spectate') return send(res, 200, { code: room.code });
      if (url.pathname === '/api/join') {
        if (!rl('join:' + me, 30, 60000)) return fail(res, 429, 'Too many join attempts.');
        if (!room.players.has(me)) {
          if (room.startAt || room.starting) return fail(res, 400, 'That race already started.');
          room.players.add(me);
        }
        await push(room);
        return send(res, 200, { code: room.code });
      }
      if (!room.players.has(me)) return fail(res, 403, 'You are not in this room.');
      if (url.pathname === '/api/leave') {
        if (!room.startAt && room.starting) return fail(res, 400, 'The race is starting. Try again in a moment.');
        if (room.startAt) {
          if (Date.now() < room.endAt && !room.forfeit.has(me)) return fail(res, 400, 'Forfeit the race to leave it.');
          for (const r of [...room.subs]) if (r.handle === me) { r.end(); room.subs.delete(r); }
          return send(res, 200, { ok: true });
        }
        room.players.delete(me); room.ready.delete(me);
        if (room.host === me) await newHost(room);
        if (rooms.has(room.code)) await push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/forfeit') {
        if (!room.startAt) return fail(res, 400, 'The race has not started. Use leave instead.');
        if (Date.now() >= room.endAt) return fail(res, 400, 'The race is already over.');
        room.forfeit.add(me);
        if ([...room.players].filter(h => !room.forfeit.has(h)).length <= 1) endEarly(room);
        await push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/ready') {
        if (room.startAt || room.starting) return fail(res, 400, 'The race already started.');
        b.ready ? room.ready.add(me) : room.ready.delete(me);
        await push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/start') {
        if (room.host !== me) return fail(res, 403, 'Only the host can start.');
        if (room.starting) return send(res, 200, { ok: true });
        if (!rl('start:' + me, 10, 36e5)) return fail(res, 429, 'Too many race starts. Try later.');
        if (room.cfg.ranked && room.players.size < 2) return fail(res, 400, 'Ranked races need at least 2 players.');
        if ([...room.players].some(h => !room.ready.has(h))) return fail(res, 400, 'Everyone must be ready.');
        await startRoom(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/code') {
        if (!rl('code:' + me, 30, 60000)) return fail(res, 429, 'Too many submissions. Slow down.');
        const k = String(b.key || ''), text = String(b.text || '').trim();
        if (!room.scores[me] || !room.scores[me][k] || !room.scores[me][k].solved) return fail(res, 400, 'No accepted submission for that problem yet.');
        if (room.finalized || Date.now() >= pasteDeadline(room)) return fail(res, 400, 'The paste window has closed.');
        if (!text || text.length > MAX_CODE) return fail(res, 400, 'Paste your code (up to ' + MAX_CODE + ' characters).');
        room.codes[me] = room.codes[me] || {};
        room.codes[me][k] = text;
        await advanceRoom(room);
        return send(res, 200, { ok: true });
      }
    }
    fail(res, 404, 'Not found');
  } catch (e) { await fail(res, storage.error ? 503 : 400, storage.error ? 'Persistent storage is unavailable. Restart after recovery.' : e.message); }
}).listen(PORT, () => console.log('CF Race on http://localhost:' + PORT));

}
main().catch(() => { console.error("Startup failed: persistent state could not be loaded. Check Supabase configuration and table permissions."); process.exit(1); });
