'use strict';

// A tiny todo list kept in a JSON file. Fictional example code for crewgate.
const fs = require('fs');

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(file, items) {
  fs.writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`);
}

function add(items, title) {
  const text = String(title || '').trim();
  if (!text) throw new Error('title is required');
  const next = items.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  const item = { id: next, title: text, done: false };
  items.push(item);
  return item;
}

function complete(items, id) {
  const item = items.find((t) => t.id === id);
  if (!item) throw new Error(`no todo with id ${id}`);
  item.done = true;
  return item;
}

function format(items) {
  if (!items.length) return 'Nothing to do.';
  return items.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.id}  ${t.title}`).join('\n');
}

module.exports = { load, save, add, complete, format };
