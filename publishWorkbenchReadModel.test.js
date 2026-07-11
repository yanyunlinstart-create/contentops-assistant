const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
globalThis.assert = assert;

const bootstrap = `
var assert = globalThis.assert;
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
save=function(){ if(__guardWrites)throw new Error('should not save during workbench read'); };

const day='2026-06-18';
const yesterday='2026-06-17';
const accs=[
  {id:1,name:'A',device:'D1',type:'edu'},
  {id:2,name:'B',device:'D2',type:'edu'}
];
function baseState(extra={}){
  return {
    customAccs:accs,
    publishRecords:[],
    publishedToday:{},
    manualPublishDetails:{},
    marketingRecords:[],
    marketingPublished:{},
    lib:[],
    normalPostCountSinceLastMarketing:{1:0,2:0},
    ...extra
  };
}

__guardWrites = true;

let s=baseState({
  publishRecords:[{id:'p_normal_1',accId:1,publishDate:day,contentType:PUBLISH_RECORD_CONTENT_NORMAL,title:'Normal'}]
});
let row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.isDone,true,'publishRecords normal should complete normal publish');
assert.strictEqual(row.hasTrustedNormalPublish,true);
assert.strictEqual(row.hasLegacyPublishedFallback,false);
assert.strictEqual(row.groupKey,'DONE');
let queue=getTodayPublishQueueRows(s,day,accs);
assert(queue.filter(item=>!item.isDone).every(item=>Number(item.acc.id)!==1),'next queue must not recommend a trusted published account');

s=baseState({publishedToday:{[day]:[1]}});
row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.isDone,true,'publishedToday may only act as legacy fallback');
assert.strictEqual(row.hasTrustedNormalPublish,false);
assert.strictEqual(row.hasLegacyPublishedFallback,true);
assert(row.legacyPublishSources.includes('publishedToday'));
assert.strictEqual(s.publishRecords.length,0,'legacy fallback must not create publishRecords');
const cardHtml=renderWorkbenchCard(row,day);
assert(cardHtml.includes('旧状态兜底'),'legacy fallback should be labeled in workbench card');

s=baseState({
  publishRecords:[{id:'p_marketing_1',accId:1,publishDate:day,contentType:PUBLISH_RECORD_CONTENT_MARKETING,isMarketing:true,title:'Marketing'}],
  publishedToday:{[day]:[1]},
  normalPostCountSinceLastMarketing:{1:5,2:0}
});
row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.hasTrustedMarketingPublish,true);
assert.strictEqual(row.hasTrustedNormalPublish,false);
assert.strictEqual(row.isDone,true,'marketing publishRecords should close today workbench completion');
assert.strictEqual(row.groupKey,'DONE');
assert.strictEqual(row.hasLegacyPublishedFallback,false,'publishedToday must not override existing publishRecords');
assert.strictEqual(hasWorkbenchNormalPublishedOnDate(s,1,day),false);
assert.strictEqual(hasWorkbenchMarketingPublishedOnDate(s,1,day),true);
assert.strictEqual(hasWorkbenchDailyPublishedOnDate(s,1,day),true);
assert.strictEqual(getNormalPostCountSinceLastMarketing(s,1),5,'marketing publish must not increment normal content count');
assert.deepStrictEqual(getMarketingReminderReasons(s,1,day),[],'marketing publishRecords should suppress duplicate marketing reminders');
assert(renderWorkbenchCard(row,day).includes('营销已发'),'marketing-only completion should be visible on workbench card');
queue=getTodayPublishQueueRows(s,day,accs);
assert(queue.filter(item=>!item.isDone).every(item=>Number(item.acc.id)!==1),'marketing published account should not remain in today normal queue');

s=baseState({
  publishRecords:[
    {id:'p_normal_2',accId:1,publishDate:day,contentType:PUBLISH_RECORD_CONTENT_NORMAL,title:'Normal'},
    {id:'p_marketing_2',accId:1,publishDate:day,contentType:PUBLISH_RECORD_CONTENT_MARKETING,isMarketing:true,title:'Marketing'}
  ],
  normalPostCountSinceLastMarketing:{1:5,2:0}
});
row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.hasTrustedNormalPublish,true);
assert.strictEqual(row.hasTrustedMarketingPublish,true);
assert.strictEqual(row.isDone,true);
assert.deepStrictEqual(row.marketingReminderReasons,[],'normal and marketing publishRecords should remain separate but both trusted');

s=baseState({
  publishRecords:[{id:'p_marketing_yesterday',accId:1,publishDate:yesterday,contentType:PUBLISH_RECORD_CONTENT_MARKETING,isMarketing:true,title:'Marketing yesterday'}],
  normalPostCountSinceLastMarketing:{1:0,2:0}
});
row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.isDone,false);
assert.strictEqual(row.priority,'P3','yesterday marketing publish should count as a daily publish action for rotation risk');
assert.strictEqual(hasWorkbenchNormalPublishedOnDate(s,1,yesterday),false);
assert.strictEqual(hasWorkbenchDailyPublishedOnDate(s,1,yesterday),true);

s=baseState({
  publishRecords:[{id:'p_normal_3',accId:1,publishDate:day,contentType:PUBLISH_RECORD_CONTENT_NORMAL,title:'Normal'}],
  publishedToday:{[day]:[2]},
  normalPostCountSinceLastMarketing:{1:0,2:0}
});
queue=getTodayPublishQueueRows(s,day,accs);
const pending=queue.filter(item=>!item.isDone);
assert(pending.every(item=>Number(item.acc.id)!==1),'next suggestion source should not include trusted normal-published account');

s=baseState({
  publishRecords:[{id:'p_yesterday',accId:1,publishDate:yesterday,contentType:PUBLISH_RECORD_CONTENT_NORMAL,title:'Yesterday'}],
  normalPostCountSinceLastMarketing:{1:3}
});
row=getAccountPublishStatus(s,accs[0],day);
assert.strictEqual(row.isDone,false);
assert.strictEqual(row.needMarketing,true,'ordinary history can still trigger marketing suggestion when no marketing publish exists today');

__guardWrites = false;
assert.strictEqual(__writes,0,'workbench read convergence must not write localStorage');
`;

new Function(bootstrap + '\n' + scripts + '\n' + testCode)();
console.log('publishWorkbenchReadModel tests passed');
process.exit(0);
