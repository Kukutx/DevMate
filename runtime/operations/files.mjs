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
      length: z.number().int().min(1).max(262144).default(65536),
      expectedVersion: sha.optional() }, true,
      'Read any-size project files safely as bounded base64 byte pages with a change-detection token.'],
    ['workspace.edit', 'edit', { path: projectPath, edits: z.array(z.object({ oldText: z.string().min(1).max(100000), newText: z.string().max(100000),
      replaceAll: z.boolean().optional() }).strict()).min(1).max(200), expectedSha256: sha.optional(), ...mutation }, false,
      'Edit a text file by exact replacement. Each oldText must match exactly once unless replaceAll is set. Edits apply in order, each to the result of the one before, and all of them or none are written. Preferred over rewriting a whole file. The previous version stays restorable.'],
    ['workspace.write', 'write', { path: projectPath, text: fileText, expectedSha256: sha.nullable().optional(), ...mutation }, false,
      'Create a new file, creating missing folders. To replace an existing file pass its sha256 from workspace_read as expectedSha256; to change part of a file prefer workspace_edit. The previous version stays restorable.'],
    ['workspace.mkdir', 'mkdir', { path: projectPath, ...mutation }, false, 'Create a project directory, including missing parents.', { idempotent: true }],
    ['workspace.move', 'move', { from: projectPath, to: projectPath, overwrite: z.boolean().optional(), ...mutation }, false, 'Move or rename a project file or directory, creating missing destination folders. overwrite:true lets a file replace a file; the replaced file stays restorable.'],
    ['workspace.delete', 'remove', { path: projectPath, recursive: z.boolean().optional(), force: z.boolean().optional(), ...mutation }, false,
      'Delete a project file or directory (recursive:true for one with content). Deleted files stay restorable through workspace_history, each under its own path; a very large file or directory needs force:true and is then not restorable.', { destructive: true }],
    ['workspace.history', 'history', { path: projectPath.optional(), limit: z.number().int().min(1).max(200).optional() }, true,
      'List what DevMate changed, newest first: for one file, or without path every recent change in the project. Each entry carries the sha256 values workspace_restore accepts.',
      { present: result => result.items.map(item => item.at + '  ' + item.action.padEnd(8) + item.path + (item.from ? '  (from ' + item.from + ')' : '') +
        (item.previousRestorable ? '  restore previous: ' + item.previousSha256 : '')).join('\n') || 'DevMate has not changed anything here.' }],
    ['workspace.restore', 'restore', { path: projectPath, sha256: sha, ...mutation }, false, 'Restore a file to a version listed by workspace_history. The replaced version stays restorable.', { destructive: true }],
    ['workspace.search', 'search', { query: z.string().min(1).max(4000), path: scope, regex: z.boolean().optional(), ignoreCase: z.boolean().optional(),
      glob: z.string().max(500).optional(), includeIgnored: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() }, true,
      'Search project file contents with ripgrep. query is literal text unless regex is set. Honours .gitignore and skips dependency and build directories unless includeIgnored is set.',
      { present: result => result.items.map(item => item.path + ':' + item.line + ': ' + item.text).join('\n') + (result.truncated ? '\n[more matches; narrow the query, glob or path]' : '') || 'No matches.' }],
    ['git.status', 'gitStatus', {}, true, 'Read project Git status. Credential-like files are listed and marked protected so they are not staged by accident.', { present: result => result.stdout || 'Working tree clean.' }],
    ['git.diff', 'gitDiff', { paths: z.array(projectPath).max(100).optional(), staged: z.boolean().optional() }, true, 'Read a bounded Git diff of the working tree or the index.', { present: stdout }],
    ['git.log', 'gitLog', { ref, paths: z.array(projectPath).max(100).optional(), limit: z.number().int().min(1).max(200).optional() }, true,
      'List commits, newest first (20 unless limit says otherwise). ref is a commit, branch or tag to start from; paths limits it to commits that touched them.', { present: result => (result.items.map(item => [item.commit.slice(0, 12), item.date, item.author, item.subject].join('  ')).join('\n') || 'No commits.') +
        (result.more ? '\n[older commits exist; raise limit (up to 200), or pass ref to start from an older commit]' : '') }],
    ['git.show', 'gitShow', { ref, stat: z.boolean().optional() }, true, 'Show one commit with its message and patch (default HEAD). ref names a commit, branch or tag; stat:true lists the changed files instead of the patch.', { present: stdout }],
    ['git.blame', 'gitBlame', { path: projectPath, startLine: line.optional(), endLine: line.optional(), ref }, true, 'Show who last changed each line of a file.', { present: stdout }],
    ['git.branches', 'gitBranches', {}, true, 'List local and remote branches and the current branch.']
  ]) {
    add(name, { ...projectScope, ...shape }, readOnly, description, args => service.workspace[method](service.project(args.projectId, { write: !readOnly }), args), options);
  }
}
