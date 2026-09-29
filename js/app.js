import * as at from './atproto.js';
import { ActivityChart } from './chart.js';

const DAY = 864e5;
const DEEP_CHECK_AFTER = 30 * DAY;
const PAGE = 200;
const GONE = new Set(['deleted', 'deactivated', 'suspended', 'unknown']);
const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const THRESHOLD_PHRASE = { 91: 'three months', 182: 'six months', 365: 'a year', 730: 'two years' };
const STATUS_LABEL = {
  stale: 'Stale', active: 'Active', pending: 'Checking', unfollowed: 'Unfollowed',
  deleted: 'Deleted', deactivated: 'Deactivated', suspended: 'Suspended', unknown: 'Unavailable',
};
const CATEGORY_ORDER = { gone: 0, stale: 1, active: 2, pending: 3, unfollowed: 4 };

const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat();
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' });

const state = {
  session: null,
  me: null,
  rows: new Map(),
  threshold: 365,
  metric: 'active',
  filter: 'all',
  query: '',
  sort: { key: 'last', dir: 1 },
  selected: new Set(),
  limit: PAGE,
  controller: null,
  scanning: false,
  stopped: false,
  now: Date.now(),
};

// ------------------------------------------------------------------ helpers

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function formatAge(t, suffix = ' ago') {
  if (t == null) return '';
  const days = (state.now - t) / DAY;
  if (days < 1) return 'Today';
  if (days < 31) return `${Math.floor(days)}d${suffix}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo${suffix}`;
  const y = Math.floor(months / 12), m = months % 12;
  return `${y}y${m ? ` ${m}mo` : ''}${suffix}`;
}

function activityTime(row, metric = state.metric) {
  if (metric === 'post') return row.lastPost;
  if (row.lastPost == null) return row.lastCommit;
  if (row.lastCommit == null) return row.lastPost;
  return Math.max(row.lastPost, row.lastCommit);
}

function category(row) {
  if (row.status === 'unfollowed') return 'unfollowed';
  if (GONE.has(row.status)) return 'gone';
  if (!row.checked) return 'pending';
  const t = activityTime(row);
  return t == null || state.now - t > state.threshold * DAY ? 'stale' : 'active';
}

function statusKey(row) {
  const cat = category(row);
  return cat === 'gone' ? row.status : cat;
}

function handleOf(row) {
  const handle = row.profile?.handle;
  return handle && handle !== 'handle.invalid' ? handle : null;
}

function nameOf(row) {
  return row.profile?.displayName?.trim() || handleOf(row) || (row.profile ? row.did : 'Account unavailable');
}

function profileUrl(row) {
  return `https://bsky.app/profile/${handleOf(row) || row.did}`;
}

async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------------ sign in

$('signin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const identifier = at.normalizeIdentifier($('handle').value);
  const password = $('password').value.trim();
  const error = $('signin-error');
  error.hidden = true;

  if (!identifier) return showError('Enter your Bluesky handle.');
  if (password && !APP_PASSWORD.test(password)) {
    return showError('That doesn’t look like an app password (xxxx-xxxx-xxxx-xxxx). For your security, only app passwords are accepted, never your main password.');
  }

  const submit = $('signin-submit');
  submit.disabled = true;
  submit.textContent = password ? 'Signing in…' : 'Looking up…';
  const controller = new AbortController();
  state.controller = controller;

  let did, pds;
  try {
    did = await at.resolveHandle(identifier, controller.signal);
    pds = await at.resolvePds(did, { signal: controller.signal, fresh: true });
    if (password) state.session = await at.Session.login(identifier, password, pds);
  } catch (err) {
    submit.disabled = false;
    submit.textContent = 'Analyze follows';
    return showError(signInMessage(err, !!password));
  }
  $('password').value = '';

  submit.disabled = false;
  submit.textContent = 'Analyze follows';
  state.me = { did, pds, handle: state.session?.handle || (identifier.startsWith('did:') ? did : identifier) };
  startResults();
  scan(controller).catch(err => {
    if (!controller.signal.aborted) setProgress(`Something went wrong: ${err.message}`, null, true);
  });

  function showError(msg) {
    error.textContent = msg;
    error.hidden = false;
  }
});

function signInMessage(err, withPassword) {
  if (err.error === 'NetworkError') return 'Couldn’t reach Bluesky. Check your connection and try again.';
  if (err.error === 'AuthFactorTokenRequired') return 'Bluesky asked for a sign-in code. Use an app password instead of your main password.';
  if (err.status === 429) return 'Too many sign-in attempts. Wait a few minutes and try again.';
  if (withPassword && err.status === 401) return 'Bluesky didn’t accept that handle and app password. Check both and try again.';
  if (err.status === 400 && /handle/i.test(err.message)) return 'Couldn’t find that handle on Bluesky.';
  if (err.error === 'Gone') return 'That account has been deleted.';
  return `Couldn’t sign in: ${err.message}`;
}

$('signout').addEventListener('click', async () => {
  state.controller?.abort();
  const session = state.session;
  state.session = null;
  state.me = null;
  state.rows.clear();
  state.selected.clear();
  state.filter = 'all';
  state.query = '';
  $('search').value = '';
  $('results').hidden = true;
  $('signin').hidden = false;
  renderSelection();
  $('whoami').hidden = true;
  $('signout').hidden = true;
  $('handle').focus();
  await session?.logout();
});

function startResults() {
  $('signin').hidden = true;
  $('results').hidden = false;
  $('whoami').textContent = `@${state.me.handle}`;
  $('whoami').hidden = false;
  $('signout').hidden = false;
  $('table').classList.toggle('readonly', !state.session);
  state.rows.clear();
  state.selected.clear();
  rowCache.clear();
  state.limit = PAGE;
  state.stopped = false;
  render();
}

// ------------------------------------------------------------------ scan

async function scan(controller) {
  const { signal } = controller;
  const { did, pds } = state.me;
  state.scanning = true;
  state.now = Date.now();

  try {
    setProgress('Loading your follows…', null);
    const records = await at.listFollowRecords(pds, did, {
      signal, onProgress: n => setProgress(`Loading your follows… ${nf.format(n)}`, null),
    });
    for (const r of records) {
      let row = state.rows.get(r.subject);
      if (!row) {
        row = { did: r.subject, rkeys: [], followedAt: null, profile: null, status: 'pending', lastPost: null, lastCommit: null, checked: false };
        state.rows.set(r.subject, row);
      }
      row.rkeys.push(r.rkey);
      const t = Date.parse(r.createdAt);
      if (Number.isFinite(t) && (row.followedAt == null || t < row.followedAt)) row.followedAt = t;
    }
    const rows = [...state.rows.values()];
    const total = rows.length;
    render();

    let done = 0;
    await pool(chunks(rows.map(r => r.did), 25), 4, async batch => {
      try {
        for (const p of await at.getProfiles(batch, { signal })) {
          const row = state.rows.get(p.did);
          if (row) { row.profile = p; row.status = 'ok'; }
        }
      } catch (err) {
        if (signal.aborted) throw err;
      }
      done += batch.length;
      setProgress(`Loading profiles… ${nf.format(done)} of ${nf.format(total)}`, done / total);
      scheduleRender();
    });

    const missing = rows.filter(r => r.status === 'pending');
    await pool(missing, 6, async row => {
      const { status, profile } = await at.getAccountStatus(row.did, { signal });
      row.status = status;
      if (profile) row.profile = profile;
      if (status !== 'ok') row.checked = true;
      scheduleRender();
    });

    done = 0;
    const live = rows.filter(r => r.status === 'ok');
    await pool(live, 8, async row => {
      await checkActivity(row, signal);
      done++;
      setProgress(`Checking activity… ${nf.format(done)} of ${nf.format(live.length)}`, done / live.length);
      scheduleRender();
    });
  } catch (err) {
    if (!signal.aborted) throw err;
    state.stopped = true;
  } finally {
    // A newer scan (after sign out and back in) owns the UI; leave it alone.
    if (state.controller === controller) {
      state.controller = null;
      state.scanning = false;
      $('progress').hidden = true;
      render();
    }
  }
}

async function checkActivity(row, signal) {
  try {
    row.lastPost = await at.getLastPost(row.did, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    row.postFailed = true;
    // Accounts hidden from logged-out viewers, or temporary errors: retry signed in.
    if (state.session) {
      try {
        row.lastPost = await at.getLastPost(row.did, { signal, session: state.session });
        row.postFailed = false;
      } catch (e) { if (signal.aborted) throw e; }
    }
  }
  if (row.lastPost == null || state.now - row.lastPost > DEEP_CHECK_AFTER) {
    try {
      const pds = await at.resolvePds(row.did, { signal });
      row.lastCommit = await at.getLastCommit(pds, row.did, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (err.error === 'Gone') row.status = 'deleted';
    }
  }
  row.checked = true;
}

$('stop').addEventListener('click', () => state.controller?.abort());

at.setRateLimitListener((host, delay) => {
  if (!state.scanning) return;
  $('progress-text').textContent = `${host} is rate-limiting requests. Resuming in ${Math.ceil(delay / 1000)}s…`;
});

function setProgress(text, fraction, isError = false) {
  $('progress').hidden = false;
  $('progress').classList.toggle('is-error', isError);
  $('progress-text').textContent = text;
  $('stop').hidden = isError;
  const bar = $('progress-bar');
  bar.classList.toggle('indeterminate', fraction == null);
  bar.style.width = fraction == null ? '' : `${Math.round(fraction * 1000) / 10}%`;
}

let renderTimer = 0;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 400);
}

// ------------------------------------------------------------------ render

const chart = new ActivityChart($('chart'), {
  onSelect: did => focusRow(did),
  describe: did => {
    const row = state.rows.get(did);
    const t = activityTime(row);
    const handle = handleOf(row);
    const what = state.metric === 'post' ? 'Last post' : 'Last active';
    return {
      value: t == null ? (state.metric === 'post' ? 'No posts found' : 'No activity found') : formatAge(t, ''),
      label: nameOf(row),
      detail: [handle && `@${handle}`, t != null && `${what} ${dateFmt.format(t)}`].filter(Boolean).join(' · '),
    };
  },
});

function render({ chart: withChart = true } = {}) {
  if (!state.scanning) state.now = Date.now();
  const rows = [...state.rows.values()];
  const counts = { all: 0, stale: 0, gone: 0, active: 0, pending: 0, unfollowed: 0 };
  for (const row of rows) {
    const cat = category(row);
    counts[cat]++;
    if (cat !== 'unfollowed') counts.all++;
  }
  renderSummary(counts);
  renderSuggest(counts);
  if (withChart) renderChart(rows);
  renderTable(rows, counts);
}

function renderSummary(counts) {
  const el = $('summary-text');
  el.replaceChildren();
  const b = n => h('strong', { text: nf.format(n) });
  const phrase = THRESHOLD_PHRASE[state.threshold];
  const verb = state.metric === 'post' ? 'posted' : 'been active';

  if (state.scanning && counts.pending) {
    el.append('Checked ', b(counts.all - counts.pending), ' of ', b(counts.all), ' accounts you follow. ',
      b(counts.stale), ` so far haven’t ${verb} in over ${phrase}.`);
    return;
  }
  if (!counts.all) {
    el.append(state.scanning ? 'Loading…' : 'You don’t follow anyone yet.');
    return;
  }
  if (counts.stale) el.append(b(counts.stale), ' of the ', b(counts.all), ` accounts you follow haven’t ${verb} in over ${phrase}.`);
  else el.append('None of the ', b(counts.all), ` accounts you follow have gone more than ${phrase} without ${state.metric === 'post' ? 'posting' : 'activity'}.`);
  if (counts.gone) el.append(' ', b(counts.gone), counts.gone === 1 ? ' more is' : ' more are', ' deleted, deactivated or suspended.');
  if (state.stopped && counts.pending) el.append(' Stopped early, so ', b(counts.pending), ' weren’t checked.');
}

function renderSuggest(counts) {
  const btn = $('select-suggested');
  const n = counts.stale + counts.gone;
  btn.hidden = !state.session || state.scanning || !n;
  btn.textContent = counts.gone && counts.stale
    ? `Select all ${nf.format(n)} stale & gone`
    : `Select all ${nf.format(n)} ${counts.gone ? 'gone' : 'stale'}`;
}

function renderChart(rows) {
  const points = [];
  for (const row of rows) {
    const cat = category(row);
    if (cat !== 'stale' && cat !== 'active') continue;
    const t = activityTime(row);
    points.push({ key: row.did, t, ageDays: t == null ? null : Math.max(0, (state.now - t) / DAY), stale: cat === 'stale' });
  }
  points.sort((a, b) => (a.t ?? -Infinity) - (b.t ?? -Infinity));
  const stale = points.filter(p => p.stale).length;
  $('legend-stale').textContent = `Stale ${nf.format(stale)}`;
  $('legend-other').textContent = `Active ${nf.format(points.length - stale)}`;
  $('chart-title').textContent = state.metric === 'post' ? 'Time since last post, per account' : 'Time since last activity, per account';
  chart.update(points, state.threshold);
}

function visibleRows(rows) {
  const q = state.query.trim().toLowerCase().replace(/^@/, '');
  const filtered = rows.filter(row => {
    const cat = category(row);
    if (state.filter === 'all' ? cat === 'unfollowed' : cat !== state.filter) return false;
    if (!q) return true;
    return [row.profile?.handle, row.profile?.displayName, row.did].some(s => s?.toLowerCase().includes(q));
  });
  const { key, dir } = state.sort;
  const val = sortValue[key];
  return filtered.sort((a, b) => {
    const va = val(a), vb = val(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return cmp * dir || nameOf(a).localeCompare(nameOf(b));
  });
}

// Missing values sort as "oldest": deleted accounts first, then no activity found.
const time = (row, t) => {
  const cat = category(row);
  if (cat === 'gone') return -2;
  if (cat === 'pending') return Number.MAX_SAFE_INTEGER;
  return t ?? -1;
};
const sortValue = {
  name: row => nameOf(row).toLowerCase(),
  last: row => time(row, activityTime(row, 'active')),
  post: row => time(row, row.lastPost),
  posts: row => row.profile?.postsCount ?? -1,
  followers: row => row.profile?.followersCount ?? -1,
  followed: row => row.followedAt ?? 0,
  status: row => CATEGORY_ORDER[category(row)],
};

function renderTable(rows, counts) {
  for (const btn of $('tabs').querySelectorAll('button')) {
    const f = btn.dataset.filter;
    btn.setAttribute('aria-pressed', String(f === state.filter));
    btn.querySelector('.count').textContent = nf.format(counts[f]);
    if (f === 'unfollowed') btn.hidden = !counts.unfollowed;
  }
  for (const th of $('table').querySelectorAll('th[data-sort]')) {
    const on = th.dataset.sort === state.sort.key;
    th.setAttribute('aria-sort', on ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }

  const shown = visibleRows(rows);
  const tbody = $('tbody');
  const frag = document.createDocumentFragment();
  for (const row of shown.slice(0, state.limit)) frag.append(cachedRow(row));
  tbody.replaceChildren(frag);

  $('table-empty').hidden = shown.length > 0;
  $('table-empty').textContent = rows.length ? 'No accounts match.' : (state.scanning ? 'Loading…' : 'No follows found.');
  $('more').hidden = shown.length <= state.limit;
  $('more-btn').textContent = `Show ${nf.format(Math.min(PAGE, shown.length - state.limit))} more of ${nf.format(shown.length - state.limit)}`;

  state.shown = shown;
  renderSelection();
}

// Rows are rebuilt only when what they display changes, so progress updates
// during a scan don't churn the DOM (or re-request avatars).
const rowCache = new Map();
function cachedRow(row) {
  const p = row.profile || {};
  const sig = [category(row), row.status, row.lastPost, row.lastCommit, row.postFailed, row.followedAt,
    p.handle, p.displayName, p.avatar, p.postsCount, p.followersCount, state.selected.has(row.did), state.now].join('|');
  const hit = rowCache.get(row.did);
  if (hit?.sig === sig) return hit.tr;
  const tr = renderRow(row);
  rowCache.set(row.did, { sig, tr });
  return tr;
}

function renderRow(row) {
  const cat = category(row);
  const key = statusKey(row);
  const handle = handleOf(row);
  const avatar = row.profile?.avatar
    ? h('img', { class: 'avatar', src: row.profile.avatar.replace('/img/avatar/', '/img/avatar_thumbnail/'), alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' })
    : h('span', { class: 'avatar avatar-empty' });
  const unfollowed = row.status === 'unfollowed';

  const check = h('input', {
    type: 'checkbox', checked: state.selected.has(row.did), disabled: unfollowed,
    'aria-label': `Select ${nameOf(row)}`,
  });
  check.dataset.did = row.did;

  const pending = cat === 'pending';
  const gone = cat === 'gone';
  const lastActive = activityTime(row, 'active'); // column always shows combined activity
  return h('tr', { class: `row-${cat}`, 'data-did': row.did },
    h('td', { class: 'col-check' }, check),
    h('td', { class: 'col-account' },
      h('a', { class: 'account', href: profileUrl(row), target: '_blank', rel: 'noopener noreferrer' },
        avatar,
        h('span', { class: 'account-text' },
          h('span', { class: 'account-name', text: nameOf(row) }),
          h('span', { class: 'account-handle', text: handle ? `@${handle}` : row.did })))),
    lastActiveCell(timeCell(lastActive, pending, gone, 'None found'), cat, key),
    timeCell(row.lastPost, pending, gone, row.postFailed ? 'Unknown' : 'Never', 'col-post'),
    h('td', { class: 'num col-opt', text: row.profile?.postsCount != null ? nf.format(row.profile.postsCount) : '' }),
    h('td', { class: 'num col-opt', text: row.profile?.followersCount != null ? nf.format(row.profile.followersCount) : '' }),
    h('td', { class: 'num col-opt', title: row.followedAt ? `You followed on ${dateFmt.format(row.followedAt)}` : null, text: row.followedAt ? monthFmt.format(row.followedAt) : '' }),
    h('td', { class: 'col-status' }, h('span', { class: `status status-${cat}` }, h('span', { class: 'dot' }), STATUS_LABEL[key])));
}

function timeCell(t, pending, gone, emptyText, cls = '') {
  if (gone) return h('td', { class: `num muted ${cls}`, text: '' });
  if (pending) return h('td', { class: `num muted ${cls}`, text: '…' });
  if (t == null) return h('td', { class: `num muted ${cls}`, text: emptyText });
  return h('td', { class: `num ${cls}`, title: dateFmt.format(t), text: formatAge(t) });
}

// On phones the Status column is hidden, so "Last active" carries the status dot
// (and the label, for accounts that are gone or unfollowed).
function lastActiveCell(td, cat, key) {
  const status = h('span', { class: `m-only status status-${cat}` }, h('span', { class: 'dot' }));
  if (cat === 'gone' || cat === 'unfollowed') status.append(STATUS_LABEL[key]);
  td.prepend(status);
  return td;
}

function renderSelection() {
  const selectable = (state.shown || []).filter(r => r.status !== 'unfollowed');
  const picked = selectable.filter(r => state.selected.has(r.did)).length;
  const all = $('check-all');
  all.checked = picked > 0 && picked === selectable.length;
  all.indeterminate = picked > 0 && picked < selectable.length;
  all.disabled = !selectable.length;

  const n = state.selected.size;
  const show = !!(n && state.session && state.me);
  $('selection').textContent = state.session ? '' : 'Read-only. Sign in with an app password to unfollow.';
  $('selbar').hidden = !show;
  document.body.classList.toggle('has-selbar', show);
  $('selbar-text').textContent = `${nf.format(n)} selected`;
  $('unfollow').textContent = `Unfollow ${nf.format(n)}`;
}

$('selbar-clear').addEventListener('click', () => {
  state.selected.clear();
  render({ chart: false });
});

$('select-suggested').addEventListener('click', () => {
  for (const row of state.rows.values()) {
    const cat = category(row);
    if (cat === 'stale' || cat === 'gone') state.selected.add(row.did);
  }
  state.filter = 'all';
  state.query = '';
  $('search').value = '';
  if (state.sort.key !== 'last' && state.sort.key !== 'post') state.sort = { key: state.metric === 'post' ? 'post' : 'last', dir: 1 };
  state.sort.dir = 1;
  state.limit = PAGE;
  render({ chart: false });
  $('table').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function focusRow(did) {
  const row = state.rows.get(did);
  if (!row) return;
  let idx = (state.shown || []).indexOf(row);
  if (idx < 0) {
    state.filter = 'all';
    state.query = '';
    $('search').value = '';
    render({ chart: false });
    idx = state.shown.indexOf(row);
  }
  if (idx >= state.limit) {
    state.limit = Math.ceil((idx + 1) / PAGE) * PAGE;
    render({ chart: false });
  }
  const tr = $('tbody').querySelector(`tr[data-did="${CSS.escape(did)}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr.classList.remove('flash');
  void tr.offsetWidth;
  tr.classList.add('flash');
}

// ------------------------------------------------------------------ controls

$('threshold').addEventListener('change', e => { state.threshold = Number(e.target.value); render(); });
$('metric').addEventListener('change', e => {
  state.metric = e.target.value;
  if (state.sort.key === 'last' || state.sort.key === 'post') state.sort.key = state.metric === 'post' ? 'post' : 'last';
  render();
});

$('tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  state.limit = PAGE;
  render({ chart: false });
});

let searchTimer = 0;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value; state.limit = PAGE; render({ chart: false }); }, 120);
});

$('table').querySelector('thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  const defaultDir = key === 'name' || key === 'last' || key === 'post' || key === 'status' ? 1 : -1;
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: defaultDir };
  render({ chart: false });
});

$('tbody').addEventListener('change', e => {
  const did = e.target.dataset.did;
  if (!did) return;
  if (e.target.checked) state.selected.add(did); else state.selected.delete(did);
  renderSelection();
});

$('check-all').addEventListener('change', e => {
  for (const row of state.shown || []) {
    if (row.status === 'unfollowed') continue;
    if (e.target.checked) state.selected.add(row.did); else state.selected.delete(row.did);
  }
  render({ chart: false });
});

$('more-btn').addEventListener('click', () => { state.limit += PAGE; render({ chart: false }); });

$('export').addEventListener('click', () => {
  const cols = ['handle', 'display_name', 'did', 'status', 'last_active', 'last_post', 'posts', 'followers', 'followed_on', 'profile_url'];
  const iso = t => (t == null ? '' : new Date(t).toISOString().slice(0, 10));
  const lines = [cols.join(',')];
  for (const row of state.shown || []) {
    lines.push([
      handleOf(row) || '', row.profile?.displayName || '', row.did, STATUS_LABEL[statusKey(row)],
      iso(activityTime(row, 'active')), iso(row.lastPost),
      row.profile?.postsCount ?? '', row.profile?.followersCount ?? '', iso(row.followedAt), profileUrl(row),
    ].map(csvCell).join(','));
  }
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `bluesky-follows-${state.me?.handle || 'export'}-${iso(Date.now())}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from evaluating it
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ------------------------------------------------------------------ unfollow

$('unfollow').addEventListener('click', () => {
  const rows = [...state.selected].map(did => state.rows.get(did)).filter(r => r && r.status !== 'unfollowed');
  if (!rows.length || !state.session) return;
  const n = rows.length;
  $('confirm-title').textContent = `Unfollow ${nf.format(n)} account${n === 1 ? '' : 's'}?`;
  $('confirm-text').textContent = 'This removes them from your follows on Bluesky. It can’t be undone from here, so export the list first if you might want it later.';
  const list = $('confirm-list');
  list.replaceChildren(...rows.slice(0, 200).map(r => h('li', {},
    h('span', { text: nameOf(r) }), ' ', h('span', { class: 'muted', text: handleOf(r) ? `@${handleOf(r)}` : '' }))));
  if (n > 200) list.append(h('li', { class: 'muted', text: `and ${nf.format(n - 200)} more` }));
  $('confirm-error').hidden = true;
  const go = $('confirm-go');
  go.disabled = false;
  go.textContent = `Unfollow ${nf.format(n)}`;
  go.onclick = () => runUnfollow(rows);
  $('confirm').showModal();
});

async function runUnfollow(rows) {
  const go = $('confirm-go');
  const dialog = $('confirm');
  go.disabled = true;
  const rkeys = rows.flatMap(r => r.rkeys);
  let removed = 0;
  try {
    await state.session.deleteFollows(rkeys, done => {
      removed = done;
      go.textContent = `Unfollowing… ${nf.format(done)} of ${nf.format(rkeys.length)}`;
      // Mark rows as they finish so a partial failure leaves an accurate table.
      let seen = 0;
      for (const row of rows) {
        seen += row.rkeys.length;
        if (seen > done) break;
        row.status = 'unfollowed';
        state.selected.delete(row.did);
      }
    });
    dialog.close();
  } catch (err) {
    const e = $('confirm-error');
    e.textContent = err.status === 401
      ? 'Your session has expired. Sign out and sign in again to continue.'
      : `Stopped after ${nf.format(removed)} of ${nf.format(rkeys.length)}: ${err.message}`;
    e.hidden = false;
    go.textContent = 'Retry';
    go.disabled = false;
    go.onclick = () => runUnfollow(rows.filter(r => r.status !== 'unfollowed'));
  }
  render();
}

// ------------------------------------------------------------------ dialogs

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

function openHelp(sectionId) {
  const dialog = $('help');
  dialog.showModal();
  const target = sectionId && $(sectionId);
  if (target) target.scrollIntoView({ block: 'start' });
  else dialog.querySelector('.dialog-body').scrollTop = 0;
}

$('help-open').addEventListener('click', () => openHelp());
for (const btn of document.querySelectorAll('[data-help]')) {
  btn.addEventListener('click', () => openHelp(btn.dataset.help));
}

$('handle').focus();
