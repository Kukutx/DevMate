'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveStateDirectory } = require('../host/runtime-controller.js');

function currentWorkspaceRoot(vscode) {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function workspaceFolders(vscode) {
  return (vscode.workspace.workspaceFolders || []).map(folder => ({
    name: folder.name,
    path: folder.uri.fsPath,
    index: folder.index
  }));
}

function setting(vscode, name, fallback) {
  const value = vscode.workspace.getConfiguration('devMate').get(name);
  return value === undefined ? fallback : value;
}

function resolveVscodeStateDirectory(vscode, context) {
  const workspaceRoot = currentWorkspaceRoot(vscode);
  if (!workspaceRoot) return context.globalStorageUri.fsPath;
  const shared = setting(vscode, 'sharedRuntimeEnabled', true) !== false;
  const stateDirectory = resolveStateDirectory({
    workspaceRoot,
    overrideDirectory: String(setting(vscode, 'sharedStateDirectory', '') || '').trim(),
    localDirectory: context.globalStorageUri.fsPath,
    shared
  });
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stateDirectory, 0o700); } catch {}
  return stateDirectory;
}

function createRuntimeContext(vscode, context) {
  const stateDirectory = resolveVscodeStateDirectory(vscode, context);
  if (path.resolve(stateDirectory) === path.resolve(context.globalStorageUri.fsPath)) return context;
  const storageUri = vscode.Uri.file(stateDirectory);
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'globalStorageUri') return storageUri;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function runtimeConfigPath(context) {
  return path.join(context.globalStorageUri.fsPath, 'config.json');
}

function gatewayCandidates(context) {
  return [
    path.join(context.extensionPath, 'gateway', 'server.bundle.mjs'),
    path.join(context.extensionPath, 'gateway', 'server.mjs')
  ];
}

function existingGatewayEntry(context) {
  return gatewayCandidates(context).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || '';
}

module.exports = {
  createRuntimeContext,
  currentWorkspaceRoot,
  existingGatewayEntry,
  gatewayCandidates,
  resolveVscodeStateDirectory,
  runtimeConfigPath,
  setting,
  workspaceFolders
};
