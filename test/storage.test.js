const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SupabaseStore, envelope } = require('../storage');
const clone = v => JSON.parse(JSON.stringify(v));
const key = 'sb_secret_test_only';
function database(initial) {
  let state = initial && clone(initial), fail = false, writes = 0;
  const fetchImpl = async (url, opts) => {
    if (fail) return Response.json({ message: 'secret should never escape' }, { status: 503 });
    if (!opts.method) return Response.json(state ? [{ value: state }] : []);
    if (opts.method === 'POST') {
      if (state) return Response.json({}, { status: 409 });
      state = JSON.parse(opts.body).value; writes++;
      return Response.json([{ value: state }]);
    }
    const revision = new URL(url).searchParams.get('value->>revision').slice(3);
    if (!state || state.revision !== revision) return Response.json([]);
    state = JSON.parse(opts.body).value; writes++;
    return Response.json([{ value: state }]);
  };
  return { fetchImpl, state: () => clone(state), fail: () => { fail = true; }, writes: () => writes };
}
const storeFor = db => new SupabaseStore({ url: 'https://example.supabase.co', key, fetchImpl: db.fetchImpl });
const user = handle => ({ handle, elo: 1000, games: 0, history: [], verified: true });
const room = () => ({ code: 'ABCDE', host: 'alice', cfg: { ranked: true, minutes: 5 },
  players: ['alice', 'bob'], ready: ['alice', 'bob'], forfeit: [], problems: [], scores: {}, codes: {}, log: {},
  startAt: Date.now() - 600000, endAt: Date.now() - 300000 });
test('fresh storage initializes automatically; failed reads never create state', async () => {
  const db = database(), store = storeFor(db);
  const state = await store.load();
  assert.deepEqual(state.users, {}); assert.deepEqual(state.rooms, []);
  assert.equal(db.writes(), 1);
  const failed = database(); failed.fail();
  await assert.rejects(storeFor(failed).load(), /HTTP 503/);
  assert.equal(failed.writes(), 0);
});
test('initialization refuses overwrite; malformed state fails validation', async () => {
  const db = database(envelope({}, []));
  await assert.rejects(storeFor(db).initialize(envelope({}, [])), /HTTP 409/);
  const bad = database({ schema: 1, revision: 'x', users: [], rooms: [] });
  await assert.rejects(storeFor(bad).load(), /Invalid/);
});
test('queued snapshots commit in order and survive a new store', async () => {
  const db = database(envelope({}, [])), s = storeFor(db);
  await s.load();
  const users = { a: user('alice') };
  const a = s.save(users, []);
  users.a.elo = 1234;
  const b = s.save(users, []);
  await Promise.all([a, b]);
  assert.equal((await storeFor(db).load()).users.a.elo, 1234);
  assert.equal(db.writes(), 2);
});
test('stale writer cannot overwrite newer state, and write failure stays latched', async () => {
  const db = database(envelope({}, [])), a = storeFor(db), b = storeFor(db);
  await Promise.all([a.load(), b.load()]);
  await a.save({ a: user('alice') }, []);
  await assert.rejects(b.save({}, []), /conflict/);
  await assert.rejects(b.save({}, []), /conflict/);
  assert.ok(db.state().users.a);
  db.fail();
  await assert.rejects(a.save({}, []), /HTTP 503/);
  await assert.rejects(a.flush(), /HTTP 503/);
  assert.ok(db.state().users.a);
});
function app(db, uid = "admin-user") {
  const store = storeFor(db);
  let handler;
  const context = {
    Buffer, URL, URLSearchParams,
    fetch: async url => {
      if (url.includes('problemset.problems')) return Response.json({ status: 'OK', result: { problems: [{ contestId: 2, index: 'B', name: 'Harder', rating: 2400, tags: ['dp'] }] } });
      if (url.includes('user.status')) return Response.json({ status: 'OK', result: [] });
      throw new Error('Unexpected fetch in test');
    }, console: { log() {}, error() {} },
    process: { env: { CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jb20k', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: key, ADMIN_CLERK_USER_ID: 'admin-user' } },
    setInterval: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }), clearTimeout() {},
    require(name) {
      if (name === './storage') return { SupabaseStore: function () { return store; }, FileStore: class {} };
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      return require(name);
    }, __dirname: require('node:path').join(__dirname, '..')
  };
  context.testUserId = uid;
  vm.createContext(context);
  let code = fs.readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  code = code.slice(0, code.lastIndexOf('main().catch')).replace('if (wait) await sleep(wait);', '');
  vm.runInContext(code + '\nauthenticate = async () => globalThis.testUserId; globalThis.api = {main, finalize, advanceRoom, everyoneSolved, everyonePasted, applyResults, view, rooms, getUsers: () => users, send};', context);
  return { api: context.api, store, handler: () => handler };
}
test('server restart restores users, Sets, submitted code and finalized Elo/history exactly once', async () => {
  const r = room(); r.codes = { alice: { '1A': 'int main(){}' } };
  const db = database(envelope({ a: user('alice'), b: user('bob') }, [r]));
  const first = app(db); await first.api.main();
  const live = first.api.rooms.get('ABCDE');
  assert.equal(live.players.has('alice'), true);
  assert.equal(live.ready.has('bob'), true);
  assert.equal(live.subs.size, 0);
  assert.ok(live.timer);
  await Promise.all([first.api.finalize(live), first.api.finalize(live)]);
  const committed = db.state();
  assert.equal(committed.users.a.games, 1);
  assert.equal(committed.users.a.history.length, 1);
  assert.equal(committed.rooms[0].finalized, true);
  const second = app(db); await second.api.main();
  await second.api.finalize(second.api.rooms.get('ABCDE'));
  assert.deepEqual(db.state(), committed);
  assert.equal(second.api.getUsers().a.history.length, 1);
  assert.equal(second.api.rooms.get('ABCDE').codes.alice['1A'], 'int main(){}');
});
test('success response is not sent before persistence and failed write returns 503', async () => {
  const db = database(envelope({}, [])), instance = app(db); await instance.api.main();
  db.fail();
  instance.store.save({}, []);
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
  await instance.api.send(res, 200, { ok: true });
  assert.equal(res.code, 503);
  assert.doesNotMatch(res.body, /secret should|sb_secret/);
});
test('server refuses startup on failed database reads, without opening HTTP listener', async () => {
  const db = database(); db.fail(); const instance = app(db);
  await assert.rejects(instance.api.main(), /HTTP 503/);
  assert.equal(instance.handler(), undefined);
  assert.equal(db.writes(), 0);
});
async function request(instance, method, url, body = {}) {
  const listeners = {};
  const req = { method, url, headers: {}, socket: { remoteAddress: 'test' },
    on(event, fn) {
      listeners[event] = fn;
      if (event === 'end') queueMicrotask(() => { listeners.data?.(JSON.stringify(body)); fn(); });
      return this;
    }
  };
  let response;
  const res = { setHeader() {}, writeHead(code) { this.code = code; },
    end(body) { response = { code: this.code, body: body && (body.startsWith('{') || body.startsWith('[') ? JSON.parse(body) : body) }; } };
  await instance.handler()(req, res);
  return response;
}
function solvedRoom() {
  const r = room();
  r.problems = [{ contestId: 1, index: 'A', pts: 1000 }];
  r.scores = { alice: { '1A': { solved: true, pts: 800, at: r.startAt + 10000 } },
    bob: { '1A': { solved: true, pts: 600, at: r.startAt + 20000 } } };
  r.codes = { alice: { '1A': 'alice solution' }, bob: { '1A': 'bob solution' } };
  return r;
}
const initialFor = r => envelope({ a: user('alice'), b: user('bob') }, [r]);
test('everyone solving ends the race early; final paste closes window and finalizes immediately', async () => {
  const r = solvedRoom(); r.startAt = Date.now() - 10000; r.endAt = Date.now() + 200000;
  delete r.codes.bob;
  const db = database(initialFor(r)), instance = app(db); await instance.api.main();
  const live = instance.api.rooms.get(r.code);
  await instance.api.advanceRoom(live);
  assert.ok(live.endAt <= Date.now());
  assert.equal(live.finalized, undefined);
  assert.ok(live.pasteEndsAt > Date.now());
  live.codes.bob = { '1A': 'bob solution' };
  await instance.api.advanceRoom(live);
  assert.equal(live.finalized, true);
  assert.ok(live.pasteEndsAt <= Date.now());
  assert.equal(db.state().users.a.games, 1);
  assert.equal((await request(instance, 'GET', '/api/archive')).body.rooms.length, 1);
});
test('pending judgments and incomplete polls keep the paste window open', async () => {
  const r = solvedRoom(); r.scores.bob = {}; r.codes.bob = {};
  r.pendingJudging = true; r.lastPollAt = Date.now();
  const db = database(initialFor(r)), instance = app(db); await instance.api.main();
  const live = instance.api.rooms.get(r.code);
  await instance.api.advanceRoom(live);
  assert.equal(live.finalized, undefined);
  live.pendingJudging = false; live.lastPollAt = r.endAt - 1;
  await instance.api.advanceRoom(live);
  assert.equal(live.finalized, undefined);
  live.lastPollAt = Date.now();
  await instance.api.advanceRoom(live);
  assert.equal(live.finalized, true);
});
test('public archive hides active/paste-window rooms and exposes finished code without authentication', async () => {
  const r = solvedRoom(); r.pasteEndsAt = Date.now() + 10000;
  const db = database(initialFor(r)), instance = app(db, null); await instance.api.main();
  assert.equal((await request(instance, 'GET', '/api/archive/ABCDE')).code, 404);
  const live = instance.api.rooms.get(r.code); live.pasteEndsAt = Date.now() - 1;
  await instance.api.finalize(live);
  const archived = await request(instance, 'GET', '/api/archive/ABCDE');
  assert.equal(archived.code, 200);
  assert.equal(archived.body.codes.alice['1A'], 'alice solution');
  assert.equal(archived.body.audit, undefined);
});
test('non-admin cannot use admin endpoints or grant themselves access by username', async () => {
  const db = database(initialFor(solvedRoom())), instance = app(db, 'admin'); await instance.api.main();
  assert.equal((await request(instance, 'GET', '/api/admin/rooms')).code, 404);
  assert.equal((await request(instance, 'POST', '/api/admin/action', { code: 'ABCDE', action: 'points', handle: 'alice', points: 999, reason: 'test' })).code, 404);
  assert.equal(db.writes(), 0);
});
test('post-race veto recalculates points, ranks, Elo and history without counting another game; reversible and persistent', async () => {
  const db = database(initialFor(solvedRoom())), instance = app(db); await instance.api.main();
  const live = instance.api.rooms.get('ABCDE'); live.pasteEndsAt = Date.now() - 1;
  await instance.api.finalize(live);
  const original = clone(db.state().users);
  const result = await request(instance, 'POST', '/api/admin/action', { code: 'ABCDE', action: 'invalidate', handle: 'alice', key: '1A', reason: 'Copied solution' });
  assert.equal(result.code, 200);
  assert.equal(db.state().users.a.games, 1);
  assert.equal(db.state().users.a.history.length, 1);
  assert.equal(db.state().users.a.history[0].pts, 0);
  assert.equal(db.state().users.a.history[0].rank, 2);
  assert.ok(db.state().users.a.elo < original.a.elo);
  assert.equal(db.state().rooms[0].audit.length, 1);
  const second = app(db); await second.api.main();
  assert.equal(second.api.rooms.get('ABCDE').invalidCodes.alice['1A'], true);
  await request(second, 'POST', '/api/admin/action', { code: 'ABCDE', action: 'validate', handle: 'alice', key: '1A', reason: 'Appeal approved' });
  assert.equal(db.state().users.a.elo, original.a.elo);
  assert.equal(db.state().users.b.elo, original.b.elo);
  assert.equal(db.state().users.a.games, 1);
  assert.equal(db.state().users.a.history.length, 1);
});
test('admin points, room deletion/restoration and input validation work', async () => {
  const db = database(initialFor(solvedRoom())), instance = app(db); await instance.api.main();
  const live = instance.api.rooms.get('ABCDE'); live.pasteEndsAt = Date.now() - 1; await instance.api.finalize(live);
  const action = body => request(instance, 'POST', '/api/admin/action', { code: 'ABCDE', reason: 'Review', ...body });
  assert.equal((await action({ action: 'points', handle: 'bob', points: 1000 })).code, 200);
  assert.equal(db.state().users.b.history[0].pts, 1600);
  assert.equal(db.state().users.b.history[0].rank, 1);
  assert.equal((await action({ action: 'points', handle: 'bob', points: 'bad' })).code, 400);
  await action({ action: 'delete' });
  assert.equal((await request(instance, 'GET', '/api/archive/ABCDE')).code, 404);
  assert.equal((await request(instance, 'GET', '/api/archive')).body.rooms.length, 0);
  await action({ action: 'restore' });
  assert.equal((await request(instance, 'GET', '/api/archive/ABCDE')).code, 200);
});
test('admin replaces harder problem, refreshes scores and preserves old pasted code for review', async () => {
  const db = database(initialFor(solvedRoom())), instance = app(db); await instance.api.main();
  const live = instance.api.rooms.get('ABCDE'); live.pasteEndsAt = Date.now() - 1; await instance.api.finalize(live);
  const result = await request(instance, 'POST', '/api/admin/action', { code: 'ABCDE', action: 'problem', slot: 0, contestId: 2, index: 'B', reason: 'Harder replacement' });
  assert.equal(result.code, 200);
  const saved = db.state();
  assert.equal(saved.rooms[0].problems[0].rating, 2400);
  assert.equal(saved.rooms[0].problemChanges[0].codes.alice, 'alice solution');
  assert.equal(saved.users.a.games, 1);
  assert.equal(saved.users.a.history.length, 1);
  assert.equal(saved.users.a.history[0].pts, 0);
});
test('admin can edit lobby settings and players, change timer, and force finish', async () => {
  const r = solvedRoom(); r.startAt = null; r.endAt = null; r.problems = []; r.scores = {}; r.codes = {};
  const db = database(initialFor(r)), instance = app(db); await instance.api.main();
  const action = body => request(instance, 'POST', '/api/admin/action', { code: 'ABCDE', reason: 'Admin control', ...body });
  assert.equal((await action({ action: 'settings', cfg: { n: 4, minutes: 60, minRating: 1600, maxRating: 2400, tag: 'dp', ranked: true } })).code, 200);
  assert.equal(db.state().rooms[0].cfg.minRating, 1600);
  assert.equal((await action({ action: 'removePlayer', handle: 'bob' })).code, 200);
  assert.equal((await action({ action: 'addPlayer', handle: 'bob' })).code, 200);
  const live = instance.api.rooms.get('ABCDE'); live.startAt = Date.now() - 1000; live.endAt = Date.now() + 100000;
  assert.equal((await action({ action: 'timing', seconds: 600 })).code, 200);
  assert.ok(live.endAt > Date.now() + 599000);
  assert.equal((await action({ action: 'finish' })).code, 200);
  assert.equal(db.state().rooms[0].finalized, true);
  assert.equal(db.state().rooms[0].audit.at(-1).action, 'finish');
});
test('admin can set any linked account Elo, including their own, without room membership', async () => {
  const state = envelope({ 'admin-user': user('adminHandle'), a: user('alice') }, []);
  const db = database(state), instance = app(db); await instance.api.main();
  const result = await request(instance, 'POST', '/api/admin/user', { handle: 'adminHandle', elo: 2400, reason: 'Set own rating' });
  assert.equal(result.code, 200);
  assert.equal(db.state().users['admin-user'].elo, 2400);
  assert.equal(db.state().users['admin-user'].adminReviews[0].before, 1000);
  const second = app(db); await second.api.main();
  assert.equal(second.api.getUsers()['admin-user'].elo, 2400);
  const unauthorized = app(db, 'other'); await unauthorized.api.main();
  assert.equal((await request(unauthorized, 'POST', '/api/admin/user', { handle: 'adminHandle', elo: 9999, reason: 'No permission' })).code, 404);
});

test('direct admin URL is an ordinary 404 for non-admin and signed-out visitors', async () => {
  const db = database(envelope({}, []));
  for (const uid of ['regular-user', null]) {
    const instance = app(db, uid); await instance.api.main();
    const response = await request(instance, 'GET', '/admin');
    assert.equal(response.code, 404);
    assert.equal(response.body, '404 Not Found');
    const apiResponse = await request(instance, 'GET', '/api/admin/rooms');
    assert.equal(apiResponse.code, 404);
    assert.equal(apiResponse.body.error, 'Not found');
  }
});
const profile = (id, handle, rest = {}) => ({ userId: id, handle, elo: 1200, cfRating: 765, games: 3,
  verified: true, handleChangedAt: 0, reason: 'Admin account edit', ...rest });
test('admin changes handle consistently across room data and history, and it survives restart', async () => {
  const r = solvedRoom();r.finalized=true;r.eloResult={alice:{before:1000,after:1016}};
  r.bonus={alice:10};r.invalidCodes={alice:{'1A':true}};
  const state=initialFor(r);state.users.b.history=[{code:'ABCDE',at:r.endAt,opp:['alice']}];
  const db=database(state), instance=app(db);await instance.api.main();
  const res=await request(instance,'POST','/api/admin/profile',profile('a','newAlice'));
  // Real Clerk IDs are required, even for existing profiles.
  assert.equal(res.code,400);
  const state2=initialFor(r);state2.users.user_alice=state2.users.a;delete state2.users.a;
  state2.users.b.history=[{code:'ABCDE',at:r.endAt,opp:['alice']}];
  const db2=database(state2), app2=app(db2);await app2.api.main();
  assert.equal((await request(app2,'POST','/api/admin/profile',profile('user_alice','newAlice'))).code,200);
  const saved=db2.state(),room=saved.rooms[0];
  assert.equal(saved.users.user_alice.handle,'newAlice');
  assert.ok(room.players.includes('newAlice'));assert.ok(!room.players.includes('alice'));
  assert.equal(room.host,'newAlice');assert.equal(room.codes.newAlice['1A'],'alice solution');
  assert.equal(room.invalidCodes.newAlice['1A'],true);assert.equal(room.bonus.newAlice,10);
  assert.equal(saved.users.b.history[0].opp[0],'newAlice');
  const restart=app(db2);await restart.api.main();assert.equal(restart.api.getUsers().user_alice.elo,1200);
});
test('admin creates profiles, rejects duplicates and normal users get 404', async () => {
  const db=database(envelope({},[])), instance=app(db);await instance.api.main();
  const body=profile('user_new','ultra_.',{create:true,elo:0,cfRating:0,games:0});
  assert.equal((await request(instance,'POST','/api/admin/profile',body)).code,200);
  assert.equal(db.state().users.user_new.handle,'ultra_.');
  assert.equal((await request(instance,'POST','/api/admin/profile',body)).code,400);
  assert.equal((await request(instance,'POST','/api/admin/profile',{...body,userId:'user_other'})).code,400);
  const other=app(db,'notAdmin');await other.api.main();
  assert.equal((await request(other,'POST','/api/admin/profile',profile('user_new','changed'))).code,404);
});
