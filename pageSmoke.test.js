const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

[
  'feishuBackendUrl',
  'feishuAppToken',
  'feishuTableAccounts',
  'feishuTablePublish',
  'feishuTableDrafts',
  'feishuTableMarketing',
  'feishuTableReports',
  'feishuTestResult',
  'feishuSyncStatusPanel',
  'feishuSyncQueueDetails'
].forEach(id => {
  assert(html.includes(`id="${id}"`) || html.includes(`id='${id}'`), `missing required element: ${id}`);
});

[
  'function testFeishuConnection',
  'function renderFeishuTableTestResult',
  'function summarizeFeishuFieldAudits',
  'function renderFeishuSyncStatusPanel',
  'function markFeishuSyncSuccess',
  'function executeFeishuQueueTask',
  'function renderFeishuDuplicateWorkflowPanel'
].forEach(signature => {
  assert(scripts.includes(signature), `missing required function: ${signature}`);
});

assert(scripts.includes("connection:hasAuditIssue?'warning':'success'"), 'field audit warnings should affect connection status');
assert(scripts.includes("fieldAuditError:hasAuditIssue?current.fieldAuditError:''"), 'successful sync should preserve field audit warnings when present');
assert(html.includes("saveFeishuConfigFromForm({markUntested:true})"), 'manual config save should require a fresh connection test');
assert(scripts.includes('publishRecords'), 'publishRecords compatibility path should remain present');
assert(scripts.includes('publishedToday'), 'legacy publishedToday fallback should remain present');

assert(html.includes('VISUAL SYSTEM V10: Avelety-informed ops polish'), 'missing final workbench visual polish layer');
assert(html.includes('.workbench-card.compact{'), 'compact workbench card rules should remain present');
assert(html.includes('overflow:visible;'), 'workbench cards should not clip manual/status tags');
assert(html.includes('white-space:normal;'), 'workbench status tags should be allowed to wrap instead of overlapping');

console.log('page smoke tests passed');
