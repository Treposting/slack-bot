const $ = (sel) => document.querySelector(sel);
const BATCH = 10;

const state = {
  channels: [],
  channel: null,
  messages: [],
  selected: new Set(),
  textFilter: '',
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Turn Slack's <@U123>, <#C123|name> and <url|label> markup into readable text.
function slackText(text) {
  return text
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const tsDate = (ts) => new Date(Number(ts) * 1000);
const iso = (d) => d.toISOString().slice(0, 10);

/* ---------- Sign in ---------- */

async function boot() {
  const config = await api('/api/config');
  $('#dry-run').classList.toggle('hidden', !config.dryRun);
  if (config.oauthEnabled) {
    $('#oauth-btn').classList.remove('hidden');
    $('#or').classList.remove('hidden');
  }
  const urlError = new URLSearchParams(location.search).get('error');
  if (urlError) $('#login-error').textContent = `Slack sign-in failed: ${urlError}`;

  try {
    const { me } = await api('/api/me');
    showApp(me);
  } catch {
    $('#login').classList.remove('hidden');
  }
}

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const { me } = await api('/api/token', { method: 'POST', body: { token: $('#token').value } });
    $('#token').value = '';
    $('#login').classList.add('hidden');
    showApp(me);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});

function showApp(me) {
  $('#app').classList.remove('hidden');
  $('#me-name').textContent = me.user;
  $('#me-team').textContent = me.team;
  const today = new Date();
  $('#to').value = iso(today);
  $('#from').value = iso(new Date(today.getTime() - 30 * 864e5));
  loadChannels();
}

/* ---------- Channels ---------- */

const KIND_LABEL = { public: 'Channels', private: 'Private channels', group: 'Group DMs', dm: 'Direct messages' };
const KIND_ICON = { public: '#', private: '🔒', group: '👥', dm: '@' };

async function loadChannels() {
  try {
    const { channels } = await api('/api/channels');
    state.channels = channels;
    renderChannels();
  } catch (err) {
    $('#channels').innerHTML = `<div class="pad error">${escapeHtml(err.message)}</div>`;
  }
}

function renderChannels() {
  const q = $('#channel-filter').value.trim().toLowerCase();
  const list = state.channels.filter((c) => String(c.name).toLowerCase().includes(q));
  const nav = $('#channels');
  nav.innerHTML = '';
  if (!list.length) {
    nav.innerHTML = '<div class="pad muted">No channels found</div>';
    return;
  }
  for (const kind of ['public', 'private', 'group', 'dm']) {
    const items = list.filter((c) => c.kind === kind);
    if (!items.length) continue;
    nav.insertAdjacentHTML('beforeend', `<div class="group-label">${KIND_LABEL[kind]}</div>`);
    for (const c of items) {
      const btn = document.createElement('button');
      btn.className = 'channel' + (state.channel?.id === c.id ? ' active' : '');
      btn.innerHTML = `<span class="icon">${KIND_ICON[kind]}</span><span class="name">${escapeHtml(String(c.name))}</span>`;
      btn.addEventListener('click', () => selectChannel(c));
      nav.appendChild(btn);
    }
  }
}

$('#channel-filter').addEventListener('input', renderChannels);

function selectChannel(c) {
  state.channel = c;
  state.messages = [];
  state.selected.clear();
  $('#channel-title').textContent = `${KIND_ICON[c.kind]} ${c.name}`;
  $('#load-btn').disabled = false;
  renderChannels();
  loadMessages();
}

/* ---------- Messages ---------- */

$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  loadMessages();
});

async function loadMessages() {
  if (!state.channel) return;
  state.selected.clear();
  $('#selection-bar').classList.add('hidden');
  $('#messages').innerHTML = '<div class="spinner"></div><p class="muted" style="text-align:center">Searching your messages…</p>';
  const params = new URLSearchParams({
    channel: state.channel.id,
    from: $('#from').value,
    to: $('#to').value,
    threads: $('#threads').checked ? '1' : '0',
  });
  try {
    const { messages, truncated } = await api(`/api/messages?${params}`);
    state.messages = messages;
    state.truncated = truncated;
    renderMessages();
  } catch (err) {
    $('#messages').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><p class="error">${escapeHtml(err.message)}</p></div>`;
  }
}

function visibleMessages() {
  const q = state.textFilter.toLowerCase();
  return state.messages.filter((m) => !m.deleted && (!q || m.text.toLowerCase().includes(q)));
}

function renderMessages() {
  const box = $('#messages');
  if (!state.messages.length) {
    $('#selection-bar').classList.add('hidden');
    box.innerHTML = '<div class="empty"><div class="empty-icon">✨</div><p>You have no messages here in this date range.</p></div>';
    return;
  }
  $('#selection-bar').classList.remove('hidden');
  const visible = visibleMessages();
  const remaining = state.messages.filter((m) => !m.deleted).length;
  let html = `<div class="summary">${remaining} of your messages found${state.truncated ? ' (showing the first 1000; narrow the date range to see more)' : ''}</div>`;
  let day = '';
  for (const m of state.messages) {
    if (!m.deleted && !visible.includes(m)) continue;
    const d = tsDate(m.ts);
    const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (label !== day) {
      day = label;
      html += `<div class="day">${label}</div>`;
    }
    const sel = state.selected.has(m.ts);
    const tags = [
      m.threadTs ? '<span class="tag">thread reply</span>' : '',
      m.replyCount ? `<span class="tag">${m.replyCount} replies</span>` : '',
      m.edited ? '<span class="tag">edited</span>' : '',
      ...m.files.map((f) => `<span class="tag">📎 ${escapeHtml(f)}</span>`),
    ].join('');
    html += `
      <div class="msg${sel ? ' selected' : ''}${m.deleted ? ' deleted' : ''}" data-ts="${m.ts}">
        <input type="checkbox" ${sel ? 'checked' : ''} ${m.deleted ? 'disabled' : ''} aria-label="Select message" />
        <div>
          <div class="msg-meta"><span>${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>${tags}</div>
          <div class="msg-text">${escapeHtml(slackText(m.text)) || '<span class="muted">(no text)</span>'}</div>
        </div>
      </div>`;
  }
  box.innerHTML = html;
  updateSelectionBar();
}

$('#messages').addEventListener('click', (e) => {
  const row = e.target.closest('.msg');
  if (!row) return;
  const ts = row.dataset.ts;
  if (state.selected.has(ts)) state.selected.delete(ts);
  else state.selected.add(ts);
  row.classList.toggle('selected', state.selected.has(ts));
  row.querySelector('input').checked = state.selected.has(ts);
  updateSelectionBar();
});

function updateSelectionBar() {
  const n = state.selected.size;
  const visible = visibleMessages();
  $('#selection-count').textContent = `${n} selected`;
  $('#delete-btn').disabled = n === 0;
  $('#delete-btn').textContent = n ? `Delete ${n} message${n === 1 ? '' : 's'}` : 'Delete selected';
  const all = $('#select-all');
  const selVisible = visible.filter((m) => state.selected.has(m.ts)).length;
  all.checked = visible.length > 0 && selVisible === visible.length;
  all.indeterminate = selVisible > 0 && selVisible < visible.length;
}

$('#select-all').addEventListener('change', (e) => {
  for (const m of visibleMessages()) {
    if (e.target.checked) state.selected.add(m.ts);
    else state.selected.delete(m.ts);
  }
  renderMessages();
});

$('#text-filter').addEventListener('input', (e) => {
  state.textFilter = e.target.value;
  renderMessages();
});

/* ---------- Delete ---------- */

$('#delete-btn').addEventListener('click', () => {
  const chosen = state.messages.filter((m) => state.selected.has(m.ts));
  const n = chosen.length;
  $('#confirm-count').textContent = `${n} message${n === 1 ? '' : 's'}`;
  $('#confirm-channel').textContent = `${KIND_ICON[state.channel.kind]} ${state.channel.name}`;
  $('#confirm-preview').innerHTML = chosen
    .slice(0, 50)
    .map((m) => `<li>${escapeHtml(slackText(m.text).slice(0, 140)) || '(no text)'}</li>`)
    .join('') + (n > 50 ? `<li class="muted">…and ${n - 50} more</li>` : '');
  $('#confirm-input').value = '';
  $('#confirm-ok').disabled = true;
  $('#confirm').showModal();
  $('#confirm-input').focus();
});

$('#confirm-input').addEventListener('input', (e) => {
  $('#confirm-ok').disabled = e.target.value.trim() !== 'DELETE';
});
$('#confirm-cancel').addEventListener('click', () => $('#confirm').close());
$('#confirm-ok').addEventListener('click', () => {
  $('#confirm').close();
  runDelete([...state.selected]);
});

async function runDelete(timestamps) {
  const total = timestamps.length;
  let done = 0;
  let failed = 0;
  let dryRun = false;
  $('#progress-title').textContent = 'Deleting…';
  $('#progress-errors').innerHTML = '';
  $('#progress-close').disabled = true;
  $('#progress-fill').style.width = '0%';
  $('#progress-text').textContent = `0 of ${total}`;
  $('#progress').showModal();

  for (let i = 0; i < total; i += BATCH) {
    const batch = timestamps.slice(i, i + BATCH);
    let results;
    try {
      const res = await api('/api/delete', { method: 'POST', body: { channel: state.channel.id, timestamps: batch } });
      results = res.results;
      dryRun = res.dryRun;
    } catch (err) {
      results = batch.map((ts) => ({ ts, ok: false, error: err.message }));
    }
    for (const r of results) {
      done++;
      const msg = state.messages.find((m) => m.ts === r.ts);
      if (r.ok) {
        if (msg) msg.deleted = true;
        state.selected.delete(r.ts);
      } else {
        failed++;
        const preview = msg ? slackText(msg.text).slice(0, 60) : r.ts;
        $('#progress-errors').insertAdjacentHTML('beforeend', `<li>${escapeHtml(preview)}: ${escapeHtml(r.error)}</li>`);
      }
    }
    $('#progress-fill').style.width = `${(done / total) * 100}%`;
    $('#progress-text').textContent = `${done} of ${total}${failed ? `, ${failed} failed` : ''}`;
  }

  const deleted = total - failed;
  $('#progress-title').textContent = dryRun
    ? `Dry run finished: ${deleted} would be deleted`
    : `Deleted ${deleted} message${deleted === 1 ? '' : 's'}`;
  $('#progress-close').disabled = false;
  renderMessages();
}

$('#progress-close').addEventListener('click', () => {
  $('#progress').close();
  toast('Done');
});

boot();
