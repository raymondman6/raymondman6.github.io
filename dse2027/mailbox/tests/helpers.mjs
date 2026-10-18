import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../backend/worker.mjs';

const migration = readFileSync(new URL('../backend/migrations/0001_mailbox.sql', import.meta.url), 'utf8');
const plain = value => value == null ? null : {...value};

/** Executes the production SQL against real SQLite; it does not model mailbox behavior. */
export class D1Sqlite {
  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.beforeBatch = null;
    if (!this.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get()) {
      this.sqlite.exec(migration);
    }
  }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) {
    // An optional one-shot hook lets integration tests create a real competing write
    // after the worker's preflight reads, before its atomic SQL transaction.
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    if (hook) await hook(statements);
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  exec(sql) { this.sqlite.exec(sql); }
  close() { this.sqlite.close(); }
}

class D1Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.db, this.sql, values); }
  async first(column) {
    const result = plain(this.db.sqlite.prepare(this.sql).get(...this.values));
    return column ? result?.[column] ?? null : result;
  }
  async all() {
    return {success: true, results: this.db.sqlite.prepare(this.sql).all(...this.values).map(plain), meta: {}};
  }
  execute() {
    const native = this.db.sqlite.prepare(this.sql);
    if (native.columns().length) return {success: true, results: native.all(...this.values).map(plain), meta: {}};
    const result = native.run(...this.values);
    return {success: true, results: [], meta: {changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid)}};
  }
  async run() { return this.execute(); }
}

export class MemoryR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, options = {}) {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
    this.objects.set(key, {bytes, options});
    return {key, size: bytes.length};
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {key, size: stored.bytes.length, body: stored.bytes.slice(), httpMetadata: stored.options.httpMetadata,
      async arrayBuffer() { return stored.bytes.slice().buffer; }};
  }
  async delete(key) { this.objects.delete(key); }
}

/** Local-only harness, also suitable for a preview server; all keys are explicit test fixtures. */
export function createMailboxHarness({dbPath = ':memory:', env: overrides = {}} = {}) {
  const DB = new D1Sqlite(dbPath);
  const env = {
    DB, BUCKET: new MemoryR2(),
    OWNER_API_KEY: 'local-test-owner-key', AGENT_API_KEY: 'local-test-agent-key',
    OWNER_EMAIL: 'owner@example.test', FRONTEND_URL: 'https://mailbox.test/',
    ALLOWED_ORIGINS: 'https://mailbox.test',
    ...overrides,
  };
  const fetch = request => worker.fetch(request, env, {waitUntil() {}});
  async function request(path, {method = 'GET', token, headers: extraHeaders, body, origin} = {}) {
    const headers = new Headers(extraHeaders);
    if (token) headers.set('authorization', 'Bearer ' + token);
    if (origin) headers.set('origin', origin);
    let wireBody = body;
    if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      headers.set('content-type', 'application/json');
      wireBody = JSON.stringify(body);
    }
    const response = await fetch(new Request(new URL(path, 'https://api.mailbox.test'), {method, headers, body: wireBody}));
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.clone().json() : new Uint8Array(await response.clone().arrayBuffer());
    return {response, status: response.status, data};
  }
  return {env, DB, fetch, request, close: () => DB.close()};
}

export const ONE_PIXEL_PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'));
