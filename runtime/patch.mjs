import { DomainError } from './store.mjs';

// A patch as a model writes it, read into one list of file changes. Two forms are understood: the envelope Codex
// uses ("*** Begin Patch" … "*** End Patch"), whose hunks carry context but no line numbers, and a unified diff
// (git diff, diff -u), whose hunks say where they belong. Nothing here touches a disk: parsePatch gives the changes,
// patchText gives the new text of one file.
//
// A change is { action: 'add', path, text } | { action: 'delete', path, hunks } | { action: 'update', path, moveTo?, hunks },
// a hunk is { header?, oldStart?, endOfFile?, lines: [{ kind: ' ' | '-' | '+', text, noNewline? }] }.
const MAX_FILES = 200;
const FORMS = 'Send either "*** Begin Patch" … "*** End Patch" with "*** Update File: <path>", "*** Add File: <path>" or "*** Delete File: <path>" sections, or a unified diff with "--- a/<path>", "+++ b/<path>" and "@@ -l,n +l,n @@" hunks.';
const invalid = (message, details) => new DomainError('invalid_patch', message, details);

function envelope(lines) {
  const files = [];
  let current = null, hunk = null, ended = false;
  for (let index = 1; index < lines.length && !ended; index++) {
    const line = lines[index], where = 'Line ' + (index + 1) + ' of the patch: ';
    if (line.trimEnd() === '*** End Patch') { ended = true; continue; }
    let match;
    if ((match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line))) {
      current = { action: match[1].toLowerCase(), path: match[2].trim(), ...(match[1] === 'Add' ? { added: [] } : { hunks: [] }) };
      files.push(current); hunk = null;
    } else if (!current) throw invalid(where + 'expected "*** Add File: <path>", "*** Update File: <path>" or "*** Delete File: <path>".');
    else if (current.action === 'add') {
      if (!line.startsWith('+')) throw invalid(where + 'every line of an added file starts with "+".');
      current.added.push(line.slice(1));
    } else if (current.action === 'delete') throw invalid(where + 'a deleted file is named and nothing more.');
    else if ((match = /^\*\*\* Move to: (.+)$/.exec(line))) {
      if (current.moveTo || current.hunks.length) throw invalid(where + '"*** Move to:" comes once, directly after "*** Update File:".');
      current.moveTo = match[1].trim();
    } else if (line.trimEnd() === '*** End of File') {
      if (!hunk) throw invalid(where + '"*** End of File" closes a hunk.');
      hunk.endOfFile = true; hunk = null;
    } else if (line.startsWith('@@')) {
      hunk = { header: line.slice(2).trim() || null, lines: [] };
      current.hunks.push(hunk);
    } else {
      // An empty line is an empty context line: editors and transports drop the space it should start with.
      const kind = line === '' ? ' ' : line[0];
      if (kind !== ' ' && kind !== '-' && kind !== '+') throw invalid(where + 'a hunk line starts with a space (unchanged), "-" (removed) or "+" (added).');
      if (!hunk) { hunk = { header: null, lines: [] }; current.hunks.push(hunk); }
      hunk.lines.push({ kind, text: line.slice(1) });
    }
  }
  if (!ended) throw invalid('The patch does not end with "*** End Patch".');
  return files.map(({ added, ...file }) => {
    if (file.action === 'add') return { ...file, text: added.length ? added.join('\n') + '\n' : '' };
    if (file.action === 'update' && !file.moveTo && !file.hunks.some(item => item.lines.some(line => line.kind !== ' ')))
      throw invalid('The section for ' + file.path + ' changes nothing: it has no "-" or "+" line.');
    return file;
  });
}

// Git writes a path with unusual characters in quotes, its bytes as octal escapes: "a/caf\303\251.txt".
function unquoted(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const source = Buffer.from(value.slice(1, -1)), bytes = [], named = { 110: 10, 116: 9, 114: 13, 97: 7, 98: 8, 102: 12, 118: 11 };
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== 92 || index + 1 >= source.length) { bytes.push(source[index]); continue; }
    const next = source[++index];
    if (next >= 48 && next <= 55) { bytes.push(parseInt(source.subarray(index, index + 3).toString('latin1'), 8) & 255); index += 2; }
    else bytes.push(named[next] ?? next);
  }
  return Buffer.from(bytes).toString('utf8');
}
// "--- a/file.txt<TAB>2026-01-01 10:00:00": what follows a tab is a timestamp.
const headerPath = value => unquoted(value.split('\t')[0].trimEnd());

function unified(lines) {
  const files = [];
  let current = null, index = 0;
  const begin = () => { current = { hunks: [] }; files.push(current); };
  while (index < lines.length) {
    const line = lines[index], where = 'Line ' + (index + 1) + ' of the patch: ';
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (line.startsWith('diff --git ')) { begin(); index++; }
    else if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      // A plain diff has no "diff" line: the pair itself starts the next file.
      if (!current || current.oldPath !== undefined) begin();
      current.oldPath = headerPath(line.slice(4)); current.newPath = headerPath(lines[index + 1].slice(4));
      index += 2;
    } else if (header) {
      if (current?.oldPath === undefined) throw invalid(where + 'a hunk comes after the "---" and "+++" lines that name its file.');
      // How many lines a hunk has is said by its header; a line that starts with "--- " inside it is a removed line.
      let oldLeft = header[2] === undefined ? 1 : Number(header[2]), newLeft = header[4] === undefined ? 1 : Number(header[4]);
      const hunk = { oldStart: Number(header[1]), lines: [] };
      for (index++; oldLeft > 0 || newLeft > 0; index++) {
        const body = lines[index];
        if (body === undefined) throw invalid('The hunk "' + line + '" ends before the lines its header announces.');
        if (body.startsWith('\\')) { if (hunk.lines.length) hunk.lines.at(-1).noNewline = true; continue; }
        const kind = body === '' ? ' ' : body[0];
        if (kind !== ' ' && kind !== '-' && kind !== '+') throw invalid('Line ' + (index + 1) + ' of the patch: a hunk line starts with a space (unchanged), "-" (removed) or "+" (added). The header "' + line + '" announces more lines than follow.');
        if (kind !== '+') oldLeft--;
        if (kind !== '-') newLeft--;
        if (oldLeft < 0 || newLeft < 0) throw invalid('The hunk "' + line + '" has more lines than its header announces.');
        hunk.lines.push({ kind, text: body.slice(1) });
      }
      if (lines[index]?.startsWith('\\')) { if (hunk.lines.length) hunk.lines.at(-1).noNewline = true; index++; }
      current.hunks.push(hunk);
    } else {
      let match;
      if (current && (match = /^rename from (.+)$/.exec(line))) current.renameFrom = unquoted(match[1]);
      else if (current && (match = /^rename to (.+)$/.exec(line))) current.renameTo = unquoted(match[1]);
      else if (current && /^(Binary files |GIT binary patch)/.test(line)) throw invalid(where + 'a binary change cannot be applied as a patch.');
      // Everything else (index and mode lines, prose around the diff) says nothing about the text.
      index++;
    }
  }
  return files.map(file => {
    if (file.oldPath === undefined) return file.renameFrom && file.renameTo ? { action: 'update', path: file.renameFrom, moveTo: file.renameTo, hunks: [] } : null;
    // git prefixes the two sides with a/ and b/; a plain diff names the files as they are.
    const prefixed = (file.oldPath === '/dev/null' || file.oldPath.startsWith('a/')) && (file.newPath === '/dev/null' || file.newPath.startsWith('b/'));
    const named = value => value === '/dev/null' ? null : prefixed ? value.slice(2) : value;
    const from = named(file.oldPath), to = named(file.newPath);
    if (from === null && to === null) throw invalid('A file section names /dev/null on both sides.');
    if (from === null) {
      const added = file.hunks.flatMap(hunk => hunk.lines);
      if (added.some(item => item.kind !== '+')) throw invalid('The section that creates ' + to + ' has lines that are not added lines.');
      return { action: 'add', path: to, text: added.map(item => item.text).join('\n') + (added.length && !added.at(-1).noNewline ? '\n' : '') };
    }
    if (to === null) return { action: 'delete', path: from, hunks: file.hunks };
    if (to === from && !file.hunks.length) return null;
    return { action: 'update', path: from, ...(to !== from ? { moveTo: to } : {}), hunks: file.hunks };
  }).filter(Boolean);
}

export function parsePatch(text) {
  if (typeof text !== 'string' || !text.trim()) throw invalid('The patch is empty. ' + FORMS);
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  let first = lines.findIndex(line => line.trim());
  // A model used to a shell wraps the patch as a here-document: <<'EOF' … EOF.
  const wrapped = /^<<-?\s*(['"]?)(\w+)\1$/.exec(lines[first].trim()), last = lines.findLastIndex(line => line.trim());
  if (wrapped && lines[last].trim() === wrapped[2]) { lines = lines.slice(first + 1, last); first = lines.findIndex(line => line.trim()); }
  if (first < 0) throw invalid('The patch is empty. ' + FORMS);
  const files = lines[first].trim() === '*** Begin Patch' ? envelope(lines.slice(first)) : unified(lines);
  if (!files.length) throw invalid('No file change was found in the patch. ' + FORMS);
  if (files.length > MAX_FILES) throw invalid('The patch changes ' + files.length + ' files, more than ' + MAX_FILES + ' at once. Send it in parts.');
  return files;
}

// Exact first; then ignoring what changes without anyone meaning it: spaces at the end of a line, and for the
// envelope, whose hunks are located by their text alone, the indentation, and last the typographic dashes, quotes
// and spaces a model writes where the file has the plain ones (or the other way round).
const plain = value => value.trim().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018-\u201b]/g, '\'').replace(/[\u201c-\u201f]/g, '"')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
const SAME = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim(), (a, b) => plain(a) === plain(b)];
const fits = (lines, wanted, at, same) => at >= 0 && at + wanted.length <= lines.length && wanted.every((line, offset) => same(lines[at + offset], line));
function firstFrom(lines, wanted, from, same) {
  for (let at = from; at + wanted.length <= lines.length; at++) if (fits(lines, wanted, at, same)) return at;
  return -1;
}
// The place nearest to where the hunk says it belongs: the file may have gained or lost lines above it.
function nearest(lines, wanted, from, expected, same) {
  for (let distance = 0; distance <= lines.length; distance++) {
    for (const at of distance ? [expected - distance, expected + distance] : [expected]) if (at >= from && fits(lines, wanted, at, same)) return at;
  }
  return -1;
}

// Why a hunk did not fit, said with the file's own line: the place where most of it matches.
function mismatch(lines, wanted, from) {
  let best = { at: -1, matched: 0 };
  for (let at = from; at < lines.length; at++) {
    let matched = 0;
    while (matched < wanted.length && at + matched < lines.length && SAME[2](lines[at + matched], wanted[matched])) matched++;
    if (matched > best.matched) best = { at, matched };
  }
  if (!best.matched) return 'None of its lines is there' + (from ? ' after line ' + from : '') + '. It starts with:\n  ' + wanted.slice(0, 3).join('\n  ');
  const line = best.at + best.matched;
  return 'Its first ' + best.matched + ' line(s) match at line ' + (best.at + 1) + ', then ' + (line < lines.length ? 'line ' + (line + 1) + ' of the file is:\n  ' + lines[line] : 'the file ends') +
    '\nwhere the patch has:\n  ' + wanted[best.matched];
}

/** The text of one file after a change: { text, additions, removals, lines: where each hunk was applied }. */
export function patchText(text, change) {
  // A file that ends every line with CRLF keeps doing so; its lines are compared without the carriage return.
  const crlf = text.includes('\r\n') && !/(?<!\r)\n/.test(text), eol = crlf ? '\r\n' : '\n';
  const lines = text === '' ? [] : (crlf ? text.replace(/\r\n/g, '\n') : text).split('\n');
  let finalNewline = lines.length > 1 && lines.at(-1) === '';
  if (finalNewline) lines.pop();
  const numbered = change.hunks.some(hunk => hunk.oldStart !== undefined), out = [], places = [];
  let cursor = 0, seek = 0, shift = 0, additions = 0, removals = 0;
  // One at a time: a file can have more lines than a call takes arguments.
  const keep = end => { for (; cursor < end; cursor++) out.push(lines[cursor]); };
  change.hunks.forEach((hunk, number) => {
    const wanted = hunk.lines.filter(line => line.kind !== '+').map(line => line.text), name = 'Hunk ' + (number + 1) + ' of ' + change.path;
    const refuse = reason => new DomainError('patch_failed', name + ' does not fit the file. ' + reason + '\nRead the file again and write the hunk against what is there. Nothing was changed.', { path: change.path, hunk: number + 1 });
    if (hunk.header) {
      // "@@ class Parser" names a line the hunk comes after.
      const at = [SAME[0], SAME[2]].map(same => lines.findIndex((line, index) => index >= seek && same(line, hunk.header))).find(found => found >= 0);
      if (at === undefined) throw refuse('No line "' + hunk.header + '" is there' + (seek ? ' after line ' + seek : '') + '.');
      seek = at + 1;
    }
    let at = -1;
    if (!wanted.length) at = numbered ? Math.min(Math.max(hunk.oldStart + shift, cursor), lines.length) : hunk.header ? seek : lines.length;
    else for (const same of numbered ? SAME.slice(0, 2) : SAME) {
      if (numbered) at = nearest(lines, wanted, cursor, hunk.oldStart - 1 + shift, same);
      // A hunk marked as the end of the file is looked for there first.
      else if (hunk.endOfFile && fits(lines, wanted, Math.max(seek, lines.length - wanted.length), same)) at = lines.length - wanted.length;
      else {
        at = firstFrom(lines, wanted, seek, same);
        // Where nothing says which place is meant, two places are one too many: the first one is a guess.
        const second = at >= 0 && !hunk.header && !hunk.endOfFile ? firstFrom(lines, wanted, at + 1, same) : -1;
        if (second >= 0) throw new DomainError('patch_ambiguous', name + ' fits at line ' + (at + 1) + ' and again at line ' + (second + 1) +
          '. Give it more unchanged lines around the change, or open it with "@@ <a line it comes after>", so that it fits one place only. Nothing was changed.', { path: change.path, hunk: number + 1, lines: [at + 1, second + 1] });
      }
      if (at >= 0) break;
    }
    if (at < 0) throw refuse(mismatch(lines, wanted, numbered ? cursor : seek));
    if (numbered && wanted.length) shift = at - (hunk.oldStart - 1);
    keep(at);
    let offset = 0;
    for (const line of hunk.lines) {
      if (line.kind === '+') { out.push(line.text); additions++; continue; }
      // An unchanged line stays as the file has it, also where it matched only without its spaces.
      if (line.kind === ' ') out.push(lines[at + offset]); else removals++;
      offset++;
    }
    cursor = seek = at + wanted.length;
    if (hunk.lines.some(line => line.kind !== ' ')) places.push(at + 1);
  });
  keep(lines.length);
  // "\ No newline at end of file" after a line of the new side says the file ends without one; after a removed line
  // only, that it ends with one now.
  const marks = change.hunks.flatMap(hunk => hunk.lines.filter(line => line.noNewline));
  if (marks.length) finalNewline = !marks.some(line => line.kind !== '-');
  else if (!lines.length && out.length) finalNewline = true;
  return { text: out.join(eol) + (finalNewline && out.length ? eol : ''), additions, removals, lines: places };
}
