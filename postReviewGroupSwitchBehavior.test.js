const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find((name) => name.endsWith('.html'));
assert(htmlFile, 'html file not found');

const html = fs.readFileSync(htmlFile, 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n');
const start = script.indexOf('const POST_PUBLISH_REVIEW_GROUPS=');
const end = script.indexOf('let _marketingHistoryFilter', start);
assert(start > 0 && end > start, 'post publish group switch functions not found');

const sandbox = `
let saved = 0;
let groupRenderCalls = [];
let emptyRenderCalls = 0;
let selectedInputs = [];
const bulkButtons = [
  {id:'postPublishBulkContinue', textContent:'', disabled:false},
  {id:'postPublishBulkStop', textContent:'', disabled:false},
  {id:'postPublishBulkDeletedStop', textContent:'', disabled:false},
  {id:'postPublishBulkArchive', textContent:'', disabled:false}
];
const elements = {};
function classList(){
  return {
    values:new Set(),
    toggle(name,on){ if(on)this.values.add(name); else this.values.delete(name); },
    contains(name){ return this.values.has(name); }
  };
}
function element(id){
  if(!elements[id])elements[id]={id, innerHTML:'', textContent:'', style:{}, classList:classList()};
  return elements[id];
}
const document = {
  getElementById: element,
  querySelectorAll(selector){
    if(selector === '#postPublishReviewList .post-review-select:checked')return selectedInputs.filter(input=>input.checked);
    if(selector === '#postPublishReviewList .post-review-select')return selectedInputs;
    const groupMatch = selector.match(/data-review-group="([^"]+)"/);
    if(groupMatch)return selectedInputs.filter(input=>input.dataset.reviewGroup===groupMatch[1]);
    if(selector.includes('#postPublishBulk'))return bulkButtons;
    return [];
  }
};
let mockBuckets = {
  missedReview:[],
  first20:[],
  abnormal2h:[],
  delete24h:[],
  final48h:[]
};
let mockRecords = [];
let mockArchived = [];
const state = {};
function getLib(){ return state; }
function getPublishDate(){ return '2026-07-11'; }
function save(){ saved++; }
function escapeHtml(value){ return String(value || ''); }
function getPostPublishReminderBuckets(){ return mockBuckets; }
function getPostPublishReviewRecords(){ return mockRecords; }
function getArchivedPostPublishReviewRecords(){ return mockArchived; }
function shouldSkipEarlyPostPublishRecord(record){ return !!record.earlySkippable; }
function renderPostPublishReviewGroup(title,items,tone,groupKey,options={}){
  groupRenderCalls.push({title, count:items.length, tone, groupKey, selectable:options.selectable!==false});
  return '<section data-group="' + groupKey + '">' + items.length + '</section>';
}
function renderPostPublishEmptyState(count){
  emptyRenderCalls++;
  return '<section data-empty="true">' + count + '</section>';
}
`;

const tests = `
function resetDom(){
  Object.keys(elements).forEach(key=>delete elements[key]);
  groupRenderCalls=[];
  emptyRenderCalls=0;
  selectedInputs=[];
  saved=0;
}
function input(group,checked=false){
  return {checked,dataset:{reviewGroup:group,kind:'draft',id:group+'-id'}};
}

mockBuckets = {
  missedReview:[{id:'m1'},{id:'m2'},{id:'m3'}],
  first20:[{id:'f1'},{id:'f2'}],
  abnormal2h:[{id:'a1'},{id:'a2'}],
  delete24h:[{id:'d1'}],
  final48h:[{id:'z1'}]
};
mockRecords = [{id:'r1'}];
mockArchived = [{id:'h1'},{id:'h2'},{id:'h3'},{id:'h4'},{id:'h5'}];
resetDom();
renderPostPublishReviewPanel();
assert.strictEqual(_postPublishReviewActiveGroup,'missedReview','default should select the first non-empty pending group');
assert.strictEqual(groupRenderCalls.length,1,'only the active group should render');
assert.strictEqual(groupRenderCalls[0].groupKey,'missedReview','first render should show missed review group');
assert(element('postPublishReviewStats').innerHTML.includes("setPostPublishReviewActiveGroup('archive')"), 'archive metric should switch the main panel');

setPostPublishReviewActiveGroup('abnormal2h');
assert.strictEqual(_postPublishReviewActiveGroup,'abnormal2h','metric switch should change active group');
assert.strictEqual(groupRenderCalls[groupRenderCalls.length-1].groupKey,'abnormal2h','switched group should render alone');

selectedInputs=[input('abnormal2h',true), input('abnormal2h',false)];
updatePostPublishBulkBar();
assert(element('postPublishBulkBar').classList.contains('active'), 'selection should show the bulk bar');
setPostPublishReviewActiveGroup('first20');
assert.strictEqual(selectedInputs.filter(item=>item.checked).length,0,'switching group should clear selections');
assert(!element('postPublishBulkBar').classList.contains('active'), 'switching group should hide bulk bar');

selectedInputs=[input('first20',false), input('first20',false), input('missedReview',false)];
_postPublishReviewActiveGroup='first20';
selectPostPublishReviewGroup('first20');
assert.strictEqual(selectedInputs.filter(item=>item.checked).length,2,'select all group should check only current group');
assert.strictEqual(selectedInputs.find(item=>item.dataset.reviewGroup==='missedReview').checked,false,'select all group should not touch another group');

setPostPublishReviewActiveGroup('archive');
assert.strictEqual(_postPublishReviewActiveGroup,'archive','archive metric should select archive view when archived records exist');
assert.strictEqual(groupRenderCalls[groupRenderCalls.length-1].groupKey,'archive','archive should render in main content');
assert.strictEqual(groupRenderCalls[groupRenderCalls.length-1].selectable,false,'archive view should be read-only');
assert(!element('postPublishBulkBar').classList.contains('active'), 'archive view should not show bulk bar');

_postPublishReviewActiveGroup='first20';
renderPostPublishReviewPanel();
assert.strictEqual(_postPublishReviewActiveGroup,'first20','refresh should keep active group while it still has records');
mockBuckets.first20=[];
renderPostPublishReviewPanel();
assert.strictEqual(_postPublishReviewActiveGroup,'missedReview','empty active group should fall back to next non-empty pending group');
mockBuckets.missedReview=[];
mockBuckets.abnormal2h=[];
mockBuckets.delete24h=[];
mockBuckets.final48h=[];
mockRecords=[{id:'early',earlySkippable:true}];
renderPostPublishReviewPanel();
assert.strictEqual(_postPublishReviewActiveGroup,'empty','all pending groups empty should show empty state');
assert.strictEqual(emptyRenderCalls > 0,true,'empty state should render when all pending groups are empty');
assert(element('postPublishReviewList').innerHTML.includes('1'), 'empty state should keep the backfill prompt count');
`;

new Function('assert', `${sandbox}\n${script.slice(start, end)}\n${tests}`)(assert);

console.log('post review group switch behavior tests passed');
