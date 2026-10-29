'use strict';

// Guesses a project's test commands from the files in its root, so `checks` is not left empty.
// Only looks at the top-level folder and reads at most a few small files; never runs anything.
const fs = require('fs');
const path = require('path');

const MAX_READ = 256 * 1024;

function read(root, name) {
  try {
    const f = path.join(root, name);
    if (!fs.statSync(f).isFile()) return null;
    return fs.readFileSync(f, 'utf8').slice(0, MAX_READ);
  } catch { return null; }
}

const exists = (root, name) => read(root, name) !== null;

// -> [command] in a stable order (package.json, go, python, rust, dotnet, make); [] when nothing is recognised.
function detectChecks(root) {
  const out = [];
  const pkg = read(root, 'package.json');
  if (pkg !== null) {
    try {
      const test = JSON.parse(pkg).scripts && JSON.parse(pkg).scripts.test;
      // `npm init` leaves a placeholder that always fails
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) out.push('npm test');
    } catch { /* unreadable package.json */ }
  }
  if (exists(root, 'go.mod')) out.push('go test ./...', 'go vet ./...');
  const pyproject = read(root, 'pyproject.toml');
  if ((pyproject !== null && /pytest/i.test(pyproject)) || exists(root, 'pytest.ini') || exists(root, 'conftest.py')) out.push('pytest');
  if (exists(root, 'Cargo.toml')) out.push('cargo test');
  let names = [];
  try { names = fs.readdirSync(root); } catch { /* unreadable root */ }
  if (names.some((n) => /\.(csproj|sln)$/i.test(n))) out.push('dotnet test');
  const make = read(root, 'Makefile') || read(root, 'makefile');
  if (make !== null && /^test[ \t]*:/m.test(make)) out.push('make test');
  return out;
}

module.exports = { detectChecks };
