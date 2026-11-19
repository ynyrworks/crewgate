'use strict';

// Tiny argparse-like parser shared by all command modules: positionals in order (optional ones
// may be left out), --opt value / --opt=value anywhere, "--" ends options.
const { UsageError } = require('./errors');

const NEG = /^-\d+(\.\d*)?$|^-\.\d+$/;
const INT = /^\s*[+-]?\d+\s*$/;

function toInt(v, what) {
  if (!INT.test(v)) throw new UsageError('args.notInt', { what, value: v });
  return parseInt(v, 10);
}

// A word with whitespace in it (before an "=" of a --name=value) is text, never an option.
function looksLikeOption(a) {
  if (!a.startsWith('-') || a.length < 2 || NEG.test(a)) return false;
  const eq = a.indexOf('=');
  return !/\s/.test(a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a);
}

// A single-dash word that no option of the command names, where the next positional slot is free text.
function isFreeText(a, options, spec, filled) {
  const p = (spec.positionals || [])[filled];
  return !!(p && p.text) && !a.startsWith('--') && !namesOption(a, options);
}

const GLOBALS = ['--json', '--project', '--lang', '--help', '--version'];
function namesOption(w, options) {
  const eq = w.startsWith('--') ? w.indexOf('=') : -1;
  const n = eq > 0 ? w.slice(0, eq) : w;
  return GLOBALS.includes(n) || Object.prototype.hasOwnProperty.call(options, n);
}

// spec: {
//   positionals: [{ name, optional?, int?, choices?, text? }],   (text: free text; while this slot is the next one open, a single-dash word such as -x
//     that is not a declared option is the value, not an unknown option; a --word still is one, pass it after "--")
//   options: { '--name': { dest, int?, choices?, default?, flag?, multi? } }   (multi: repeatable, collects an array)
//   rest?: name   (collect all extra positionals into an array under this name)
// }
// -> object keyed by positional name / option dest. Throws UsageError.
function parse(argv, spec) {
  const out = {};
  const options = spec.options || {};
  for (const o of Object.values(options)) if ('default' in o) out[o.dest] = o.default;
  const pos = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!rest && a === '--') { rest = true; continue; }
    if (!rest && looksLikeOption(a) && !isFreeText(a, options, spec, pos.length)) {
      let name = a;
      let value;
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) { name = a.slice(0, eq); value = a.slice(eq + 1); }
      const o = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : null;
      if (!o) throw new UsageError('args.unknownOption', { name });
      if (o.flag) {
        if (value !== undefined) throw new UsageError('args.noValue', { name });
        out[o.dest] = true;
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        // a value may start with "-" unless it names an option of this command or a global option (or is "--"),
        // also as --known=...
        if (next === undefined || next === '--' || namesOption(next, options)) throw new UsageError('args.needsValue', { name });
        value = next;
        i++;
      }
      if (o.choices && !o.choices.includes(value)) throw new UsageError('args.badChoice', { name, choices: o.choices.join(', ') });
      const v = o.int ? toInt(value, name) : value;
      if (o.multi) (out[o.dest] = out[o.dest] || []).push(v);
      else out[o.dest] = v;
    } else {
      pos.push(a);
    }
  }
  const ps = spec.positionals || [];
  if (pos.length > ps.length && !spec.rest) throw new UsageError('args.extra', { args: pos.slice(ps.length).join(' ') });
  ps.forEach((p, i) => {
    if (i >= pos.length) {
      if (!p.optional) throw new UsageError('args.missing', { name: p.name });
      return;
    }
    const v = pos[i];
    if (p.choices && !p.choices.includes(v)) throw new UsageError('args.badChoice', { name: p.name, choices: p.choices.join(', ') });
    out[p.name] = p.int ? toInt(v, p.name) : v;
  });
  if (spec.rest) out[spec.rest] = pos.slice(ps.length);
  return out;
}

module.exports = { parse, UsageError };
