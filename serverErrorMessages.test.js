const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function formatPublishRecordErrorMessage');
const end = server.indexOf('async function handleDebugNetwork', start);
const accountValidateStart = server.indexOf('function validateAccountsListPayload');
const accountValidateEnd = server.indexOf('function validatePublishRecordCreatePayload', accountValidateStart);
assert(start > 0 && end > start, 'server error message helpers not found');
assert(accountValidateStart > 0 && accountValidateEnd > accountValidateStart, 'account validation helpers not found');

Function('assert', `
${server.slice(accountValidateStart, accountValidateEnd)}
function describePublishIdentityMatchFailure() { return ''; }
function describeMarketingIdentityMatchFailure() { return ''; }
${server.slice(start, end)}

assert.throws(() => validateAccountsListPayload({ appToken: '', tables: { accounts: 'tbl_accounts' } }), error => {
  assert(error.message.includes('app_token'));
  return true;
});

assert.throws(() => validateAccountsListPayload({ appToken: 'app_token', tables: {} }), error => {
  assert(error.message.includes('table_id'));
  return true;
});

assert.throws(() => validateAccountsUpdatePayload({ appToken: 'app_token', tableId: 'tbl_accounts', fields: {} }), error => {
  assert(error.message.includes('record_id'));
  return true;
});

let message = formatDraftCreateErrorMessage({ details: { code: 91403, msg: 'forbidden' } });
assert(message.includes('飞书文案库权限不足'));
assert(!/Feishu draft table permission denied/i.test(message));

message = formatDraftCreateErrorMessage({ details: { code: 123, msg: 'bad field' } });
assert(message.includes('飞书返回 123'));
assert(!/Feishu returned/i.test(message));

message = formatDraftCreateErrorMessage({ details: { code: 1254064, msg: 'DatetimeFieldConvFail' } });
assert(message.includes('日期字段格式不匹配'));

message = formatMarketingRecordErrorMessage({ details: { code: 91403, msg: 'forbidden' } }, '更新');
assert(message.includes('飞书营销记录表权限不足'));
assert(!/Feishu marketing table permission denied/i.test(message));

message = formatMarketingRecordErrorMessage({ details: { code: 1254064, msg: 'DatetimeFieldConvFail' } }, '更新');
assert(message.includes('日期字段格式不匹配'));

message = formatMarketingRecordErrorMessage({ details: { code: 456, msg: 'bad field' } }, '更新');
assert(message.includes('飞书返回 456'));
assert(!/Feishu returned/i.test(message));

console.log('server error message tests passed');
`)(assert);
