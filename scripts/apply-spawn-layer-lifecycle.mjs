#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const decode = value => Buffer.from(value, 'base64').toString('utf8');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function write(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), value, 'utf8');
}

function replaceOnce(relativePath, from, to, label) {
  const source = read(relativePath);
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Could not locate ${label} in ${relativePath}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Found multiple ${label} matches in ${relativePath}`);
  write(relativePath, source.slice(0, first) + to + source.slice(first + from.length));
}

function replaceBetween(relativePath, startMarker, endMarker, replacement, label) {
  const source = read(relativePath);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not locate ${label} start in ${relativePath}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  if (end < 0) throw new Error(`Could not locate ${label} end in ${relativePath}`);
  write(relativePath, source.slice(0, start) + replacement + source.slice(end));
}

replaceOnce(
  'extension.js',
  "const { spawn, spawnSync } = require('child_process');\nconst { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');\nconst { RuntimeController } = require('./host/runtime-controller.js');\n",
  "const childProcess = require('child_process');\nconst { OperationCoordinator } = require('./host/runtime/operation-coordinator.js');\nconst { RuntimeController, SUPPORTED_CONFIG_VERSION } = require('./host/runtime-controller.js');\n\nfunction spawn(...args){ return childProcess.spawn(...args); }\nfunction spawnSync(...args){ return childProcess.spawnSync(...args); }\n",
  'dynamic child process access'
);
replaceOnce('extension.js', '    version: 9,\n', '    version: SUPPORTED_CONFIG_VERSION,\n', 'default config schema version');
replaceOnce(
  'extension.js',
  '  data.version = 9;\n',
  '  data.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(data.version) || 0);\n',
  'monotonic config schema version'
);

replaceOnce(
  'extension-entry.js',
  "const childProcess = require('child_process');\nconst {\n",
  "const childProcess = require('child_process');\nconst { SpawnLayer } = require('./vscode-host/spawn-layer.js');\nconst {\n",
  'managed spawn layer import'
);
replaceOnce(
  'extension-entry.js',
  'let globalContext = null;\n',
  'let globalContext = null;\nlet managedSpawnLayer = null;\nlet activationAttempted = false;\nlet activated = false;\n',
  'managed spawn lifecycle state'
);
replaceBetween(
  'extension-entry.js',
  'function loadBaseExtensionWithNgrokWrapper() {',
  'async function saveManagedAuthtoken',
  decode('ZnVuY3Rpb24gaW5zdGFsbE1hbmFnZWRTcGF3bkxheWVyKCkgewogIGlmIChtYW5hZ2VkU3Bhd25MYXllcj8uYWN0aXZlKSByZXR1cm4gbWFuYWdlZFNwYXduTGF5ZXI7CiAgbWFuYWdlZFNwYXduTGF5ZXIgPSBuZXcgU3Bhd25MYXllcih7CiAgICBjaGlsZFByb2Nlc3MsCiAgICBuYW1lOiAnZGV2bWF0ZS1tYW5hZ2VkLW5ncm9rJywKICAgIHdyYXA6IHByZXZpb3VzU3Bhd24gPT4gY3JlYXRlRXh0ZW5zaW9uU3Bhd24ocHJldmlvdXNTcGF3bikKICB9KTsKICByZXR1cm4gbWFuYWdlZFNwYXduTGF5ZXIuaW5zdGFsbCgpOwp9CgpmdW5jdGlvbiByZXN0b3JlTWFuYWdlZFNwYXduTGF5ZXIoKSB7CiAgY29uc3QgbGF5ZXIgPSBtYW5hZ2VkU3Bhd25MYXllcjsKICBtYW5hZ2VkU3Bhd25MYXllciA9IG51bGw7CiAgaWYgKCFsYXllcikgcmV0dXJuIHsgZGlzcG9zZWQ6IHRydWUsIGFscmVhZHlEaXNwb3NlZDogdHJ1ZSB9OwogIHJldHVybiBsYXllci5kaXNwb3NlKCk7Cn0KCmZ1bmN0aW9uIGxvYWRCYXNlRXh0ZW5zaW9uKCkgewogIHJldHVybiByZXF1aXJlKCcuL2V4dGVuc2lvbicpOwp9Cgo='),
  'managed spawn lifetime helpers'
);
replaceBetween(
  'extension-entry.js',
  'async function activate(context) {',
  '',
  decode('YXN5bmMgZnVuY3Rpb24gYWN0aXZhdGUoY29udGV4dCkgewogIGlmIChhY3RpdmF0aW9uQXR0ZW1wdGVkIHx8IGFjdGl2YXRlZCkgewogICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoJ0Rldk1hdGUgbmdyb2sgaW50ZWdyYXRpb24gaXMgYWxyZWFkeSBhY3RpdmUnKTsKICAgIGVycm9yLmNvZGUgPSAnREVWTUFURV9OR1JPS19MQVlFUl9BTFJFQURZX0FDVElWRSc7CiAgICB0aHJvdyBlcnJvcjsKICB9CiAgYWN0aXZhdGlvbkF0dGVtcHRlZCA9IHRydWU7CiAgZ2xvYmFsQ29udGV4dCA9IGNvbnRleHQ7CiAgc2V0dXBPdXRwdXQgPSB2c2NvZGUud2luZG93LmNyZWF0ZU91dHB1dENoYW5uZWwoJ0Rldk1hdGUgU2V0dXAnKTsKICBjb250ZXh0LnN1YnNjcmlwdGlvbnMucHVzaChzZXR1cE91dHB1dCk7CiAgbWFuYWdlZEF1dGh0b2tlbiA9IGF3YWl0IGNvbnRleHQuc2VjcmV0cy5nZXQoU0VDUkVUX0tFWSkgfHwgJyc7CgogIHJlZ2lzdGVyKGNvbnRleHQsICdkZXZNYXRlLm5ncm9rU2V0dXAnLCAoKSA9PiBndWlkZWRTZXR1cChjb250ZXh0KSk7CiAgcmVnaXN0ZXIoY29udGV4dCwgJ2Rldk1hdGUubmdyb2tTd2l0Y2hBY2NvdW50JywgKCkgPT4gc3dpdGNoQWNjb3VudChjb250ZXh0KSk7CiAgcmVnaXN0ZXIoY29udGV4dCwgJ2Rldk1hdGUubmdyb2tDbGVhckFjY291bnQnLCAoKSA9PiBjbGVhck1hbmFnZWRBY2NvdW50KGNvbnRleHQpKTsKICByZWdpc3Rlcihjb250ZXh0LCAnZGV2TWF0ZS5uZ3Jva0RvY3RvcicsICgpID0+IG5ncm9rRG9jdG9yKCkpOwogIHJlZ2lzdGVyKGNvbnRleHQsICdkZXZNYXRlLm9wZW5OZ3Jva0Rhc2hib2FyZCcsICgpID0+IG9wZW5FeHRlcm5hbChOR1JPS19TRVRVUF9VUkwpKTsKCiAgaW5zdGFsbE1hbmFnZWRTcGF3bkxheWVyKCk7CiAgdHJ5IHsKICAgIGJhc2VFeHRlbnNpb24gPSBsb2FkQmFzZUV4dGVuc2lvbigpOwogICAgYXdhaXQgYmFzZUV4dGVuc2lvbi5hY3RpdmF0ZShjb250ZXh0KTsKICAgIGFjdGl2YXRlZCA9IHRydWU7CiAgICBsb2coYG5ncm9rIGludGVncmF0aW9uIHJlYWR5LiBBY2NvdW50IG1vZGU6ICR7dXNlc01hbmFnZWRBY2NvdW50KCkgPyAnbWFuYWdlZCcgOiAnZ2xvYmFsJ307IG1hbmFnZWQgdG9rZW46ICR7bWFuYWdlZEF1dGh0b2tlbiA/ICdjb25maWd1cmVkJyA6ICdub3QgY29uZmlndXJlZCd9LmApOwogICAgdm9pZCBtYXliZVByb21wdEZvck5ncm9rU2V0dXAoY29udGV4dCk7CiAgfSBjYXRjaCAoZXJyb3IpIHsKICAgIHRyeSB7IGlmIChiYXNlRXh0ZW5zaW9uPy5kZWFjdGl2YXRlKSBhd2FpdCBiYXNlRXh0ZW5zaW9uLmRlYWN0aXZhdGUoKTsgfSBjYXRjaCB7fQogICAgYWN0aXZhdGlvbkF0dGVtcHRlZCA9IGZhbHNlOwogICAgYWN0aXZhdGVkID0gZmFsc2U7CiAgICByZXN0b3JlTWFuYWdlZFNwYXduTGF5ZXIoKTsKICAgIGdsb2JhbENvbnRleHQgPSBudWxsOwogICAgdGhyb3cgZXJyb3I7CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBkZWFjdGl2YXRlKCkgewogIGlmICghYWN0aXZhdGlvbkF0dGVtcHRlZCAmJiAhYWN0aXZhdGVkICYmICFtYW5hZ2VkU3Bhd25MYXllcikgcmV0dXJuOwogIHRyeSB7CiAgICBpZiAoYWN0aXZhdGlvbkF0dGVtcHRlZCAmJiBiYXNlRXh0ZW5zaW9uPy5kZWFjdGl2YXRlKSBhd2FpdCBiYXNlRXh0ZW5zaW9uLmRlYWN0aXZhdGUoKTsKICB9IGZpbmFsbHkgewogICAgYWN0aXZhdGlvbkF0dGVtcHRlZCA9IGZhbHNlOwogICAgYWN0aXZhdGVkID0gZmFsc2U7CiAgICByZXN0b3JlTWFuYWdlZFNwYXduTGF5ZXIoKTsKICAgIGdsb2JhbENvbnRleHQgPSBudWxsOwogICAgc2V0dXBPdXRwdXQgPSBudWxsOwogIH0KfQoKbW9kdWxlLmV4cG9ydHMgPSB7CiAgYWN0aXZhdGUsCiAgZGVhY3RpdmF0ZSwKICBjcmVhdGVFeHRlbnNpb25TcGF3biwKICBpbnN0YWxsTWFuYWdlZFNwYXduTGF5ZXIsCiAgbG9hZEJhc2VFeHRlbnNpb24sCiAgcmVzdG9yZU1hbmFnZWRTcGF3bkxheWVyCn07Cg=='),
  'managed ngrok activation lifecycle'
);

write(
  'extension-entry-win32.js',
  decode('J3VzZSBzdHJpY3QnOwoKY29uc3QgY2hpbGRQcm9jZXNzID0gcmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpOwpjb25zdCBsZWdhY3lFbnRyeSA9IHJlcXVpcmUoJy4vZXh0ZW5zaW9uLWVudHJ5Jyk7CmNvbnN0IHsgY3JlYXRlTmdyb2tDcmVkZW50aWFsQ29tcGF0U3Bhd24gfSA9IHJlcXVpcmUoJy4vbmdyb2stbGF1bmNoLWNvbXBhdCcpOwpjb25zdCB7IFNwYXduTGF5ZXIgfSA9IHJlcXVpcmUoJy4vdnNjb2RlLWhvc3Qvc3Bhd24tbGF5ZXIuanMnKTsKCmxldCBjcmVkZW50aWFsQ29tcGF0TGF5ZXIgPSBudWxsOwpsZXQgYWN0aXZhdGlvbkF0dGVtcHRlZCA9IGZhbHNlOwpsZXQgYWN0aXZhdGVkID0gZmFsc2U7CgpmdW5jdGlvbiBpbnN0YWxsQ3JlZGVudGlhbENvbXBhdExheWVyKCkgewogIGlmIChjcmVkZW50aWFsQ29tcGF0TGF5ZXI/LmFjdGl2ZSkgcmV0dXJuIGNyZWRlbnRpYWxDb21wYXRMYXllcjsKICBjcmVkZW50aWFsQ29tcGF0TGF5ZXIgPSBuZXcgU3Bhd25MYXllcih7CiAgICBjaGlsZFByb2Nlc3MsCiAgICBuYW1lOiAnZGV2bWF0ZS13aW5kb3dzLW5ncm9rLWNyZWRlbnRpYWwtY29tcGF0JywKICAgIHdyYXA6IHByZXZpb3VzU3Bhd24gPT4gY3JlYXRlTmdyb2tDcmVkZW50aWFsQ29tcGF0U3Bhd24ocHJldmlvdXNTcGF3bikKICB9KTsKICByZXR1cm4gY3JlZGVudGlhbENvbXBhdExheWVyLmluc3RhbGwoKTsKfQoKZnVuY3Rpb24gcmVzdG9yZUNyZWRlbnRpYWxDb21wYXRMYXllcigpIHsKICBjb25zdCBsYXllciA9IGNyZWRlbnRpYWxDb21wYXRMYXllcjsKICBjcmVkZW50aWFsQ29tcGF0TGF5ZXIgPSBudWxsOwogIGlmICghbGF5ZXIpIHJldHVybiB7IGRpc3Bvc2VkOiB0cnVlLCBhbHJlYWR5RGlzcG9zZWQ6IHRydWUgfTsKICByZXR1cm4gbGF5ZXIuZGlzcG9zZSgpOwp9Cgphc3luYyBmdW5jdGlvbiBhY3RpdmF0ZShjb250ZXh0KSB7CiAgaWYgKGFjdGl2YXRpb25BdHRlbXB0ZWQgfHwgYWN0aXZhdGVkKSB7CiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcignRGV2TWF0ZSBXaW5kb3dzIGNvbXBhdGliaWxpdHkgaW50ZWdyYXRpb24gaXMgYWxyZWFkeSBhY3RpdmUnKTsKICAgIGVycm9yLmNvZGUgPSAnREVWTUFURV9XSU5ET1dTX0xBWUVSX0FMUkVBRFlfQUNUSVZFJzsKICAgIHRocm93IGVycm9yOwogIH0KICBhY3RpdmF0aW9uQXR0ZW1wdGVkID0gdHJ1ZTsKICBpbnN0YWxsQ3JlZGVudGlhbENvbXBhdExheWVyKCk7CiAgdHJ5IHsKICAgIGF3YWl0IGxlZ2FjeUVudHJ5LmFjdGl2YXRlKGNvbnRleHQpOwogICAgYWN0aXZhdGVkID0gdHJ1ZTsKICB9IGNhdGNoIChlcnJvcikgewogICAgdHJ5IHsgYXdhaXQgbGVnYWN5RW50cnkuZGVhY3RpdmF0ZSgpOyB9IGNhdGNoIHt9CiAgICBhY3RpdmF0aW9uQXR0ZW1wdGVkID0gZmFsc2U7CiAgICBhY3RpdmF0ZWQgPSBmYWxzZTsKICAgIHJlc3RvcmVDcmVkZW50aWFsQ29tcGF0TGF5ZXIoKTsKICAgIHRocm93IGVycm9yOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gZGVhY3RpdmF0ZSgpIHsKICBpZiAoIWFjdGl2YXRpb25BdHRlbXB0ZWQgJiYgIWFjdGl2YXRlZCAmJiAhY3JlZGVudGlhbENvbXBhdExheWVyKSByZXR1cm47CiAgdHJ5IHsKICAgIGlmIChhY3RpdmF0aW9uQXR0ZW1wdGVkKSBhd2FpdCBsZWdhY3lFbnRyeS5kZWFjdGl2YXRlKCk7CiAgfSBmaW5hbGx5IHsKICAgIGFjdGl2YXRpb25BdHRlbXB0ZWQgPSBmYWxzZTsKICAgIGFjdGl2YXRlZCA9IGZhbHNlOwogICAgcmVzdG9yZUNyZWRlbnRpYWxDb21wYXRMYXllcigpOwogIH0KfQoKbW9kdWxlLmV4cG9ydHMgPSB7CiAgYWN0aXZhdGUsCiAgZGVhY3RpdmF0ZSwKICBpbnN0YWxsQ3JlZGVudGlhbENvbXBhdExheWVyLAogIHJlc3RvcmVDcmVkZW50aWFsQ29tcGF0TGF5ZXIKfTsK')
);

console.log('Applied asserted VS Code spawn-layer lifecycle migration.');
