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
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
if (!PUBLISHABLE_KEY) { console.error('Set CLERK_PUBLISHABLE_KEY in .env'); process.exit(1); }
const FRONTEND_API = Buffer.from(PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, ''), 'base64').toString().replace(/\$$/, '');
const ISSUER = 'https://' + FRONTEND_API;

const MIN_PTS = 1000, MAX_PTS = 3500;
const DECAY_PER_MIN = 25;
const WRONG_PENALTY = 125;
const FLOOR = 0;
const POLL_MS = 6000;
const GRACE_MS = 5 * 60000;
const MAX_CODE = 20000;
const K_FACTOR = 32;
const UNRATED_START = 1000;
const CF_ID = process.env.CF_CLIENT_ID || '', CF_SECRET = process.env.CF_CLIENT_SECRET || '';
const CF_ISSUER = (process.env.CF_ISSUER || 'https://codeforces.com').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED_HANDLE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const HANDLE_COOLDOWN = 7 * 864e5, CARRY_PER = 600, CARRY_BASE = 10;

const basePts = r => Math.round(Math.min(MAX_PTS, Math.max(MIN_PTS, MIN_PTS + (r - 800) / 8)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const buckets = new Map(), sseCount = new Map();
const rl = (key, max, win) => { const t = Date.now(); let b = buckets.get(key); if (!b || t > b.reset) { b = { n: 0, reset: t + win }; buckets.set(key, b); } return ++b.n <= max; };
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();
const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';

let users = {};
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
const saveUsers = () => { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(users)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); };
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
const ROOMS_FILE = process.env.ROOMS_FILE || path.join(path.dirname(DATA_FILE), 'rooms.json');
const ROOM_TTL = 24 * 36e5, LOBBY_TTL = 2 * 36e5;
let saveTimer = null;
function saveRooms() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out = [...rooms.values()].map(r => ({ ...r, subs: undefined, timer: undefined,
      players: [...r.players], ready: [...r.ready], forfeit: [...r.forfeit] }));
    fs.writeFile(ROOMS_FILE + '.tmp', JSON.stringify(out), e => { if (!e) fs.rename(ROOMS_FILE + '.tmp', ROOMS_FILE, () => {}); });
  }, 1000);
}
function schedule(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { finalize(room); push(room); }, Math.max(0, room.endAt + GRACE_MS - Date.now()) + 30000);
}
function endEarly(room) {
  const t = Date.now();
  if (room.startAt > t) room.startAt = t;
  room.endAt = t;
  schedule(room);
}
function restoreRooms() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')); } catch (e) {}
  list.forEach(r => {
    const players = r.finalized ? r.players : r.players.filter(h => byHandle(h));
    if (!players.length) return;
    const room = { ...r, players: new Set(players), ready: new Set(r.ready), forfeit: new Set(r.forfeit || []),
      subs: new Set(), starting: !!r.startAt, touched: Date.now() };
    if (!players.includes(room.host)) room.host = players[0];
    rooms.set(room.code, room);
    if (room.startAt && !room.finalized) { schedule(room); pollLoop(room); }
  });
  console.log('Restored ' + rooms.size + ' room(s)');
}
setInterval(() => {
  const t = Date.now();
  for (const [c, r] of rooms) {
    const dead = r.startAt ? t > r.endAt + ROOM_TTL : (!r.starting && t - (r.touched || 0) > LOBBY_TTL);
    if (dead) rooms.delete(c);
  }
  saveRooms();
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
      o.pts = Math.max(FLOOR, p.pts - Math.floor((t - room.startAt) / 60000) * DECAY_PER_MIN - o.wrong * WRONG_PENALTY);
    } else if (s.verdict && s.verdict !== 'COMPILATION_ERROR' && s.verdict !== 'TESTING') o.wrong++;
  });
  return out;
}

function standings(room) {
  return [...room.players].map(h => {
    const v = Object.entries(room.scores[h] || {}).filter(([k, o]) => o.solved && room.codes[h] && room.codes[h][k]).map(([, o]) => o);
    return { handle: h, f: room.forfeit.has(h), pts: v.reduce((a, o) => a + o.pts, 0), t: v.reduce((a, o) => a + o.at - room.startAt, 0) };
  });
}

const beats = (a, b) => a.f !== b.f ? !a.f : a.pts !== b.pts ? a.pts > b.pts : a.t < b.t;
const tied = (a, b) => a.f === b.f && a.pts === b.pts && (a.pts === 0 || a.t === b.t);

function finalize(room) {
  if (room.finalized || !room.startAt) return;
  room.finalized = true;
  const st = standings(room), n = st.length, delta = {};
  if (room.cfg.ranked && n >= 2) {
    st.forEach(a => {
      let sum = 0;
      st.forEach(b => {
        if (a === b) return;
        const sc = tied(a, b) ? 0.5 : beats(a, b) ? 1 : 0;
        const e = 1 / (1 + Math.pow(10, (byHandle(b.handle).elo - byHandle(a.handle).elo) / 400));
        sum += sc - e;
      });
      delta[a.handle] = Math.round(K_FACTOR / (n - 1) * sum);
    });
    room.eloResult = {};
    st.forEach(a => {
      const u = byHandle(a.handle), before = u.elo;
      u.elo = before + delta[a.handle]; u.games = (u.games || 0) + 1;
      room.eloResult[a.handle] = { before, after: u.elo };
    });
  }
  st.forEach(a => {
    const u = byHandle(a.handle);
    u.history = u.history || [];
    u.history.unshift({ code: room.code, at: room.endAt, ranked: room.cfg.ranked && n >= 2, rank: 1 + st.filter(b => b !== a && beats(b, a)).length,
      of: n, pts: a.pts, forfeit: a.f, opp: st.filter(b => b !== a).map(b => b.handle), elo: room.eloResult && room.eloResult[a.handle] || null });
  });
  saveUsers(); push(room);
}

function view(room, viewer) {
  const live = room.startAt && Date.now() >= room.startAt;
  const open = room.endAt && Date.now() > room.endAt + GRACE_MS;
  const scores = {}, codes = {};
  for (const h of Object.keys(room.scores)) {
    scores[h] = {};
    for (const k of Object.keys(room.scores[h])) {
      const has = room.codes[h] && room.codes[h][k];
      scores[h][k] = { ...room.scores[h][k], claimed: !!has };
      if (has) {
        codes[h] = codes[h] || {};
        codes[h][k] = (open || h === viewer) ? has : true;
      }
    }
  }
  return {
    code: room.code, host: room.host, cfg: room.cfg, now: Date.now(), startAt: room.startAt, endAt: room.endAt,
    players: [...room.players].map(h => ({ handle: h, elo: (byHandle(h) || {}).elo, ready: room.ready.has(h), forfeit: room.forfeit.has(h) })),
    problems: live ? room.problems : null, scores, codes, log: room.log, eloResult: room.eloResult || null,
    error: room.error || null, rules: { DECAY_PER_MIN, WRONG_PENALTY }
  };
}
function push(room) {
  room.touched = Date.now(); saveRooms();
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
    push(room);
    setTimeout(() => push(room), 5100);
    schedule(room);
    pollLoop(room);
  } catch (e) { room.error = e.message; room.starting = false; push(room); }
}

async function pollLoop(room) {
  await sleep(Math.max(0, room.startAt - Date.now()));
  while (!room.finalized && rooms.get(room.code) === room) {
    const last = Date.now() > room.endAt + GRACE_MS;    for (const h of [...room.players]) {
      try {
        const subs = await cf('user.status', { handle: h, from: 1, count: 100 });
        room.scores[h] = score(room, subs);
        room.log[h] = subs.filter(s => s.verdict && s.verdict !== 'TESTING' && inRace(room, s)).map(s => ({
          id: s.id, key: key(s.problem), contestId: s.problem.contestId, verdict: s.verdict,
          t: s.creationTimeSeconds * 1000, lang: s.programmingLanguage
        })).sort((a, b) => a.t - b.t);
      } catch (e) {}
    }
    push(room);
    if (last) break;
    await sleep(POLL_MS);
  }
  if (rooms.get(room.code) === room) { finalize(room); push(room); }
}

const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 100000) { req.destroy(); r({}); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });

function newHost(room) {
  const next = [...room.players][0];
  if (!next) { rooms.delete(room.code); saveRooms(); return; }
  room.host = next;
}

const oidcStates = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of oidcStates) if (t > v.exp) oidcStates.delete(k); }, 60000).unref();
let oidcCache = null, oidcAt = 0;
async function oidcConf() {
  if (!oidcCache || Date.now() - oidcAt > 36e5) { oidcCache = await (await fetch(CF_ISSUER + '/.well-known/openid-configuration')).json(); oidcAt = Date.now(); }
  return oidcCache;
}
const activeRoomsFor = handle => [...rooms.values()].filter(r => r.players.has(handle) && !r.finalized);
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
function applyLink(userId, info) {
  const u = users[userId], base = info.rating || UNRATED_START, other = byHandle(info.handle);
  if (other && other !== u) throw new Error('That Codeforces account is already linked to another user.');
  if (!u) {
    users[userId] = { handle: info.handle, cfRating: base, elo: base, games: 0, verified: true, history: [] };
    saveUsers(); return 'Linked ' + info.handle + '.';
  }
  if (u.handle.toLowerCase() === info.handle.toLowerCase()) { u.handle = info.handle; u.verified = true; saveUsers(); return 'Verified ' + u.handle + '.'; }
  const b = changeBlock(u);
  if (b) throw new Error(b);
  const before = u.elo;
  u.elo = carryElo(u, base); u.cfRating = base; u.handle = info.handle; u.verified = true; u.handleChangedAt = Date.now();
  saveUsers();
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
    back('oidc=' + encodeURIComponent(applyLink(st.userId, info)));
  } catch (e) { back('oidc_error=' + encodeURIComponent(e.message)); }
}

restoreRooms();
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  try {
    if (!rl('ip:' + clientIp(req), 300, 60000)) return fail(res, 429, 'Too many requests. Slow down.');
    if (req.method === 'GET' && url.pathname === '/auth/codeforces/callback') return oidcCallback(url, res);
    if (req.method === 'GET' && (['/', '/leaderboard', '/history'].includes(url.pathname) || /^\/(race|watch)\/[A-Za-z]{5}$/.test(url.pathname))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { publishableKey: PUBLISHABLE_KEY, frontendApi: FRONTEND_API });

    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
    let userId;
    try { userId = await authenticate(bearer); } catch (e) { return fail(res, 401, e.message); }
    const user = users[userId];
    if (!rl('u:' + userId, 240, 60000)) return fail(res, 429, 'Too many requests. Slow down.');

    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, user ? { handle: user.handle, elo: user.elo, games: user.games || 0, verified: !!user.verified, changeBlock: changeBlock(user), oidc: !!(CF_ID && CF_SECRET) } : { handle: null, oidc: !!(CF_ID && CF_SECRET), dev: ALLOW_UNVERIFIED });

    if (req.method === 'POST' && url.pathname === '/api/handle') {
      if (!ALLOW_UNVERIFIED) return fail(res, 400, 'Verify your handle with Codeforces.');
      if (user) return fail(res, 400, 'Your handle is already set.');
      const b = await readBody(req);
      let info;
      try { info = (await cf('user.info', { handles: String(b.handle || '').trim() }))[0]; } catch (e) { return fail(res, 400, 'Codeforces handle not found.'); }
      if (byHandle(info.handle)) return fail(res, 400, 'That handle is already linked to another account.');
      users[userId] = { handle: info.handle, cfRating: info.rating || null, elo: info.rating || UNRATED_START, games: 0, verified: false };
      saveUsers();
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
    if (!user) return fail(res, 403, 'Set your Codeforces handle first.');
    const me = user.handle;
    if (req.method === 'GET' && url.pathname === '/api/history') return send(res, 200, { history: user.history || [] });
    if (req.method === 'GET' && url.pathname === '/api/active') {
      const t = Date.now();
      return send(res, 200, { rooms: [...rooms.values()].filter(r => r.players.has(me) && !r.finalized && !r.forfeit.has(me))
        .map(r => ({ code: r.code, cfg: r.cfg, players: r.players.size, status: !r.startAt ? 'Waiting in lobby' : t < r.endAt ? 'In progress' : 'Finished, paste window open' })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard')
      return send(res, 200, { top: Object.values(users).filter(u => u.games).sort((a, b) => b.elo - a.elo).slice(0, 5).map(u => ({ handle: u.handle, elo: u.elo, games: u.games })) });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase()), spectate = url.searchParams.get('spectate') === '1';
      if (!room || (!spectate && !room.players.has(me))) return fail(res, 404, 'No such room');
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
        if (rooms.size >= 500) return fail(res, 503, 'The server is full. Try again later.');
        if (!rl('create:' + me, 10, 36e5)) return fail(res, 429, 'You are creating rooms too quickly.');
        if (activeRoomsFor(me).length >= 5) return fail(res, 400, 'You have too many active rooms. Leave one first.');
        let code;
        do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms.has(code));
        rooms.set(code, { code, host: me, cfg, players: new Set([me]), ready: new Set(), problems: [], scores: {}, codes: {}, log: {},
          subs: new Set(), forfeit: new Set(), touched: Date.now(), startAt: null, endAt: null });
        saveRooms();
        return send(res, 200, { code });
      }
      const room = rooms.get(String(b.code || '').toUpperCase());
      if (!room) return fail(res, 404, 'No room with that code.');
      if (url.pathname === '/api/spectate') return send(res, 200, { code: room.code });
      if (url.pathname === '/api/join') {
        if (!rl('join:' + me, 30, 60000)) return fail(res, 429, 'Too many join attempts.');
        if (!room.players.has(me)) {
          if (room.startAt || room.starting) return fail(res, 400, 'That race already started.');
          room.players.add(me);
        }
        push(room);
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
        if (room.host === me) newHost(room);
        if (rooms.has(room.code)) push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/forfeit') {
        if (!room.startAt) return fail(res, 400, 'The race has not started. Use leave instead.');
        if (Date.now() >= room.endAt) return fail(res, 400, 'The race is already over.');
        room.forfeit.add(me);
        if ([...room.players].filter(h => !room.forfeit.has(h)).length <= 1) endEarly(room);
        push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/ready') {
        if (room.startAt || room.starting) return fail(res, 400, 'The race already started.');
        b.ready ? room.ready.add(me) : room.ready.delete(me);
        push(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/start') {
        if (room.host !== me) return fail(res, 403, 'Only the host can start.');
        if (room.starting) return send(res, 200, { ok: true });
        if (!rl('start:' + me, 10, 36e5)) return fail(res, 429, 'Too many race starts. Try later.');
        if (room.cfg.ranked && room.players.size < 2) return fail(res, 400, 'Ranked races need at least 2 players.');
        if ([...room.players].some(h => !room.ready.has(h))) return fail(res, 400, 'Everyone must be ready.');
        startRoom(room);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/code') {
        if (!rl('code:' + me, 30, 60000)) return fail(res, 429, 'Too many submissions. Slow down.');
        const k = String(b.key || ''), text = String(b.text || '').trim();
        if (!room.scores[me] || !room.scores[me][k] || !room.scores[me][k].solved) return fail(res, 400, 'No accepted submission for that problem yet.');
        if (Date.now() > room.endAt + GRACE_MS) return fail(res, 400, 'The paste window has closed.');
        if (!text || text.length > MAX_CODE) return fail(res, 400, 'Paste your code (up to ' + MAX_CODE + ' characters).');
        room.codes[me] = room.codes[me] || {};
        room.codes[me][k] = text;
        push(room);
        return send(res, 200, { ok: true });
      }
    }
    fail(res, 404, 'Not found');
  } catch (e) { fail(res, 400, e.message); }
}).listen(PORT, () => console.log('CF Race on http://localhost:' + PORT));