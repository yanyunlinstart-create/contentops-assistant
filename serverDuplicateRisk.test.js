const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function hasPublishSuggestionValue');
const end = server.indexOf('async function previewPublishDuplicateSuggestions', start);
assert(start > 0 && end > start, 'publish duplicate suggestion helpers not found');

Function('assert', `
${server.slice(start, end)}

function group(records) {
  return {
    key: 'legacy:2026-06-20|测试账号|1号',
    publishDate: '2026-06-20',
    accName: '测试账号',
    device: '1号',
    count: records.length,
    records
  };
}

let suggestion = buildPublishDuplicateSuggestion(group([
  { record_id: 'rec_keep', title: '工作台标记', isManual: false, isPublished: true, isMarketing: false, play: '', reward: false, note: '', createdTime: '2026-06-20T10:00:00Z' },
  { record_id: 'rec_clean', title: '工作台标记', isManual: false, isPublished: true, isMarketing: false, play: '', reward: false, note: '', createdTime: '2026-06-20T09:00:00Z' }
]));
assert.strictEqual(suggestion.riskLevel, 'low');
assert.strictEqual(suggestion.riskLabel, '低风险候选');

suggestion = buildPublishDuplicateSuggestion(group([
  { record_id: 'rec_keep', title: '工作台标记', isManual: false, isPublished: true, isMarketing: false, play: '12000', reward: false, note: '', createdTime: '2026-06-20T10:00:00Z' },
  { record_id: 'rec_clean', title: '工作台标记', isManual: false, isPublished: true, isMarketing: false, play: '', reward: false, note: '', createdTime: '2026-06-20T09:00:00Z' }
]));
assert.strictEqual(suggestion.riskLevel, 'review');
assert(suggestion.riskReasons.some(reason => reason.includes('播放')));

suggestion = buildPublishDuplicateSuggestion(group([
  { record_id: 'rec_keep', title: '营销内容已发', isManual: false, isPublished: true, isMarketing: true, play: '', reward: false, note: '营销', createdTime: '2026-06-20T10:00:00Z' },
  { record_id: 'rec_clean', title: '矮小', isManual: true, isPublished: true, isMarketing: false, play: '', reward: false, note: '真实标题', createdTime: '2026-06-20T09:00:00Z' }
]));
assert.strictEqual(suggestion.riskLevel, 'high');
assert.strictEqual(suggestion.riskLabel, '高冲突勿删');
assert(suggestion.riskReasons.some(reason => reason.includes('营销')));

console.log('server duplicate risk tests passed');
`)(assert);
