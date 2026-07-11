const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

const updateStart = scripts.indexOf('function updateLocalPublishRecordSyncState');
const updateEnd = scripts.indexOf('function removePendingPublishCreateSyncTask', updateStart);
const queueStart = scripts.indexOf('function markMatchingFeishuSyncTasksDone');
const queueEnd = scripts.indexOf('function getFeishuQueueSummary', queueStart);
const enqueueStart = scripts.indexOf('function getQueueTaskIndex');
const enqueueEnd = scripts.indexOf('function markFeishuSyncSuccess', enqueueStart);
const successStart = scripts.indexOf('function markFeishuSyncSuccess');
const successEnd = scripts.indexOf('function updateFeishuQueueTask', successStart);
const classifyStart = scripts.indexOf('function classifyFeishuSyncError');
const classifyEnd = scripts.indexOf('function getQueueTaskIndex', classifyStart);
assert(updateStart > 0 && updateEnd > updateStart, 'publish sync state helper not found');
assert(queueStart > 0 && queueEnd > queueStart, 'queue completion helper not found');
assert(enqueueStart > 0 && enqueueEnd > enqueueStart, 'queue enqueue helper not found');
assert(successStart > 0 && successEnd > successStart, 'sync success helper not found');
assert(classifyStart > 0 && classifyEnd > classifyStart, 'sync error classifier not found');

Function('assert', `
var savedState = null;
var state = {
  publishRecords: [
    { id: 'p_1', publishRecordId: 'p_1', syncStatus: 'failed', feishuRecordId: 'rec_old', lastSyncError: 'old error' }
  ]
};
function getLib() { return state; }
function ensurePublishRecordsState(s) { return s.publishRecords || (s.publishRecords = []); }
function save(s) { savedState = JSON.parse(JSON.stringify(s)); }
${scripts.slice(updateStart, updateEnd)}

const record = { id: 'p_1', publishRecordId: 'p_1', syncStatus: 'failed', feishuRecordId: 'rec_old' };
updateLocalPublishRecordSyncState(record, {
  syncStatus: 'deleted',
  feishuRecordId: '',
  lastDeletedSyncedAt: '2026-06-20T00:00:00.000Z',
  lastSyncError: ''
});
assert.strictEqual(record.syncStatus, 'deleted');
assert.strictEqual(state.publishRecords[0].syncStatus, 'deleted');
assert.strictEqual(state.publishRecords[0].feishuRecordId, '');
assert.strictEqual(state.publishRecords[0].lastSyncError, '');
assert(savedState, 'state should be saved when matching publish record exists');

var queue = [
  { id: 'a', type: 'publish_record_create', localRefId: 'record:p_1', status: 'failed', lastError: 'old' },
  { id: 'b', type: 'publish_record_create', localRefId: 'record:p_1', status: 'pending', lastError: 'old pending' },
  { id: 'c', type: 'publish_record_create', localRefId: 'record:p_2', status: 'failed', lastError: 'other' },
  { id: 'd', type: 'publish_record_delete', localRefId: 'record:p_1', status: 'failed', lastError: 'other type' },
  { id: 'e', type: 'publish_record_create', localRefId: 'record:p_1', status: 'done', lastError: 'already done' }
];
var savedQueue = null;
function getFeishuSyncQueue() { return queue; }
function saveFeishuSyncQueue(next) { savedQueue = next; queue = next; }
function renderFeishuSyncStatusPanel() {}
function renderFeishuSyncQueueDetails() {}
${scripts.slice(queueStart, queueEnd)}

const count = markMatchingFeishuSyncTasksDone('publish_record_create', 'record:p_1');
assert.strictEqual(count, 2);
assert(savedQueue, 'queue should be saved when matching tasks are completed');
assert.strictEqual(queue.find(t => t.id === 'a').status, 'done');
assert.strictEqual(queue.find(t => t.id === 'a').lastError, '');
assert.strictEqual(queue.find(t => t.id === 'b').status, 'done');
assert.strictEqual(queue.find(t => t.id === 'c').status, 'failed');
assert.strictEqual(queue.find(t => t.id === 'd').status, 'failed');
assert.strictEqual(queue.find(t => t.id === 'e').lastError, 'already done');

console.log('feishu sync state tests passed');
`)(assert);

Function('assert', `
var queue = [];
var status = {};
var statusRenderCount = 0;
var detailRenderCount = 0;
function classifyFeishuSyncError(error) { return error.message || String(error); }
function getFeishuSyncQueue() { return queue; }
function saveFeishuSyncQueue(next) { queue = next; }
function saveFeishuSyncStatus(patch) { status = { ...status, ...(patch || {}) }; }
function renderFeishuSyncStatusPanel() { statusRenderCount += 1; }
function renderFeishuSyncQueueDetails() { detailRenderCount += 1; }
${scripts.slice(enqueueStart, enqueueEnd)}

const queued = enqueueFeishuSyncTask('marketing_record_update', { id: 1 }, 'm_1', new Error('missing record'));
assert.strictEqual(queued, true);
assert.strictEqual(queue.length, 1);
assert.strictEqual(status.connection, 'failed');
assert.strictEqual(statusRenderCount, 1);
assert.strictEqual(detailRenderCount, 1);
`)(assert);

Function('assert', `
${scripts.slice(classifyStart, classifyEnd)}

const message = classifyFeishuSyncError(new Error('飞书返回 1254064：DatetimeFieldConvFail'));
assert(message.includes('日期字段格式不匹配'));
assert(message.includes('重新测试飞书连接'));
`)(assert);

Function('assert', `
var syncStatus = {
  connection: 'warning',
  lastSyncAt: '',
  lastError: 'old sync error',
  fieldAuditStatus: 'error',
  fieldAuditError: '字段体检发现 2 张表缺关键字段，请先修正 table_id 或字段名。'
};
function getFeishuSyncStatus() { return syncStatus; }
function saveFeishuSyncStatus(patch) { syncStatus = { ...syncStatus, ...(patch || {}) }; return syncStatus; }
${scripts.slice(successStart, successEnd)}

markFeishuSyncSuccess();
assert.strictEqual(syncStatus.connection, 'warning');
assert.strictEqual(syncStatus.lastError, '');
assert.strictEqual(syncStatus.fieldAuditStatus, 'error');
assert(syncStatus.fieldAuditError.includes('缺关键字段'));

syncStatus = { connection: 'failed', lastSyncAt: '', lastError: 'network', fieldAuditStatus: '', fieldAuditError: '' };
markFeishuSyncSuccess();
assert.strictEqual(syncStatus.connection, 'success');
assert.strictEqual(syncStatus.lastError, '');
assert.strictEqual(syncStatus.fieldAuditError, '');
`)(assert);
