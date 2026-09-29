// Minimal AT Protocol client for the browser. No dependencies.
//
// Public data is read from Bluesky's public AppView and from each account's
// own PDS. The app password is only ever sent to the signed-in user's own
// Bluesky server (createSession); nothing is persisted.

const APPVIEW = 'https://public.api.bsky.app';
const PLC = 'https://plc.directory';

export class XrpcError extends Error {
  constructor(status, error, message) {
    super(message || error || `HTTP ${status}`);
    this.status = status;
    this.error = error || '';
  }
}

// Per-host pause shared by all concurrent requests, set when a host rate-limits us.
const pausedUntil = new Map();
let onRateLimit = null;
export function setRateLimitListener(fn) { onRateLimit = fn; }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

async function request(url, { method = 'GET', body, token, signal, retries = 3 } = {}) {
  const host = url.host;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    const wait = (pausedUntil.get(host) || 0) - Date.now();
    if (wait > 0) await sleep(wait, signal);

    let res;
    try {
      res = await fetch(url, {
        method, headers, signal,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= retries) throw new XrpcError(0, 'NetworkError', `Could not reach ${host}`);
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      let delay = 2000 * 2 ** attempt;
      const reset = Number(res.headers.get('ratelimit-reset'));
      if (res.status === 429) {
        if (reset > 0) delay = Math.max(1000, reset * 1000 - Date.now());
        delay = Math.min(Math.max(delay, 5000), 90_000);
        pausedUntil.set(host, Date.now() + delay);
        onRateLimit?.(host, delay);
      }
      await sleep(delay, signal);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    throw new XrpcError(res.status, data.error, data.message);
  }
}

function xrpc(service, nsid, { params, ...opts } = {}) {
  const url = new URL(`/xrpc/${nsid}`, service);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  return request(url, opts);
}

// ---------------------------------------------------------------- identity

export function normalizeIdentifier(input) {
  let id = input.trim()
    .replace(/^https?:\/\/(www\.)?bsky\.app\/profile\//i, '')
    .replace(/^at:\/\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
  if (id.startsWith('did:')) return id;
  id = id.toLowerCase();
  if (id && !id.includes('.')) id += '.bsky.social';
  return id;
}

export async function resolveHandle(identifier, signal) {
  if (identifier.startsWith('did:')) return identifier;
  const { did } = await xrpc(APPVIEW, 'com.atproto.identity.resolveHandle', {
    params: { handle: identifier }, signal, retries: 1,
  });
  return did;
}

const PDS_CACHE_KEY = 'stale-follows:pds';
const PDS_CACHE_TTL = 7 * 864e5;
const pdsCache = loadPdsCache();

function loadPdsCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(PDS_CACHE_KEY) || '{}');
    const now = Date.now();
    return new Map(Object.entries(raw).filter(([, v]) => now - v.t < PDS_CACHE_TTL));
  } catch { return new Map(); }
}

let saveTimer = 0;
function savePdsCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(PDS_CACHE_KEY, JSON.stringify(Object.fromEntries(pdsCache))); } catch { /* storage unavailable */ }
  }, 1000);
}

// Returns the PDS URL for a DID, or throws. A tombstoned did:plc throws with error 'Gone'.
export async function resolvePds(did, { signal, retries = 2, fresh = false } = {}) {
  const cached = pdsCache.get(did);
  if (cached && !fresh) return cached.pds;

  let url;
  if (did.startsWith('did:plc:')) url = new URL(`${PLC}/${did}`);
  else if (did.startsWith('did:web:')) url = new URL(`https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`);
  else throw new XrpcError(0, 'UnsupportedDid', `Unsupported DID: ${did}`);

  let doc;
  try {
    doc = await request(url, { signal, retries });
  } catch (err) {
    if (err.status === 410) err.error = 'Gone';
    throw err;
  }
  const svc = (doc.service || []).find(s => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`);
  if (!svc?.serviceEndpoint) throw new XrpcError(0, 'NoPds', 'No PDS listed in DID document');
  pdsCache.set(did, { pds: svc.serviceEndpoint, t: Date.now() });
  savePdsCache();
  return svc.serviceEndpoint;
}

// ---------------------------------------------------------------- session

export class Session {
  constructor(service, data) {
    this.service = service;
    this.did = data.did;
    this.handle = data.handle;
    this.accessJwt = data.accessJwt;
    this.refreshJwt = data.refreshJwt;
  }

  // Accounts hosted by Bluesky sign in through the bsky.social entryway, which
  // also routes their writes. Self-hosted accounts talk to their own PDS.
  static async login(identifier, password, pds) {
    const host = new URL(pds).hostname;
    const service = host === 'bsky.social' || host.endsWith('.bsky.network') ? 'https://bsky.social' : pds;
    const data = await xrpc(service, 'com.atproto.server.createSession', {
      method: 'POST', body: { identifier, password }, retries: 0,
    });
    return new Session(service, data);
  }

  async call(nsid, opts = {}) {
    try {
      return await xrpc(this.service, nsid, { ...opts, token: this.accessJwt });
    } catch (err) {
      if (err.error !== 'ExpiredToken') throw err;
      await this.refresh();
      return xrpc(this.service, nsid, { ...opts, token: this.accessJwt });
    }
  }

  async refresh() {
    const data = await xrpc(this.service, 'com.atproto.server.refreshSession', {
      method: 'POST', token: this.refreshJwt, retries: 0,
    });
    this.accessJwt = data.accessJwt;
    this.refreshJwt = data.refreshJwt;
  }

  async logout() {
    try {
      await xrpc(this.service, 'com.atproto.server.deleteSession', {
        method: 'POST', token: this.refreshJwt, retries: 0,
      });
    } catch { /* best effort */ }
    this.accessJwt = this.refreshJwt = null;
  }

  // Deletes follow records in batches; falls back to one-by-one if a batch fails
  // (e.g. a record was already removed elsewhere).
  async deleteFollows(rkeys, onProgress) {
    const BATCH = 50;
    let done = 0;
    for (let i = 0; i < rkeys.length; i += BATCH) {
      const chunk = rkeys.slice(i, i + BATCH);
      try {
        await this.call('com.atproto.repo.applyWrites', {
          method: 'POST', retries: 2,
          body: {
            repo: this.did,
            writes: chunk.map(rkey => ({
              $type: 'com.atproto.repo.applyWrites#delete',
              collection: 'app.bsky.graph.follow',
              rkey,
            })),
          },
        });
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err;
        for (const rkey of chunk) {
          await this.call('com.atproto.repo.deleteRecord', {
            method: 'POST', retries: 2,
            body: { repo: this.did, collection: 'app.bsky.graph.follow', rkey },
          });
        }
      }
      done += chunk.length;
      onProgress?.(done);
    }
  }
}

// ---------------------------------------------------------------- data

// All follow records in the user's repo, including follows of deleted accounts.
export async function listFollowRecords(pds, did, { signal, onProgress } = {}) {
  const records = [];
  let cursor;
  const seen = new Set();
  do {
    const res = await xrpc(pds, 'com.atproto.repo.listRecords', {
      params: { repo: did, collection: 'app.bsky.graph.follow', limit: 100, cursor }, signal,
    });
    for (const r of res.records || []) {
      const subject = r.value?.subject;
      if (typeof subject !== 'string' || !subject.startsWith('did:')) continue;
      records.push({ rkey: r.uri.split('/').pop(), subject, createdAt: r.value.createdAt });
    }
    onProgress?.(records.length);
    cursor = res.records?.length && res.cursor && !seen.has(res.cursor) ? res.cursor : null;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}

export async function getProfiles(dids, { signal } = {}) {
  const res = await xrpc(APPVIEW, 'app.bsky.actor.getProfiles', { params: { actors: dids }, signal });
  return res.profiles || [];
}

// For accounts missing from getProfiles: why are they missing?
export async function getAccountStatus(did, { signal } = {}) {
  try {
    const profile = await xrpc(APPVIEW, 'app.bsky.actor.getProfile', { params: { actor: did }, signal, retries: 1 });
    return { status: 'ok', profile };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.error === 'AccountDeactivated') return { status: 'deactivated' };
    if (err.error === 'AccountTakedown') return { status: 'suspended' };
    if (err.status === 400) return { status: 'deleted' };
    return { status: 'unknown' };
  }
}

// Timestamp (ms) of the account's most recent post, reply or repost, or null.
// With a session, reads through the user's PDS (sees accounts hidden from logged-out viewers).
export async function getLastPost(actor, { signal, session } = {}) {
  const opts = { params: { actor, limit: 3, filter: 'posts_with_replies' }, signal };
  const res = session
    ? await session.call('app.bsky.feed.getAuthorFeed', opts)
    : await xrpc(APPVIEW, 'app.bsky.feed.getAuthorFeed', opts);
  let latest = null;
  for (const item of res.feed || []) {
    let t;
    if (item.reason?.indexedAt) {
      t = Date.parse(item.reason.indexedAt);
    } else {
      const indexed = Date.parse(item.post?.indexedAt);
      const created = Date.parse(item.post?.record?.createdAt);
      // createdAt is client-supplied and can be in the future; never trust it past indexedAt.
      t = Number.isFinite(created) && Number.isFinite(indexed) ? Math.min(created, indexed)
        : Number.isFinite(indexed) ? indexed : created;
    }
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

// Timestamp (ms) of the latest commit to an account's repo: any post, like,
// repost, follow, block or profile edit. Throws with the PDS error otherwise.
export async function getLastCommit(pds, did, { signal } = {}) {
  const { rev } = await xrpc(pds, 'com.atproto.sync.getLatestCommit', {
    params: { did }, signal, retries: 1,
  });
  return tidToTime(rev);
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
export function tidToTime(tid) {
  if (typeof tid !== 'string' || !/^[234567a-j][234567a-z]{12}$/.test(tid)) return null;
  let n = 0n;
  for (const c of tid) n = n * 32n + BigInt(S32.indexOf(c));
  const ms = Number((n >> 10n) / 1000n);
  // Sanity window: the network launched in 2022; allow slight clock skew.
  return ms > Date.UTC(2022, 0, 1) && ms < Date.now() + 864e5 ? ms : null;
}
