'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const todo = require('../src/todo');

test('add assigns increasing ids and trims the title', () => {
  const items = [];
  assert.equal(todo.add(items, '  write docs ').id, 1);
  assert.equal(todo.add(items, 'ship it').id, 2);
  assert.equal(items[0].title, 'write docs');
});

test('add rejects an empty title', () => {
  assert.throws(() => todo.add([], '   '), /title is required/);
});

test('complete marks an item done and rejects unknown ids', () => {
  const items = [];
  todo.add(items, 'a');
  assert.equal(todo.complete(items, 1).done, true);
  assert.throws(() => todo.complete(items, 9), /no todo with id 9/);
});

test('format shows a checkbox, the id and the title', () => {
  const items = [];
  todo.add(items, 'a');
  todo.complete(items, 1);
  todo.add(items, 'b');
  assert.equal(todo.format(items), '[x] 1  a\n[ ] 2  b');
  assert.equal(todo.format([]), 'Nothing to do.');
});
