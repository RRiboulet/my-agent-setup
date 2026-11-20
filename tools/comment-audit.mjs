#!/usr/bin/env node
/**
 * comment-audit — a read-only comment inventory, stratified sample and recount
 * for ticket 06 ("the comment question has an evidence-backed answer"), R13 of
 * docs/specs/2026-11-19-prevent-recurrence.md.
 *
 * It answers one question mechanically: what is the population of comments in
 * the two projects, and what fraction of a fixed-seed stratified sample is
 * *workaround justification* (below 20% ⇒ no comment skill is added).
 *
 * Design rules, all of them deliberate:
 *
 *  1. Read-only. The only git command run against a target is `git ls-files`;
 *     files are opened for reading and never written. No git write command, no
 *     network, no dependency outside the Node standard library.
 *  2. The inventory is derived from `git ls-files`, so an untracked or vendored
 *     tree cannot leak in by being on disk. Excludes are explicit below.
 *  3. Strata are assigned mechanically from file *text*, never by reading the
 *     comment for meaning: S = suppression-adjacent, T = timer/retry/async
 *     adjacent, O = ordinary. Both windows are ±3 lines.
 *  4. The sample is drawn with a published seed and a documented PRNG, from
 *     units sorted by ID, so re-running this file anywhere reproduces the same
 *     IDs and the same draw. No unit was re-drawn after being read.
 *  5. Classification labels live in `tools/comment-audit-labels.json`, keyed by
 *     unit ID and pinned to the unit's text hash. This script joins them, so the
 *     counts in docs/experiments/comment-audit.md can be recounted without
 *     trusting the prose, and a comment edited after labelling is reported as a
 *     mismatch instead of silently changing the counts.
 *
 * Usage:
 *   node tools/comment-audit.mjs                    # inventory + strata + sample + counts
 *   node tools/comment-audit.mjs --context 4        # ...plus 4 lines of source around each sampled unit
 *   node tools/comment-audit.mjs --sample-only      # just the draw, for labelling
 *   node tools/comment-audit.mjs --json             # the same data, machine-readable
 *   node tools/comment-audit.mjs --pupkeep=/path --analytics=/path
 *
 * Roots default to /home/ubuntu/pupkeep and /home/ubuntu/analytics-agent (where
 * this audit was run) and can be overridden by --pupkeep/--analytics or by
 * COMMENT_AUDIT_PUPKEEP / COMMENT_AUDIT_ANALYTICS.
 *
 * Exit codes: 0 ok; 1 the label file disagrees with the inventory (missing
 * label, stale text hash, unknown ID); 2 usage error or a target root that is
 * not a git checkout.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(HERE, 'comment-audit-labels.json');

// ---------------------------------------------------------------------------
// Scope. One table, so the report's file counts are the numbers this code
// computes. Paths are relative to each root and match `git ls-files` output.
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    key: 'pupkeep',
    label: 'pupkeep',
    idPrefix: 'PU',
    seed: 'comment-audit-v1-pupkeep',
    root: process.env.COMMENT_AUDIT_PUPKEEP || '/home/ubuntu/pupkeep',
    extensions: ['.ts', '.js', '.mjs', '.sh', '.css'],
  },
  {
    key: 'analytics',
    label: 'analytics-agent',
    idPrefix: 'AA',
    seed: 'comment-audit-v1-analytics',
    root: process.env.COMMENT_AUDIT_ANALYTICS || '/home/ubuntu/analytics-agent',
    extensions: ['.py', '.sql', '.sh'],
  },
];

// Vendored third-party code is not ours to comment on. `web/vendor/*.mjs` is
// minified preact/htm, pinned and hash-checked by test/vendor.test.ts; counting
// its three comments would put library prose in the population.
const EXCLUDES = [
  /(^|\/)node_modules\//,
  /(^|\/)web\/vendor\//,
  /(^|\/)\.venv\//,
  /(^|\/)evaluation_results\//,
  /(^|\/)\.worktrees/,
  /(^|\/)\.pi\/git\//,
];

// A suppression directive, as R8 and the ticket name them. One pattern does
// both jobs in this audit: counting directive lines and marking units S.
const DIRECTIVE_RE =
  /(?:\bnoqa\b|\beslint-disable(?:-next-line|-line)?\b|@ts-ignore\b|@ts-expect-error\b|@ts-nocheck\b|\btype:\s*ignore\b|\bpylint:\s*disable\b|\bflake8:\s*noqa\b|prettier-ignore)/;

// The T stratum's keyword set. Adopted verbatim from the draft audit, which
// fixed it before sampling: keeping it unchanged keeps these strata comparable
// with that draft, and the report says so. Case-insensitive; a trailing `*` in
// the draft's prose list means "starts with" here.
const TIMER_RE = new RegExp(
  [
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'sleep',
    'delay',
    'retry',
    'retries',
    'backoff',
    'await',
    'async',
    'promise',
    'abortsignal',
    'abortcontroller',
    'schedul',
    'deadline',
    'timeout',
    'timer',
    'thrott',
    'poll',
    'asyncio',
    'threadpoolexecutor',
    'set_alarm',
    'recurring',
    'interval',
  ].join('|'),
  'i',
);

const STRATA = ['S', 'T', 'O'];
const STRATUM_NAMES = {
  S: 'suppression-adjacent',
  T: 'timer/retry/async-adjacent',
  O: 'ordinary',
};
const WINDOW = 3; // ±3 lines, for both S and T adjacency
const QUOTA = { S: 10, T: 10, O: 10 };
// If a stratum cannot fill its quota, the shortfall goes here, in this order.
// pupkeep has no suppressions at all, so its S quota lands on O — the rule the
// draft audit used, kept so the two designs are comparable.
const QUOTA_OVERFLOW_ORDER = ['O', 'T', 'S'];

const CLASSES = ['I', 'E', 'WJ', 'N'];
const CLASS_NAMES = {
  I: 'invariant',
  E: 'external quirk',
  WJ: 'workaround justification',
  N: 'narration',
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { context: 0, json: false, sampleOnly: false, roots: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sample-only') opts.sampleOnly = true;
    else if (a === '--context') opts.context = Number(argv[++i]);
    else if (a.startsWith('--context=')) opts.context = Number(a.slice(10));
    else if (a.startsWith('--pupkeep=')) opts.roots.pupkeep = a.slice(10);
    else if (a.startsWith('--analytics=')) opts.roots.analytics = a.slice(12);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
      process.exit(0);
    } else {
      process.stderr.write(`comment-audit: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.context) || opts.context < 0) {
    process.stderr.write('comment-audit: --context takes a non-negative integer\n');
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Lexer helpers. Every scanner tracks only an offset; line numbers come from a
// precomputed table, so a scanner cannot drift by miscounting a newline.
// ---------------------------------------------------------------------------

function lineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function onlyWhitespaceBefore(text, i) {
  const start = text.lastIndexOf('\n', i - 1) + 1;
  for (let k = start; k < i; k++) {
    const c = text[k];
    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\f' && c !== '\v') return false;
  }
  return true;
}

function blankComments(text, spans) {
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const { start, end } of spans) {
    for (let k = start; k < end; k++) if (chars[k] !== '\n') chars[k] = ' ';
  }
  return chars.join('');
}

/** Records a comment. `i` is the marker start, `j` the exclusive end, so the
 *  text is everything after `markerLength`. */
function makeCommentSink(text) {
  const lineOf = lineLookup(text);
  const comments = [];
  const spans = [];
  return {
    comments,
    spans,
    push(i, j, markerLength, kind) {
      const startLine = lineOf(i);
      const endLine = lineOf(Math.max(i, j - 1));
      const ownLine = onlyWhitespaceBefore(text, i);
      // Strip an inherited CR owned by a CRLF checkout, so text hashes (and
      // therefore labels) do not depend on how the tree was checked out.
      const body = text.slice(i + markerLength, j).replace(/\r$/, '');
      comments.push({ startLine, endLine, kind, ownLine, start: i, end: j, text: body });
      spans.push({ start: i, end: j });
      return comments[comments.length - 1];
    },
  };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript / ESM: `//`, `/* *\/`, quoted strings, template
// literals with `${…}` nesting, and regex literals.
// ---------------------------------------------------------------------------

function scanJs(text) {
  const sink = makeCommentSink(text);
  const n = text.length;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const regexPunct = new Set('(,=:[!&|?{};+-*%~^<>'.split(''));
  const regexWords = new Set(
    'return typeof case do else in of new delete void throw instanceof yield await'.split(' '),
  );
  let i = 0;
  let prevSig = ''; // last significant char outside comments and strings
  let prevWord = '';

  function skipTemplateExpr(from) {
    let j = from;
    let depth = 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      // A `${…}` holds ordinary code, comments included: web/ templates put
      // explanatory `//` blocks inside these interpolations.
      if (c === '/' && text[j + 1] === '/') {
        let k = j + 2;
        while (k < n && text[k] !== '\n') k++;
        sink.push(j, k, 2, 'line');
        j = k;
        continue;
      }
      if (c === '/' && text[j + 1] === '*') {
        let k = j + 2;
        while (k < n && !(text[k] === '*' && text[k + 1] === '/')) k++;
        const end = Math.min(k + 2, n);
        sink.push(j, end, 2, 'block');
        j = end;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        j = skipString(j, c);
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return j;
  }

  function skipString(from, quote) {
    let j = from + 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') {
        // Unterminated single/double-quoted string: stop at the newline rather
        // than swallowing the rest of the file. Template literals may span.
        j++;
        if (quote !== '`') return j;
        continue;
      }
      if (c === quote) return j + 1;
      if (quote === '`' && c === '$' && text[j + 1] === '{') {
        j = skipTemplateExpr(j + 2);
        continue;
      }
      j++;
    }
    return j;
  }

  function skipRegex(from) {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return j;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++;
        return j;
      }
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j++;
      sink.push(i, j, 2, 'line');
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      const end = Math.min(j + 2, n);
      sink.push(i, end, 2, 'block');
      i = end;
      continue;
    }
    if (c === '/' && (prevSig === '' || regexPunct.has(prevSig) || regexWords.has(prevWord))) {
      i = skipRegex(i);
      prevSig = ')';
      prevWord = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(i, c);
      prevSig = c;
      prevWord = '';
      continue;
    }
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(text[j])) j++;
      prevWord = text.slice(i, j);
      prevSig = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = '';
    }
    i++;
  }
  return { comments: sink.comments, spans: sink.spans, codeText: blankComments(text, sink.spans) };
}

// ---------------------------------------------------------------------------
// CSS: `/* … *\/`, with quoted strings skipped.
// ---------------------------------------------------------------------------

function scanCss(text) {
  const sink = makeCommentSink(text);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      const end = Math.min(j + 2, n);
      sink.push(i, end, 2, 'block');
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return { comments: sink.comments, spans: sink.spans, codeText: blankComments(text, sink.spans) };
}

// ---------------------------------------------------------------------------
// POSIX shell: `#` comments (only at the start of a word), quoting, and
// heredocs, whose bodies are generated data rather than comments.
// ---------------------------------------------------------------------------

function scanShell(text) {
  const sink = makeCommentSink(text);
  const n = text.length;
  let i = 0;
  let wordStart = true;
  const heredocs = []; // pending delimiters, oldest first

  const skipHeredocBody = (from) => {
    const delim = heredocs.shift();
    let j = from;
    while (j < n) {
      let e = text.indexOf('\n', j);
      if (e === -1) e = n;
      const body = text.slice(j, e).replace(/\r$/, '');
      const candidate = delim.stripTabs ? body.replace(/^\t+/, '') : body;
      j = Math.min(e + 1, n);
      if (candidate === delim.text) break;
    }
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      i++;
      // A heredoc's body begins on the line after the `<<DELIM` line.
      if (heredocs.length > 0) i = skipHeredocBody(i);
      wordStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      wordStart = true;
      i++;
      continue;
    }
    if (c === '#' && wordStart) {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      sink.push(i, j, 1, 'line');
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== "'") j++;
      i = j + 1;
      wordStart = false;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      wordStart = false;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (text[j] === '-') {
        stripTabs = true;
        j++;
      }
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
      let delim = '';
      if (text[j] === '"' || text[j] === "'") {
        const q = text[j++];
        while (j < n && text[j] !== q) delim += text[j++];
        j++;
      } else {
        while (j < n && /[A-Za-z0-9_@.]/.test(text[j])) delim += text[j++];
      }
      if (delim) heredocs.push({ text: delim, stripTabs });
      i = j;
      wordStart = false;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      wordStart = true;
      i++;
      continue;
    }
    wordStart = false;
    i++;
  }
  return { comments: sink.comments, spans: sink.spans, codeText: blankComments(text, sink.spans) };
}

// ---------------------------------------------------------------------------
// Python: `#` comments, docstrings as prose, f-string brace nesting.
//
// A "docstring" here is a string expression statement that begins a logical
// line at bracket depth 0, immediately after the start of file, a `:` or a `;`.
// That is the mechanical shape of a module/class/function docstring; it is
// cross-checked against `ast.get_docstring` in the report's method section.
// ---------------------------------------------------------------------------

function scanPython(text) {
  const sink = makeCommentSink(text);
  const n = text.length;
  const docstrings = [];
  let i = 0;
  let prevSig = '';
  let depth = 0;

  function skipFExpr(from) {
    let j = from;
    let d = 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        j = skipPyString(j, c, text.startsWith(c.repeat(3), j) ? 3 : 1, false);
        continue;
      }
      if (c === '{') d++;
      else if (c === '}') {
        d--;
        if (d === 0) return j + 1;
      }
      j++;
    }
    return j;
  }

  function skipPyString(from, quote, quoteLen, fstring) {
    let j = from + quoteLen;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (quoteLen === 3) {
        if (c === quote && text.startsWith(quote.repeat(3), j)) return j + 3;
        j++;
        continue;
      }
      if (c === '\n') return j + 1; // unterminated single-line string
      if (c === quote) return j + 1;
      if (fstring && (c === '{' || c === '}')) {
        if (text[j + 1] === c) {
          j += 2;
          continue;
        }
        if (c === '{') {
          j = skipFExpr(j + 1);
          continue;
        }
      }
      j++;
    }
    return j;
  }

  while (i < n) {
    const c = text[i];
    if (c === '#') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      sink.push(i, j, 1, 'line');
      i = j;
      continue;
    }
    // Optional string prefix (r, b, u, f, rb, br, fr, rf, any case), then a quote.
    const m = /^([rRbBuUfF]{1,2})?('''|"""|'|")/.exec(text.slice(i, i + 5));
    if (m) {
      const quoteSeq = m[2];
      const prefixLen = m[1] ? m[1].length : 0;
      const quote = quoteSeq[0];
      const quoteLen = quoteSeq.length;
      const fstring = /[fF]/.test(m[1] || '');
      const startLine = sinkLineOf(text, i);
      const statementStart =
        onlyWhitespaceBefore(text, i) && depth === 0 && (prevSig === '' || prevSig === ':' || prevSig === ';');
      const bodyStart = i + prefixLen + quoteLen;
      const end = skipPyString(i + prefixLen, quote, quoteLen, fstring);
      if (statementStart) {
        docstrings.push({
          startLine,
          endLine: sinkLineOf(text, Math.max(i, end - 1)),
          start: i,
          end,
          text: text.slice(bodyStart, Math.max(bodyStart, end - quoteLen)),
        });
      }
      i = end;
      prevSig = quote;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      prevSig = c;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      prevSig = c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return {
    comments: sink.comments,
    spans: sink.spans,
    docstrings,
    codeText: blankComments(text, sink.spans),
  };
}

const lineOfCache = new Map();
function sinkLineOf(text, pos) {
  let f = lineOfCache.get(text);
  if (!f) {
    f = lineLookup(text);
    lineOfCache.set(text, f);
  }
  return f(pos);
}

// ---------------------------------------------------------------------------
// SQL: `--` line comments, `/* … *\/`, `'…'` with `''` doubling.
// ---------------------------------------------------------------------------

function scanSql(text) {
  const sink = makeCommentSink(text);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      sink.push(i, j, 2, 'line');
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      const end = Math.min(j + 2, n);
      sink.push(i, end, 2, 'block');
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === q) {
          if (text[j + 1] === q) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return { comments: sink.comments, spans: sink.spans, codeText: blankComments(text, sink.spans) };
}

const LANG_BY_EXT = {
  '.ts': 'js',
  '.js': 'js',
  '.mjs': 'js',
  '.css': 'css',
  '.sh': 'sh',
  '.py': 'py',
  '.sql': 'sql',
};

function scanFile(text, lang) {
  switch (lang) {
    case 'js':
      return scanJs(text);
    case 'css':
      return scanCss(text);
    case 'sh':
      return scanShell(text);
    case 'py':
      return scanPython(text);
    case 'sql':
      return scanSql(text);
    default:
      throw new Error(`no lexer for ${lang}`);
  }
}

// ---------------------------------------------------------------------------
// Units. A unit is one contiguous run of same-marker full-line comments, one
// block comment, one docstring, or one trailing comment on a code line.
//
// Trailing comments never merge with anything: `a(); // x` and `b(); // y` are
// two annotations on two statements, and merging them would fuse a run of
// per-line `# type: ignore`s into one giant unit — exactly the stratum this
// audit needs to see one directive at a time.
// ---------------------------------------------------------------------------

function buildUnits(relPath, text, lang) {
  const scan = scanFile(text, lang);
  const tokens = scan.comments.slice().sort((a, b) => a.start - b.start);
  const units = [];

  for (const tok of tokens) {
    const last = units[units.length - 1];
    const mergeable =
      tok.kind === 'line' &&
      tok.ownLine &&
      last !== undefined &&
      last.kind === 'line' &&
      last.ownLine &&
      last.endLine + 1 === tok.startLine;
    if (mergeable) {
      last.endLine = tok.endLine;
      last.text += '\n' + tok.text;
      continue;
    }
    units.push({
      file: relPath,
      startLine: tok.startLine,
      endLine: tok.endLine,
      kind: tok.kind,
      ownLine: tok.ownLine,
      text: tok.text,
    });
  }
  for (const doc of scan.docstrings || []) {
    units.push({
      file: relPath,
      startLine: doc.startLine,
      endLine: doc.endLine,
      kind: 'docstring',
      ownLine: true,
      text: doc.text,
    });
  }
  units.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return { units, scan };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function gitLsFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\0').filter(Boolean);
  } catch (err) {
    process.stderr.write(`comment-audit: ${root} is not a readable git checkout (${String(err.message).split('\n')[0]})\n`);
    process.exit(2);
  }
  return [];
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

const codeLineCache = new Map();

function inventory(project) {
  const root = resolve(project.root);
  if (!existsSync(root)) {
    process.stderr.write(`comment-audit: target root does not exist: ${root}\n`);
    process.exit(2);
  }
  const all = gitLsFiles(root);
  const inScope = all
    .filter((rel) => project.extensions.includes(rel.slice(rel.lastIndexOf('.'))))
    .filter((rel) => !EXCLUDES.some((re) => re.test(rel)))
    .sort();

  const files = [];
  const units = [];
  const directiveLines = [];
  const directoryCounts = new Map();
  const scanByFile = new Map();

  for (const rel of inScope) {
    const text = readFileSync(join(root, rel), 'utf8');
    const lang = LANG_BY_EXT[rel.slice(rel.lastIndexOf('.'))];
    const { units: fileUnits, scan } = buildUnits(rel, text, lang);
    files.push({ path: rel, units: fileUnits.length });
    scanByFile.set(rel, scan);
    codeLineCache.set(`${root}\0${rel}`, scan.codeText.split('\n'));
    const top = rel.includes('/') ? rel.split('/')[0] + '/' : '(root)';
    directoryCounts.set(top, (directoryCounts.get(top) || 0) + 1);
    for (const u of fileUnits) {
      u.id = `${project.idPrefix}-${sha256(`${rel}:${u.startLine}`).slice(0, 8)}`;
      u.textSha = sha256(u.text);
      u.lang = lang;
      units.push(u);
    }
    for (const tok of scan.comments) {
      if (DIRECTIVE_RE.test(tok.text)) {
        directiveLines.push({ file: rel, line: tok.startLine, text: tok.text.trim() });
      }
    }
  }

  const directiveByFile = new Map();
  for (const d of directiveLines) {
    if (!directiveByFile.has(d.file)) directiveByFile.set(d.file, []);
    directiveByFile.get(d.file).push(d.line);
  }

  for (const u of units) {
    const dirLines = (directiveByFile.get(u.file) || []).filter(
      (ln) => ln >= u.startLine - WINDOW && ln <= u.endLine + WINDOW,
    );
    if (DIRECTIVE_RE.test(u.text) || dirLines.length > 0) {
      u.stratum = 'S';
      continue;
    }
    const codeLines = codeLineCache.get(`${root}\0${u.file}`) || [];
    let timer = false;
    const from = Math.max(1, u.startLine - WINDOW);
    const to = Math.min(codeLines.length, u.endLine + WINDOW);
    for (let ln = from; ln <= to; ln++) {
      if (TIMER_RE.test(codeLines[ln - 1])) {
        timer = true;
        break;
      }
    }
    u.stratum = timer ? 'T' : 'O';
  }

  return { root, all: all.length, inScope, files, units, directiveLines, directoryCounts, scanByFile };
}

// ---------------------------------------------------------------------------
// Sampling. sfc32 seeded from a published string, units sorted by ID, then a
// Fisher–Yates shuffle: reproducible in any JS engine, no dependency.
// ---------------------------------------------------------------------------

function seededRng(seed) {
  const h = createHash('sha256').update(seed).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  return function next() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

function shuffled(list, rng) {
  const order = list.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

function draw(units, seed) {
  const pools = { S: [], T: [], O: [] };
  for (const u of units) pools[u.stratum].push(u);
  for (const k of STRATA) pools[k].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const rng = seededRng(seed);
  const chosen = [];
  const used = new Set();
  const taken = { S: 0, T: 0, O: 0 };
  const remaining = { ...QUOTA };
  const reassigned = {};

  // Draw each stratum's quota first, in a fixed stratum order, so the PRNG
  // stream consumed by one stratum does not depend on another's pool size.
  for (const k of STRATA) {
    const want = Math.min(QUOTA[k], pools[k].length);
    for (const u of shuffled(pools[k], rng).slice(0, want)) {
      chosen.push(u);
      used.add(u.id);
      taken[k]++;
    }
    remaining[k] = QUOTA[k] - want;
  }

  // A shortfall goes down QUOTA_OVERFLOW_ORDER. That is how an empty S pool
  // becomes 20 ordinary units in pupkeep instead of 10. Reported, never silent.
  for (const k of STRATA) {
    while (remaining[k] > 0) {
      const to = QUOTA_OVERFLOW_ORDER.find((c) => c !== k && pools[c].some((u) => !used.has(u.id)));
      if (to === undefined) break;
      const next = shuffled(
        pools[to].filter((u) => !used.has(u.id)),
        rng,
      )[0];
      chosen.push(next);
      used.add(next.id);
      taken[to]++;
      reassigned[k] = (reassigned[k] || 0) + 1;
      remaining[k]--;
    }
  }

  chosen.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { pools, chosen, taken, remaining, reassigned };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function loadLabels() {
  if (!existsSync(LABELS_PATH)) return { present: false, units: {} };
  const raw = JSON.parse(readFileSync(LABELS_PATH, 'utf8'));
  return { present: true, units: raw.units || {}, meta: raw };
}

function joinLabels(sample, labels, prefix) {
  const problems = [];
  const byId = new Map(sample.chosen.map((u) => [u.id, u]));
  // One labels file serves both projects; a project only owns its own prefix.
  const own = Object.entries(labels.units).filter(([id]) => id.startsWith(`${prefix}-`));
  if (labels.present) {
    for (const [id, entry] of own) {
      if (!byId.has(id)) problems.push(`label for ${id} is not in the draw (stale sample?)`);
      else if (!CLASSES.includes(entry.class)) problems.push(`label for ${id} has unknown class ${entry.class}`);
      else if (entry.textSha !== byId.get(id).textSha) {
        problems.push(`label for ${id} is pinned to different comment text (${byId.get(id).file}:${byId.get(id).startLine})`);
      }
    }
    for (const u of sample.chosen) {
      if (!labels.units[u.id]) problems.push(`sampled unit ${u.id} (${u.file}:${u.startLine}) has no label`);
    }
  }
  for (const u of sample.chosen) {
    const entry = labels.units[u.id];
    u.class = entry && CLASSES.includes(entry.class) ? entry.class : null;
    u.why = entry ? entry.why || '' : '';
  }
  return problems;
}
// ---------------------------------------------------------------------------
// Redaction. Sampled comment text is quoted in the report, so anything that
// looks like a credential is masked before it can be printed. Nothing in these
// two projects' comments should match; the check is here so that "no secrets
// were found" is a computed statement rather than a hope.
// ---------------------------------------------------------------------------

const SECRET_RE = /(?:\b[A-Za-z0-9_+/=-]{24,}\b|-----BEGIN [A-Z ]+-----|(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+)/gi;

function redact(s) {
  return s.replace(SECRET_RE, (m) => {
    // A long identifier in prose is not a credential: prose words are
    // lowercase-with-hyphens, base64 looks like base64. Require both cases or
    // digits or base64 punctuation before masking.
    if (!/[A-Z]/.test(m) || !/[a-z]/.test(m) || !/[0-9]/.test(m)) return m;
    return `[redacted ${m.length} chars]`;
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function oneLine(s, max = 96) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function summarise(project, inv, sample, labels, problems) {
  const poolSizes = { S: sample.pools.S.length, T: sample.pools.T.length, O: sample.pools.O.length };
  const counts = { I: 0, E: 0, WJ: 0, N: 0 };
  const byStratum = { S: { n: 0, WJ: 0 }, T: { n: 0, WJ: 0 }, O: { n: 0, WJ: 0 } };
  let labelled = 0;
  for (const u of sample.chosen) {
    byStratum[u.stratum].n++;
    if (u.class) {
      labelled++;
      counts[u.class]++;
      if (u.class === 'WJ') byStratum[u.stratum].WJ++;
    }
  }
  const sampleSize = sample.chosen.length;
  const wj = counts.WJ;
  const pct = labelled === sampleSize && sampleSize > 0 ? wj / sampleSize : null;

  // Design-weighted estimate over the whole inventory: each stratum's sampled
  // WJ rate applied to that stratum's population size.
  let weightedNumerator = 0;
  const weightedParts = [];
  for (const k of STRATA) {
    const n = byStratum[k].n;
    const size = poolSizes[k];
    const contribution = n === 0 || size === 0 ? 0 : (size * byStratum[k].WJ) / n;
    weightedNumerator += contribution;
    weightedParts.push({ stratum: k, size, n, wj: byStratum[k].WJ, contribution });
  }
  const total = poolSizes.S + poolSizes.T + poolSizes.O;
  const weighted = total > 0 && labelled === sampleSize ? weightedNumerator / total : null;

  const directiveByTop = new Map();
  for (const d of inv.directiveLines) {
    const top = d.file.includes('/') ? d.file.split('/')[0] + '/' : '(root)';
    directiveByTop.set(top, (directiveByTop.get(top) || 0) + 1);
  }

  return {
    key: project.key,
    label: project.label,
    root: inv.root,
    trackedFiles: inv.all,
    inScopeFiles: inv.inScope.length,
    units: inv.units.length,
    directiveLines: inv.directiveLines.length,
    directiveFiles: new Set(inv.directiveLines.map((d) => d.file)).size,
    directiveByTop: [...directiveByTop].sort((a, b) => b[1] - a[1]),
    directories: [...inv.directoryCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    poolSizes,
    taken: sample.taken,
    remaining: sample.remaining,
    reassigned: sample.reassigned,
    sampleSize,
    labelled,
    counts,
    byStratum,
    pct,
    weighted,
    weightedParts,
    weightedNumerator,
    problems,
    labelsPresent: labels.present,
    chosen: sample.chosen.map((u) => ({
      id: u.id,
      stratum: u.stratum,
      file: u.file,
      line: u.startLine,
      endLine: u.endLine,
      kind: u.kind,
      class: u.class,
      why: u.why,
      text: u.text,
      textSha: u.textSha,
    })),
    files: inv.files,
  };
}

function humanReport(summaries, opts) {
  const out = [];
  out.push('comment-audit — read-only comment inventory, strata, fixed-seed sample');
  out.push('');
  for (const s of summaries) {
    out.push(`## ${s.label}  (${s.root})`);
    out.push('');
    out.push(`  tracked files: ${s.trackedFiles}`);
    out.push(`  in-scope files: ${s.inScopeFiles}`);
    for (const [dir, n] of s.directories) out.push(`      ${dir.padEnd(18)} ${n}`);
    out.push(`  comment units: ${s.units}`);
    out.push(
      `  suppression-directive lines: ${s.directiveLines} in ${s.directiveFiles} files` +
        (s.directiveByTop.length ? ` (${s.directiveByTop.map(([d, n]) => `${d} ${n}`).join(', ')})` : ''),
    );
    out.push(`  strata: S=${s.poolSizes.S}  T=${s.poolSizes.T}  O=${s.poolSizes.O}  (total ${s.units})`);
    out.push(
      `  sample: S=${s.taken.S}  T=${s.taken.T}  O=${s.taken.O}  = ${s.sampleSize}` +
        (Object.keys(s.reassigned).length
          ? `  (quota moved: ${Object.entries(s.reassigned)
              .map(([k, v]) => `${k}+${v}`)
              .join(', ')})`
          : ''),
    );
    if (Object.values(s.remaining).some((v) => v > 0)) {
      out.push(`  UNFILLED QUOTA: ${JSON.stringify(s.remaining)}`);
    }
    out.push('');
    if (!s.labelsPresent) {
      out.push('  labels: none yet (tools/comment-audit-labels.json absent) — sample only');
    } else if (s.problems.length) {
      out.push(`  labels: ${s.labelled}/${s.sampleSize} matched, ${s.problems.length} problem(s):`);
      for (const p of s.problems) out.push(`    ! ${p}`);
    } else {
      out.push(`  labels: ${s.labelled}/${s.sampleSize} classified`);
      out.push(
        `  counts: I=${s.counts.I}  E=${s.counts.E}  WJ=${s.counts.WJ}  N=${s.counts.N}` +
          (s.pct === null ? '' : `   WJ = ${s.counts.WJ}/${s.sampleSize} = ${(s.pct * 100).toFixed(1)}%`),
      );
      const parts = s.weightedParts
        .map((p) => `${p.stratum}(${p.size}x${p.wj}/${p.n}=${p.contribution.toFixed(1)})`)
        .join(' + ');
      if (s.weighted !== null) {
        out.push(`  weighted: ${parts} = ${s.weightedNumerator.toFixed(1)} / ${s.units} = ${(s.weighted * 100).toFixed(2)}%`);
      }
      out.push(`  decision vs 20% threshold: ${decide(s)}`);
    }
    out.push('');
  }

  out.push('## Sampled units');
  out.push('');
  for (const s of summaries) {
    out.push(`### ${s.label}`);
    out.push('');
    out.push('| id | stratum | file:line | class | comment |');
    out.push('|---|---|---|---|---|');
    for (const u of s.chosen) {
      out.push(
        `| ${u.id} | ${u.stratum} | ${u.file}:${u.line} | ${u.class || '—'} | ${oneLine(redact(u.text), 70).replace(/\|/g, '\\|')} |`,
      );
    }
    out.push('');
  }

  if (opts.context > 0) {
    out.push('## Source context');
    for (const s of summaries) {
      out.push('');
      out.push(`### ${s.label}`);
      for (const u of s.chosen) {
        const lines = readFileSync(join(s.root, u.file), 'utf8').split('\n');
        const from = Math.max(1, u.line - opts.context);
        const to = Math.min(lines.length, u.endLine + opts.context);
        out.push('');
        out.push(`--- ${u.id} ${u.stratum} ${u.class || '—'} ${u.file}:${u.line}`);
        for (let ln = from; ln <= to; ln++) out.push(`${String(ln).padStart(5)} | ${lines[ln - 1]}`);
      }
    }
  }
  return out.join('\n');
}

function decide(s) {
  if (s.pct === null) return 'undecided (sample not fully classified)';
  const sampleVerdict = s.pct >= 0.2 ? 'AT/above 20%' : 'below 20%';
  const wVerdict = s.weighted === null ? '' : s.weighted >= 0.2 ? 'AT/above 20%' : 'below 20%';
  return `sample ${(s.pct * 100).toFixed(1)}% is ${sampleVerdict}; weighted ${(s.weighted * 100).toFixed(2)}% is ${wVerdict}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const labels = loadLabels();
  const summaries = [];
  const problemsAll = [];

  for (const project of PROJECTS) {
    if (opts.roots[project.key]) project.root = resolve(opts.roots[project.key]);
    const inv = inventory(project);
    const sample = draw(inv.units, project.seed);
    const problems = joinLabels(sample, labels, project.idPrefix);
    problemsAll.push(...problems.map((p) => `${project.key}: ${p}`));
    summaries.push(summarise(project, inv, sample, labels, problems));
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          tool: 'comment-audit',
          version: 1,
          window: WINDOW,
          quota: QUOTA,
          classes: CLASS_NAMES,
          strata: STRATUM_NAMES,
          directivePattern: DIRECTIVE_RE.source,
          timerPattern: TIMER_RE.source,
          excludes: EXCLUDES.map((r) => r.source),
          seeds: PROJECTS.map((p) => ({ key: p.key, seed: p.seed })),
          projects: summaries.map((s) => ({ ...s, files: s.files.length })),
          labelProblems: problemsAll,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (opts.sampleOnly) {
    const out = [];
    for (const s of summaries) {
      out.push(`## ${s.label} — draw (${s.sampleSize} units)`);
      out.push('| id | stratum | file:line | textSha | class | comment |');
      out.push('|---|---|---|---|---|---|');
      for (const u of s.chosen) {
        out.push(
          `| ${u.id} | ${u.stratum} | ${u.file}:${u.line} | ${u.textSha.slice(0, 12)} | ${u.class || '—'} | ${oneLine(redact(u.text), 80).replace(/\|/g, '\\|')} |`,
        );
      }
      out.push('');
    }
    process.stdout.write(out.join('\n') + '\n');
  } else {
    process.stdout.write(humanReport(summaries, opts) + '\n');
  }

  if (problemsAll.length > 0) {
    process.stderr.write(`comment-audit: ${problemsAll.length} label problem(s)\n`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { scanFile, buildUnits, inventory, draw, PROJECTS, QUOTA, WINDOW, DIRECTIVE_RE, TIMER_RE };
