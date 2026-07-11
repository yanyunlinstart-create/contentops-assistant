const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('async function deletePublishBitableRecordByIdentity');
const end = server.indexOf('async function createDraftBitableRecord', start);
assert(start > 0 && end > start, 'publish delete helper not found');

Function('assert', `
const console = { log() {} };
let listedRecords = false;
let matchedIdentity = false;
const deleted = [];

async function listBitableFields() { return []; }
function getPublishRecordIdentity() {
  return { publishRecordId: '', publishDate: '', accountName: '', device: '' };
}
async function listBitableRecords() {
  listedRecords = true;
  return [{ record_id: 'rec_other' }];
}
function findPublishIdentityMatches() {
  matchedIdentity = true;
  return { records: [{ record_id: 'rec_other' }], matchMode: 'base_unique' };
}
async function deletePublishBitableRecord(appToken, tableId, recordId) {
  deleted.push(recordId);
  return { code: 0, msg: 'ok', data: { record_id: recordId } };
}
function wait() { return Promise.resolve(); }

${server.slice(start, end)}

return (async () => {
  const result = await deletePublishBitableRecordByIdentity('app', 'tbl', {}, 'token', 'rec_exact');
  assert.deepStrictEqual(deleted, ['rec_exact']);
  assert.strictEqual(listedRecords, false, 'explicit record_id delete should not scan identity candidates');
  assert.strictEqual(matchedIdentity, false, 'explicit record_id delete should not use identity fallback');
  assert.strictEqual(result.matchMode, 'explicit_record_id');
  assert.strictEqual(result.deletedCount, 1);

  await assert.rejects(
    () => deletePublishBitableRecordByIdentity('app', 'tbl', {}, 'token', ''),
    error => {
      assert.strictEqual(error.status, 400);
      assert(error.message.includes('Missing publish record delete identity'));
      return true;
    }
  );
})();
`)(assert).then(() => {
  console.log('server publish delete tests passed');
});
