'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildVaultGraph } = require('../obsidian-plugin/src/bridge/vault-graph-core.js');

function note(path) {
  const name = path.split('/').pop().replace(/\.md$/, '');
  return {
    path,
    name,
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    modifiedAt: '2026-08-04T00:00:00.000Z',
    tags: [],
    properties: { status: 'active' }
  };
}

const records = ['A.md', 'B.md', 'C.md', 'D.md'].map(note);
const links = {
  'A.md': { 'B.md': 2, 'C.md': 1 },
  'B.md': { 'D.md': 1 },
  'C.md': { 'D.md': 3 }
};

test('builds deterministic outbound graph neighborhoods', () => {
  const graph = buildVaultGraph(records, links, { paths: ['A.md'], direction: 'outbound', depth: 2 });
  assert.deepEqual(graph.nodes.map(node => [node.path, node.depth]), [
    ['A.md', 0], ['B.md', 1], ['C.md', 1], ['D.md', 2]
  ]);
  assert.deepEqual(graph.edges, [
    { source: 'A.md', target: 'B.md', count: 2 },
    { source: 'A.md', target: 'C.md', count: 1 },
    { source: 'B.md', target: 'D.md', count: 1 },
    { source: 'C.md', target: 'D.md', count: 3 }
  ]);
});

test('supports inbound traversal and missing roots', () => {
  const graph = buildVaultGraph(records, links, { paths: ['D.md', 'Missing.md'], direction: 'inbound', depth: 2 });
  assert.deepEqual(graph.missingRoots, ['Missing.md']);
  assert.deepEqual(graph.nodes.map(node => node.path), ['D.md', 'B.md', 'C.md', 'A.md']);
});

test('enforces node and edge bounds and optionally includes properties', () => {
  const graph = buildVaultGraph(records, links, {
    paths: ['A.md'], direction: 'outbound', depth: 3, maxNodes: 2, maxEdges: 1, includeProperties: true
  });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.truncated.nodes, true);
  assert.equal(graph.nodes[0].properties.status, 'active');
});
