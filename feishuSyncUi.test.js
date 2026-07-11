const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find(name => name.endsWith('.html'));
assert(htmlFile, 'html file not found');
const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');

const helperStart = scripts.indexOf('function setFeishuResult');
const helperEnd = scripts.indexOf('function setFeishuAccountsPreview', helperStart);
const errorStart = scripts.indexOf('function buildFeishuResponseError');
const errorEnd = scripts.indexOf('async function createDraftOnFeishu', errorStart);
assert(helperStart > 0 && helperEnd > helperStart, 'Feishu table test helpers not found');
assert(errorStart > 0 && errorEnd > errorStart, 'Feishu response error helper not found');

Function('assert', `
var document = { getElementById(){ return null; } };
${scripts.slice(helperStart, helperEnd)}
${scripts.slice(errorStart, errorEnd)}

const auditSummary = summarizeFeishuFieldAudits({
  accounts: { status: 'ok' },
  publish: { status: 'warn' },
  marketing: { status: 'error' }
});
assert.strictEqual(auditSummary.errorCount, 1);
assert.strictEqual(auditSummary.warnCount, 1);
assert.strictEqual(auditSummary.noticeCount, 0);
assert(auditSummary.message.includes('缺关键字段'), 'critical field audit summary should be explicit');
assert(auditSummary.message.includes('营销记录表'), 'critical field audit summary should include table role');

const optionalAuditSummary = summarizeFeishuFieldAudits({
  accounts: { status: 'notice', missingOptional: ['是否指定营销账号', '指定营销内容'] }
});
assert.strictEqual(optionalAuditSummary.errorCount, 0);
assert.strictEqual(optionalAuditSummary.warnCount, 0);
assert.strictEqual(optionalAuditSummary.noticeCount, 1);
assert(optionalAuditSummary.message.includes('缺可选字段'), 'optional field audit summary should be softer than warnings');

const successHtml = renderFeishuTableTestResult({
  tables: {
    accounts: { tableId: 'tbl_acc', name: 'Accounts' },
    publish: { tableId: 'tbl_pub', name: 'Publish Records' },
    drafts: { tableId: 'tbl_draft', name: 'Drafts' },
    marketing: { tableId: 'tbl_marketing', name: 'Marketing' },
    reports: { tableId: 'tbl_report', name: 'Daily Reports' }
  },
  actualTables: [
    { tableId: 'tbl_acc', name: 'Accounts' },
    { tableId: 'tbl_pub', name: 'Publish Records' },
    { tableId: 'tbl_draft', name: 'Drafts' },
    { tableId: 'tbl_marketing', name: 'Marketing' },
    { tableId: 'tbl_report', name: 'Daily Reports' }
  ],
  fieldAudits: {
    accounts: { status: 'notice', fieldCount: 6, missingRequired: [], missingRecommended: [], missingOptional: ['指定营销内容'] },
    publish: { status: 'warn', fieldCount: 4, missingRequired: [], missingRecommended: ['内容标题 / 选题'] },
    drafts: { status: 'ok', fieldCount: 7, missingRequired: [], missingRecommended: [] },
    marketing: { status: 'error', fieldCount: 1, missingRequired: ['本地营销记录ID'], missingRecommended: [], availableFields: ['完全不相关字段'] },
    reports: { status: 'ok', fieldCount: 5, missingRequired: [], missingRecommended: [] }
  }
});
assert(successHtml.includes('tbl_report'), 'optional reports table should be rendered when present');
assert(successHtml.includes('5'), 'matched table count should include reports table');
assert(successHtml.includes('缺建议字段'), 'field warnings should be visible');
assert(successHtml.includes('缺可选字段'), 'optional field notices should be visible');
assert(successHtml.includes('本地营销记录ID'), 'missing critical fields should be visible');
assert(successHtml.includes('复制字段体检报告'), 'field audit report copy action should be visible');

const auditReportText = buildFeishuFieldAuditReportText({
  tables: { marketing: { tableId: 'tbl_marketing', name: 'Marketing' } },
  fieldAudits: {
    marketing: { status: 'error', tableId: 'tbl_marketing', name: 'Marketing', fieldCount: 1, missingRequired: ['本地营销记录ID'], missingRecommended: [], missingOptional: ['删除完成日期'], availableFields: ['完全不相关字段'] }
  }
});
assert(auditReportText.includes('飞书字段体检报告'), 'field audit report should have a clear title');
assert(auditReportText.includes('本地营销记录ID'), 'field audit report should include missing critical fields');
assert(auditReportText.includes('缺可选字段：删除完成日期'), 'field audit report should include optional field notices');
assert(auditReportText.includes('完全不相关字段'), 'field audit report should include current available fields');

const failureMessage = buildFeishuTestFailureMessage({
  message: 'table_id mismatch',
  details: {
    missing: [{ name: 'marketing', tableId: 'tbl_wrong' }],
    actualTables: [
      { table_id: 'tbl_acc', name: 'Accounts' },
      { table_id: 'tbl_marketing', name: 'Marketing' }
    ]
  }
});
assert(failureMessage.includes('tbl_wrong'), 'missing table_id should be visible');
assert(failureMessage.includes('tbl_marketing'), 'available table_id should be visible');

const accountFailureMessage = buildFeishuTestFailureMessage({
  message: 'accounts read failed',
  details: { message: 'permission denied' }
});
assert(accountFailureMessage.includes('permission denied'), 'plain detail message should be visible');

const responseMessage = buildFeishuResponseError({
  message: 'sync failed',
  details: { matchMode: 'base_detail_ambiguous', baseCount: 2 }
});
assert(responseMessage.includes('2'), 'ambiguous candidate count should be visible');

const fieldMismatchMessage = buildFeishuResponseError({
  message: '发布记录表字段未匹配',
  details: {
    reason: 'field_mismatch',
    requestedFields: ['发布日期', '账号名'],
    availableFields: ['完全不相关字段']
  }
});
assert(fieldMismatchMessage.includes('发布日期'), 'requested field names should be visible');
assert(fieldMismatchMessage.includes('完全不相关字段'), 'available field names should be visible');

console.log('feishu sync UI tests passed');
`)(assert);
