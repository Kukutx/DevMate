#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    (root / name).write_text(value.rstrip() + '\n', encoding='utf-8')


gateway = read('tests/smoke-gateway.mjs')
old_gateway = """async function rpc(method, params, authToken = token) {
  const url = authToken
    ? `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(authToken)}`
    : `http://127.0.0.1:${port}/mcp`;
  return fetchJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}"""
new_gateway = """async function rpc(method, params, authToken = token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}"""
if old_gateway not in gateway:
    raise RuntimeError('Could not convert Gateway smoke authentication')
write('tests/smoke-gateway.mjs', gateway.replace(old_gateway, new_gateway, 1))

local = read('tests/smoke-local-capabilities.mjs')
old_local = """async function rpc(method, params) {
  return fetchJson(`http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}"""
new_local = """async function rpc(method, params) {
  return fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}"""
if old_local not in local:
    raise RuntimeError('Could not convert local capability smoke authentication')
write('tests/smoke-local-capabilities.mjs', local.replace(old_local, new_local, 1))

for relative in ['tests/smoke-gateway.mjs', 'tests/smoke-local-capabilities.mjs']:
    source = read(relative)
    if '/mcp?token=' in source or "searchParams.set('token'" in source:
        raise RuntimeError(f'Query credentials remain in {relative}')
    if 'authorization' not in source.lower() or 'Bearer' not in source:
        raise RuntimeError(f'Bearer authentication missing from {relative}')

Path(__file__).unlink()
print('Converted Gateway smoke clients to bearer-header authentication.')
