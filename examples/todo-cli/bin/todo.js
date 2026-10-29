#!/usr/bin/env node
'use strict';

// Usage: todo add "write docs" | todo done 1 | todo list
const path = require('path');
const todo = require('../src/todo');

const FILE = process.env.TODO_FILE || path.join(process.cwd(), 'todos.json');
const [cmd, arg] = process.argv.slice(2);
const items = todo.load(FILE);

try {
  if (cmd === 'add') {
    console.log(`added #${todo.add(items, arg).id}`);
    todo.save(FILE, items);
  } else if (cmd === 'done') {
    console.log(`completed #${todo.complete(items, Number(arg)).id}`);
    todo.save(FILE, items);
  } else if (cmd === 'list' || cmd === undefined) {
    console.log(todo.format(items));
  } else {
    console.error('usage: todo add "title" | todo done <id> | todo list');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
