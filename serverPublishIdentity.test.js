const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function publishFieldAliasMap');
const end = server.indexOf('function normalizePublishPreviewBool', start);
assert(start > 0 && end > start, 'publish identity helpers not found');

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
function normalizePublishBoolText(value) { return String(value || ''); }
function normalizePublishFieldValueByType(value) { return value; }
function shanghaiDateKeyFromTime(time) { return new Date(time).toISOString().slice(0, 10); }
function canonicalPublishFieldName(name) { return String(name || '').normalize('NFKC').replace(/[\\s\\u3000]+/g, '').replace(/[\\/\\uff0f\\\\|]/g, '').replace(/[()（）【】[\\]_-]+/g, '').toLowerCase(); }
\n${server.slice(start, end)}

const identity = getPublishRecordIdentity({
  '发布记录ID': 'p_1',
  '发布日期': '2026-06-20',
  '账号名': '声声漫',
  '设备号': '164',
  '内容类型': '营销内容',
  '内容标题 / 选题': '外部营销内容',
  '本地文案ID': 'draft_1',
  '本地营销记录ID': 'marketing_1'
}, []);
assert.strictEqual(identity.draftId, 'draft_1');
assert.strictEqual(identity.marketingRecordId, 'marketing_1');

let result = findPublishIdentityMatches([
  { fields: { '发布记录ID': 'p_1', '发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '内容标题 / 选题': '旧标题' } }
], identity, [], { conservativeFallback: true });
assert.strictEqual(result.matchMode, 'record_id');
assert.strictEqual(result.records.length, 1);

result = findPublishIdentityMatches([
  { fields: { '发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '内容类型': '营销内容', '内容标题 / 选题': '外部 营销内容！' } }
], identity, [], { conservativeFallback: true });
assert.strictEqual(result.matchMode, 'base_unique');
assert.strictEqual(result.records.length, 1);

result = findPublishIdentityMatches([
  { fields: { '发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '内容标题 / 选题': 'A' } },
  { fields: { '发布日期': '2026-06-20', '账号名': '声声漫', '设备号': '164号', '内容标题 / 选题': 'B' } }
], identity, [], { conservativeFallback: true });
assert.strictEqual(result.matchMode, 'base_ambiguous');
assert.strictEqual(result.records.length, 0);
assert.strictEqual(result.baseCount, 2);

const preciseIdentity = getPublishRecordIdentity({
  '\\u53d1\\u5e03\\u8bb0\\u5f55ID': 'pub_precise',
  '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20',
  '\\u8d26\\u53f7\\u540d': 'account A',
  '\\u8bbe\\u5907\\u53f7': '164',
  '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'exact title',
  '\\u672c\\u5730\\u6587\\u6848ID': 'draft_exact'
}, []);
result = findPublishIdentityMatches([
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164', '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'other title' } },
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164', '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'old title', '\\u672c\\u5730\\u6587\\u6848ID': 'draft_exact' } },
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164' } }
], preciseIdentity, [], { conservativeFallback: true });
assert.strictEqual(result.matchMode, 'base_local_id_unique');
assert.strictEqual(result.records.length, 1);

const titleIdentity = getPublishRecordIdentity({
  '\\u53d1\\u5e03\\u8bb0\\u5f55ID': 'pub_title',
  '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20',
  '\\u8d26\\u53f7\\u540d': 'account A',
  '\\u8bbe\\u5907\\u53f7': '164',
  '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'exact title'
}, []);
result = findPublishIdentityMatches([
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164', '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'other title' } },
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164', '\\u5185\\u5bb9\\u6807\\u9898 / \\u9009\\u9898': 'exact title' } },
  { fields: { '\\u53d1\\u5e03\\u65e5\\u671f': '2026-06-20', '\\u8d26\\u53f7\\u540d': 'account A', '\\u8bbe\\u5907\\u53f7': '164' } }
], titleIdentity, [], { conservativeFallback: true });
assert.strictEqual(result.matchMode, 'base_title_unique');
assert.strictEqual(result.records.length, 1);

const message = describePublishIdentityMatchFailure({ matchMode: 'base_ambiguous', baseCount: 2 });
assert(message.includes('2'));

console.log('server publish identity tests passed');
`)(assert);
