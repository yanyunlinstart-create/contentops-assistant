const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function draftFieldAliasMap');
const end = server.indexOf('function marketingFieldAliasMap', start);
assert(start > 0 && end > start, 'draft identity helpers not found');

Function('assert', `
function normalizeFeishuCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(normalizeFeishuCellValue).filter(Boolean).join('、');
  if (typeof value === 'object') {
    if (value.text !== undefined) return normalizeFeishuCellValue(value.text);
    if (value.name !== undefined) return normalizeFeishuCellValue(value.name);
    if (value.value !== undefined) return normalizeFeishuCellValue(value.value);
  }
  return String(value || '').trim();
}
function getPublishFieldTypeByName() { return new Map(); }
function canonicalPublishFieldName(name) { return String(name || '').replace(/\\s+/g, '').toLowerCase(); }
function normalizeMarketingIdentityText(value) { return normalizeFeishuCellValue(value).replace(/\\s+/g, '').trim(); }
\n${server.slice(start, end)}

const identity = getDraftRecordIdentity({ '本地文案ID': 'd_1' }, []);
let result = findDraftIdentityMatches([
  { fields: { '本地文案ID': 'd_1', '选题': '旧标题' } }
], identity, []);
assert.strictEqual(result.matchMode, 'local_id');
assert.strictEqual(result.records.length, 1);

result = findDraftIdentityMatches([
  { fields: { '本地文案ID': 'd_2', '选题': '旧标题' } }
], identity, []);
assert.strictEqual(result.matchMode, 'none');
assert.strictEqual(result.records.length, 0);

console.log('server draft identity tests passed');
`)(assert);
