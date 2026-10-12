import { z } from 'zod';
import { fileText, line, mutation, projectPath, projectScope, sha } from './shared.mjs';

// Files and read-only Git. Each entry is: operation, workspace method, input shape,
// read-only, description, options. Git writes (commit, branch, push) go through shell.run.
export function defineFileOperations(service, add) {
  // Line numbers as the file has them: the newline that ends the last line starts no further line, and the
  // carriage return of a CRLF file is not part of the line (it would be copied into oldText and never match).
  const numbered = (body, first = 1) => {
    if (!body) return '(empty file)';
    const lines = body.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines.map((value, index) => String(first + index).padStart(6) + '\t' + value.replace(/\r$/, '')).join('\n');
  };
  const stdout = result => result.stdout || '(no output)';
  // On Windows a file another program holds for a moment cannot be changed until it is let go (workspace.mjs says
  // so with file_busy, and has changed nothing). The whole change is made again, a little later each time, for up to
  // twenty seconds. Between the tries the runtime is free: other calls are served while this one waits.
  const FILE_BUSY_PATIENCE_MS = 20000;
  async function patiently(change) {
    for (let attempt = 0, waited = 0; ; attempt++) {
      try { return await change(); }
      catch (failure) {
        const pause = Math.min(1000, 100 * 2 ** attempt);
        if (failure?.code !== 'file_busy' || failure.incomplete) throw failure;
        if (waited + pause > (service.fileBusyPatienceMs ?? FILE_BUSY_PATIENCE_MS)) {
          // A program that holds a file for a moment has let go long before this. What refuses for this long is a
          // program that keeps the file open, or permissions that do not let this account change it: Windows gives
          // the same answer for both.
          // (Not only at its end: workspace.patch says what became of the rest of the patch after it.)
          failure.message = failure.message.replace(' Try again in a moment.', '') + ' It stayed so for ' + Math.max(1, Math.round(waited / 1000)) +
            ' second(s) of trying again: a program keeps it open, or this account is not allowed to change it (its permissions).';
          throw failure;
        }
        await new Promise(resolve => setTimeout(resolve, pause));
        waited += pause;
      }
    }
  }
  const scope = z.string().max(4096).default('');
  const ref = z.string().max(250).optional();
  for (const [name, method, shape, readOnly, description, options] of [
    ['workspace.files', 'files', { path: scope, cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(1000).optional() }, true, 'List the entries of one directory (the project root when path is omitted), not its subdirectories. To find files by name or pattern anywhere in the project use workspace_find.'],
    ['workspace.find', 'find', { pattern: z.string().min(1).max(500), path: scope, includeIgnored: z.boolean().optional(),
      limit: z.number().int().min(1).max(2000).optional() }, true,
      'Find project files by glob, for example "**/*.test.ts" or "*.json". Honours .gitignore and skips dependency and build directories unless includeIgnored is set.',
      { present: result => (result.items.map(item => item.path).join('\n') + (result.truncated ? '\n[more matches; narrow the pattern or path]' : '') || 'No files match.') +
        (result.withheld ? '\n[' + result.withheld + ' matching file(s) not shown: links, or kept back by the project\'s credential-file protection]' : '') }],
    ['workspace.read', 'read', { path: projectPath, startLine: line.optional(), lineCount: line.max(20000).optional() }, true,
      'Read a project text file with line numbers. Large files return a page; continue with nextStartLine. sha256 identifies the whole file for workspace_edit and workspace_write.',
      { present: result => numbered(result.text, result.startLine || 1), meta: ['sha256', 'totalLines', 'endLine', 'truncated', 'nextStartLine', 'note'] }],
    ['workspace.read_bytes', 'readBytes', { path: projectPath,
      offset: z.number().int().nonnegative().default(0),
      // As base64 a page is a third longer than its bytes, and has to fit in one tool result.
      length: z.number().int().min(1).max(98304).default(65536),
      expectedVersion: sha.optional() }, true,
      'Read any-size project files safely as bounded base64 byte pages with a change-detection token.'],
    ['workspace.edit', 'edit', { path: projectPath, edits: z.array(z.object({ oldText: z.string().min(1).max(100000), newText: z.string().max(100000),
      replaceAll: z.boolean().optional() }).strict()).min(1).max(200), expectedSha256: sha.optional(), ...mutation }, false,
      'Edit a text file by exact replacement. Each oldText must match exactly once unless replaceAll is set. Edits apply in order, each to the result of the one before, and all of them or none are written. Preferred over rewriting a whole file. The previous version stays restorable.'],
    ['workspace.patch', 'applyPatch', { patch: fileText.min(1), dryRun: z.boolean().optional().describe('Work the patch out and say what it would change, without changing anything.'), ...mutation }, false,
      'Change one or several files with one patch: all of it is applied, or none. Either "*** Begin Patch", then per file "*** Update File: <path>" (optionally "*** Move to: <path>") with hunks of unchanged lines (leading space), "-" removed and "+" added lines, a hunk optionally opened by "@@" or "@@ <a line it comes after>"; "*** Add File: <path>" whose every line starts with "+", in a new file too; "*** Delete File: <path>"; and "*** End Patch". Or a unified diff as git diff prints it. Give a few unchanged lines around every change: a hunk is found by its text, and refused when it fits nowhere or in two places. The result says what changed and how to take all of it back: do not read the files again to confirm it.',
      { destructive: true, meta: ['since', 'warning'], present: result => (result.dryRun ? 'Would change ' : 'Changed ') + result.files.length + ' file(s) (+' + result.additions + ' −' + result.removals + '):\n' +
        result.files.map(file => '  ' + file.operation.padEnd(7) + (file.previousPath ? file.previousPath + ' → ' : '') + file.path + (file.additions !== undefined ? '  (+' + file.additions + ' −' + file.removals + ')' : '') +
          (file.lines ? '  at line ' + file.lines.join(', ') : '')).join('\n') +
        (result.since !== undefined ? '\nTake all of it back with workspace_restore {since:' + result.since + '}.' : '') }],
    ['workspace.write', 'write', { path: projectPath, text: fileText, expectedSha256: sha.nullable().optional(), overwrite: z.boolean().optional(),
      append: z.boolean().optional().describe('Add the text to the end of the file itself instead of replacing it; a file that is not there is created.'), ...mutation }, false,
      'Create a new file, creating missing folders. To replace an existing file pass its sha256 from workspace_read as expectedSha256 (or overwrite:true to replace it whatever it holds); to change part of a file prefer workspace_edit. The previous version stays restorable. A file is replaced by a new one: a program that has it open to write to it, such as a server and its log, keeps the old one. Add to such a file with append.'],
    ['workspace.mkdir', 'mkdir', { path: projectPath, ...mutation }, false, 'Create a project directory, including missing parents.', { idempotent: true }],
    ['workspace.move', 'move', { from: projectPath, to: projectPath, overwrite: z.boolean().optional(), ...mutation }, false, 'Move or rename a project file or directory, creating missing destination folders. overwrite:true lets a file replace a file; the replaced file stays restorable.'],
    ['workspace.delete', 'remove', { path: projectPath, recursive: z.boolean().optional(), force: z.boolean().optional(), ...mutation }, false,
      'Delete a project file or directory (recursive:true for one with content). Deleted files stay restorable through workspace_history, each under its own path; a very large file or directory needs force:true and is then not restorable.', { destructive: true }],
    ['workspace.history', 'history', { path: projectPath.optional(), limit: z.number().int().min(1).max(200).optional() }, true,
      'List what DevMate changed, newest first: for one file, or without path every recent change in the project. Each entry carries its number and the sha256 values workspace_restore accepts.',
      { present: result => result.items.map(item => '#' + item.sequence + '  ' + item.at + '  ' + item.action.padEnd(8) + item.path + (item.from ? '  (from ' + item.from + ')' : '') +
        (item.previousRestorable ? '  restore previous: ' + item.previousSha256 : '')).join('\n') || 'DevMate has not changed anything here.' }],
    ['workspace.restore', 'restore', { path: projectPath.optional(), sha256: sha.optional(), since: z.number().int().nonnegative().optional().describe('The number of a workspace_history entry: every change made after it is taken back.'), ...mutation }, false,
      'Restore a file to a version listed by workspace_history (path and sha256). Or take back, in one call, every change DevMate\'s file tools made in the project after one history entry (since: its number, shown as #N): newest first, each checked against the file as it is now, so a file that something else changed in the meantime is left alone and listed. Whatever is replaced stays restorable, so this can itself be taken back. Changes made by commands or by delegated agents are not in this history: use Git for those.', { destructive: true }],
    ['workspace.search', 'search', { query: z.string().min(1).max(4000), path: scope, regex: z.boolean().optional(), ignoreCase: z.boolean().optional(),
      glob: z.string().max(500).optional(), includeIgnored: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() }, true,
      'Search project file contents with ripgrep. query is literal text unless regex is set. Honours .gitignore and skips dependency and build directories unless includeIgnored is set.',
      { present: result => result.items.map(item => item.path + ':' + item.line + ': ' + item.text).join('\n') + (result.truncated ? '\n[more matches; narrow the query, glob or path]' : '') || 'No matches.' }],
    ['workspace.changes', 'changes', { since: z.enum(['last_review', 'last_commit']).optional().describe('last_review (the default) leaves out what was already shown and marked; last_commit shows everything that is not committed.'),
      markReviewed: z.boolean().optional().describe('Remember what is shown now as reviewed.') }, true,
      'Say what changed in the project and is not committed yet, whoever changed it: per file whether it was added, modified, renamed or deleted and how many lines came and went. With markReviewed the next call shows only what changed after this one, and nothing when nothing did. git_diff shows the lines themselves.',
      { present: result => (result.files.length ? result.files.length + (result.moreFiles ? '+' : '') + ' file(s) changed (+' + result.additions + ' −' + result.removals + ')' + (result.since === 'last_review' ? ' since the last review' : ' since the last commit') + ':\n' +
        result.files.map(file => '  ' + file.type.padEnd(9) + (file.previousPath ? file.previousPath + ' → ' : '') + file.path + (file.binary ? '  (binary)' : '  (+' + file.additions + ' −' + file.removals + ')')).join('\n') +
        (result.moreFiles ? '\n  … and ' + result.moreFiles + ' more' : '')
        : result.since === 'last_review' ? 'Nothing changed since the last review.' : 'Nothing is uncommitted.') +
        (result.alreadyReviewed ? '\n[' + result.alreadyReviewed + ' other changed file(s) were reviewed before and are unchanged since; since:"last_commit" shows them]' : '') +
        (result.omittedProtected ? '\n[' + result.omittedProtected + ' protected file(s) changed and are not shown]' : '') + (result.markedReviewed !== undefined ? '\n[marked as reviewed]' : '') }],
    ['git.status', 'gitStatus', {}, true, 'Read project Git status. Credential-like files are listed and marked protected so they are not staged by accident.', { present: result => result.stdout || 'Working tree clean.' }],
    ['git.diff', 'gitDiff', { paths: z.array(projectPath).max(100).optional(), staged: z.boolean().optional() }, true, 'Read a bounded Git diff of the working tree or the index.', { present: stdout }],
    ['git.log', 'gitLog', { ref, paths: z.array(projectPath).max(100).optional(), limit: z.number().int().min(1).max(200).optional() }, true,
      'List commits, newest first (20 unless limit says otherwise). ref is a commit, branch or tag to start from; paths limits it to commits that touched them.', { present: result => (result.items.map(item => [item.commit.slice(0, 12), item.date, item.author, item.subject].join('  ')).join('\n') || 'No commits.') +
        (result.more ? '\n[older commits exist; raise limit (up to 200), or pass ref to start from an older commit]' : '') }],
    ['git.show', 'gitShow', { ref, stat: z.boolean().optional() }, true, 'Show one commit with its message and patch (default HEAD). ref names a commit, branch or tag; stat:true lists the changed files instead of the patch.', { present: stdout }],
    ['git.blame', 'gitBlame', { path: projectPath, startLine: line.optional(), endLine: line.optional(), ref }, true, 'Show who last changed each line of a file.', { present: stdout }],
    ['git.branches', 'gitBranches', {}, true, 'List local and remote branches and the current branch.']
  ]) {
    // A page of a file is sized for a model's client, except at this computer.
    const direct = (args, context) => service.workspace[method](service.project(args.projectId, { write: !readOnly }), args, { local: context.surface === 'local' });
    add(name, { ...projectScope, ...shape }, readOnly, description, readOnly ? direct : (args, context) => patiently(() => service.workspace.quickly(() => direct(args, context))), options);
  }
}
