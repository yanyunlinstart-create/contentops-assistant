const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');

function sliceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  const end = html.indexOf(endNeedle, start);
  assert(start > 0 && end > start, `${startNeedle} helper not found`);
  return html.slice(start, end);
}

const dailyHelpers = sliceBetween('function buildTodayReportGovernanceStatus', 'function classifyFeishuDailyReportSaveError');
const draftFieldHelper = sliceBetween('function putDraftField', 'async function syncDraftToFeishu');
const marketingFieldHelper = sliceBetween('function buildFeishuMarketingFields', 'function buildFeishuMarketingDeletedFields');
const marketingDeletedHelper = sliceBetween('function buildFeishuMarketingDeletedFields', 'async function syncMarketingRecordToFeishu');

Function('assert', `
function dateKey(){ return '2026-06-20'; }
function normalizeMarketingDay(value,fallback=dateKey()){ return String(value || fallback).slice(0, 10); }
function addDaysToKey(day,delta){ const d = new Date(day + 'T00:00:00+08:00'); d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }
function getCurrentAccs(){ return [{id:1,name:'A',device:'1'}]; }
function isDraftPublished(d){ return !!(d && d.used); }
function syncPostPublishReviewState(){}
function formatLabel(value){ return value || ''; }
function isPostPublishArchived(item){ return !!(item && (item.postPublishDisposition === 'historical_unfilled' || item.postPublishArchivedAt)); }
function isSpecifiedMarketingRecord(){ return false; }
function getSpecifiedMarketingRecordContent(){ return ''; }
function marketingSourceLabel(value){ return value || ''; }
const POST_PUBLISH_REASON_LABEL = { account_exception: '账号异常' };
${dailyHelpers}
${draftFieldHelper}
${marketingFieldHelper}
${marketingDeletedHelper}

const reportFields = buildFeishuDailyReportFields({
  day: '2026-06-20',
  sourceLabel: '本地账号',
  activeAccounts: 3,
  published: [{}, {}],
  unpublished: [{}],
  rate: '66.7%',
  postPublishStats: {
    missedReview: 1,
    first20: 0,
    abnormal2h: 0,
    delete24h: 0,
    final48h: 0,
    historicalUnfilled: 2,
    deletedFeedback: 0,
    newFailureSamples: 0
  },
  openTasks: [],
  failedTasks: [],
  govStats: {}
}, '日报正文');
assert.strictEqual(reportFields['逾期待补录数量'], 1);
assert.strictEqual(reportFields['历史未补录归档数量'], 2);
assert(reportFields['创建时间']);
assert(reportFields['更新时间']);

const archivedDraftFields = buildFeishuDraftFields({
  id: 'draft_archived',
  used: true,
  accId: 1,
  topic: 'archived draft',
  dataReviewStatus: '\\u5386\\u53f2\\u672a\\u8865\\u5f55\\uff0c\\u5df2\\u5f52\\u6863',
  postPublishDisposition: 'historical_unfilled',
  abnormalReason: 'account_exception',
  operationDiagnosis: { ruleName: 'old rule', hypothesis: 'old hypothesis', confidence: 'high' }
});
assert.strictEqual(archivedDraftFields['\\u6570\\u636e\\u56de\\u8bbf\\u72b6\\u6001'], '\\u5386\\u53f2\\u672a\\u8865\\u5f55\\uff0c\\u5df2\\u5f52\\u6863');
assert.strictEqual(archivedDraftFields['\\u5f02\\u5e38\\u539f\\u56e0'], undefined);
assert.strictEqual(archivedDraftFields['\\u8fd0\\u8425\\u8bca\\u65ad\\u89c4\\u5219'], undefined);

const archivedMarketingFields = buildFeishuMarketingFields({
  id: 'marketing_archived',
  postedAt: '2026-06-20',
  title: 'archived marketing',
  postPublishDisposition: 'historical_unfilled',
  operationDiagnosis: { ruleName: 'old rule', hypothesis: 'old hypothesis', confidence: 'high' }
}, '');
assert.strictEqual(archivedMarketingFields['\\u8fd0\\u8425\\u8bca\\u65ad\\u89c4\\u5219'], undefined);

const deletedFields = buildFeishuMarketingDeletedFields({
  id: 'marketing_1',
  postedAt: '2026-06-20',
  accName: '账号A',
  device: '设备1',
  title: '营销内容',
  deleteReason: '已处理'
});
assert.strictEqual(deletedFields['是否已删除'], true);
assert.strictEqual(deletedFields['当前状态'], '已删除');
assert(deletedFields['删除完成日期'], 'deleted marketing update should include completion time');

console.log('feishu optional fields tests passed');
`)(assert);
