// Pure selection logic, kept free of any DOM access so it can be unit-tested.
// Loaded as a plain script in the extension (attaches to window) and required
// directly in tests.
(function (root) {
  // A scanned message is { id, author, authorId, isMine, text, ts, node? }.

  function onlyMine(messages) {
    return messages.filter((m) => m.isMine);
  }

  class SelectionModel {
    constructor(messages = []) {
      this.setMessages(messages);
    }

    setMessages(messages) {
      this.messages = messages;
      // Drop selections for messages that are gone after a rescan.
      const ids = new Set(messages.map((m) => m.id));
      this.selected = new Set([...(this.selected || [])].filter((id) => ids.has(id)));
      return this;
    }

    // Messages shown in the panel: the user's own, optionally narrowed by text.
    visible(filterText = '') {
      const q = filterText.trim().toLowerCase();
      return onlyMine(this.messages).filter((m) => !q || (m.text || '').toLowerCase().includes(q));
    }

    isSelected(id) {
      return this.selected.has(id);
    }

    toggle(id) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      return this.isSelected(id);
    }

    setAll(ids, on) {
      for (const id of ids) {
        if (on) this.selected.add(id);
        else this.selected.delete(id);
      }
    }

    clear() {
      this.selected.clear();
    }

    selectedMessages() {
      // Preserve on-screen order and skip anything no longer present.
      return this.messages.filter((m) => this.selected.has(m.id));
    }

    // How a "select all" checkbox should look for the currently visible rows.
    headerState(filterText = '') {
      const vis = this.visible(filterText);
      const n = vis.filter((m) => this.selected.has(m.id)).length;
      if (vis.length === 0) return { checked: false, indeterminate: false, count: this.selected.size };
      if (n === 0) return { checked: false, indeterminate: false, count: this.selected.size };
      if (n === vis.length) return { checked: true, indeterminate: false, count: this.selected.size };
      return { checked: false, indeterminate: true, count: this.selected.size };
    }
  }

  const api = { SelectionModel, onlyMine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SlackCleanerSelection = api;
})(typeof window !== 'undefined' ? window : null);
