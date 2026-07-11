const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function assertNormalizedFieldsNotEmpty');
const end = server.indexOf('function shanghaiDateKeyFromTime', start);
assert(start > 0 && end > start, 'field mismatch helper not found');

Function('assert', `
${server.slice(start, end)}

assert.doesNotThrow(() => assertNormalizedFieldsNotEmpty(
  '发布记录表',
  { '发布日期': '2026-06-20' },
  { '发布日期': '2026-06-20' },
  [{ field_name: '发布日期' }]
));

assert.doesNotThrow(() => assertNormalizedFieldsNotEmpty(
  '发布记录表',
  { '发布日期': '2026-06-20' },
  {},
  []
));

assert.throws(() => assertNormalizedFieldsNotEmpty(
  '发布记录表',
  { '发布日期': '2026-06-20', '账号名': 'A' },
  {},
  [{ field_name: '完全不相关字段' }]
), error => {
  assert.strictEqual(error.status, 400);
  assert.strictEqual(error.details.reason, 'field_mismatch');
  assert(error.message.includes('发布记录表字段未匹配'));
  assert(error.details.requestedFields.includes('发布日期'));
  assert(error.details.availableFields.includes('完全不相关字段'));
  return true;
});

console.log('server field mismatch tests passed');
`)(assert);
