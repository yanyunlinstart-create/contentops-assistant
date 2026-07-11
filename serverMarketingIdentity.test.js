const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function marketingFieldAliasMap');
const end = server.indexOf('async function listBitableFields', start);
assert(start > 0 && end > start, 'marketing identity helpers not found');

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
function normalizePublishIdentityDay(value) { return String(value || '').slice(0, 10); }
function getPublishFieldTypeByName() { return new Map(); }
function canonicalPublishFieldName(name) { return String(name || '').replace(/\\s+/g, '').toLowerCase(); }
\n${server.slice(start, end)}

const identity = getMarketingRecordIdentity({
  '本地营销记录ID': 'm_1',
  '营销发布日期': '2026-06-20',
  '账号名': '声声漫',
  '设备号': '164',
  '营销内容标题': '外部营销内容'
}, []);

let result = findMarketingIdentityMatches([
  { fields: { '本地营销记录ID': 'm_1', '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': '完全不同标题' } }
], identity, []);
assert.strictEqual(result.matchMode, 'local_id');
assert.strictEqual(result.records.length, 1);

result = findMarketingIdentityMatches([
  { fields: { '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': '外部 营销内容！' } }
], {...identity, localId: ''}, []);
assert.strictEqual(result.matchMode, 'base_unique');
assert.strictEqual(result.records.length, 1);

result = findMarketingIdentityMatches([
  { fields: { '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': '外部营销内容' } },
  { fields: { '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': '外部营销内容' } }
], {...identity, localId: ''}, []);
assert.strictEqual(result.matchMode, 'base_title_ambiguous');
assert.strictEqual(result.records.length, 0);
assert.strictEqual(result.baseCount, 2);

result = findMarketingIdentityMatches([
  { fields: { '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': 'A' } },
  { fields: { '营销发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '营销内容标题': 'B' } }
], {...identity, localId: '', title: 'Z'}, []);
assert.strictEqual(result.matchMode, 'base_ambiguous');
assert.strictEqual(result.records.length, 0);
assert.strictEqual(result.baseCount, 2);

const message = describeMarketingIdentityMatchFailure({ matchMode: 'base_ambiguous', baseCount: 2 });
assert(message.includes('2'));

console.log('server marketing identity tests passed');
`)(assert);
