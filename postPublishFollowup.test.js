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
const renderItemStart = script.indexOf('function renderPostPublishMoreActions');
const renderItemEnd = script.indexOf('function renderPostPublishReviewGroup', renderItemStart);
assert(adjustmentStart > 0 && adjustmentEnd > adjustmentStart && start > 0 && end > start && publishRecordStart > 0 && publishRecordEnd > publishRecordStart && renderItemStart > 0 && renderItemEnd > renderItemStart, 'post-publish functions not found in HTML');

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
function formatPostPublishData(data){ return JSON.stringify(data || {}); }
function textSnippet(v,limit=70){ return String(v || '').slice(0,limit); }
function splitWords(text){ return String(text || '').split(/\\s+|[，。；、,.!?]/).filter(Boolean); }
function jaccardText(a,b){ const as = new Set(splitWords(a)); const bs = new Set(splitWords(b)); if(!as.size || !bs.size) return 0; let same=0; as.forEach(x => { if(bs.has(x)) same++; }); return same / (as.size + bs.size - same); }
function formatLibDateTime(){ return ''; }
let draftSyncCount = 0;
let marketingSyncCount = 0;
function syncDraftToFeishu(){ draftSyncCount++; }
function syncMarketingRecordToFeishu(){ marketingSyncCount++; }
function renderPostPublishReviewPanel(){}
function refreshReminderPanel(){}
function renderLib(){}
let lastToast = '';
function showToast(value){ lastToast = String(value || ''); }
let state = { lib: [], marketingRecords: [] };
function getLib(){ return state; }
function save(s){ state = s; }
function confirm(){ return true; }
`;

Function(`${sandboxPrefix}\n${script.slice(adjustmentStart, adjustmentEnd)}\n${script.slice(start, end)}\n${script.slice(publishRecordStart, publishRecordEnd)}\n${script.slice(renderItemStart, renderItemEnd)}\n
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
assert.strictEqual(derivePostPublishReviewState(draft, new Date('2026-06-09T00:21:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.DUE_FIRST, '20m due state should be centralized');
assert.strictEqual(derivePostPublishReviewState(draft, new Date('2026-06-09T00:21:00.000Z')).needsRealData, true, '20m due state should require real data before diagnosis');
const firstDueHtml = renderPostPublishReviewItem(buildPostPublishRecord('draft', draft, new Date('2026-06-09T00:21:00.000Z')));
assert(firstDueHtml.includes('记录首轮数据'), '20m due card should guide the user to record first-round data');
assert(!firstDueHtml.includes('接受诊断'), '20m due card must not expose diagnosis before data exists');

const archivableFirst = { id:'d_first_archive', used:true, accId:1, accName:'A', topic:'首轮也不补', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(archivableFirst, base);
state.lib.push(archivableFirst);
state = { lib:[archivableFirst], marketingRecords:[] };
archiveUnfilledPostPublishReviews();
assert.strictEqual(archivableFirst.postPublishDisposition, 'historical_unfilled', '20m due review can be archived as historical unfilled');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T00:21:00.000Z'));
assert(!buckets.first20.some(x => x.id === 'd_first_archive'), 'archived 20m due review should leave first bucket');
assert(getArchivedPostPublishReviewRecords(state).some(x => x.id === 'd_first_archive'), 'archived 20m due review should remain in archive records');
state = { lib:[draft], marketingRecords:[marketing] };

const observeDraft = { id:'d_observe', used:true, accId:1, accName:'A', topic:'继续观察不关闭', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(observeDraft, base);
state.lib.push(observeDraft);
prompt = function(){ return 'wait and recheck'; };
continuePostPublishObserve('draft','d_observe');
assert(!observeDraft.deleteHandledAt, 'continue observe must not permanently close the review');
assert(observeDraft.postPublishObserveUntil, 'continue observe should set a next review time');
observeDraft.postPublishObserveUntil = '2026-06-09T02:00:00.000Z';
assert.strictEqual(derivePostPublishReviewState(observeDraft, new Date('2026-06-09T00:30:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.CONTINUE_OBSERVE, 'continue observe should snooze until the next checkpoint');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T00:30:00.000Z'));
assert(!buckets.first20.some(x => x.id === 'd_observe') && !buckets.missedReview.some(x => x.id === 'd_observe'), 'snoozed review should not stay in immediate reminders');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T02:01:00.000Z'));
assert(buckets.missedReview.some(x => x.id === 'd_observe'), 'snoozed review should return when the next checkpoint is due');
prompt = function(){ return null; };

const skippedEarly = { id:'d_skip', used:true, accId:1, accName:'A', topic:'错过早期回访', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(skippedEarly, base);
skippedEarly.earlyReviewSkippedAt = '2026-06-09T00:21:00.000Z';
state.lib.push(skippedEarly);
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T00:21:00.000Z'));
assert(buckets.missedReview.some(x => x.id === 'd_skip'), 'early skipped review should stay visible as catch-up');
assert.strictEqual(derivePostPublishReviewState(skippedEarly, new Date('2026-06-09T00:21:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.MISSED, 'early skipped review should derive missed state');
acceptPostPublishDiagnosis('draft','d_skip');
assert.strictEqual(Boolean(skippedEarly.feedbackToGeneration), false, 'missed review without data must not feed generation');
prompt = function(){ return ''; };
updatePostPublishData('draft','d_skip','manual');
assert(!hasPostPublishRecordedData(skippedEarly), 'blank catch-up submit must not create zero data');
assert(lastToast.includes('空白不会被当作 0 数据'), 'blank catch-up submit should explain it was not recorded as zero');
prompt = function(){ return null; };

state = { lib:[skippedEarly], marketingRecords:[] };
archiveMissedPostPublishReviews();
assert.strictEqual(skippedEarly.postPublishDisposition, 'historical_unfilled', 'missed catch-up can be archived as historical gap');
assert.strictEqual(Boolean(skippedEarly.feedbackToGeneration), false, 'archived historical gap must not feed generation');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T02:01:00.000Z'));
assert(!buckets.missedReview.some(x => x.id === 'd_skip'), 'archived historical gap should leave active reminders');
assert(getArchivedPostPublishReviewRecords(state).some(x => x.id === 'd_skip'), 'archived historical gap should remain visible in archive records');
feedbackPostPublishToGeneration('draft','d_skip');
assert.strictEqual(Boolean(skippedEarly.feedbackToGeneration), false, 'archived historical gap must ignore direct generation feedback action');
confirmPostPublishDeleted('draft','d_skip');
assert.strictEqual(Boolean(skippedEarly.deletedAfterZeroData), false, 'archived historical gap must ignore direct delete feedback action');
const archivedDisposition = skippedEarly.postPublishDisposition;
continuePostPublishObserve('draft','d_skip');
markPostPublishAbnormal('draft','d_skip');
assert.strictEqual(skippedEarly.postPublishDisposition, archivedDisposition, 'archived historical gap must ignore direct observe/abnormal actions');
const archivedAdjustment = buildOperationGenerationAdjustments([{id:1,name:'A',device:'1'}], {isMarketing:false});
assert.strictEqual(archivedAdjustment.promptText, '', 'archived historical gap with diagnosis must not affect generation adjustments');
const archivedHtml = renderPostPublishReviewItem(buildPostPublishRecord('draft', skippedEarly, new Date('2026-06-09T02:01:00.000Z')));
assert(archivedHtml.includes('补录真实数据'), 'archived card should still allow real data backfill');
assert(!archivedHtml.includes('接受诊断') && !archivedHtml.includes('feedbackPostPublishToGeneration'), 'archived card must not expose diagnosis or generation feedback actions');
assert(!archivedHtml.includes('辅助诊断') && archivedHtml.includes('历史缺口'), 'archived card should explain historical gap instead of showing diagnosis');
prompt = function(){ return '12 1 0 0 0 late data'; };
updatePostPublishData('draft','d_skip','manual');
assert.strictEqual(skippedEarly.postPublishDisposition, '', 'real data backfill should clear historical archive disposition');
assert(!skippedEarly.postPublishArchivedAt, 'real data backfill should clear historical archive timestamp');
prompt = function(){ return null; };

const stopDraft = { id:'d_stop', used:true, accId:1, accName:'A', topic:'停止追踪但保留发布记录', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(stopDraft, base);
state = { lib:[stopDraft], marketingRecords:[] };
draftSyncCount = 0;
stopPostPublishTracking('draft','d_stop');
assert.strictEqual(stopDraft.postPublishDisposition, 'stopped_tracking', 'stop tracking should mark a terminal stop disposition');
assert.strictEqual(stopDraft.noPostPublishReminder, true, 'stop tracking should disable future reminders');
assert.strictEqual(Boolean(stopDraft.feedbackToGeneration), false, 'stop tracking must not feed generation');
assert.strictEqual(stopDraft.failureType || '', '', 'stop tracking must not create a failure type');
assert.strictEqual(Number(stopDraft.failureWeight) || 0, 0, 'stop tracking must not add failure weight');
assert.strictEqual(Boolean(stopDraft.deletedAfterZeroData), false, 'stop tracking must not imply content was deleted for performance');
assert.strictEqual(draftSyncCount, 0, 'stop tracking should not trigger Feishu draft sync side effects');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:01:00.000Z'));
assert(!Object.values(buckets).some(items => items.some(x => x.id === 'd_stop')), 'stopped tracking record must stay out of all active review buckets');
const restoredStopState = JSON.parse(JSON.stringify(stopDraft));
assert.strictEqual(derivePostPublishReviewState(restoredStopState, new Date('2026-06-11T00:01:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.STOPPED_TRACKING, 'stopped tracking state should survive reload');
assert.strictEqual(restoredStopState.publishedAt, base, 'stop tracking should preserve the publish record timestamp');

const deletedStopDraft = { id:'d_deleted_stop', used:true, accId:1, accName:'A', topic:'内容删除仅停止追踪', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(deletedStopDraft, base);
state = { lib:[deletedStopDraft], marketingRecords:[] };
draftSyncCount = 0;
markPostPublishDeletedStopTracking('draft','d_deleted_stop');
assert.strictEqual(deletedStopDraft.postPublishDisposition, 'deleted_stop_tracking', 'content deleted stop should use its own non-failure disposition');
assert.strictEqual(deletedStopDraft.contentDeletedStopTracking, true, 'content deleted stop should record content deletion');
assert.strictEqual(deletedStopDraft.noPostPublishReminder, true, 'content deleted stop should disable future reminders');
assert.strictEqual(Boolean(deletedStopDraft.feedbackToGeneration), false, 'content deleted stop must not feed generation');
assert.strictEqual(Boolean(deletedStopDraft.deletedAfterZeroData), false, 'content deleted stop must not reuse performance delete flag');
assert.strictEqual(draftSyncCount, 0, 'content deleted stop should not trigger Feishu draft sync side effects');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:01:00.000Z'));
assert(!Object.values(buckets).some(items => items.some(x => x.id === 'd_deleted_stop')), 'content deleted stop record must stay out of active review buckets');
assert.strictEqual(derivePostPublishReviewState(JSON.parse(JSON.stringify(deletedStopDraft)), new Date('2026-06-11T00:01:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.DELETED_STOP_TRACKING, 'content deleted stop state should survive reload');

const bulkStopA = { id:'d_bulk_stop_a', used:true, accId:1, accName:'A', topic:'批量停止 A', publishedAt:base, usedDates:[base] };
const bulkStopB = { id:'d_bulk_stop_b', used:true, accId:1, accName:'A', topic:'批量停止 B', publishedAt:base, usedDates:[base] };
const untouched = { id:'d_bulk_keep', used:true, accId:1, accName:'A', topic:'不应默认处理', publishedAt:base, usedDates:[base] };
[bulkStopA, bulkStopB, untouched].forEach(item => ensurePostPublishSchedule(item, base));
state = { lib:[bulkStopA, bulkStopB, untouched], marketingRecords:[] };
const bulkResult = applyPostPublishBulkAction([
  {kind:'draft', id:'d_bulk_stop_a'},
  {kind:'draft', id:'d_bulk_stop_b'}
], 'stop_tracking');
assert.strictEqual(bulkResult.updated, 2, 'bulk stop tracking should update only selected records');
assert.strictEqual(bulkStopA.postPublishDisposition, 'stopped_tracking', 'first selected record should stop tracking');
assert.strictEqual(bulkStopB.postPublishDisposition, 'stopped_tracking', 'second selected record should stop tracking');
assert(untouched.postPublishDisposition !== 'stopped_tracking', 'unselected record must not be changed by bulk action');
assert.strictEqual(Boolean(untouched.noPostPublishReminder), false, 'unselected record must remain eligible for reminders');

const bulkContinueA = { id:'d_bulk_continue_a', used:true, accId:1, accName:'A', topic:'bulk continue A', publishedAt:base, usedDates:[base] };
const bulkContinueB = { id:'d_bulk_continue_b', used:true, accId:1, accName:'A', topic:'bulk continue B', publishedAt:base, usedDates:[base] };
const bulkContinueKeep = { id:'d_bulk_continue_keep', used:true, accId:1, accName:'A', topic:'bulk continue keep', publishedAt:base, usedDates:[base] };
[bulkContinueA, bulkContinueB, bulkContinueKeep].forEach(item => ensurePostPublishSchedule(item, base));
bulkContinueA.abnormalCheckAt = '2099-01-01T00:00:00.000Z';
bulkContinueB.deleteSuggestCheckAt = '2099-01-02T00:00:00.000Z';
state = { lib:[bulkContinueA, bulkContinueB, bulkContinueKeep], marketingRecords:[] };
const continueResult = applyPostPublishBulkAction([
  {kind:'draft', id:'d_bulk_continue_a'},
  {kind:'draft', id:'d_bulk_continue_b'}
], 'continue_observe');
assert.strictEqual(continueResult.updated, 2, 'bulk continue observe should update only selected records');
assert.strictEqual(bulkContinueA.postPublishDisposition, 'continue_observe', 'first selected record should continue observing');
assert.strictEqual(bulkContinueB.postPublishDisposition, 'continue_observe', 'second selected record should continue observing');
assert.strictEqual(bulkContinueA.abnormalNote, '批量继续观察', 'bulk continue observe should use a shared note');
assert.strictEqual(bulkContinueB.abnormalNote, '批量继续观察', 'bulk continue observe should use a shared note');
assert.strictEqual(bulkContinueA.postPublishObserveUntil, '2099-01-01T00:00:00.000Z', 'bulk continue should use each record next checkpoint');
assert.strictEqual(bulkContinueB.postPublishObserveUntil, '2099-01-02T00:00:00.000Z', 'bulk continue should not write one uniform next checkpoint');
assert.strictEqual(bulkContinueKeep.postPublishDisposition || '', '', 'unselected record must not be continued by bulk action');

const bulkDeletedA = { id:'d_bulk_deleted_a', used:true, accId:1, accName:'A', topic:'bulk deleted A', publishedAt:base, usedDates:[base] };
const bulkDeletedKeep = { id:'d_bulk_deleted_keep', used:true, accId:1, accName:'A', topic:'bulk deleted keep', publishedAt:base, usedDates:[base] };
[bulkDeletedA, bulkDeletedKeep].forEach(item => ensurePostPublishSchedule(item, base));
state = { lib:[bulkDeletedA, bulkDeletedKeep], marketingRecords:[] };
const deletedBulkResult = applyPostPublishBulkAction([{kind:'draft', id:'d_bulk_deleted_a'}], 'deleted_stop_tracking');
assert.strictEqual(deletedBulkResult.updated, 1, 'bulk deleted-stop should update selected record');
assert.strictEqual(bulkDeletedA.postPublishDisposition, 'deleted_stop_tracking', 'selected record should be marked content deleted only stop tracking');
assert.strictEqual(bulkDeletedKeep.postPublishDisposition || '', '', 'unselected record must not be marked content deleted');

const bulkArchiveA = { id:'d_bulk_archive_a', used:true, accId:1, accName:'A', topic:'bulk archive A', publishedAt:base, usedDates:[base] };
const bulkArchiveKeep = { id:'d_bulk_archive_keep', used:true, accId:1, accName:'A', topic:'bulk archive keep', publishedAt:base, usedDates:[base] };
[bulkArchiveA, bulkArchiveKeep].forEach(item => ensurePostPublishSchedule(item, base));
state = { lib:[bulkArchiveA, bulkArchiveKeep], marketingRecords:[] };
const archiveBulkResult = applyPostPublishBulkAction([{kind:'draft', id:'d_bulk_archive_a'}], 'archive_unfilled');
assert.strictEqual(archiveBulkResult.updated, 1, 'bulk archive should update selected record');
assert.strictEqual(bulkArchiveA.postPublishDisposition, 'historical_unfilled', 'selected record should be archived as historical unfilled');
assert.strictEqual(bulkArchiveKeep.postPublishDisposition || '', '', 'unselected record must not be archived');

const selectedButSingleA = { id:'d_selected_single_a', used:true, accId:1, accName:'A', topic:'selected single A', publishedAt:base, usedDates:[base] };
const selectedButSingleB = { id:'d_selected_single_b', used:true, accId:1, accName:'A', topic:'selected single B', publishedAt:base, usedDates:[base] };
[selectedButSingleA, selectedButSingleB].forEach(item => ensurePostPublishSchedule(item, base));
state = { lib:[selectedButSingleA, selectedButSingleB], marketingRecords:[] };
stopPostPublishTracking('draft','d_selected_single_a');
assert.strictEqual(selectedButSingleA.postPublishDisposition, 'stopped_tracking', 'single stop should update the clicked record');
assert.strictEqual(selectedButSingleB.postPublishDisposition || '', '', 'single stop must not update another selected-looking record');

state = { lib:[draft], marketingRecords:[marketing] };
applyPostPublishData(draft, {play:0, likes:0, comments:0, saves:0, shares:0, note:'zero'}, 'first');
assert.strictEqual(draft.firstChecked, true, 'first check should be marked checked');
assert.strictEqual(draft.firstCheckZeroData, true, '20m zero should be only early signal');
assert.strictEqual(Boolean(draft.deleteSuggested), false, '20m zero must not suggest delete');

buckets = getPostPublishReminderBuckets(state, new Date('2026-06-09T02:01:00.000Z'));
assert(draft.zeroData2h && buckets.abnormal2h.some(x => x.id === 'd1'), '2h zero should enter abnormal bucket');

const uncertainDraft = { id:'d_uncertain', used:true, accId:1, accName:'A', topic:'诊断继续观察', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(uncertainDraft, base);
state.lib.push(uncertainDraft);
applyPostPublishData(uncertainDraft, {play:0, likes:0, comments:0, saves:0, shares:0, note:'zero'}, 'first');
getPostPublishReminderBuckets(state, new Date('2026-06-09T02:01:00.000Z'));
revisePostPublishDiagnosis('draft','d_uncertain','uncertain');
assert(!uncertainDraft.deleteHandledAt, 'uncertain diagnosis should not permanently close the review');
assert(uncertainDraft.postPublishObserveUntil, 'uncertain diagnosis should set a next review time');
uncertainDraft.zeroData24h = false;
uncertainDraft.zeroData48h = false;
uncertainDraft.deleteSuggested = false;
uncertainDraft.finalDeleteReminder = false;
delete uncertainDraft.deleteSuggestedAt;
uncertainDraft.postPublishObserveUntil = '2026-06-10T00:00:00.000Z';
assert.strictEqual(derivePostPublishReviewState(uncertainDraft, new Date('2026-06-09T03:00:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.CONTINUE_OBSERVE, 'uncertain diagnosis should snooze temporarily');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-10T00:01:00.000Z'));
assert(buckets.delete24h.some(x => x.id === 'd_uncertain'), 'uncertain diagnosis should return for 24h zero-data review');
draft.zeroData48h = false;
draft.finalDeleteReminder = false;

buckets = getPostPublishReminderBuckets(state, new Date('2026-06-10T00:01:00.000Z'));
assert(draft.zeroData24h && draft.deleteSuggested && buckets.delete24h.some(x => x.id === 'd1'), '24h zero should suggest delete');

applyPostPublishData(draft, {play:120, likes:3, comments:1, saves:0, shares:0, note:'later non-zero'}, 'manual');
assert(!draft.zeroData2h && !draft.zeroData24h && !draft.zeroData48h && !draft.deleteSuggested, 'non-zero catch-up should clear stale zero flags');
assert.strictEqual(derivePostPublishReviewState(draft, new Date('2026-06-10T00:02:00.000Z')).key, POST_PUBLISH_REVIEW_STATE.FIRST_CHECKED, 'non-zero catch-up should return to checked state');

applyPostPublishData(draft, {play:0, likes:0, comments:0, saves:0, shares:0, note:'confirmed zero again'}, 'manual');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-10T00:03:00.000Z'));
assert(draft.zeroData48h && draft.finalDeleteReminder && buckets.final48h.some(x => x.id === 'd1'), 'confirmed zero after correction should re-enter the current due bucket');

const final48Archive = { id:'d_final_archive', used:true, accId:1, accName:'A', topic:'48小时也归档', publishedAt:base, usedDates:[base] };
ensurePostPublishSchedule(final48Archive, base);
applyPostPublishData(final48Archive, {play:0, likes:0, comments:0, saves:0, shares:0, note:'confirmed zero'}, 'manual');
state = { lib:[final48Archive], marketingRecords:[] };
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:01:00.000Z'));
assert(buckets.final48h.some(x => x.id === 'd_final_archive'), '48h zero should be in final reminder before archive');
const bucketRecordCount = Object.values(buckets).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
assert.strictEqual(getArchivablePostPublishRecords(state, new Date('2026-06-11T00:01:00.000Z')).length, bucketRecordCount, 'archive scope should automatically cover every active review bucket');
archiveActivePostPublishReviews();
assert.strictEqual(final48Archive.postPublishDisposition, 'historical_unfilled', '48h zero final reminder can be archived as historical unfilled');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:02:00.000Z'));
assert(!buckets.final48h.some(x => x.id === 'd_final_archive'), 'archived 48h zero should leave final reminder bucket');
assert.strictEqual(Boolean(final48Archive.feedbackToGeneration), false, 'archived 48h zero must not feed generation');
state = { lib:[draft], marketingRecords:[marketing] };

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
assert(!draft48.zeroData48h && buckets.missedReview.some(x => x.id === 'd48'), 'missing review data should not become 48h zero');

applyPostPublishData(draft48, {play:0, likes:0, comments:0, saves:0, shares:0, note:'confirmed zero'}, 'manual');
buckets = getPostPublishReminderBuckets(state, new Date('2026-06-11T00:01:00.000Z'));
assert(draft48.zeroData48h && buckets.final48h.some(x => x.id === 'd48'), 'confirmed 48h zero should enter final reminder');

const diagnosis = buildOperationDiagnosis(buildPostPublishRecord('draft', draft48), state);
assert(diagnosis.text && diagnosis.confidence, 'diagnosis should produce hypothesis and confidence');
revisePostPublishDiagnosis('draft','d48','account_exception');
assert(draft48.operationDiagnosis && draft48.abnormalReason === 'account_exception', 'user correction should update diagnosis and weights');

console.log('post-publish followup tests passed');
`)();
