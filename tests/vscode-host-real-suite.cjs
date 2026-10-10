// Runs inside a real VS Code extension host, next to the DevMate extension. Started by
// scripts/test-vscode-host.mjs, which tells it what to do through the environment and reads what it reports.
const vscode = require('vscode');
const fs = require('node:fs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out: ' + label);
    await wait(250);
  }
}

exports.run = async () => {
  const { DEVMATE_HOST_TEST_ROLE: role, DEVMATE_HOST_TEST_OUT: out, DEVMATE_HOST_TEST_EXTRA: extra, DEVMATE_HOST_TEST_CHANGE: change, DEVMATE_HOST_TEST_DONE: done } = process.env;
  const result = { role };
  const save = () => fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  // The suite also runs in the second window this editor opens; only the first one reports and acts as the owner.
  const leading = here.toLowerCase() !== String(extra || '').toLowerCase();
  try {
    const extension = vscode.extensions.getExtension('kukutx.devmate-agent');
    result.found = !!extension;
    await extension.activate();
    result.active = extension.isActive;
    result.vscode = vscode.version;
    result.commands = (await vscode.commands.getCommands(true)).filter(id => id.startsWith('devMate.runtime.')).sort();
    // Auto-start is on in this profile: the runtime comes up with the editor.
    const state = await until(async () => {
      const value = await vscode.commands.executeCommand('devMate.runtime.status');
      return value?.running ? value : null;
    }, 'runtime running');
    result.state = { state: state.state, pid: state.record.pid, port: state.record.port, generation: state.record.generation };
    // A second window of the same editor, with a folder of its own.
    if (leading && role === 'primary' && extra) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(extra), { forceNewWindow: true });
    if (leading) save();
    if (leading && role === 'primary') {
      // Nothing is clicked up to here: the folder is shared by the default alone. Once the harness has seen
      // that, the owner's later word is given through the command, choosing "Read only".
      await until(() => fs.existsSync(change), 'harness saw the default', 150000);
      const original = vscode.window.showQuickPick;
      vscode.window.showQuickPick = async items => (await items).find(item => item.access === 'read');
      try { await vscode.commands.executeCommand('devMate.runtime.registerFolder', here); }
      finally { vscode.window.showQuickPick = original; }
      result.changed = true;
      save();
    }
    await until(() => fs.existsSync(done), 'harness finished', 240000);
  } catch (error) { result.error = String(error?.stack || error); }
  if (leading) save();
};
