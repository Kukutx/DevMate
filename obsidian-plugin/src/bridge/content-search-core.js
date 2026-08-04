'use strict';

const MAX_QUERY_CHARS = 500;
const MAX_SEARCH_TERMS = 20;
const MAX_OCCURRENCES_PER_TERM = 50;

function normalizeMode(value) {
  const mode = String(value || 'all').toLowerCase();
  return ['phrase', 'all', 'any'].includes(mode) ? mode : 'all';
}

function normalizeQuery(value) {
  const query = String(value || '').trim();
  if (!query) throw new Error('Search query is required');
  if (query.length > MAX_QUERY_CHARS) throw new Error(`Search query exceeds ${MAX_QUERY_CHARS} characters`);
  return query;
}

function phraseTerm(query) {
  let phrase = normalizeQuery(query);
  const first = phrase[0];
  const last = phrase[phrase.length - 1];
  if (phrase.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    phrase = phrase.slice(1, -1).trim();
  }
  if (!phrase) throw new Error('Search query does not contain a searchable phrase');
  return phrase;
}

function tokenizeQuery(query, mode = 'all') {
  const normalized = normalizeQuery(query);
  if (normalizeMode(mode) === 'phrase') return [phraseTerm(normalized)];
  const output = [];
  const seen = new Set();
  const pattern = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(normalized))) {
    const term = String(match[1] || match[2] || match[3] || '').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (output.length >= MAX_SEARCH_TERMS) {
      throw new Error(`Search query exceeds ${MAX_SEARCH_TERMS} unique terms`);
    }
    seen.add(key);
    output.push(term);
  }
  if (!output.length) throw new Error('Search query does not contain searchable terms');
  return output;
}

function countOccurrences(text, term, limit = MAX_OCCURRENCES_PER_TERM) {
  if (!term) return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  let offset = 0;
  while (count < limit) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    if (first < 0) first = index;
    count += 1;
    offset = index + Math.max(1, term.length);
  }
  return { count, first };
}

function lineNumberAt(text, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function buildSnippet(content, index, matchLength, maxChars = 280) {
  const text = String(content || '');
  const size = Math.max(80, Math.min(1000, Number(maxChars) || 280));
  const center = Math.max(0, Number(index) || 0);
  let start = Math.max(0, center - Math.floor((size - matchLength) / 2));
  let end = Math.min(text.length, start + size);
  if (end - start < size) start = Math.max(0, end - size);
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '… ' : ''}${raw}${end < text.length ? ' …' : ''}`;
}

function searchDocument(content, options = {}) {
  const text = String(content || '');
  const query = normalizeQuery(options.query);
  const mode = normalizeMode(options.mode);
  const caseSensitive = options.caseSensitive === true;
  const terms = tokenizeQuery(query, mode);
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needles = caseSensitive ? terms : terms.map(term => term.toLowerCase());
  const matches = needles.map(needle => countOccurrences(haystack, needle));
  const matchedTerms = matches.filter(item => item.count > 0).length;
  const matched = mode === 'any' ? matchedTerms > 0 : matchedTerms === needles.length;
  if (!matched) return { matched: false, terms };

  const totalOccurrences = matches.reduce((total, item) => total + item.count, 0);
  const firstMatch = matches.reduce((earliest, item) => item.first >= 0 ? Math.min(earliest, item.first) : earliest, Infinity);
  const firstTermIndex = matches.findIndex(item => item.first === firstMatch);
  const matchLength = firstTermIndex >= 0 ? needles[firstTermIndex].length : 1;
  const coverage = matchedTerms / needles.length;
  const phraseBonus = mode === 'phrase' ? 200 : 0;
  const score = phraseBonus + Math.round(coverage * 100) + Math.min(100, totalOccurrences * 4);

  return {
    matched: true,
    terms,
    matchedTerms,
    totalOccurrences,
    score,
    line: lineNumberAt(text, firstMatch),
    snippet: buildSnippet(text, firstMatch, matchLength, options.snippetChars)
  };
}

function metadataScore(record, terms, caseSensitive = false) {
  const normalize = value => caseSensitive ? String(value || '') : String(value || '').toLowerCase();
  const needles = caseSensitive ? terms : terms.map(term => term.toLowerCase());
  const name = normalize(record?.name);
  const path = normalize(record?.path);
  const headings = normalize((record?.headings || []).map(item => item.heading).join('\n'));
  const tags = normalize((record?.tags || []).join(' '));
  let score = 0;
  for (const term of needles) {
    if (name.includes(term)) score += 80;
    if (path.includes(term)) score += 40;
    if (headings.includes(term)) score += 25;
    if (tags.includes(term)) score += 10;
  }
  return score;
}

module.exports = {
  MAX_QUERY_CHARS,
  MAX_SEARCH_TERMS,
  buildSnippet,
  countOccurrences,
  metadataScore,
  normalizeMode,
  normalizeQuery,
  phraseTerm,
  searchDocument,
  tokenizeQuery
};
