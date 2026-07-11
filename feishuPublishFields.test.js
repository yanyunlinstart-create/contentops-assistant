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

const contentTypeHelpers = sliceBetween("const PUBLISH_RECORD_CONTENT_NORMAL=", 'function ensurePublishRecordsState');
const publishFieldHelpers = sliceBetween('function putPublishField', 'function putDraftField');

Function('assert', `
function dateKey(){ return '2026-06-20'; }
${contentTypeHelpers}
${publishFieldHelpers}

const draftPublishFields = buildFeishuPublishFields({
  publishRecordId: 'pub_1',
  publishDate: '2026-06-20',
  accountName: '账号A',
  device: '设备1',
  title: '普通选题',
  draftId: 'draft_1',
  contentType: PUBLISH_RECORD_CONTENT_NORMAL,
  isPublished: true,
  dataReviewStatus: '回访逾期，待补录数据'
});
assert.strictEqual(draftPublishFields['本地文案ID'], 'draft_1');
assert.strictEqual(draftPublishFields['本地营销记录ID'], undefined);
assert.strictEqual(draftPublishFields['数据回访状态'], '回访逾期，待补录数据');

const marketingPublishFields = buildFeishuPublishFields({
  publishRecordId: 'pub_2',
  publishDate: '2026-06-20',
  accountName: '账号B',
  device: '设备2',
  title: '营销选题',
  marketingRecordId: 'marketing_1',
  contentType: PUBLISH_RECORD_CONTENT_MARKETING,
  isMarketing: true,
  isPublished: true
});
assert.strictEqual(marketingPublishFields['本地文案ID'], undefined);
assert.strictEqual(marketingPublishFields['本地营销记录ID'], 'marketing_1');

console.log('feishu publish fields tests passed');
`)(assert);
