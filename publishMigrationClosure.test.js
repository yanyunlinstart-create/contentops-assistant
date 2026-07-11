const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
globalThis.assert = assert;

const bootstrap = `
var window = globalThis;
window.addEventListener=function(){};
window.removeEventListener=function(){};
var setInterval=function(){ return 0; };
var setTimeout=function(){ return 0; };
var clearInterval=function(){};
var clearTimeout=function(){};
var document = {
  getElementById(){ return { innerHTML:'', value:'', checked:false, classList:{add(){},remove(){},toggle(){},contains(){return false;}}, style:{}, addEventListener(){}, appendChild(){}, remove(){}, querySelector(){return null;}, querySelectorAll(){return [];}, insertAdjacentHTML(){}, select(){} }; },
  querySelector(){ return null; },
  querySelectorAll(){ return []; },
  addEventListener(){},
  createElement(){ return { style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false;}}, appendChild(){}, remove(){}, select(){}, value:'', innerHTML:'', addEventListener(){}, click(){} }; },
  body:{ appendChild(){} }
};
var navigator = { onLine:true, clipboard:{ writeText(){ return Promise.resolve(); } } };
var __writes = 0;
var __guardWrites = false;
var localStorage = { getItem(){ return null; }, setItem(){ if(__guardWrites){ __writes++; throw new Error('unexpected localStorage write'); } }, removeItem(){}, key(){return null;}, length:0 };
var URL = { createObjectURL(){ return 'blob:test'; }, revokeObjectURL(){} };
var confirm = function(){ return false; };
var alert = function(){};
`;

const testCode = `
showToast=function(){};
syncPublishRecordToFeishu=function(){ throw new Error('should not sync feishu'); };
save=function(){ if(__guardWrites)throw new Error('should not save during closure preview'); };
__writes = 0;

const sample = {
  customAccs:[{id:1,name:'A',device:'D1'},{id:2,name:'B',device:'D2'}],
  publishRecords:[],
  publishedToday:{'2026-06-18':[1,2]},
  manualPublishDetails:{'2026-06-17':{'1':{note:String.fromCharCode(0x8425,0x9500)+' old normal',isMarketing:false}}},
  marketingRecords:[],
  lib:[
    {id:'d1',accId:1,topic:'Draft unclear',usedDates:['2026-06-16'],usedAccIds:[1],zeroData48h:true,finalDeleteReminder:true},
    {id:'d_skip',accId:2,topic:'早期回访欠账记录',usedDates:['2026-06-16'],usedAccIds:[2],firstCheckAt:'2026-06-16T12:20:00.000Z',earlyReviewSkippedAt:'2026-06-16T13:00:00.000Z',firstCheckSkipped:true,firstChecked:true}
  ]
};

const before = JSON.stringify(sample);
__guardWrites = true;
const plan = buildPublishMigrationPreview(sample);
const stats = getPublishMigrationPreviewStats(plan);
const conclusion = buildPublishMigrationClosureConclusion(plan);

assert.strictEqual(stats.manual, 0);
assert.strictEqual(stats.marketing, 0);
assert.strictEqual(stats.draft, 0);
assert.strictEqual(stats.highConfidenceMigratable, 0);
assert.strictEqual(stats.dedupedMigratable, 0);
assert(conclusion.noHighConfidence, 'closure conclusion should say no high-confidence migration');
assert(conclusion.title.includes('无需执行高可信迁移'));

assert(plan.groups.publishedToday.length > 0, 'publishedToday should remain visible as low-confidence preview');
assert(plan.groups.publishedToday.every(item => item.lowConfidenceOnly === true), 'publishedToday must be low-confidence only');
assert(plan.groups.publishedToday.every(item => !item.preview), 'publishedToday must not build publishRecords preview');
assert(plan.groups.publishedToday.every(item => item.targetType.includes('不建议迁移')), 'publishedToday label must not recommend migration');

assert(plan.groups.needsReview.every(item => !item.preview), 'manual review items must not build executable previews');
assert(plan.groups.needsReview.some(item => item.skipReason === '回访状态不明'), 'review-unknown item should be classified');
assert(plan.groups.needsReview.some(item => String(item.detail || item.reviewCompatibility?.note || '').includes('补录')), 'early skipped review should be classified as catch-up, not terminal');

const report = buildPublishMigrationPreviewReportText(plan);
assert(report.includes('当前无高可信可自动迁移记录'));
assert(report.includes('低可信 publishedToday 历史状态预览'));
assert(!report.includes('publishedToday 可选迁移'));

const rendered = { innerHTML:'' };
document.getElementById = function(id){ return id === 'publishMigrationPreviewResult' ? rendered : { innerHTML:'', classList:{contains(){return false;}} }; };
renderPublishMigrationPreview(plan);
assert(rendered.innerHTML.includes('无需执行高可信迁移'));
assert(rendered.innerHTML.includes('低可信历史状态预览'));

const classification = buildRemainingPublishExceptionClassification(sample);
const classificationReport = buildRemainingPublishExceptionClassificationReportText(classification);
__guardWrites = false;
assert(classificationReport.includes('读取收敛兜底'));
assert(classificationReport.includes('不迁移'));

assert.strictEqual(JSON.stringify(sample), before, 'closure preview/classification must not mutate sample data');
assert.strictEqual(__writes, 0, 'closure preview/classification must not write localStorage');
`;

new Function(bootstrap + '\n' + scripts + '\n' + testCode)();
console.log('publishMigrationClosure tests passed');
process.exit(0);
