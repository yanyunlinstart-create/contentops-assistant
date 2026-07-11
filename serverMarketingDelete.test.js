const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('async function deleteMarketingBitableRecordByIdentity');
const end = server.indexOf('async function handleAccountsList', start);
assert(start > 0 && end > start, 'marketing delete helper not found');

Function('assert', `
const console = { log() {} };
let listedRecords = false;
let matchedIdentity = false;
const deleted = [];

async function listBitableFields() { return []; }
function completeMarketingStatusFields(fields) { return fields; }
function getMarketingRecordIdentity() {
  return { localId: '', postedAt: '', accountName: '', device: '', title: '' };
}
function getMissingMarketingIdentityFields() { return ['营销发布日期']; }
async function listBitableRecords() {
  listedRecords = true;
  return [{ record_id: 'rec_other' }];
}
function findMarketingIdentityMatches() {
  matchedIdentity = true;
  return { records: [{ record_id: 'rec_other' }], matchMode: 'base_unique' };
}
async function deleteMarketingBitableRecord(appToken, tableId, recordId) {
  deleted.push(recordId);
  return { code: 0, msg: 'ok', data: { record_id: recordId } };
}
function wait() { return Promise.resolve(); }

${server.slice(start, end)}

return (async () => {
  const result = await deleteMarketingBitableRecordByIdentity('app', 'tbl', {}, 'token', 'rec_exact');
  assert.deepStrictEqual(deleted, ['rec_exact']);
  assert.strictEqual(listedRecords, false, 'explicit record_id delete should not scan identity candidates');
  assert.strictEqual(matchedIdentity, false, 'explicit record_id delete should not use identity fallback');
  assert.strictEqual(result.matchMode, 'explicit_record_id');
  assert.strictEqual(result.deletedCount, 1);

  await assert.rejects(
    () => deleteMarketingBitableRecordByIdentity('app', 'tbl', {}, 'token', ''),
    error => {
      assert.strictEqual(error.status, 400);
      assert(Array.isArray(error.details.missingFields));
      return true;
    }
  );
})();
`)(assert).then(() => {
  console.log('server marketing delete tests passed');
});
