const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

const start = scripts.indexOf('function getFeishuPublishDuplicateHandledMap');
const end = scripts.indexOf('function getFeishuDuplicateHandledStats', start);
assert(start > 0 && end > start, 'Feishu duplicate UI helpers not found');

Function('assert', `
const FEISHU_PUBLISH_DUPLICATE_HANDLED_KEY = 'handled';
const store = {};
var window = {};
var document = { getElementById(){ return null; } };
var localStorage = {
  getItem(key){ return store[key] || null; },
  setItem(key, value){ store[key] = String(value); }
};
function parseJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}
function rerenderFeishuDuplicateViews() {}
function renderFeishuDuplicateHandledSummary() {}
function renderFeishuDuplicateWorkflowPanel() {}
function renderSaasTopStatusBar() {}
function isPageActive() { return false; }
function refreshReminderPanel() {}

${scripts.slice(start, end)}

const groups = [
  { key: 'low', riskLevel: 'low' },
  { key: 'review', riskLevel: 'review' },
  { key: 'high', riskLevel: 'high' }
];

window._feishuDuplicateHandledFilter = 'all';
window._feishuDuplicateRiskFilter = 'low';
assert.deepStrictEqual(getFeishuDuplicateFilteredGroups(groups).map(group => group.key), ['low']);

window._feishuDuplicateRiskFilter = 'high';
assert.deepStrictEqual(getFeishuDuplicateFilteredGroups(groups).map(group => group.key), ['high']);

saveFeishuPublishDuplicateHandledMap({ high: { groupKey: 'high' } });
window._feishuDuplicateHandledFilter = 'unhandled';
window._feishuDuplicateRiskFilter = 'all';
assert.deepStrictEqual(getFeishuDuplicateFilteredGroups(groups).map(group => group.key), ['low', 'review']);

console.log('feishu duplicate UI tests passed');
`)(assert);
