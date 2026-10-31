const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const STATE_KEY = 'cfrace:state:v1';
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function validateState(s) {
  if (!object(s) || s.schema !== 1 || typeof s.revision !== 'string' || !s.revision ||
      !object(s.users) || !Array.isArray(s.rooms)) throw new Error('Invalid persistent state');
  const handles = new Set();
  for (const u of Object.values(s.users)) {
    if (!object(u) || typeof u.handle !== 'string' || !u.handle || !Number.isFinite(u.elo) ||
        (u.history !== undefined && !Array.isArray(u.history)) || handles.has(u.handle.toLowerCase()))
      throw new Error('Invalid persistent user');
    handles.add(u.handle.toLowerCase());
  }
  const codes = new Set();
  for (const r of s.rooms) {
    if (!object(r) || typeof r.code !== 'string' || codes.has(r.code) || !object(r.cfg) ||
        !Array.isArray(r.players) || !Array.isArray(r.ready) || !Array.isArray(r.forfeit) ||
        !Array.isArray(r.problems) || !object(r.scores) || !object(r.codes) || !object(r.log) ||
        r.players.some(h => !handles.has(String(h).toLowerCase()))) throw new Error('Invalid persistent room');
    codes.add(r.code);
  }
  return s;
}
function envelope(users, rooms) {
  return validateState({ schema: 1, revision: crypto.randomUUID(), users, rooms });
}
class SupabaseStore {
  constructor({ url, key, fetchImpl = fetch }) {
    if (!url || !key) throw new Error('Set SUPABASE_URL and server-side SUPABASE_KEY');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');
    // Reject client/anonymous keys rather than depending on permissive table policies.
    if (key.startsWith('sb_publishable_')) throw new Error('SUPABASE_KEY must be a server secret/service-role key');
    if (!key.startsWith('sb_secret_')) {
      let claims;
      try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')); } catch {}
      if (claims?.role !== 'service_role') throw new Error('SUPABASE_KEY must be a server secret/service-role key');
    }
    this.url = parsed.origin + '/rest/v1/kv';
    this.headers = { apikey: key, 'Content-Type': 'application/json' };
    if (!key.startsWith('sb_secret_')) this.headers.Authorization = 'Bearer ' + key;
    this.fetch = fetchImpl;
    this.tail = Promise.resolve();
    this.error = null;
    this.revision = null;
  }
  async request(query, options = {}) {
    let res;
    try { res = await this.fetch(this.url + query, { ...options,
      headers: { ...this.headers, ...options.headers }, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Persistent storage request failed'); }
    if (!res.ok) throw new Error('Persistent storage request failed (HTTP ' + res.status + ')');
    try { return await res.json(); } catch { throw new Error('Invalid persistent storage response'); }
  }
  async load() {
    const query = '?key=eq.' + encodeURIComponent(STATE_KEY) + '&select=value';
    let rows = await this.request(query);
    if (!Array.isArray(rows)) throw new Error('Invalid persistent storage response');
    if (rows.length === 0) {
      // Only initialize after a successful read proves this app has no state.
      // Ignore a duplicate insert if another instance initializes concurrently.
      await this.request('?on_conflict=key', { method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ key: STATE_KEY, value: envelope({}, []) }) });
      rows = await this.request(query);
    }
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Persistent state could not be loaded');
    const state = validateState(rows[0].value);
    this.revision = state.revision;
    return state;
  }
  async initialize(state) {
    validateState(state);
    // Plain INSERT: the primary key prevents overwriting an existing database.
    const rows = await this.request('', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ key: STATE_KEY, value: state }) });
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Initialization was not confirmed');
    this.revision = state.revision;
  }
  save(users, rooms) {
    if (!this.revision) throw new Error('Persistent storage has not been loaded');
    // Copy now, not when the queued request runs. Users and rooms share one atomic row.
    let state;
    try { state = JSON.parse(JSON.stringify(envelope(users, rooms))); }
    catch { this.error = new Error('Invalid state; persistence stopped'); return Promise.reject(this.error); }
    const task = this.tail.then(async () => {
      if (this.error) throw this.error;
      const rows = await this.request('?key=eq.' + encodeURIComponent(STATE_KEY) +
        '&value->>revision=eq.' + encodeURIComponent(this.revision), {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ value: state })
      });
      if (!Array.isArray(rows) || rows.length !== 1)
        throw new Error('Persistent storage conflict: another process updated the state. Restart this instance.');
      this.revision = state.revision;
    }).catch(error => { this.error = error; throw error; });
    this.tail = task;
    // Always attach a rejection handler, including for background saves.
    task.catch(() => {});
    return task;
  }
  async flush() { await this.tail; if (this.error) throw this.error; }
}
class FileStore {
  constructor(file) { this.file = file; this.tail = Promise.resolve(); this.error = null; }
  async load() { return validateState(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
  async initialize(state) { await fs.writeFile(this.file, JSON.stringify(validateState(state)), { flag: 'wx', mode: 0o600 }); }
  save(users, rooms) {
    const text = JSON.stringify(envelope(users, rooms));
    this.tail = this.tail.then(async () => {
      await fs.writeFile(this.file + '.tmp', text, { mode: 0o600 });
      await fs.rename(this.file + '.tmp', this.file);
    }).catch(e => { this.error = e; throw e; });
    this.tail.catch(() => {});
    return this.tail;
  }
  async flush() { await this.tail; }
}
module.exports = { SupabaseStore, FileStore, validateState, envelope, STATE_KEY };
