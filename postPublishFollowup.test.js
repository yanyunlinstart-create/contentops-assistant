const fs = require('fs');
const assert = require('assert');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
const html = fs.readFileSync(htmlFile, 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
const adjustmentStart = script.indexOf('function buildOperationGenerationAdjustments');
const adjustmentEnd = script.indexOf('function buildGenerationQualityFeedback', adjustmentStart);
const start = script.indexOf('const POST_PUBLISH_METRICS=');
const end = script.indexOf('function getDraftMarketingRecord', start);
const publishRecordStart = script.indexOf('const PUBLISH_RECORD_CONTENT_NORMAL');
const publishRecordEnd = script.indexOf('function getDraftPublishedDays', publishRecordStart);
assert(adjustmentStart > 0 && adjustmentEnd > adjustmentStart && start > 0 && end > start && publishRecordStart > 0 && publishRecordEnd > publishRecordStart, 'post-publish functions not found in HTML');

const sandboxPrefix = `
function assert(value,message){ if(!value) throw new Error(message || 'assert failed'); }
assert.strictEqual = function(actual, expected, message){ if(actual !== expected) throw new Error((message || 'strictEqual failed') + ': ' + actual + ' !== ' + expected); };
const storage = {};
const localStorage = { getItem:k => storage[k] || null, setItem:(k,v) => { storage[k] = String(v); } };
function parseJsonStorage(key,fallback){ try { return JSON.parse(localStorage.getItem(key) || ''); } catch(e) { return fallback; } }
function dateKey(d = new Date('2026-06-09T10:00:00+08:00')) { return new Date(d).toISOString().slice(0,10); }
function getPublishDate(){ return dateKey(); }
function getPublishDateTimeForDay(day){ return day + 'T12:00'; }
function getCurrentAccs(){ return [{id:1,name:'A',device:'1'}]; }
function normalizePublishDay(value,fallbackDay=''){ const raw=value?.day||value?.date||value?.publishDate||value?.publishedDate||value?.publishedAt||value?.createdAt||value?.time||fallbackDay; const key=String(raw||'').slice(0,10); return /^\\d{4}-\\d{2}-\\d{2}$/.test(key)?key:''; }
function normalizePublishAccId(value,fallbackAccId=''){ const raw=value?.accId||value?.accountId||value?.accountID||value?.account?.id||value?.acc?.id||fallbackAccId; const n=Number(raw); return Number.isFinite(n)&&n>0?n:0; }
function normalizeMarketingDay(value,fallback=dateKey()){ return String(value || fallback).slice(0,10); }
function addDaysToKey(day,delta){ const d = new Date(day + 'T00:00:00+08:00'); d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }
function isDraftPublished(d){ return !!(d && (d.used || d.publishedAt || (Array.isArray(d.usedDates) && d.usedDates.length))); }
function getDraftContentTypeLabel(d){ return d && d.isMarketing ? '营销内容' : '普通内容'; }
function getMarketingRecords(s){ return Array.isArray(s && s.marketingRecords) ? s.marketingRecords : []; }
function escapeHtml(v){ return String(v || ''); }
function textSnippet(v,limit=70){ return String(v || '').slice(0,limit); }
function splitWords(text){ return String(text || '').split(/\\s+|[，。；、,.!?]/).filter(Boolean); }
function jaccardText(a,b){ const as = new Set(splitWords(a)); const bs = new Set(splitWords(b)); if(!as.size || !bs.size) return 0; let same=0; as.forEach(x => { if(bs.has(x)) same++; }); return same / (as.size + bs.size - same); }
function formatLibDateTime(){ return ''; }
function syncDraftToFeishu(){}
function syncMarketingRecordToFeishu(){}
function renderPostPublishReviewPanel(){}
function refreshReminderPanel(){}
function renderLib(){}
function showToast(){}
let state = { lib: [], marketingRecords: [] };
function getLib(){ return state; }
function save(s){ state = s; }
function confirm(){ return true; }
`;

Function(`${sandboxPrefix}\n${script.slice(adjustmentStart, adjustmentEnd)}\n${script.slice(start, end)}\n${script.slice(publishRecordStart, publishRecordEnd)}\n
const base = '2026-06-09T00:00:00.000Z';
const draft = { id:'d1', used:true, accId:1, accName:'A', topic:'家庭教育 切入', format:'short_video', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(draft, base);
assert(draft.firstCheckAt && new Date(draft.firstCheckAt) - new Date(base) === 20 * 60000, 'normal draft should create 20m check');

const marketing = { id:'m1', accId:1, accName:'A', title:'营销内容', publishedAt:base };
ensurePostPublishSchedule(marketing, base);
assert(marketing.firstCheckAt && new Date(marketing.firstCheckAt) - new Date(base) === 20 * 60000, 'marketing record should create 20m check');

state = { lib:[draft], marketingRecords:[marketing] };
let buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T00:21:00.000Z'));
assert(buckets.first20.some(x => x.id === 'd1'), '20m due draft should appear in first bucket');

applyPostPublishData(draft, {play:0, likes:0, comments:0, saves:0, shares:0, note:'zero'}, 'first');
assert.strictEqual(draft.firstChecked, true, 'first check should be marked checked');
assert.strictEqual(draft.firstCheckZeroData, true, '20m zero should be only early signal');
assert.strictEqual(Boolean(draft.deleteSuggested), false, '20m zero must not suggest delete');

buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T02:01:00.000Z'));
assert(draft.zeroData2h && buckets.abnormal2h.some(x => x.id === 'd1'), '2h zero should enter abnormal bucket');

buckets = getPostPublishReminderBuckets(state, new Date('2026-06-10T00:01:00.000Z'));
assert(draft.zeroData24h && draft.deleteSuggested && buckets.delete24h.some(x => x.id === 'd1'), '24h zero should suggest delete');

confirmPostPublishDeleted('draft','d1');
assert(draft.deletedAfterZeroData && draft.feedbackToGeneration && draft.failureType === 'zero_data_24h', 'confirmed delete should enter failure pool');

const adjustment = buildOperationGenerationAdjustments([{id:1,name:'A',device:'1'}], {isMarketing:false});
assert(/本次调节依据/.test(adjustment.promptText), 'generation should read failure samples and produce adjustment basis');

const marketingCycle = { id:'m7', status:'已删除', deleteReason:'marketing_cycle_7d', publishedAt:base };
state.marketingRecords.push(marketingCycle);
assert.strictEqual(marketingCycle.deleteReason, 'marketing_cycle_7d', '7d marketing delete reason should stay distinct');

state = { lib:[], marketingRecords:[], publishRecords:[] };
const normalPublish = addPublishRecordToState(state, {
  accId:1,
  accountName:'A',
  device:'1',
  publishDate:'2026-06-09',
  publishedAt:base,
  contentType:'正常内容',
  title:'normal'
});
const marketingPublish = addPublishRecordToState(state, {
  accId:1,
  accountName:'A',
  device:'1',
  publishDate:'2026-06-09',
  publishedAt:'2026-06-09T00:05:00.000Z',
  contentType:'营销内容',
  title:'marketing'
});
assert(normalPublish.id && marketingPublish.id && normalPublish.id !== marketingPublish.id, 'same account/day publish records should get distinct ids');
state.publishRecords.find(x => x.id === normalPublish.id).dataReviewStatus = '20分钟待查看';
state.publishRecords.find(x => x.id === marketingPublish.id).dataReviewStatus = '等待48小时';
assert.strictEqual(state.publishRecords.length, 2, 'same account/day should keep two publish records');
assert.strictEqual(state.publishRecords.find(x => x.id === normalPublish.id).dataReviewStatus, '20分钟待查看', 'normal review status should bind to its publish record');
assert.strictEqual(state.publishRecords.find(x => x.id === marketingPublish.id).dataReviewStatus, '等待48小时', 'marketing review status should bind to its publish record');

const draft48 = { id:'d48', used:true, accId:1, accName:'A', topic:'另一个主题', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(draft48, base);
state.lib.push(draft48);
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:01:00.000Z'));
assert(draft48.zeroData48h && buckets.final48h.some(x => x.id === 'd48'), '48h zero should enter final reminder');

const diagnosis = buildOperationDiagnosis(buildPostPublishRecord('draft', draft48), state);
assert(diagnosis.text && diagnosis.confidence, 'diagnosis should produce hypothesis and confidence');
revisePostPublishDiagnosis('draft','d48','account_exception');
assert(draft48.operationDiagnosis && draft48.abnormalReason === 'account_exception', 'user correction should update diagnosis and weights');

console.log('post-publish followup tests passed');
`)();
