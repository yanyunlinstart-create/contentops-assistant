const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function normalizePublishFieldValueByType');
const end = server.indexOf('function normalizePublishRecordFields', start);
assert(start > 0 && end > start, 'publish field normalization helper not found');

Function('assert', `
function normalizePublishBoolText(value) { return String(value || ''); }
function publishYesText() { return '是'; }
${server.slice(start, end)}

const isoTime = '2026-06-20T15:25:00.886+08:00';
const normalizedIso = normalizePublishFieldValueByType(isoTime, 5);
assert.strictEqual(typeof normalizedIso, 'number');
assert(Number.isFinite(normalizedIso));

const dayTime = normalizePublishFieldValueByType('2026-06-20', 5);
assert.strictEqual(dayTime, new Date('2026-06-20T00:00:00+08:00').getTime());

console.log('server field normalization tests passed');
`)(assert);
