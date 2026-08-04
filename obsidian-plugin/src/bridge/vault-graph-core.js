'use strict';

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function publicGraphRecord(record, depth, includeProperties = false) {
  const output = {
    path: record.path,
    name: record.name,
    folder: record.folder,
    modifiedAt: record.modifiedAt,
    tags: record.tags || [],
    depth
  };
  if (includeProperties) output.properties = record.properties || {};
  return output;
}

function buildReverseLinks(resolvedLinks, recordMap) {
  const reverse = new Map();
  for (const [source, destinations] of Object.entries(resolvedLinks || {})) {
    if (!recordMap.has(source)) continue;
    for (const [target, rawCount] of Object.entries(destinations || {})) {
      if (!recordMap.has(target)) continue;
      const incoming = reverse.get(target) || [];
      incoming.push({ source, target, count: Math.max(1, Number(rawCount) || 1) });
      reverse.set(target, incoming);
    }
  }
  for (const entries of reverse.values()) entries.sort((left, right) => left.source.localeCompare(right.source));
  return reverse;
}

function outgoingEdges(path, resolvedLinks, recordMap) {
  return Object.entries(resolvedLinks?.[path] || {})
    .filter(([target]) => recordMap.has(target))
    .map(([target, rawCount]) => ({ source: path, target, count: Math.max(1, Number(rawCount) || 1) }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function buildVaultGraph(records, resolvedLinks, options = {}) {
  const recordMap = records instanceof Map ? records : new Map((records || []).map(record => [record.path, record]));
  const roots = [...new Set((Array.isArray(options.paths) ? options.paths : []).map(String).filter(Boolean))].slice(0, 50);
  if (!roots.length) throw new Error('At least one root note path is required');
  const direction = ['inbound', 'outbound', 'both'].includes(options.direction) ? options.direction : 'both';
  const depthLimit = boundedInteger(options.depth, 1, 1, 3);
  const maxNodes = boundedInteger(options.maxNodes, 200, 1, 500);
  const maxEdges = boundedInteger(options.maxEdges, 1000, 1, 2000);
  const includeProperties = options.includeProperties === true;
  const reverse = direction === 'outbound' ? new Map() : buildReverseLinks(resolvedLinks, recordMap);
  const nodeDepth = new Map();
  const queue = [];
  const missingRoots = [];
  const omittedRoots = [];
  const truncated = { nodes: false, edges: false };

  for (const root of roots) {
    if (!recordMap.has(root)) {
      missingRoots.push(root);
      continue;
    }
    if (!nodeDepth.has(root)) {
      if (nodeDepth.size >= maxNodes) {
        truncated.nodes = true;
        omittedRoots.push(root);
        continue;
      }
      nodeDepth.set(root, 0);
      queue.push(root);
    }
  }

  const edgeMap = new Map();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const currentDepth = nodeDepth.get(current) || 0;
    if (currentDepth >= depthLimit) continue;
    const edges = [];
    if (direction !== 'inbound') edges.push(...outgoingEdges(current, resolvedLinks, recordMap));
    if (direction !== 'outbound') edges.push(...(reverse.get(current) || []));
    edges.sort((left, right) => {
      const sourceOrder = left.source.localeCompare(right.source);
      return sourceOrder || left.target.localeCompare(right.target);
    });

    for (const edge of edges) {
      const key = `${edge.source}\u0000${edge.target}`;
      const isNewEdge = !edgeMap.has(key);
      if (isNewEdge && edgeMap.size >= maxEdges) {
        truncated.edges = true;
        continue;
      }
      const next = edge.source === current ? edge.target : edge.source;
      if (!nodeDepth.has(next)) {
        if (nodeDepth.size >= maxNodes) {
          truncated.nodes = true;
          continue;
        }
        nodeDepth.set(next, currentDepth + 1);
        queue.push(next);
      }
      if (isNewEdge) edgeMap.set(key, edge);
    }
  }

  const nodes = [...nodeDepth.entries()]
    .map(([path, depth]) => publicGraphRecord(recordMap.get(path), depth, includeProperties))
    .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
  const edges = [...edgeMap.values()].sort((left, right) => {
    const sourceOrder = left.source.localeCompare(right.source);
    return sourceOrder || left.target.localeCompare(right.target);
  });

  return {
    roots: roots.filter(path => nodeDepth.get(path) === 0),
    missingRoots,
    omittedRoots,
    direction,
    depth: depthLimit,
    nodes,
    edges,
    truncated
  };
}

module.exports = {
  buildReverseLinks,
  buildVaultGraph,
  boundedInteger,
  publicGraphRecord
};
