// The in-page panel. Injected into app.slack.com; toggled from the toolbar
// button. Uses SlackCleanerUI (DOM) and SlackCleanerSelection (pure state).
(function () {
  const UI = window.SlackCleanerUI;
  const { SelectionModel } = window.SlackCleanerSelection;
  const DELETE_GAP_MS = 1200; // stay well under Slack's chat.delete rate limit

  const model = new SelectionModel();
  let self = { id: '', name: '' };
  let filterText = '';
  let root = null;
  let busy = false;
  let stopRequested = false;
  let tab = 'pick';

  const LOGO = `<svg viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="30" fill="#3DDC97" fill-opacity=".14"/>
    <path d="M30 34h44a8 8 0 0 1 8 8v28a8 8 0 0 1-8 8H50l-14 12v-12h-6a8 8 0 0 1-8-8V42a8 8 0 0 1 8-8z" fill="#fff"/>
    <rect x="86" y="38" width="12" height="12" rx="3" fill="#fff" opacity=".85"/><rect x="88" y="58" width="10" height="10" rx="2.5" fill="#fff" opacity=".6"/>
    <rect x="104" y="46" width="8" height="8" rx="2" fill="#fff" opacity=".4"/>
    <rect x="34" y="46" width="36" height="7" rx="3.5" fill="#2B1B5A" opacity=".85"/><rect x="34" y="60" width="24" height="7" rx="3.5" fill="#3DDC97"/></svg>`;
  const ICON = {
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const esc = (s) =>
    (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  const $ = (sel) => root.querySelector(`[data-sc="${sel}"]`);

  function mount() {
    if (root) return;
    root = el(`
      <div id="slack-cleaner" class="sc-panel" role="region" aria-label="Slack Cleaner">
        <header class="sc-head">
          <span class="sc-logo">${LOGO}</span>
          <div class="sc-title">
            <strong>Slack Cleaner</strong>
            <span data-sc="who">Your messages, gone for good</span>
          </div>
          <button class="sc-icon sc-x" data-sc="close" title="Close" aria-label="Close">${ICON.close}</button>
        </header>

        <div class="sc-stats">
          <div class="sc-stat"><b data-sc="n-view">0</b><span>in view</span></div>
          <div class="sc-stat"><b data-sc="n-mine">0</b><span>yours</span></div>
          <div class="sc-stat sc-stat-accent"><b data-sc="n-sel">0</b><span>selected</span></div>
        </div>

        <nav class="sc-tabs" role="tablist">
          <button role="tab" data-tab="pick">Pick messages</button>
          <button role="tab" data-tab="auto">Clear everything</button>
        </nav>

        <section class="sc-pane" data-pane="pick">
          <div class="sc-controls">
            <label class="sc-check" title="Select all shown"><input type="checkbox" data-sc="all" /></label>
            <div class="sc-search">${ICON.search}<input data-sc="filter" type="search" placeholder="Filter your messages" /></div>
            <button class="sc-icon" data-sc="rescan" title="Rescan after scrolling" aria-label="Rescan">${ICON.refresh}</button>
          </div>
          <div class="sc-list" data-sc="list"></div>
          <footer class="sc-foot">
            <button class="sc-btn sc-danger" data-sc="delete" disabled>${ICON.trash}<span>Delete selected</span></button>
          </footer>
        </section>

        <section class="sc-pane" data-pane="auto" hidden>
          <div class="sc-card">
            <p><b>Clears every message you sent in this conversation.</b></p>
            <p>Starts at the newest message and scrolls up to the very top, skipping everyone else's. You can stop at any time.</p>
          </div>
          <button class="sc-btn sc-primary sc-wide" data-sc="auto">${ICON.trash}<span>Clear all my messages</span></button>
          <button class="sc-btn sc-ghost sc-wide" data-sc="stop" hidden>Stop</button>
        </section>

        <div class="sc-status" data-sc="status" hidden>
          <div class="sc-bar"><i data-sc="bar"></i></div>
          <div class="sc-status-text" data-sc="status-text"></div>
        </div>
      </div>`);
    document.body.appendChild(root);

    $('close').addEventListener('click', hide);
    $('rescan').addEventListener('click', rescan);
    $('filter').addEventListener('input', (e) => {
      filterText = e.target.value;
      renderList();
    });
    $('all').addEventListener('change', (e) => {
      model.setAll(model.visible(filterText).map((m) => m.id), e.target.checked);
      renderList();
    });
    $('delete').addEventListener('click', confirmAndDelete);
    $('auto').addEventListener('click', autoClear);
    $('stop').addEventListener('click', () => {
      stopRequested = true;
      $('stop').disabled = true;
      $('stop').textContent = 'Stopping…';
    });
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    setTab(tab);
  }

  function setTab(name) {
    if (busy) return;
    tab = name;
    root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    root.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
  }

  function show() {
    mount();
    root.style.display = 'flex';
    rescan();
  }
  function hide() {
    if (root) root.style.display = 'none';
  }
  function toggle() {
    if (!root || root.style.display === 'none') show();
    else hide();
  }

  // Progress strip under the panel. `done`/`total` drive the bar; total=null
  // shows an indeterminate shimmer. tone: '', 'ok' or 'warn'.
  function status(text, { done = 0, total = null, tone = '' } = {}) {
    const box = $('status');
    box.hidden = false;
    box.className = `sc-status${tone ? ` sc-${tone}` : ''}`;
    const bar = $('bar');
    bar.classList.toggle('sc-indet', total === null);
    bar.style.width = total === null ? '' : `${total ? Math.round((done / total) * 100) : 100}%`;
    $('status-text').innerHTML = text;
  }

  function rescan() {
    if (busy) return;
    const scan = UI.scanMessages(document);
    self = scan.self;
    model.setMessages(scan.messages);
    const mine = scan.messages.filter((m) => m.isMine).length;
    $('n-view').textContent = scan.messages.length;
    $('n-mine').textContent = mine;
    $('who').textContent = self.name ? `Signed in as ${self.name}` : 'Your messages, gone for good';
    renderList();
  }

  function renderList() {
    const list = $('list');
    const visible = model.visible(filterText);
    if (!visible.length) {
      list.innerHTML = filterText
        ? `<div class="sc-empty"><b>No matches</b><span>Nothing of yours contains “${esc(filterText)}”.</span></div>`
        : `<div class="sc-empty"><b>Nothing of yours in view</b><span>Scroll the conversation to load older messages, then hit rescan.</span></div>`;
    } else {
      list.innerHTML = visible
        .map((m) => {
          const sel = model.isSelected(m.id);
          const time = m.ts ? new Date(Number(m.ts) * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
          return `<label class="sc-row${sel ? ' sel' : ''}" data-id="${esc(m.id)}">
            <input type="checkbox" ${sel ? 'checked' : ''} />
            <span class="sc-row-body"><span class="sc-text">${esc(m.text) || '<i>(attachment or no text)</i>'}</span>
            <span class="sc-time">${esc(time)}</span></span></label>`;
        })
        .join('');
      list.querySelectorAll('.sc-row').forEach((rowEl) => {
        rowEl.querySelector('input').addEventListener('change', () => {
          model.toggle(rowEl.dataset.id);
          renderList();
        });
      });
    }

    const head = model.headerState(filterText);
    const all = $('all');
    all.checked = head.checked;
    all.indeterminate = head.indeterminate;
    all.disabled = busy || !visible.length;
    $('n-sel').textContent = head.count;
    const del = $('delete');
    del.disabled = busy || head.count === 0;
    del.querySelector('span').textContent = head.count ? `Delete ${plural(head.count, 'message')}` : 'Delete selected';
  }

  function lockUi(on) {
    busy = on;
    root.classList.toggle('sc-busy', on);
    $('rescan').disabled = on;
    $('filter').disabled = on;
  }

  function problemsHtml(problems) {
    return problems.length
      ? `<ul class="sc-probs">${problems.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      : '';
  }

  async function confirmAndDelete() {
    const chosen = model.selectedMessages();
    if (!chosen.length || busy) return;
    const ok = window.confirm(
      `Permanently delete ${plural(chosen.length, 'message')} of yours?\n\n` +
        `This uses Slack's own delete, so it cannot be undone.`
    );
    if (!ok) return;

    lockUi(true);
    renderList();
    let done = 0;
    let failed = 0;
    const problems = [];

    for (const m of chosen) {
      status(`Deleting ${done + 1} of ${chosen.length}…`, { done, total: chosen.length });
      let res;
      try {
        res = await UI.deleteMessage(m.node, document);
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      done += 1;
      if (res.ok) {
        model.selected.delete(m.id);
      } else {
        failed += 1;
        problems.push(`${(m.text || m.id).slice(0, 40)}: ${res.error}`);
      }
      await UI.sleep(DELETE_GAP_MS);
    }

    lockUi(false);
    rescan();
    status(
      failed
        ? `Deleted ${done - failed}, ${failed} couldn't be removed.${problemsHtml(problems)}`
        : `Deleted ${plural(done, 'message')}.`,
      { done, total: done, tone: failed ? 'warn' : 'ok' }
    );
  }

  async function autoClear() {
    if (busy) return;
    const ok = window.confirm(
      'Delete ALL of your messages in this conversation?\n\n' +
        'It starts at the newest message and scrolls up to the top, deleting only ' +
        "messages you sent. This uses Slack's own delete and cannot be undone. " +
        'You can press Stop at any time.'
    );
    if (!ok) return;

    lockUi(true);
    stopRequested = false;
    const autoBtn = $('auto');
    const stopBtn = $('stop');
    autoBtn.hidden = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    status('Starting at the newest message…');

    const result = await UI.autoClear(document, {
      shouldStop: () => stopRequested,
      onProgress: ({ total, failed, phase }) => {
        const n = total - failed;
        status(
          phase === 'scrolling'
            ? `Loading older messages… <b>${n}</b> deleted so far`
            : `Deleting… <b>${n}</b> removed${failed ? `, ${failed} failed` : ''}`
        );
      },
    });

    lockUi(false);
    autoBtn.hidden = false;
    stopBtn.hidden = true;
    rescan();

    const cleared = result.total - result.failed;
    let msg = stopRequested
      ? `Stopped. Deleted ${plural(cleared, 'message')}.`
      : `Done. Deleted ${plural(cleared, 'message')}${result.reachedTop ? ' up to the top' : ''}.`;
    if (result.failed) msg += ` ${result.failed} couldn't be removed.${problemsHtml(result.problems)}`;
    status(msg, { done: 1, total: 1, tone: result.failed ? 'warn' : 'ok' });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'slack-cleaner:toggle') toggle();
  });
})();
