const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const validateStart = server.indexOf('function validateTestPayload');
const validateEnd = server.indexOf('function validateAccountsListPayload', validateStart);
const matchStart = server.indexOf('function matchRequiredTables');
const matchEnd = server.indexOf('async function listBitableRecords', matchStart);
function helperSlice(startNeedle, endNeedle) {
  const startIndex = server.indexOf(startNeedle);
  const endIndex = server.indexOf(endNeedle, startIndex);
  assert(startIndex > 0 && endIndex > startIndex, `${startNeedle} helper not found`);
  return server.slice(startIndex, endIndex);
}
const aliasHelpers = [
  helperSlice('function accountFieldAliasMap', 'function resolveAccountFieldName'),
  helperSlice('function dailyReportFieldAliasMap', 'function resolveDailyReportFieldName'),
  helperSlice('function canonicalPublishFieldName', 'function resolvePublishFieldName'),
  helperSlice('function draftFieldAliasMap', 'function resolveDraftFieldName'),
  helperSlice('function marketingFieldAliasMap', 'function resolveMarketingFieldName')
].join('\n');
assert(validateStart > 0 && validateEnd > validateStart, 'validateTestPayload helper not found');
assert(matchStart > 0 && matchEnd > matchStart, 'matchRequiredTables helper not found');

Function('assert', `
${server.slice(validateStart, validateEnd)}
${aliasHelpers}
${server.slice(matchStart, matchEnd)}

let payload = validateTestPayload({
  appToken: 'app_token',
  tables: {
    accounts: 'tbl_accounts',
    publish: 'tbl_publish',
    drafts: 'tbl_drafts',
    marketing: 'tbl_marketing'
  }
});
assert.deepStrictEqual(Object.keys(payload.tableIds).sort(), ['accounts', 'drafts', 'marketing', 'publish']);

payload = validateTestPayload({
  appToken: 'app_token',
  tables: {
    accounts: 'tbl_accounts',
    publish: 'tbl_publish',
    drafts: 'tbl_drafts',
    marketing: 'tbl_marketing',
    reports: 'tbl_reports'
  }
});
assert.strictEqual(payload.tableIds.reports, 'tbl_reports');

const matched = matchRequiredTables(payload.tableIds, [
  { tableId: 'tbl_accounts', name: 'Accounts' },
  { tableId: 'tbl_publish', name: 'Publish' },
  { tableId: 'tbl_drafts', name: 'Drafts' },
  { tableId: 'tbl_marketing', name: 'Marketing' },
  { tableId: 'tbl_reports', name: 'Reports' }
]);
assert.strictEqual(matched.reports.name, 'Reports');

assert.throws(() => matchRequiredTables(payload.tableIds, [
  { tableId: 'tbl_accounts', name: 'Accounts' },
  { tableId: 'tbl_publish', name: 'Publish' },
  { tableId: 'tbl_drafts', name: 'Drafts' },
  { tableId: 'tbl_marketing', name: 'Marketing' }
]), error => {
  assert.strictEqual(error.status, 400);
  assert.strictEqual(error.details.missing[0].name, 'reports');
  assert.strictEqual(error.details.missing[0].tableId, 'tbl_reports');
  return true;
});

const publishAudit = buildFeishuFieldAudit('publish', { tableId: 'tbl_publish', name: 'Publish' }, [
  { field_name: '发布日期' },
  { field_name: '账号名' },
  { field_name: '设备号' },
  { field_name: '发布记录ID' }
]);
assert.strictEqual(publishAudit.status, 'warn');
assert.deepStrictEqual(publishAudit.missingRequired, []);
assert(publishAudit.missingRecommended.includes('内容标题 / 选题'), 'recommended publish fields should be checked');
assert(Array.isArray(publishAudit.missingOptional), 'optional field diagnostics should be exposed');

const wrongMarketingAudit = buildFeishuFieldAudit('marketing', { tableId: 'tbl_wrong', name: 'Wrong' }, [
  { field_name: '完全不相关字段' }
]);
assert.strictEqual(wrongMarketingAudit.status, 'error');
assert(wrongMarketingAudit.missingRequired.includes('本地营销记录ID'), 'stable marketing identity field should be required');
assert(wrongMarketingAudit.availableFields.includes('完全不相关字段'), 'available fields should be exposed for diagnosis');

const accountAliasAudit = buildFeishuFieldAudit('accounts', { tableId: 'tbl_accounts', name: 'Accounts' }, [
  { field_name: '账号' },
  { field_name: '设备' },
  { field_name: '账号类型' },
  { field_name: '账号分组' },
  { field_name: '是否禁用' },
  { field_name: '人工指定营销账号' },
  { field_name: '营销任务备注' },
  { field_name: '说明' }
]);
assert.strictEqual(accountAliasAudit.status, 'ok', 'compatible account aliases should not be reported as missing');

const accountOptionalAudit = buildFeishuFieldAudit('accounts', { tableId: 'tbl_accounts', name: 'Accounts' }, [
  { field_name: '账号名' },
  { field_name: '设备号' },
  { field_name: '内容方向' },
  { field_name: '分组' },
  { field_name: '是否禁言' },
  { field_name: '备注' }
]);
assert.strictEqual(accountOptionalAudit.status, 'notice', 'optional account feature fields should not be treated as stability warnings');
assert(accountOptionalAudit.missingOptional.includes('是否指定营销账号'), 'optional account feature fields should remain visible');

const publishAliasAudit = buildFeishuFieldAudit('publish', { tableId: 'tbl_publish', name: 'Publish' }, [
  { field_name: '日期' },
  { field_name: '账号' },
  { field_name: '设备' },
  { field_name: '记录ID' },
  { field_name: '标题' },
  { field_name: '是否营销' },
  { field_name: '体裁' },
  { field_name: '补记' },
  { field_name: '文案ID' },
  { field_name: '营销记录ID' },
  { field_name: '状态' },
  { field_name: '播放量' },
  { field_name: '激励' },
  { field_name: '说明' }
]);
assert.strictEqual(publishAliasAudit.status, 'ok', 'compatible publish aliases should not be reported as missing');

const draftAliasAudit = buildFeishuFieldAudit('drafts', { tableId: 'tbl_drafts', name: 'Drafts' }, [
  { field_name: '文案ID' },
  { field_name: '账号' },
  { field_name: '设备' },
  { field_name: '标题' },
  { field_name: '体裁' },
  { field_name: '类型' },
  { field_name: '口播脚本' },
  { field_name: '创建日期' },
  { field_name: '状态' },
  { field_name: '复盘备注' }
]);
assert.strictEqual(draftAliasAudit.status, 'ok', 'compatible draft aliases should not be reported as missing');

const marketingAliasAudit = buildFeishuFieldAudit('marketing', { tableId: 'tbl_marketing', name: 'Marketing' }, [
  { field_name: '营销记录ID' },
  { field_name: '营销日期' },
  { field_name: '账号' },
  { field_name: '设备' },
  { field_name: '营销标题' },
  { field_name: '状态' },
  { field_name: '已删除' },
  { field_name: '删除日期' },
  { field_name: '实际删除日期' },
  { field_name: '风险备注' },
  { field_name: '营销内容' },
  { field_name: '说明' }
]);
assert.strictEqual(marketingAliasAudit.status, 'ok', 'compatible marketing aliases should not be reported as missing');

const reportsAliasAudit = buildFeishuFieldAudit('reports', { tableId: 'tbl_reports', name: 'Reports' }, [
  { field_name: '日期' },
  { field_name: '账号来源' },
  { field_name: '日报全文' },
  { field_name: '生成时间' },
  { field_name: '最后更新时间' }
]);
assert.strictEqual(reportsAliasAudit.status, 'ok', 'compatible report aliases should not be reported as missing');

console.log('server Feishu table test helpers passed');
`)(assert);
