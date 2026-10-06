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

  const esc = (s) =>
    (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function mount() {
    if (root) return;
    root = el(`
      <div id="slack-cleaner" class="sc-panel" role="region" aria-label="Slack Cleaner">
        <header class="sc-head">
          <strong>🧹 Slack Cleaner</strong>
          <button class="sc-x" title="Close" aria-label="Close">✕</button>
        </header>
        <div class="sc-sub" data-sc="sub"></div>
        <div class="sc-controls">
          <label class="sc-check"><input type="checkbox" data-sc="all" /> <span data-sc="count">0 selected</span></label>
          <input class="sc-filter" data-sc="filter" type="search" placeholder="Filter by text" />
          <button class="sc-btn" data-sc="rescan" title="Rescan after scrolling">Rescan</button>
        </div>
        <div class="sc-list" data-sc="list"></div>
        <footer class="sc-foot">
          <div class="sc-note" data-sc="foot"></div>
          <button class="sc-btn sc-danger" data-sc="delete" disabled>Delete selected</button>
        </footer>
      </div>`);
    document.body.appendChild(root);

    root.querySelector('.sc-x').addEventListener('click', hide);
    root.querySelector('[data-sc="rescan"]').addEventListener('click', rescan);
    root.querySelector('[data-sc="filter"]').addEventListener('input', (e) => {
      filterText = e.target.value;
      renderList();
    });
    root.querySelector('[data-sc="all"]').addEventListener('change', (e) => {
      model.setAll(model.visible(filterText).map((m) => m.id), e.target.checked);
      renderList();
    });
    root.querySelector('[data-sc="delete"]').addEventListener('click', confirmAndDelete);
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

  function rescan() {
    if (busy) return;
    const scan = UI.scanMessages(document);
    self = scan.self;
    model.setMessages(scan.messages);
    const mine = scan.messages.filter((m) => m.isMine).length;
    const who = self.name ? `you (${esc(self.name)})` : 'you';
    root.querySelector('[data-sc="sub"]').innerHTML = self.name || mine
      ? `${mine} message${mine === 1 ? '' : 's'} from ${who} in view. Scroll the conversation and Rescan to load older ones.`
      : `Couldn't tell which messages are yours. Open a conversation in Slack, then Rescan.`;
    renderList();
  }

  function renderList() {
    const list = root.querySelector('[data-sc="list"]');
    const visible = model.visible(filterText);
    if (!visible.length) {
      list.innerHTML = `<div class="sc-empty">No messages of yours ${filterText ? 'match that filter' : 'in view'}.</div>`;
    } else {
      list.innerHTML = visible
        .map((m) => {
          const sel = model.isSelected(m.id);
          const time = m.ts ? new Date(Number(m.ts) * 1000).toLocaleString() : '';
          return `<label class="sc-row${sel ? ' sel' : ''}" data-id="${esc(m.id)}">
            <input type="checkbox" ${sel ? 'checked' : ''} />
            <span class="sc-row-body"><span class="sc-time">${esc(time)}</span>
            <span class="sc-text">${esc(m.text) || '<i>(no text)</i>'}</span></span></label>`;
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
    const all = root.querySelector('[data-sc="all"]');
    all.checked = head.checked;
    all.indeterminate = head.indeterminate;
    root.querySelector('[data-sc="count"]').textContent = `${head.count} selected`;
    const del = root.querySelector('[data-sc="delete"]');
    del.disabled = busy || head.count === 0;
    del.textContent = head.count ? `Delete ${head.count} message${head.count === 1 ? '' : 's'}` : 'Delete selected';
  }

  async function confirmAndDelete() {
    const chosen = model.selectedMessages();
    if (!chosen.length || busy) return;
    const ok = window.confirm(
      `Permanently delete ${chosen.length} message${chosen.length === 1 ? '' : 's'} of yours?\n\n` +
        `This uses Slack's own delete, so it cannot be undone.`
    );
    if (!ok) return;

    busy = true;
    const foot = root.querySelector('[data-sc="foot"]');
    root.querySelector('[data-sc="delete"]').disabled = true;
    let done = 0;
    let failed = 0;
    const problems = [];

    for (const m of chosen) {
      foot.textContent = `Deleting ${done + 1} of ${chosen.length}…`;
      let res;
      try {
        res = await UI.deleteViaMenu(m.node, document);
      } catch (e) {
        res = { ok: false, error: String(e && e.message || e) };
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

    busy = false;
    rescan();
    foot.innerHTML = failed
      ? `Deleted ${done - failed}, ${failed} couldn't be removed.<br><span class="sc-prob">${esc(problems.slice(0, 5).join(' · '))}</span>`
      : `Deleted ${done} message${done === 1 ? '' : 's'}.`;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'slack-cleaner:toggle') toggle();
  });
})();
