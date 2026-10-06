// Pure selection logic, kept free of any DOM access so it can be unit-tested.

/** A message as the panel sees it. `node` is the Slack DOM row, when scanned from a page. */
export interface Message {
  id: string;
  isMine: boolean | null;
  text: string;
  author?: string | null;
  authorId?: string;
  ts?: string;
  node?: Element;
}

export interface HeaderState {
  checked: boolean;
  indeterminate: boolean;
  count: number;
}

export function onlyMine<M extends Message>(messages: M[]): M[] {
  return messages.filter((m) => m.isMine);
}

export class SelectionModel<M extends Message = Message> {
  messages: M[] = [];
  selected = new Set<string>();

  constructor(messages: M[] = []) {
    this.setMessages(messages);
  }

  setMessages(messages: M[]): this {
    this.messages = messages;
    // Drop selections for messages that are gone after a rescan.
    const ids = new Set(messages.map((m) => m.id));
    this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
    return this;
  }

  // Messages shown in the panel: the user's own, optionally narrowed by text.
  visible(filterText = ''): M[] {
    const q = filterText.trim().toLowerCase();
    return onlyMine(this.messages).filter((m) => !q || (m.text || '').toLowerCase().includes(q));
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  toggle(id: string): boolean {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    return this.isSelected(id);
  }

  setAll(ids: string[], on: boolean): void {
    for (const id of ids) {
      if (on) this.selected.add(id);
      else this.selected.delete(id);
    }
  }

  clear(): void {
    this.selected.clear();
  }

  selectedMessages(): M[] {
    // Preserve on-screen order and skip anything no longer present.
    return this.messages.filter((m) => this.selected.has(m.id));
  }

  // How a "select all" checkbox should look for the currently visible rows.
  headerState(filterText = ''): HeaderState {
    const vis = this.visible(filterText);
    const n = vis.filter((m) => this.selected.has(m.id)).length;
    const count = this.selected.size;
    if (vis.length === 0 || n === 0) return { checked: false, indeterminate: false, count };
    if (n === vis.length) return { checked: true, indeterminate: false, count };
    return { checked: false, indeterminate: true, count };
  }
}
