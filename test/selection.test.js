const { test } = require('node:test');
const assert = require('node:assert');
const { SelectionModel, onlyMine } = require('../extension/selection');

const msgs = [
  { id: 'a', isMine: true, text: 'hello world' },
  { id: 'b', isMine: false, text: 'not mine' },
  { id: 'c', isMine: true, text: 'another HELLO' },
  { id: 'd', isMine: true, text: 'goodbye' },
];

test('onlyMine keeps just the user\'s messages', () => {
  assert.deepStrictEqual(onlyMine(msgs).map((m) => m.id), ['a', 'c', 'd']);
});

test('visible applies the text filter case-insensitively, mine only', () => {
  const m = new SelectionModel(msgs);
  assert.deepStrictEqual(m.visible('').map((x) => x.id), ['a', 'c', 'd']);
  assert.deepStrictEqual(m.visible('hello').map((x) => x.id), ['a', 'c']);
  assert.deepStrictEqual(m.visible('not mine').map((x) => x.id), []); // b is not mine
});

test('toggle and selectedMessages preserve order', () => {
  const m = new SelectionModel(msgs);
  m.toggle('d');
  m.toggle('a');
  assert.deepStrictEqual(m.selectedMessages().map((x) => x.id), ['a', 'd']);
  assert.strictEqual(m.toggle('d'), false); // toggled back off
  assert.deepStrictEqual(m.selectedMessages().map((x) => x.id), ['a']);
});

test('setAll respects the current filter', () => {
  const m = new SelectionModel(msgs);
  m.setAll(m.visible('hello').map((x) => x.id), true);
  assert.deepStrictEqual([...m.selected].sort(), ['a', 'c']);
});

test('header checkbox reflects partial and full selection', () => {
  const m = new SelectionModel(msgs);
  assert.deepStrictEqual(m.headerState(''), { checked: false, indeterminate: false, count: 0 });
  m.toggle('a');
  assert.deepStrictEqual(m.headerState(''), { checked: false, indeterminate: true, count: 1 });
  m.setAll(['a', 'c', 'd'], true);
  assert.deepStrictEqual(m.headerState(''), { checked: true, indeterminate: false, count: 3 });
});

test('rescan drops selections for messages that disappeared', () => {
  const m = new SelectionModel(msgs);
  m.setAll(['a', 'c'], true);
  m.setMessages([{ id: 'a', isMine: true, text: 'hello world' }]);
  assert.deepStrictEqual([...m.selected], ['a']);
});
