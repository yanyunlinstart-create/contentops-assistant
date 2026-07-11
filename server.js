const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  buildEducationQuestionPrompt,
  getEducationQuestionOptions
} = require('./contentPrompts');

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';
loadDotEnv();
const REQUEST_TIMEOUT_MS = Number(process.env.FEISHU_REQUEST_TIMEOUT_MS || 20_000);

let tokenCache = {
  token: '',
  expiresAt: 0
};

const PORT = Number(process.env.PORT || 3000);

function summarizeText(text, limit = 500) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
}

function redactSensitiveText(text) {
  return String(text || '')
    .replace(/("tenant_access_token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/("app_secret"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/("app_id"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

function summarizeSafeText(text, limit = 500) {
  return summarizeText(redactSensitiveText(text), limit);
}

function summarizeFeishuResponse(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    code: data.code,
    msg: data.msg || data.message || '',
    dataKeys: data.data && typeof data.data === 'object' ? Object.keys(data.data) : []
  };
}

function redactFeishuUrl(url) {
  return String(url || '')
    .replace(/\/bitable\/v1\/apps\/[^/?#]+/g, '/bitable/v1/apps/[APP_TOKEN]')
    .replace(/\/tables\/[^/?#]+/g, '/tables/[TABLE_ID]');
}

function summarizeError(error, depth = 0) {
  if (!error || depth > 2) return null;
  return {
    name: error.name || '',
    message: error.message || String(error),
    code: error.code || '',
    cause: error.cause ? summarizeError(error.cause, depth + 1) : null,
    stack: summarizeSafeText(error.stack || '', 700)
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError' || String(error.message || '').includes('timeout')) {
      const err = new Error(`Request timeout after ${timeoutMs}ms`);
      err.code = 'REQUEST_TIMEOUT';
      err.isNetworkError = true;
      err.cause = error;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key]) return;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`Missing environment variable: ${name}`);
    err.status = 500;
    throw err;
  }
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      const err = new Error(`飞书返回了非 JSON 响应：HTTP ${response.status}`);
      err.status = response.status;
      err.details = text.slice(0, 300);
      throw err;
    }
  }

  if (!response.ok) {
    const err = new Error(data.msg || data.message || `飞书请求失败：HTTP ${response.status}`);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

async function requestFeishuJson(label, url, options = {}) {
  console.log(`[feishu-api] ${label} request`, {
    method: options.method || 'GET',
    url: redactFeishuUrl(url),
    nodeVersion: process.version
  });

  let response;
  try {
    response = await fetchWithTimeout(url, options);
  } catch (error) {
    const errSummary = summarizeError(error);
    console.log(`[feishu-api] ${label} fetch failed`, {
      url: redactFeishuUrl(url),
      nodeVersion: process.version,
      error: errSummary
    });
    const err = new Error(error.message || '飞书网络请求失败');
    err.isNetworkError = true;
    err.details = {
      kind: 'network',
      url: redactFeishuUrl(url),
      nodeVersion: process.version,
      error: errSummary
    };
    throw err;
  }
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    console.log(`[feishu-api] ${label} non-json response`, {
      httpStatus: response.status,
      rawSummary: summarizeSafeText(text)
    });
    const err = new Error(`飞书返回了非 JSON 响应：HTTP ${response.status}`);
    err.status = response.status;
    err.details = summarizeSafeText(text);
    throw err;
  }

  console.log(`[feishu-api] ${label} response`, {
    httpStatus: response.status,
    code: data.code,
    msg: data.msg || data.message || '',
    rawSummary: summarizeSafeText(text),
    summary: summarizeFeishuResponse(data)
  });

  if (!response.ok) {
    const err = new Error(data.msg || data.message || `飞书请求失败：HTTP ${response.status}`);
    err.status = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

async function requestFeishuJsonWithNetworkRetry(label, url, options = {}, retryDelayMs = 800) {
  try {
    return await requestFeishuJson(label, url, options);
  } catch (error) {
    if (!error.isNetworkError) throw error;
    console.log(`[feishu-api] ${label} retry after network failure`, {
      retryDelayMs,
      firstError: summarizeError(error)
    });
    await wait(retryDelayMs);
    try {
      return await requestFeishuJson(`${label}:retry`, url, options);
    } catch (retryError) {
      if (retryError.isNetworkError) {
        retryError.firstAttempt = error.details || summarizeError(error);
      }
      throw retryError;
    }
  }
}

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const appId = requireEnv('FEISHU_APP_ID');
  const appSecret = requireEnv('FEISHU_APP_SECRET');
  const data = await requestFeishuJson('tenant_access_token', `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  if (data.code !== 0 || !data.tenant_access_token) {
    const err = new Error(data.msg || '获取飞书 tenant_access_token 失败');
    err.details = data;
    throw err;
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Number(data.expire || 7200) * 1000
  };

  return tokenCache.token;
}

function validateTestPayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tables = body?.tables || {};
  const tableIds = {
    accounts: String(tables.accounts || '').trim(),
    publish: String(tables.publish || '').trim(),
    drafts: String(tables.drafts || '').trim(),
    marketing: String(tables.marketing || '').trim()
  };
  const reportsTableId = String(tables.reports || '').trim();

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  Object.entries(tableIds).forEach(([name, value]) => {
    if (!value) {
      const err = new Error(`缺少飞书表 table_id：${name}`);
      err.status = 400;
      throw err;
    }
  });
  if (reportsTableId) tableIds.reports = reportsTableId;

  return { appToken, tableIds };
}

function validateAccountsListPayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.accountsTableId || body?.tables?.accounts || '').trim();

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少账号表 table_id');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId };
}

function validateAccountsCreatePayload(body) {
  const { appToken, tableId } = validateAccountsListPayload(body);
  const fields = body?.fields;

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少账号字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, fields };
}

function validateAccountsUpdatePayload(body) {
  const { appToken, tableId } = validateAccountsListPayload(body);
  const recordId = String(body?.recordId || body?.record_id || body?.feishuRecordId || body?.feishu_record_id || '').trim();
  const fields = body?.fields;

  if (!recordId) {
    const err = new Error('缺少飞书账号表 record_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少账号字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, recordId, fields };
}

function validatePublishRecordCreatePayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.publishTableId || body?.tables?.publish || '').trim();
  const fields = body?.fields;

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少发布记录表 table_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少发布记录字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, fields };
}

function validatePublishRecordDeletePayload(body) {
  const { appToken, tableId, fields } = validatePublishRecordCreatePayload(body);
  const recordId = String(body?.recordId || body?.record_id || body?.publishRecordId || body?.publish_record_id || '').trim();
  return { appToken, tableId, fields, recordId };
}

function validateDailyReportUpsertPayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.reportsTableId || body?.tables?.reports || '').trim();
  const fields = body?.fields;

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少日报表 table_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少日报字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, fields };
}

function validateDailyReportCheckPayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.reportsTableId || body?.tables?.reports || '').trim();
  const date = normalizePublishIdentityDay(body?.date || body?.day || '');
  const accountSource = normalizeFeishuCellValue(body?.accountSource || body?.source || '');

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少日报表 table_id');
    err.status = 400;
    throw err;
  }

  if (!date) {
    const err = new Error('缺少日报日期');
    err.status = 400;
    throw err;
  }

  if (!accountSource) {
    const err = new Error('缺少日报账号来源');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, date, accountSource };
}

function validatePublishDuplicatePreviewPayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.publishTableId || body?.tables?.publish || '').trim();

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少发布记录表 table_id');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId };
}

function validateDraftCreatePayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.draftsTableId || body?.tables?.drafts || '').trim();
  const fields = body?.fields;

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少文案库表 table_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少文案字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, fields };
}

function validateDraftDeletePayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.draftsTableId || body?.tables?.drafts || '').trim();
  const recordId = String(body?.recordId || body?.record_id || body?.draftRecordId || body?.draft_record_id || '').trim();

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少文案库表 table_id');
    err.status = 400;
    throw err;
  }

  if (!recordId) {
    const err = new Error('缺少飞书文案库 record_id');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, recordId };
}

function validateMarketingRecordCreatePayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.marketingTableId || body?.tables?.marketing || '').trim();
  const fields = body?.fields;

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少营销记录表 table_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少营销记录字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, fields };
}

function validateMarketingRecordUpdatePayload(body) {
  const appToken = String(body?.appToken || '').trim();
  const tableId = String(body?.tableId || body?.marketingTableId || body?.tables?.marketing || '').trim();
  const recordId = String(
    body?.recordId ||
    body?.record_id ||
    body?.marketingRecordId ||
    body?.marketing_record_id ||
    body?.feishuRecordId ||
    body?.feishu_record_id ||
    body?.feishuMarketingRecordId ||
    body?.feishu_marketing_record_id ||
    ''
  ).trim();
  const fields = body?.fields;

  if (!appToken) {
    const err = new Error('缺少飞书 app_token');
    err.status = 400;
    throw err;
  }

  if (!tableId) {
    const err = new Error('缺少营销记录表 table_id');
    err.status = 400;
    throw err;
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    const err = new Error('缺少营销记录字段');
    err.status = 400;
    throw err;
  }

  return { appToken, tableId, recordId, fields };
}

function validateMarketingRecordDeletePayload(body) {
  const { appToken, tableId, fields } = validateMarketingRecordCreatePayload(body);
  const recordId = String(
    body?.recordId ||
    body?.record_id ||
    body?.marketingRecordId ||
    body?.marketing_record_id ||
    body?.feishuRecordId ||
    body?.feishu_record_id ||
    body?.feishuMarketingRecordId ||
    body?.feishu_marketing_record_id ||
    ''
  ).trim();
  return { appToken, tableId, recordId, fields };
}

function classifyListTablesError(error) {
  if (error?.isNetworkError || error?.details?.kind === 'network') {
    return '网络请求飞书多维表格接口失败';
  }

  const status = Number(error?.status || 0);
  const details = error?.details || {};
  const code = Number(details.code);
  const msg = String(details.msg || details.message || error?.message || '').toLowerCase();

  if (status === 401 || status === 403 || /permission|forbidden|access|unauthorized|权限/.test(msg)) {
    return '权限不足';
  }

  if (status === 404 || /not found|app_token|app token|bitable|base/.test(msg)) {
    return 'app_token 错误或应用无权访问该多维表格';
  }

  if (status) {
    return `HTTP 非 200：${status}`;
  }

  if (code && code !== 0) {
    return '飞书接口返回错误';
  }

  return '飞书接口异常';
}

function normalizeTableListItems(data) {
  const items = data?.data?.items || data?.data?.tables || [];
  return (Array.isArray(items) ? items : []).map(item => ({
    tableId: String(item.table_id || item.tableId || item.id || '').trim(),
    name: String(item.name || item.table_name || item.tableName || '').trim()
  })).filter(item => item.tableId);
}

async function listFeishuTables(appToken, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?page_size=100`;
  let data;

  try {
    data = await requestFeishuJsonWithNetworkRetry('list_tables', url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  } catch (error) {
    const reason = classifyListTablesError(error);
    console.log('[feishu-test] list tables failed', {
      reason,
      httpStatus: error.status || null,
      code: error.details?.code,
      msg: error.details?.msg || error.details?.message || error.message || '',
      nodeVersion: process.version,
      error: error.details?.error || summarizeError(error),
      firstAttempt: error.firstAttempt || null
    });
    const err = new Error(reason === '网络请求飞书多维表格接口失败' ? reason : `列出数据表失败：${reason}`);
    err.status = error.status || 500;
    err.details = {
      reason,
      httpStatus: error.status || null,
      code: error.details?.code,
      msg: error.details?.msg || error.details?.message || error.message || '',
      nodeVersion: process.version,
      networkError: error.details?.error || null,
      firstAttempt: error.firstAttempt || null,
      raw: error.details || null
    };
    throw err;
  }

  if (data.code !== 0) {
    const reason = classifyListTablesError({ details: data, message: data.msg });
    console.log('[feishu-test] list tables returned non-zero code', {
      reason,
      code: data.code,
      msg: data.msg || data.message || '',
      rawSummary: summarizeFeishuResponse(data)
    });
    const err = new Error(`列出数据表失败：${reason}`);
    err.status = 400;
    err.details = {
      reason,
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  const tables = normalizeTableListItems(data);
  console.log('[feishu-test] listed tables', {
    count: tables.length,
    tables: tables.map(item => ({
      table_id: item.tableId,
      name: item.name
    }))
  });

  return tables;
}

function matchRequiredTables(requiredTableIds, actualTables) {
  const actualMap = new Map(actualTables.map(item => [item.tableId, item]));
  const results = {};
  const missing = [];

  Object.entries(requiredTableIds).forEach(([name, tableId]) => {
    const matched = actualMap.get(tableId);
    if (matched) {
      results[name] = matched;
      return;
    }
    missing.push({
      name,
      tableId
    });
  });

  if (missing.length) {
    const actual = actualTables.map(item => ({
      table_id: item.tableId,
      name: item.name
    }));
    const missingText = missing.map(item => `${item.name}: ${item.tableId}`).join('；');
    const err = new Error(`填写的 table_id 不存在：${missingText}`);
    err.status = 400;
    err.details = {
      missing,
      actualTables: actual,
      message: '请确认 4 个 table_id 是否属于当前 app_token 对应的多维表格。'
    };
    throw err;
  }

  return results;
}

const FEISHU_TABLE_FIELD_PROFILES = {
  accounts: {
    required: ['账号名', '设备号'],
    recommended: ['内容方向', '分组', '是否禁言', '备注'],
    optional: ['是否指定营销账号', '指定营销内容']
  },
  publish: {
    required: ['发布日期', '账号名', '设备号'],
    recommended: ['发布记录ID', '内容标题 / 选题', '内容类型', '发布体裁', '是否补记', '是否营销', '本地文案ID', '本地营销记录ID', '发布状态', '播放 / 阅读量', '是否获得激励', '备注']
  },
  drafts: {
    required: ['本地文案ID', '账号名', '设备号', '选题'],
    recommended: ['发布体裁', '内容类型', '文案正文', '创建时间', '发布状态', '备注']
  },
  marketing: {
    required: ['本地营销记录ID', '营销发布日期', '账号名', '设备号', '营销内容标题'],
    recommended: ['当前状态', '是否已删除', '删除提醒日期', '删除备注', '营销内容正文', '备注'],
    optional: ['删除完成日期']
  },
  reports: {
    required: ['日期', '账号来源', '今日汇报全文'],
    recommended: ['创建时间'],
    optional: ['更新时间']
  }
};

function normalizeBitableFieldName(field) {
  return String(field?.field_name || field?.name || field || '').trim();
}

function getFeishuAuditFieldAliases(role, name) {
  if (role === 'accounts') return accountFieldAliasMap().get(name) || [name];
  if (role === 'publish') return publishFieldAliasMap().get(name) || [name];
  if (role === 'drafts') return draftFieldAliasMap().get(name) || [name];
  if (role === 'marketing') return marketingFieldAliasMap().get(name) || [name];
  if (role === 'reports') return dailyReportFieldAliasMap().get(name) || [name];
  return [name];
}

function hasFeishuAuditField(fieldSet, canonicalFieldSet, role, name) {
  return getFeishuAuditFieldAliases(role, name).some(alias => (
    fieldSet.has(alias) || canonicalFieldSet.has(canonicalPublishFieldName(alias))
  ));
}

function buildFeishuFieldAudit(role, table, tableFields) {
  const profile = FEISHU_TABLE_FIELD_PROFILES[role] || { required: [], recommended: [], optional: [] };
  const fieldNames = (Array.isArray(tableFields) ? tableFields : [])
    .map(normalizeBitableFieldName)
    .filter(Boolean);
  const fieldSet = new Set(fieldNames);
  const canonicalFieldSet = new Set(fieldNames.map(canonicalPublishFieldName));
  const missingRequired = profile.required.filter(name => !hasFeishuAuditField(fieldSet, canonicalFieldSet, role, name));
  const missingRecommended = profile.recommended.filter(name => !hasFeishuAuditField(fieldSet, canonicalFieldSet, role, name));
  const missingOptional = (profile.optional || []).filter(name => !hasFeishuAuditField(fieldSet, canonicalFieldSet, role, name));
  const status = missingRequired.length ? 'error' : (missingRecommended.length ? 'warn' : (missingOptional.length ? 'notice' : 'ok'));

  return {
    role,
    tableId: table?.tableId || table?.table_id || '',
    name: table?.name || '',
    status,
    fieldCount: fieldNames.length,
    requiredFields: profile.required,
    recommendedFields: profile.recommended,
    optionalFields: profile.optional || [],
    missingRequired,
    missingRecommended,
    missingOptional,
    availableFields: fieldNames
  };
}

async function auditFeishuTableFields(tableResults, appToken, token) {
  const audits = {};
  for (const [role, table] of Object.entries(tableResults || {})) {
    try {
      const fields = await listBitableFields(appToken, table.tableId, token);
      audits[role] = buildFeishuFieldAudit(role, table, fields);
    } catch (error) {
      audits[role] = {
        role,
        tableId: table?.tableId || '',
        name: table?.name || '',
        status: 'error',
        fieldCount: 0,
        requiredFields: FEISHU_TABLE_FIELD_PROFILES[role]?.required || [],
        recommendedFields: FEISHU_TABLE_FIELD_PROFILES[role]?.recommended || [],
        optionalFields: FEISHU_TABLE_FIELD_PROFILES[role]?.optional || [],
        missingRequired: FEISHU_TABLE_FIELD_PROFILES[role]?.required || [],
        missingRecommended: FEISHU_TABLE_FIELD_PROFILES[role]?.recommended || [],
        missingOptional: FEISHU_TABLE_FIELD_PROFILES[role]?.optional || [],
        availableFields: [],
        message: error.message || '读取表字段失败',
        details: error.details || null
      };
    }
  }
  return audits;
}

function normalizeFeishuCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'boolean') return value ? '是' : '否';

  if (Array.isArray(value)) {
    return value.map(normalizeFeishuCellValue).filter(Boolean).join('、');
  }

  if (typeof value === 'object') {
    if (value.text !== undefined) return normalizeFeishuCellValue(value.text);
    if (value.name !== undefined) return normalizeFeishuCellValue(value.name);
    if (value.value !== undefined) return normalizeFeishuCellValue(value.value);
    if (value.title !== undefined) return normalizeFeishuCellValue(value.title);
    if (value.link !== undefined) return normalizeFeishuCellValue(value.link);
    if (value.en_us !== undefined || value.zh_cn !== undefined) return normalizeFeishuCellValue(value.zh_cn || value.en_us);
  }

  return String(value || '').trim();
}

function normalizeBooleanField(value) {
  if (typeof value === 'boolean') return value;
  const text = normalizeFeishuCellValue(value).trim().toLowerCase();
  return ['true', 'yes', 'y', '1', '是', '禁言', '禁用', '已禁言'].includes(text);
}

function normalizeAccountRecord(record) {
  const fields = record?.fields || {};
  const recordId = record?.record_id || record?.recordId || record?.id || '';
  return {
    recordId,
    record_id: recordId,
    name: normalizeFeishuCellValue(fields['账号名']),
    device: normalizeFeishuCellValue(fields['设备号']),
    type: normalizeFeishuCellValue(fields['内容方向']),
    group: normalizeFeishuCellValue(fields['分组']),
    muted: normalizeBooleanField(fields['是否禁言']),
    specifiedMarketingAccount: normalizeBooleanField(fields['是否指定营销账号'] ?? fields['是否指定营销内容'] ?? fields['指定营销账号'] ?? fields['人工指定营销账号']),
    specifiedMarketingContent: normalizeFeishuCellValue(fields['指定营销内容'] ?? fields['指定营销任务'] ?? fields['营销任务备注'] ?? fields['指定营销备注']),
    note: normalizeFeishuCellValue(fields['备注'])
  };
}

async function listBitableRecords(appToken, tableId, token) {
  const allItems = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${params}`;
    const data = await requestFeishuJson(`accounts_records:${tableId}`, url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (data.code !== 0) {
      const err = new Error(data.msg || '读取飞书记录失败');
      err.status = 400;
      err.details = {
        code: data.code,
        msg: data.msg || data.message || '',
        raw: summarizeFeishuResponse(data)
      };
      throw err;
    }

    const items = data?.data?.items || [];
    if (Array.isArray(items)) allItems.push(...items);
    pageToken = data?.data?.has_more ? (data?.data?.page_token || '') : '';
  } while (pageToken);

  return allItems;
}

function accountFieldAliasMap() {
  return new Map([
    ['\u8d26\u53f7\u540d', ['\u8d26\u53f7\u540d', '\u8d26\u53f7', '\u540d\u79f0']],
    ['\u8bbe\u5907\u53f7', ['\u8bbe\u5907\u53f7', '\u8bbe\u5907']],
    ['\u5185\u5bb9\u65b9\u5411', ['\u5185\u5bb9\u65b9\u5411', '\u8d26\u53f7\u7c7b\u578b', '\u7c7b\u578b']],
    ['\u5206\u7ec4', ['\u5206\u7ec4', '\u8d26\u53f7\u5206\u7ec4']],
    ['\u662f\u5426\u7981\u8a00', ['\u662f\u5426\u7981\u8a00', '\u7981\u8a00', '\u662f\u5426\u7981\u7528']],
    ['\u662f\u5426\u6307\u5b9a\u8425\u9500\u8d26\u53f7', ['\u662f\u5426\u6307\u5b9a\u8425\u9500\u8d26\u53f7', '\u6307\u5b9a\u8425\u9500\u8d26\u53f7', '\u4eba\u5de5\u6307\u5b9a\u8425\u9500\u8d26\u53f7', '\u662f\u5426\u6307\u5b9a\u8425\u9500\u5185\u5bb9', '\u6307\u5b9a\u8425\u9500\u5185\u5bb9\u8d26\u53f7', '\u8425\u9500\u8d26\u53f7\u6307\u5b9a']],
    ['\u6307\u5b9a\u8425\u9500\u5185\u5bb9', ['\u6307\u5b9a\u8425\u9500\u5185\u5bb9', '\u6307\u5b9a\u8425\u9500\u4efb\u52a1', '\u8425\u9500\u4efb\u52a1\u5907\u6ce8', '\u6307\u5b9a\u8425\u9500\u5907\u6ce8', '\u8425\u9500\u5907\u6ce8']],
    ['\u5907\u6ce8', ['\u5907\u6ce8', '\u8bf4\u660e']]
  ]);
}

function resolveAccountFieldName(requestedName, fieldTypeByName) {
  if (fieldTypeByName.has(requestedName)) return requestedName;
  const byCanonical = new Map();
  fieldTypeByName.forEach((type, actualName) => {
    byCanonical.set(canonicalPublishFieldName(actualName), actualName);
  });
  const aliases = accountFieldAliasMap().get(requestedName) || [requestedName];
  for (const alias of aliases) {
    const actualName = byCanonical.get(canonicalPublishFieldName(alias));
    if (actualName) return actualName;
  }
  return '';
}

function normalizeAccountRecordFields(fields) {
  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    next[key] = value;
  });
  return next;
}

function normalizeAccountFieldValueByType(value, fieldType) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) {
    return fieldType === 1 || fieldType === 10 ? '' : undefined;
  }

  if (fieldType === 2) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  if (fieldType === 7) {
    return typeof value === 'boolean' ? value : normalizeYesNo(value) === '是';
  }

  if (fieldType === 3) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (fieldType === 1 || fieldType === 10) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (typeof value === 'boolean') return normalizeYesNo(value);
  return value;
}

function normalizeAccountRecordFieldsForTable(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });

  if (!fieldTypeByName.size) return normalizeAccountRecordFields(fields);

  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    const actualName = resolveAccountFieldName(key, fieldTypeByName);
    if (!actualName) return;
    const normalized = normalizeAccountFieldValueByType(value, fieldTypeByName.get(actualName));
    if (normalized !== undefined) next[actualName] = normalized;
  });
  return next;
}

function getSkippedAccountFieldNames(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });
  if (!fieldTypeByName.size) return [];
  return Object.keys(fields || {}).filter(key => !resolveAccountFieldName(key, fieldTypeByName));
}

function dailyReportFieldAliasMap() {
  return new Map([
    ['\u65e5\u671f', ['\u65e5\u671f', '\u6c47\u62a5\u65e5\u671f']],
    ['\u8d26\u53f7\u6765\u6e90', ['\u8d26\u53f7\u6765\u6e90', '\u6765\u6e90\u8d26\u53f7']],
    ['\u53c2\u4e0e\u7edf\u8ba1\u8d26\u53f7\u6570', ['\u53c2\u4e0e\u7edf\u8ba1\u8d26\u53f7\u6570', '\u53c2\u4e0e\u8d26\u53f7\u6570']],
    ['\u5df2\u53d1\u5e03\u8d26\u53f7\u6570', ['\u5df2\u53d1\u5e03\u8d26\u53f7\u6570', '\u5df2\u53d1\u5e03']],
    ['\u672a\u53d1\u5e03\u8d26\u53f7\u6570', ['\u672a\u53d1\u5e03\u8d26\u53f7\u6570', '\u672a\u53d1\u5e03']],
    ['\u5b8c\u6210\u7387', ['\u5b8c\u6210\u7387', '\u4eca\u65e5\u5b8c\u6210\u7387']],
    ['\u4eca\u65e5\u6c47\u62a5\u5168\u6587', ['\u4eca\u65e5\u6c47\u62a5\u5168\u6587', '\u6c47\u62a5\u5168\u6587', '\u65e5\u62a5\u5168\u6587']],
    ['\u903e\u671f\u5f85\u8865\u5f55\u6570\u91cf', ['\u903e\u671f\u5f85\u8865\u5f55\u6570\u91cf', 'missedReviewCount']],
    ['20\u5206\u949f\u5f85\u67e5\u770b\u6570\u91cf', ['20\u5206\u949f\u5f85\u67e5\u770b\u6570\u91cf', 'first20Count']],
    ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38\u6570\u91cf', ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38\u6570\u91cf', 'abnormal2hCount']],
    ['24\u5c0f\u65f6\u5efa\u8bae\u5220\u9664\u6570\u91cf', ['24\u5c0f\u65f6\u5efa\u8bae\u5220\u9664\u6570\u91cf', 'delete24hCount']],
    ['48\u5c0f\u65f6\u5f3a\u63d0\u9192\u6570\u91cf', ['48\u5c0f\u65f6\u5f3a\u63d0\u9192\u6570\u91cf', 'final48hCount']],
    ['\u5386\u53f2\u672a\u8865\u5f55\u5f52\u6863\u6570\u91cf', ['\u5386\u53f2\u672a\u8865\u5f55\u5f52\u6863\u6570\u91cf', 'historicalUnfilledCount']],
    ['\u5df2\u5220\u9664\u5e76\u53cd\u9988\u751f\u6210\u6570\u91cf', ['\u5df2\u5220\u9664\u5e76\u53cd\u9988\u751f\u6210\u6570\u91cf', 'deletedFeedbackCount']],
    ['\u5931\u8d25\u6837\u672c\u65b0\u589e\u6570\u91cf', ['\u5931\u8d25\u6837\u672c\u65b0\u589e\u6570\u91cf', 'newFailureSampleCount']],
    ['\u5f85\u540c\u6b65\u4efb\u52a1\u6570', ['\u5f85\u540c\u6b65\u4efb\u52a1\u6570', '\u5f85\u540c\u6b65']],
    ['\u5931\u8d25\u4efb\u52a1\u6570', ['\u5931\u8d25\u4efb\u52a1\u6570', '\u5931\u8d25\u4efb\u52a1']],
    ['\u6570\u636e\u6cbb\u7406\u72b6\u6001', ['\u6570\u636e\u6cbb\u7406\u72b6\u6001', '\u6570\u636e\u6cbb\u7406']],
    ['\u521b\u5efa\u65f6\u95f4', ['\u521b\u5efa\u65f6\u95f4', '\u751f\u6210\u65f6\u95f4']],
    ['\u66f4\u65b0\u65f6\u95f4', ['\u66f4\u65b0\u65f6\u95f4', '\u6700\u540e\u66f4\u65b0\u65f6\u95f4', '\u4fee\u6539\u65f6\u95f4', '\u66f4\u65b0\u65e5\u671f', 'updatedAt']],
    ['\u6765\u6e90', ['\u6765\u6e90', '\u6c47\u62a5\u6765\u6e90']]
  ]);
}

function resolveDailyReportFieldName(requestedName, fieldTypeByName) {
  if (fieldTypeByName.has(requestedName)) return requestedName;
  const byCanonical = new Map();
  fieldTypeByName.forEach((type, actualName) => {
    byCanonical.set(canonicalPublishFieldName(actualName), actualName);
  });
  const aliases = dailyReportFieldAliasMap().get(requestedName) || [requestedName];
  for (const alias of aliases) {
    const actualName = byCanonical.get(canonicalPublishFieldName(alias));
    if (actualName) return actualName;
  }
  return '';
}

function normalizeDailyReportFieldValueByType(value, fieldType) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) {
    return fieldType === 1 || fieldType === 10 ? '' : undefined;
  }

  if (fieldType === 5) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00+08:00`).getTime();
    const time = new Date(text).getTime();
    return Number.isFinite(time) ? time : value;
  }

  if (fieldType === 2) {
    const numberValue = Number(String(value).replace('%', '').trim());
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  if (fieldType === 7) {
    return typeof value === 'boolean' ? value : normalizeYesNo(value) === '是';
  }

  if (fieldType === 3) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (fieldType === 1 || fieldType === 10) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (typeof value === 'boolean') return normalizeYesNo(value);
  return value;
}

function normalizeDailyReportFieldsForTable(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });

  if (!fieldTypeByName.size) return normalizeAccountRecordFields(fields);

  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    const actualName = resolveDailyReportFieldName(key, fieldTypeByName);
    if (!actualName) return;
    const normalized = normalizeDailyReportFieldValueByType(value, fieldTypeByName.get(actualName));
    if (normalized !== undefined) next[actualName] = normalized;
  });
  return next;
}

function getDailyReportFieldValueByAlias(fields, requestedName, tableFields) {
  const source = fields || {};
  if (Object.prototype.hasOwnProperty.call(source, requestedName)) return source[requestedName];
  const fieldTypeByName = getPublishFieldTypeByName(tableFields);
  const actualName = fieldTypeByName.size ? resolveDailyReportFieldName(requestedName, fieldTypeByName) : '';
  if (actualName && Object.prototype.hasOwnProperty.call(source, actualName)) return source[actualName];
  const aliases = dailyReportFieldAliasMap().get(requestedName) || [requestedName];
  const byCanonical = new Map();
  Object.entries(source).forEach(([key, value]) => byCanonical.set(canonicalPublishFieldName(key), value));
  for (const alias of aliases) {
    const value = byCanonical.get(canonicalPublishFieldName(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function getDailyReportIdentity(fields, tableFields) {
  return {
    date: normalizePublishIdentityDay(getDailyReportFieldValueByAlias(fields, '\u65e5\u671f', tableFields)),
    accountSource: normalizeFeishuCellValue(getDailyReportFieldValueByAlias(fields, '\u8d26\u53f7\u6765\u6e90', tableFields))
  };
}

function normalizePublishRecordFields(fields) {
  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && !value.trim()) return;
    next[key] = value;
  });
  const day = String(next['发布日期'] || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) next['发布日期'] = new Date(`${day}T00:00:00+08:00`).getTime();
  return next;
}

function normalizeYesNo(value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  const text = normalizeFeishuCellValue(value);
  if (/^(true|yes|y|1|是|已发布|已补记|营销)$/i.test(text)) return '是';
  if (/^(false|no|n|0|否|未发布|未补记|非营销)$/i.test(text)) return '否';
  return text;
}

function normalizePublishFieldByType(key, value, fieldType) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;

  if (fieldType === 5) {
    const day = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Date(`${day}T00:00:00+08:00`).getTime();
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return time;
    return value;
  }

  if (fieldType === 2) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  if (fieldType === 7) {
    return typeof value === 'boolean' ? value : normalizeYesNo(value) === '是';
  }

  if (fieldType === 3) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (fieldType === 1 || fieldType === 10) {
    return typeof value === 'boolean' ? normalizeYesNo(value) : String(value);
  }

  if (typeof value === 'boolean') return normalizeYesNo(value);
  return value;
}

function publishYesText() {
  return '\u662f';
}

function publishNoText() {
  return '\u5426';
}

function normalizePublishBoolText(value) {
  if (typeof value === 'boolean') return value ? publishYesText() : publishNoText();
  const text = normalizeFeishuCellValue(value);
  if (/^(true|yes|y|1|\u662f|\u5df2\u53d1\u5e03|\u5df2\u8865\u8bb0|\u8425\u9500)$/i.test(text)) return publishYesText();
  if (/^(false|no|n|0|\u5426|\u672a\u53d1\u5e03|\u672a\u8865\u8bb0|\u975e\u8425\u9500)$/i.test(text)) return publishNoText();
  return text;
}

function normalizePublishFieldValueByType(value, fieldType) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;

  if (fieldType === 5) {
    const day = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Date(`${day}T00:00:00+08:00`).getTime();
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : value;
  }

  if (fieldType === 2) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }

  if (fieldType === 7) {
    return typeof value === 'boolean' ? value : normalizePublishBoolText(value) === publishYesText();
  }

  if (fieldType === 3) {
    return typeof value === 'boolean' ? normalizePublishBoolText(value) : String(value);
  }

  if (fieldType === 1 || fieldType === 10) {
    return typeof value === 'boolean' ? normalizePublishBoolText(value) : String(value);
  }

  if (typeof value === 'boolean') return normalizePublishBoolText(value);
  return value;
}

function canonicalPublishFieldName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\/\uff0f\\|]/g, '')
    .replace(/[()（）【】\[\]_-]+/g, '')
    .toLowerCase();
}

function publishFieldAliasMap() {
  return new Map([
    ['\u53d1\u5e03\u8bb0\u5f55ID', ['\u53d1\u5e03\u8bb0\u5f55ID', '\u53d1\u5e03\u8bb0\u5f55 Id', '\u53d1\u5e03\u8bb0\u5f55id', '\u672c\u5730\u53d1\u5e03\u8bb0\u5f55ID', '\u53d1\u5e03ID', '\u8bb0\u5f55ID', 'publishRecordId', 'publish_record_id', 'id']],
    ['\u53d1\u5e03\u65e5\u671f', ['\u53d1\u5e03\u65e5\u671f', '\u65e5\u671f']],
    ['\u8d26\u53f7\u540d', ['\u8d26\u53f7\u540d', '\u8d26\u53f7', '\u540d\u79f0']],
    ['\u8bbe\u5907\u53f7', ['\u8bbe\u5907\u53f7', '\u8bbe\u5907']],
    ['\u5185\u5bb9\u6807\u9898 / \u9009\u9898', [
      '\u5185\u5bb9\u6807\u9898 / \u9009\u9898',
      '\u5185\u5bb9\u6807\u9898/\u9009\u9898',
      '\u5185\u5bb9\u6807\u9898',
      '\u9009\u9898',
      '\u6807\u9898'
    ]],
    ['\u5185\u5bb9\u7c7b\u578b', ['\u5185\u5bb9\u7c7b\u578b', '\u53d1\u5e03\u5185\u5bb9\u7c7b\u578b', '\u5185\u5bb9\u65b9\u5411', '\u53d1\u5e03\u7c7b\u578b', '\u7c7b\u578b', '\u662f\u5426\u8425\u9500', '\u8425\u9500', '\u666e\u901a/\u8425\u9500', 'contentType']],
    ['\u6587\u6848\u6458\u8981', ['\u6587\u6848\u6458\u8981', '\u6807\u9898\u6216\u6587\u6848\u6458\u8981', '\u6458\u8981', 'summary']],
    ['\u53d1\u5e03\u4f53\u88c1', ['\u53d1\u5e03\u4f53\u88c1', '\u4f53\u88c1', '\u7c7b\u578b']],
    ['\u53d1\u5e03\u65f6\u95f4', ['\u53d1\u5e03\u65f6\u95f4', '\u7cbe\u786e\u53d1\u5e03\u65f6\u95f4', 'publishedAt']],
    ['\u6570\u636e\u56de\u8bbf\u72b6\u6001', ['\u6570\u636e\u56de\u8bbf\u72b6\u6001', '\u56de\u8bbf\u72b6\u6001', 'dataReviewStatus']],
    ['\u662f\u5426\u8865\u8bb0', ['\u662f\u5426\u8865\u8bb0', '\u8865\u8bb0']],
    ['\u662f\u5426\u5df2\u53d1\u5e03', ['\u662f\u5426\u5df2\u53d1\u5e03', '\u5df2\u53d1\u5e03', '\u662f\u5426\u53d1\u5e03']],
    ['\u672c\u5730\u6587\u6848ID', ['\u672c\u5730\u6587\u6848ID', '\u6587\u6848ID', '\u8349\u7a3fID', 'draftId', 'localDraftId']],
    ['\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', ['\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', '\u8425\u9500\u8bb0\u5f55ID', '\u8425\u9500ID', 'marketingRecordId', 'localMarketingId']],
    ['\u53d1\u5e03\u72b6\u6001', ['\u53d1\u5e03\u72b6\u6001', '\u5f53\u524d\u72b6\u6001', '\u72b6\u6001', '\u662f\u5426\u5df2\u53d1\u5e03', '\u5df2\u53d1\u5e03', '\u662f\u5426\u53d1\u5e03']],
    ['\u662f\u5426\u8425\u9500', ['\u662f\u5426\u8425\u9500', '\u8425\u9500']],
    ['\u64ad\u653e / \u9605\u8bfb\u91cf', [
      '\u64ad\u653e / \u9605\u8bfb\u91cf',
      '\u64ad\u653e/\u9605\u8bfb\u91cf',
      '\u64ad\u653e\u91cf',
      '\u9605\u8bfb\u91cf'
    ]],
    ['\u70b9\u8d5e', ['\u70b9\u8d5e', '\u70b9\u8d5e\u91cf']],
    ['\u8bc4\u8bba', ['\u8bc4\u8bba', '\u8bc4\u8bba\u91cf']],
    ['\u6536\u85cf', ['\u6536\u85cf', '\u6536\u85cf\u91cf']],
    ['\u5206\u4eab', ['\u5206\u4eab', '\u8f6c\u53d1', '\u5206\u4eab\u91cf']],
    ['\u662f\u5426\u83b7\u5f97\u6fc0\u52b1', ['\u662f\u5426\u83b7\u5f97\u6fc0\u52b1', '\u83b7\u5f97\u6fc0\u52b1', '\u6fc0\u52b1']],
    ['\u5907\u6ce8', ['\u5907\u6ce8', '\u8bf4\u660e']]
  ]);
}

function resolvePublishFieldName(requestedName, fieldTypeByName) {
  if (fieldTypeByName.has(requestedName)) return requestedName;
  const byCanonical = new Map();
  fieldTypeByName.forEach((type, actualName) => {
    byCanonical.set(canonicalPublishFieldName(actualName), actualName);
  });
  const aliases = publishFieldAliasMap().get(requestedName) || [requestedName];
  for (const alias of aliases) {
    const actualName = byCanonical.get(canonicalPublishFieldName(alias));
    if (actualName) return actualName;
  }
  return '';
}

function normalizePublishRecordFieldsForTable(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });

  if (!fieldTypeByName.size) return normalizePublishRecordFields(fields);

  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    const actualName = resolvePublishFieldName(key, fieldTypeByName);
    if (!actualName) return;
    const normalized = normalizePublishFieldValueByType(value, fieldTypeByName.get(actualName));
    if (normalized !== undefined) next[actualName] = normalized;
  });
  return next;
}

function getBitableRecordId(data, fallback = '') {
  return data?.data?.record?.record_id || data?.data?.record_id || fallback || '';
}

function assertNormalizedFieldsNotEmpty(context, fields, normalizedFields, tableFields) {
  const requestedFields = Object.keys(fields || {});
  const sentFields = Object.keys(normalizedFields || {});
  const availableFields = (Array.isArray(tableFields) ? tableFields : [])
    .map(field => String(field.field_name || field.name || '').trim())
    .filter(Boolean);
  if (!requestedFields.length || sentFields.length || !availableFields.length) return;
  const err = new Error(`${context}字段未匹配：请确认 table_id 指向正确表格，或飞书字段名与模板一致`);
  err.status = 400;
  err.details = {
    reason: 'field_mismatch',
    context,
    requestedFields,
    availableFields: availableFields.slice(0, 50)
  };
  throw err;
}

function shanghaiDateKeyFromTime(time) {
  if (!Number.isFinite(time)) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(time));
  } catch (error) {
    return new Date(time).toISOString().slice(0, 10);
  }
}

function normalizePublishIdentityDay(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number') return shanghaiDateKeyFromTime(value);
  const text = normalizeFeishuCellValue(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (/^\d+$/.test(text)) return shanghaiDateKeyFromTime(Number(text));
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? shanghaiDateKeyFromTime(parsed) : text.slice(0, 10);
}

function getPublishFieldTypeByName(tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });
  return fieldTypeByName;
}

function getPublishFieldValueByAlias(fields, requestedName, tableFields) {
  const source = fields || {};
  if (Object.prototype.hasOwnProperty.call(source, requestedName)) return source[requestedName];
  const fieldTypeByName = getPublishFieldTypeByName(tableFields);
  const actualName = fieldTypeByName.size ? resolvePublishFieldName(requestedName, fieldTypeByName) : '';
  if (actualName && Object.prototype.hasOwnProperty.call(source, actualName)) return source[actualName];
  const aliases = publishFieldAliasMap().get(requestedName) || [requestedName];
  const byCanonical = new Map();
  Object.entries(source).forEach(([key, value]) => byCanonical.set(canonicalPublishFieldName(key), value));
  for (const alias of aliases) {
    const value = byCanonical.get(canonicalPublishFieldName(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function getPublishRecordIdentity(fields, tableFields) {
  return {
    publishRecordId: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u53d1\u5e03\u8bb0\u5f55ID', tableFields)),
    publishDate: normalizePublishIdentityDay(getPublishFieldValueByAlias(fields, '\u53d1\u5e03\u65e5\u671f', tableFields)),
    accountName: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u8d26\u53f7\u540d', tableFields)),
    device: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u8bbe\u5907\u53f7', tableFields)),
    contentType: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u5185\u5bb9\u7c7b\u578b', tableFields)),
    title: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u5185\u5bb9\u6807\u9898 / \u9009\u9898', tableFields)),
    publishedAt: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u53d1\u5e03\u65f6\u95f4', tableFields)),
    draftId: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u672c\u5730\u6587\u6848ID', tableFields)),
    marketingRecordId: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', tableFields))
  };
}

function isSamePublishIdentity(recordFields, identity, tableFields) {
  const current = getPublishRecordIdentity(recordFields, tableFields);
  if (identity.publishRecordId) return current.publishRecordId === identity.publishRecordId;
  return current.publishDate === identity.publishDate
    && current.accountName === identity.accountName
    && current.device === identity.device;
}

function normalizePublishIdentityText(value) {
  return normalizeFeishuCellValue(value).replace(/\s+/g, '').trim();
}

function normalizePublishDeviceIdentity(value) {
  return normalizePublishIdentityText(value)
    .toLowerCase()
    .replace(/^(device|dev|\u8bbe\u5907)/, '')
    .replace(/[\u53f7\u865f#\uff03]/g, '');
}

function normalizePublishTitleIdentity(value) {
  return normalizePublishIdentityText(value)
    .toLowerCase()
    .replace(/[\u3000\s"'“”‘’.,，。:：;；!！?？()（）[\]【】<>《》]/g, '');
}

function normalizePublishTypeIdentity(value) {
  return normalizePublishIdentityText(value).toLowerCase();
}

function isSamePublishBaseIdentity(recordFields, identity, tableFields) {
  const current = getPublishRecordIdentity(recordFields, tableFields);
  return current.publishDate === identity.publishDate
    && normalizePublishIdentityText(current.accountName) === normalizePublishIdentityText(identity.accountName)
    && normalizePublishDeviceIdentity(current.device) === normalizePublishDeviceIdentity(identity.device);
}

function isCompatiblePublishDetailIdentity(recordFields, identity, tableFields) {
  const current = getPublishRecordIdentity(recordFields, tableFields);
  const currentType = normalizePublishTypeIdentity(current.contentType);
  const expectedType = normalizePublishTypeIdentity(identity.contentType);
  if (currentType && expectedType && currentType !== expectedType) return false;
  const currentTitle = normalizePublishTitleIdentity(current.title);
  const expectedTitle = normalizePublishTitleIdentity(identity.title);
  if (!currentTitle || !expectedTitle) return true;
  return currentTitle === expectedTitle || currentTitle.includes(expectedTitle) || expectedTitle.includes(currentTitle);
}

function isSamePublishLocalLinkIdentity(recordFields, identity, tableFields) {
  const current = getPublishRecordIdentity(recordFields, tableFields);
  const expectedDraftId = normalizePublishIdentityText(identity.draftId);
  const currentDraftId = normalizePublishIdentityText(current.draftId);
  if (expectedDraftId && currentDraftId && expectedDraftId === currentDraftId) return true;
  const expectedMarketingId = normalizePublishIdentityText(identity.marketingRecordId);
  const currentMarketingId = normalizePublishIdentityText(current.marketingRecordId);
  return !!(expectedMarketingId && currentMarketingId && expectedMarketingId === currentMarketingId);
}

function isSamePublishTitleIdentity(recordFields, identity, tableFields) {
  const current = getPublishRecordIdentity(recordFields, tableFields);
  const currentTitle = normalizePublishTitleIdentity(current.title);
  const expectedTitle = normalizePublishTitleIdentity(identity.title);
  if (!currentTitle || !expectedTitle) return false;
  return currentTitle === expectedTitle || currentTitle.includes(expectedTitle) || expectedTitle.includes(currentTitle);
}

function findPublishIdentityMatches(records, identity, tableFields, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const publishRecordId = normalizePublishIdentityText(identity.publishRecordId);
  if (publishRecordId) {
    const byId = list.filter(record => normalizePublishIdentityText(getPublishRecordIdentity(record?.fields || {}, tableFields).publishRecordId) === publishRecordId);
    if (byId.length) return { records: byId, matchMode: 'record_id' };
  }

  const base = list.filter(record => isSamePublishBaseIdentity(record?.fields || {}, identity, tableFields));
  if (!publishRecordId && !options.conservativeFallback) return { records: base, matchMode: base.length ? 'legacy_base' : 'none', baseCount: base.length };
  if (publishRecordId && base.length > 1) {
    const linked = base.filter(record => isSamePublishLocalLinkIdentity(record?.fields || {}, identity, tableFields));
    if (linked.length === 1) return { records: linked, matchMode: 'base_local_id_unique', baseCount: base.length };
    if (linked.length > 1) return { records: [], matchMode: 'base_local_id_ambiguous', baseCount: linked.length };
    const titled = base.filter(record => isSamePublishTitleIdentity(record?.fields || {}, identity, tableFields));
    if (titled.length === 1) return { records: titled, matchMode: 'base_title_unique', baseCount: base.length };
    if (titled.length > 1) return { records: [], matchMode: 'base_title_ambiguous', baseCount: titled.length };
  }
  if (base.length === 1) return { records: base, matchMode: 'base_unique' };

  const detailed = base.filter(record => isCompatiblePublishDetailIdentity(record?.fields || {}, identity, tableFields));
  if (detailed.length === 1) return { records: detailed, matchMode: 'base_detail_unique' };
  if (detailed.length > 1) return { records: [], matchMode: 'base_detail_ambiguous', baseCount: detailed.length };
  return { records: [], matchMode: base.length ? 'base_ambiguous' : 'none', baseCount: base.length };
}

function describePublishIdentityMatchFailure(details = {}) {
  const matchMode = String(details.matchMode || '').trim();
  const baseCount = Number(details.baseCount || 0);
  if ((matchMode === 'base_ambiguous' || matchMode === 'base_detail_ambiguous' || matchMode === 'base_local_id_ambiguous' || matchMode === 'base_title_ambiguous') && baseCount > 1) {
    return `发布记录匹配到 ${baseCount} 条同日同账号同设备候选，无法唯一确认。请在飞书发布记录表补齐“发布记录ID”，或先处理重复发布记录。`;
  }
  return '';
}

function normalizePublishPreviewBool(value) {
  return normalizePublishBoolText(value) === publishYesText();
}

function normalizePublishPreviewNumber(value) {
  const text = normalizeFeishuCellValue(value);
  if (!text) return '';
  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : text;
}

function normalizeFeishuRecordTime(value) {
  if (!value) return '';
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function normalizePublishRecordPreview(record, tableFields) {
  const fields = record?.fields || {};
  return {
    record_id: record?.record_id || record?.id || '',
    publishRecordId: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u53d1\u5e03\u8bb0\u5f55ID', tableFields)),
    title: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u5185\u5bb9\u6807\u9898 / \u9009\u9898', tableFields)),
    contentType: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u5185\u5bb9\u7c7b\u578b', tableFields)),
    format: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u53d1\u5e03\u4f53\u88c1', tableFields)),
    isManual: normalizePublishPreviewBool(getPublishFieldValueByAlias(fields, '\u662f\u5426\u8865\u8bb0', tableFields)),
    isPublished: normalizePublishPreviewBool(getPublishFieldValueByAlias(fields, '\u662f\u5426\u5df2\u53d1\u5e03', tableFields)),
    isMarketing: normalizePublishPreviewBool(getPublishFieldValueByAlias(fields, '\u662f\u5426\u8425\u9500', tableFields)),
    play: normalizePublishPreviewNumber(getPublishFieldValueByAlias(fields, '\u64ad\u653e / \u9605\u8bfb\u91cf', tableFields)),
    reward: normalizePublishPreviewBool(getPublishFieldValueByAlias(fields, '\u662f\u5426\u83b7\u5f97\u6fc0\u52b1', tableFields)),
    note: normalizeFeishuCellValue(getPublishFieldValueByAlias(fields, '\u5907\u6ce8', tableFields)),
    createdTime: normalizeFeishuRecordTime(record?.created_time || record?.createdTime || record?.created_at),
    updatedTime: normalizeFeishuRecordTime(record?.last_modified_time || record?.updated_time || record?.updatedTime || record?.updated_at)
  };
}

async function previewPublishRecordDuplicates(appToken, tableId, token) {
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-publish-duplicates] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const records = await listBitableRecords(appToken, tableId, token);
  const groupMap = new Map();
  records.forEach(record => {
    const identity = getPublishRecordIdentity(record?.fields || {}, tableFields);
    const hasRecordId = Boolean(identity.publishRecordId);
    if (!hasRecordId && (!identity.publishDate || !identity.accountName || !identity.device)) return;
    const key = hasRecordId ? `record:${identity.publishRecordId}` : `legacy:${identity.publishDate}|${identity.accountName}|${identity.device}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        publishRecordId: identity.publishRecordId,
        publishDate: identity.publishDate,
        accName: identity.accountName,
        device: identity.device,
        contentType: identity.contentType,
        records: []
      });
    }
    groupMap.get(key).records.push(normalizePublishRecordPreview(record, tableFields));
  });

  const groups = [...groupMap.values()]
    .filter(group => group.records.length >= 2)
    .map(group => ({ ...group, count: group.records.length }))
    .sort((a, b) => b.count - a.count || b.publishDate.localeCompare(a.publishDate));

  return {
    rawCount: records.length,
    duplicateGroupCount: groups.length,
    duplicateRecordCount: groups.reduce((sum, group) => sum + group.count, 0),
    groups
  };
}

function hasPublishSuggestionValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function publishSuggestionNumber(value) {
  if (!hasPublishSuggestionValue(value)) return null;
  const numberValue = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(numberValue) ? numberValue : null;
}

function publishSuggestionTimeValue(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function publishSuggestionScore(record) {
  let score = 0;
  if (hasPublishSuggestionValue(record.play)) score += 8;
  if (record.reward) score += 7;
  if (hasPublishSuggestionValue(record.note)) score += 5;
  if (hasPublishSuggestionValue(record.title)) score += 3;
  if (hasPublishSuggestionValue(record.format)) score += 2;
  if (record.isMarketing) score += 3;
  if (record.isManual && (
    hasPublishSuggestionValue(record.play) ||
    record.reward ||
    hasPublishSuggestionValue(record.note)
  )) {
    score += 6;
  }
  return score;
}

function publishSuggestionDistinctValues(records, getter, includeEmpty = false) {
  const valueMap = new Map();
  records.forEach(record => {
    const raw = getter(record);
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!includeEmpty && !text) return;
    const label = text || '(空)';
    if (!valueMap.has(label)) valueMap.set(label, []);
    valueMap.get(label).push(record.record_id || '');
  });
  return [...valueMap.entries()].map(([value, recordIds]) => ({ value, recordIds: recordIds.filter(Boolean) }));
}

function buildPublishSuggestionConflicts(records) {
  const specs = [
    { field: 'title', label: '内容标题 / 选题', getter: record => record.title, includeEmpty: false },
    { field: 'format', label: '发布体裁', getter: record => record.format, includeEmpty: false },
    { field: 'isMarketing', label: '是否营销', getter: record => record.isMarketing ? '是' : '否', includeEmpty: true },
    { field: 'play', label: '播放 / 阅读量', getter: record => hasPublishSuggestionValue(record.play) ? record.play : '', includeEmpty: false },
    { field: 'reward', label: '是否获得激励', getter: record => record.reward ? '是' : '否', includeEmpty: true },
    { field: 'note', label: '备注', getter: record => record.note, includeEmpty: false },
    { field: 'isManual', label: '是否补记', getter: record => record.isManual ? '是' : '否', includeEmpty: true }
  ];

  return specs
    .map(spec => ({
      field: spec.field,
      label: spec.label,
      values: publishSuggestionDistinctValues(records, spec.getter, spec.includeEmpty)
    }))
    .filter(conflict => conflict.values.length >= 2);
}

function choosePublishSuggestionText(records, field) {
  const candidates = publishSuggestionDistinctValues(records, record => record[field], false);
  if (!candidates.length) return { value: '', sourceRecordId: '', conflict: false, candidates: [] };
  if (candidates.length === 1) {
    return {
      value: candidates[0].value,
      sourceRecordId: candidates[0].recordIds[0] || '',
      conflict: false,
      candidates
    };
  }
  return {
    value: `冲突：${candidates.map(item => item.value).join(' / ')}`,
    sourceRecordId: '',
    conflict: true,
    candidates
  };
}

function buildPublishSuggestionMergedPreview(group, records) {
  const title = choosePublishSuggestionText(records, 'title');
  const format = choosePublishSuggestionText(records, 'format');
  const playCandidates = records
    .map(record => ({ recordId: record.record_id || '', value: record.play, numberValue: publishSuggestionNumber(record.play) }))
    .filter(item => hasPublishSuggestionValue(item.value));
  let play = { value: '', sourceRecordId: '', rule: '' };
  if (playCandidates.length) {
    const numericCandidates = playCandidates.filter(item => item.numberValue !== null);
    const chosen = (numericCandidates.length ? numericCandidates : playCandidates)
      .sort((a, b) => {
        if (a.numberValue !== null && b.numberValue !== null) return b.numberValue - a.numberValue;
        return String(b.value).localeCompare(String(a.value));
      })[0];
    play = {
      value: chosen.value,
      sourceRecordId: chosen.recordId,
      rule: numericCandidates.length ? '取最大非空值' : '取非空值'
    };
  }

  const notes = [];
  const noteSeen = new Set();
  records.forEach(record => {
    if (!hasPublishSuggestionValue(record.note)) return;
    const key = `${record.record_id || ''}|${record.note}`;
    if (noteSeen.has(key)) return;
    noteSeen.add(key);
    notes.push({
      recordId: record.record_id || '',
      value: record.note
    });
  });

  return {
    publishDate: group.publishDate,
    accName: group.accName,
    device: group.device,
    title,
    format,
    isManual: records.some(record => record.isManual),
    isPublished: records.some(record => record.isPublished) || true,
    isMarketing: records.some(record => record.isMarketing),
    play,
    reward: records.some(record => record.reward),
    notes
  };
}

function isGenericPublishDuplicateTitle(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return [
    '工作台标记',
    '手动补记发布',
    '网页已发布标记',
    '发布标记'
  ].includes(text);
}

function classifyPublishDuplicateRisk(records, cleanupRecords, conflicts) {
  const conflictFields = new Set((conflicts || []).map(conflict => conflict.field).filter(Boolean));
  const reasons = [];
  let riskLevel = 'low';

  const hasMarketingRecord = records.some(record => record.isMarketing);
  const hasRewardRecord = records.some(record => record.reward);
  const hasManualConflict = conflictFields.has('isManual');
  const hasMarketingConflict = conflictFields.has('isMarketing');
  const hasTitleConflict = conflictFields.has('title');
  const hasNoteConflict = conflictFields.has('note');
  const hasPlayConflict = conflictFields.has('play');
  const playValueSet = new Set(records.map(record => hasPublishSuggestionValue(record.play) ? String(record.play).trim() : '(空)'));
  const hasPlaySpread = records.some(record => hasPublishSuggestionValue(record.play)) && playValueSet.size >= 2;
  const hasMeaningfulTitleConflict = hasTitleConflict && records.some(record => !isGenericPublishDuplicateTitle(record.title));

  if (hasMarketingRecord || hasRewardRecord || hasManualConflict || hasMarketingConflict || hasMeaningfulTitleConflict || hasNoteConflict) {
    riskLevel = 'high';
    if (hasMarketingRecord || hasMarketingConflict) reasons.push('包含营销标记或营销冲突');
    if (hasRewardRecord) reasons.push('包含激励信息');
    if (hasManualConflict) reasons.push('补记状态不一致');
    if (hasMeaningfulTitleConflict) reasons.push('内容标题不是单纯系统标记');
    if (hasNoteConflict) reasons.push('备注不一致');
  } else if (hasPlayConflict || hasPlaySpread || conflictFields.size) {
    riskLevel = 'review';
    if (hasPlayConflict || hasPlaySpread) reasons.push('播放 / 阅读量不同，需确认保留记录已取最大值');
    const otherConflicts = [...conflictFields].filter(field => field !== 'play');
    if (otherConflicts.length) reasons.push('存在非关键字段差异');
  } else {
    reasons.push('字段基本一致，像历史重复标记');
  }

  if (!cleanupRecords.length) {
    riskLevel = riskLevel === 'low' ? 'review' : riskLevel;
    reasons.push('没有明确可处理的重复记录');
  }

  const labels = {
    low: '低风险候选',
    review: '需人工确认',
    high: '高冲突勿删'
  };
  const advices = {
    low: '可作为第一批人工核对对象；确认保留记录无误后，再手动处理重复项。',
    review: '不要直接删除；先确认关键数值或差异字段是否已并入保留记录。',
    high: '暂时不要删除；这组可能混有真实营销、补记、标题或备注信息。'
  };

  return {
    riskLevel,
    riskLabel: labels[riskLevel],
    riskReasons: reasons,
    riskAdvice: advices[riskLevel]
  };
}

function buildPublishDuplicateSuggestion(group) {
  const records = (group.records || []).map((record, index) => ({
    ...record,
    _index: index,
    _score: publishSuggestionScore(record),
    _time: Math.max(publishSuggestionTimeValue(record.updatedTime), publishSuggestionTimeValue(record.createdTime))
  }));
  const sorted = [...records].sort((a, b) => b._score - a._score || b._time - a._time || b._index - a._index);
  const keep = sorted[0] || records[records.length - 1] || {};
  const mostComplete = [...records].sort((a, b) => b._score - a._score || b._index - a._index)[0] || keep;
  const cleanupRecords = records.filter(record => record.record_id !== keep.record_id);
  const reasons = [];
  if (hasPublishSuggestionValue(keep.play)) reasons.push('有播放 / 阅读量');
  if (keep.reward) reasons.push('有激励信息');
  if (hasPublishSuggestionValue(keep.note)) reasons.push('有备注');
  if (hasPublishSuggestionValue(keep.title)) reasons.push('有内容标题 / 选题');
  if (hasPublishSuggestionValue(keep.format)) reasons.push('有发布体裁');
  if (keep.isMarketing) reasons.push('营销标记为是');
  if (keep.isManual) reasons.push('包含补记信息');
  if (!reasons.length) reasons.push('信息完整度与同组记录接近');
  if (keep._time) reasons.push('时间较新');
  else reasons.push('无法判断最新，按列表顺序保留更靠后的记录');
  const conflicts = buildPublishSuggestionConflicts(records);
  const mergedPreview = buildPublishSuggestionMergedPreview(group, records);
  const risk = classifyPublishDuplicateRisk(records, cleanupRecords, conflicts);

  return {
    key: group.key,
    publishDate: group.publishDate,
    accName: group.accName,
    device: group.device,
    count: group.count,
    suggestedKeepRecordId: keep.record_id || '',
    mostCompleteRecordId: mostComplete.record_id || '',
    suspectedCleanupRecordIds: cleanupRecords.map(record => record.record_id).filter(Boolean),
    cleanupRecordIds: cleanupRecords.map(record => record.record_id).filter(Boolean),
    keepReason: reasons.join('；'),
    conflicts,
    mergedPreview,
    ...risk,
    records: records.map(({ _index, _score, _time, ...record }) => record)
  };
}

async function previewPublishDuplicateSuggestions(appToken, tableId, token) {
  const duplicatePreview = await previewPublishRecordDuplicates(appToken, tableId, token);
  const groups = (duplicatePreview.groups || []).map(buildPublishDuplicateSuggestion);
  return {
    rawCount: duplicatePreview.rawCount,
    duplicateGroupCount: duplicatePreview.duplicateGroupCount,
    duplicateRecordCount: duplicatePreview.duplicateRecordCount,
    suggestionCount: groups.length,
    riskStats: groups.reduce((stats, group) => {
      const level = group.riskLevel || 'review';
      stats[level] = (stats[level] || 0) + 1;
      return stats;
    }, { low: 0, review: 0, high: 0 }),
    groups
  };
}

function draftFieldAliasMap() {
  return new Map([
    ['\u672c\u5730\u6587\u6848ID', ['\u672c\u5730\u6587\u6848ID', '\u6587\u6848ID', '\u672c\u5730\u8bb0\u5f55ID', 'localDraftId', 'draftId']],
    ['\u521b\u5efa\u65f6\u95f4', ['\u521b\u5efa\u65f6\u95f4', '\u521b\u5efa\u65e5\u671f', '\u65f6\u95f4']],
    ['\u8d26\u53f7\u540d', ['\u8d26\u53f7\u540d', '\u8d26\u53f7', '\u540d\u79f0']],
    ['\u8bbe\u5907\u53f7', ['\u8bbe\u5907\u53f7', '\u8bbe\u5907']],
    ['\u5185\u5bb9\u65b9\u5411', ['\u5185\u5bb9\u65b9\u5411', '\u65b9\u5411']],
    ['\u5185\u5bb9\u7c7b\u578b', ['\u5185\u5bb9\u7c7b\u578b', '\u5185\u5bb9\u65b9\u5411', '\u53d1\u5e03\u7c7b\u578b', '\u7c7b\u578b', '\u662f\u5426\u8425\u9500', '\u666e\u901a/\u8425\u9500']],
    ['\u9009\u9898', ['\u9009\u9898', '\u5185\u5bb9\u6807\u9898', '\u6807\u9898', '\u5185\u5bb9\u6807\u9898 / \u9009\u9898']],
    ['\u53d1\u5e03\u4f53\u88c1', ['\u53d1\u5e03\u4f53\u88c1', '\u4f53\u88c1', '\u7c7b\u578b']],
    ['\u53e3\u64ad\u811a\u672c', ['\u53e3\u64ad\u811a\u672c', '\u53e3\u64ad', '\u811a\u672c']],
    ['\u6587\u6848\u6b63\u6587', ['\u6587\u6848\u6b63\u6587', '\u6587\u6848\u5185\u5bb9', '\u5185\u5bb9\u6b63\u6587', '\u6b63\u6587', '\u53e3\u64ad\u811a\u672c', '\u53e3\u64ad', '\u811a\u672c']],
    ['\u56fe\u6587\u7ed3\u6784', ['\u56fe\u6587\u7ed3\u6784', '\u56fe\u6587\u9875\u6587\u6848', '\u56fe\u6587\u6587\u6848']],
    ['\u914d\u6587', ['\u914d\u6587', '\u53d1\u5e03\u914d\u6587']],
    ['\u7f6e\u9876\u8bc4\u8bba', ['\u7f6e\u9876\u8bc4\u8bba', '\u7f6e\u9876']],
    ['\u8bdd\u9898\u6807\u7b7e', ['\u8bdd\u9898\u6807\u7b7e', '\u6807\u7b7e']],
    ['\u7d20\u6750\u5173\u952e\u8bcd', ['\u7d20\u6750\u5173\u952e\u8bcd', '\u7d20\u6750', '\u5173\u952e\u8bcd']],
    ['\u6863\u4f4d', ['\u6863\u4f4d', '\u8bc4\u6863']],
    ['\u662f\u5426\u5df2\u4f7f\u7528', ['\u662f\u5426\u5df2\u4f7f\u7528', '\u5df2\u4f7f\u7528', '\u662f\u5426\u4f7f\u7528']],
    ['\u5f53\u524d\u72b6\u6001', ['\u5f53\u524d\u72b6\u6001', '\u72b6\u6001', '\u53d1\u5e03\u72b6\u6001']],
    ['\u53d1\u5e03\u72b6\u6001', ['\u53d1\u5e03\u72b6\u6001', '\u5f53\u524d\u72b6\u6001', '\u72b6\u6001', '\u662f\u5426\u5df2\u4f7f\u7528', '\u5df2\u4f7f\u7528']],
    ['\u751f\u6210\u7248\u672c', ['\u751f\u6210\u7248\u672c', 'generationVersion', 'promptVersion', '\u751f\u6210\u89c4\u5219\u7248\u672c', '\u63d0\u793a\u8bcd\u7248\u672c']],
    ['\u8bc4\u6863\u65e5\u671f', ['\u8bc4\u6863\u65e5\u671f', '\u8bc4\u5206\u65e5\u671f', '\u590d\u76d8\u65e5\u671f']],
    ['\u4e09\u6863\u5931\u8d25\u539f\u56e0', ['\u4e09\u6863\u5931\u8d25\u539f\u56e0', '\u5931\u8d25\u539f\u56e0', '\u539f\u56e0']],
    ['\u53d1\u5e03\u65f6\u95f4', ['\u53d1\u5e03\u65f6\u95f4', '\u53d1\u5e03\u65e5\u671f']],
    ['\u6570\u636e\u56de\u8bbf\u72b6\u6001', ['\u6570\u636e\u56de\u8bbf\u72b6\u6001', '\u56de\u8bbf\u72b6\u6001', 'dataReviewStatus']],
    ['20\u5206\u949f\u68c0\u67e5\u65f6\u95f4', ['20\u5206\u949f\u68c0\u67e5\u65f6\u95f4', '\u9996\u8f6e\u68c0\u67e5\u65f6\u95f4', 'firstCheckAt']],
    ['20\u5206\u949f\u662f\u5426\u5df2\u67e5\u770b', ['20\u5206\u949f\u662f\u5426\u5df2\u67e5\u770b', '\u9996\u8f6e\u662f\u5426\u5df2\u67e5\u770b', 'firstChecked']],
    ['20\u5206\u949f0\u6570\u636e\u4fe1\u53f7', ['20\u5206\u949f0\u6570\u636e\u4fe1\u53f7', 'firstCheckZeroData']],
    ['2\u5c0f\u65f6\u68c0\u67e5\u65f6\u95f4', ['2\u5c0f\u65f6\u68c0\u67e5\u65f6\u95f4', 'abnormalCheckAt']],
    ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38', ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38', 'zeroData2h']],
    ['\u5f02\u5e38\u539f\u56e0', ['\u5f02\u5e38\u539f\u56e0', 'abnormalReason']],
    ['24\u5c0f\u65f6\u5efa\u8bae\u5220\u9664\u65f6\u95f4', ['24\u5c0f\u65f6\u5efa\u8bae\u5220\u9664\u65f6\u95f4', 'deleteSuggestCheckAt']],
    ['24\u5c0f\u65f60\u6570\u636e', ['24\u5c0f\u65f60\u6570\u636e', 'zeroData24h']],
    ['\u662f\u5426\u5efa\u8bae\u5220\u9664', ['\u662f\u5426\u5efa\u8bae\u5220\u9664', 'deleteSuggested']],
    ['48\u5c0f\u65f6\u5f3a\u63d0\u9192\u65f6\u95f4', ['48\u5c0f\u65f6\u5f3a\u63d0\u9192\u65f6\u95f4', 'finalZeroCheckAt']],
    ['48\u5c0f\u65f60\u6570\u636e', ['48\u5c0f\u65f60\u6570\u636e', 'zeroData48h']],
    ['\u5220\u9664\u539f\u56e0', ['\u5220\u9664\u539f\u56e0', 'deleteReason']],
    ['\u662f\u5426\u53cd\u9988\u751f\u6210', ['\u662f\u5426\u53cd\u9988\u751f\u6210', 'feedbackToGeneration']],
    ['\u5931\u8d25\u7c7b\u578b', ['\u5931\u8d25\u7c7b\u578b', 'failureType']],
    ['\u5931\u8d25\u6743\u91cd', ['\u5931\u8d25\u6743\u91cd', 'failureWeight']],
    ['\u8fd0\u8425\u8bca\u65ad\u89c4\u5219', ['\u8fd0\u8425\u8bca\u65ad\u89c4\u5219', 'operationDiagnosisRule']],
    ['\u8fd0\u8425\u8bca\u65ad\u5047\u8bbe', ['\u8fd0\u8425\u8bca\u65ad\u5047\u8bbe', 'operationDiagnosisHypothesis']],
    ['\u8fd0\u8425\u8bca\u65ad\u7f6e\u4fe1\u5ea6', ['\u8fd0\u8425\u8bca\u65ad\u7f6e\u4fe1\u5ea6', 'operationDiagnosisConfidence']],
    ['\u64ad\u653e / \u9605\u8bfb\u91cf', ['\u64ad\u653e / \u9605\u8bfb\u91cf', '\u64ad\u653e/\u9605\u8bfb\u91cf', '\u64ad\u653e\u91cf', '\u9605\u8bfb\u91cf']],
    ['\u70b9\u8d5e', ['\u70b9\u8d5e', '\u70b9\u8d5e\u91cf']],
    ['\u8bc4\u8bba', ['\u8bc4\u8bba', '\u8bc4\u8bba\u91cf']],
    ['\u6536\u85cf', ['\u6536\u85cf', '\u6536\u85cf\u91cf']],
    ['\u5206\u4eab', ['\u5206\u4eab', '\u8f6c\u53d1', '\u5206\u4eab\u91cf']],
    ['\u590d\u76d8\u5907\u6ce8', ['\u590d\u76d8\u5907\u6ce8', '\u590d\u76d8', '\u5907\u6ce8']],
    ['\u5907\u6ce8', ['\u5907\u6ce8', '\u8bf4\u660e', '\u590d\u76d8\u5907\u6ce8']]
  ]);
}

function resolveDraftFieldName(requestedName, fieldTypeByName) {
  if (fieldTypeByName.has(requestedName)) return requestedName;
  const byCanonical = new Map();
  fieldTypeByName.forEach((type, actualName) => {
    byCanonical.set(canonicalPublishFieldName(actualName), actualName);
  });
  const aliases = draftFieldAliasMap().get(requestedName) || [requestedName];
  for (const alias of aliases) {
    const actualName = byCanonical.get(canonicalPublishFieldName(alias));
    if (actualName) return actualName;
  }
  return '';
}

function normalizeDraftRecordFieldsForTable(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });

  if (!fieldTypeByName.size) return normalizePublishRecordFields(fields);

  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    const actualName = resolveDraftFieldName(key, fieldTypeByName);
    if (!actualName) return;
    const normalized = normalizePublishFieldValueByType(value, fieldTypeByName.get(actualName));
    if (normalized !== undefined) next[actualName] = normalized;
  });
  return next;
}

function getDraftFieldValueByAlias(fields, requestedName, tableFields) {
  const source = fields || {};
  if (Object.prototype.hasOwnProperty.call(source, requestedName)) return source[requestedName];
  const fieldTypeByName = getPublishFieldTypeByName(tableFields);
  const actualName = fieldTypeByName.size ? resolveDraftFieldName(requestedName, fieldTypeByName) : '';
  if (actualName && Object.prototype.hasOwnProperty.call(source, actualName)) return source[actualName];
  const aliases = draftFieldAliasMap().get(requestedName) || [requestedName];
  const byCanonical = new Map();
  Object.entries(source).forEach(([key, value]) => byCanonical.set(canonicalPublishFieldName(key), value));
  for (const alias of aliases) {
    const value = byCanonical.get(canonicalPublishFieldName(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function getDraftRecordIdentity(fields, tableFields) {
  return {
    draftId: normalizeFeishuCellValue(getDraftFieldValueByAlias(fields, '\u672c\u5730\u6587\u6848ID', tableFields))
  };
}

function findDraftIdentityMatches(records, identity, tableFields) {
  const list = Array.isArray(records) ? records : [];
  const draftId = normalizeMarketingIdentityText(identity?.draftId || '');
  if (!draftId) return { records: [], matchMode: 'none' };
  const matched = list.filter(record => normalizeMarketingIdentityText(getDraftRecordIdentity(record?.fields || {}, tableFields).draftId) === draftId);
  return matched.length
    ? { records: matched, matchMode: 'local_id' }
    : { records: [], matchMode: 'none' };
}

function marketingFieldAliasMap() {
  return new Map([
    ['\u8425\u9500\u53d1\u5e03\u65e5\u671f', ['\u8425\u9500\u53d1\u5e03\u65e5\u671f', '\u53d1\u5e03\u65e5\u671f', '\u8425\u9500\u65e5\u671f']],
    ['\u53d1\u5e03\u65f6\u95f4', ['\u53d1\u5e03\u65f6\u95f4', '\u7cbe\u786e\u53d1\u5e03\u65f6\u95f4', 'publishedAt']],
    ['\u8d26\u53f7\u540d', ['\u8d26\u53f7\u540d', '\u8d26\u53f7', '\u540d\u79f0']],
    ['\u8bbe\u5907\u53f7', ['\u8bbe\u5907\u53f7', '\u8bbe\u5907']],
    ['\u8425\u9500\u5185\u5bb9\u6807\u9898', ['\u8425\u9500\u5185\u5bb9\u6807\u9898', '\u8425\u9500\u6807\u9898', '\u5185\u5bb9\u6807\u9898', '\u6807\u9898']],
    ['\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', ['\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', '\u672c\u5730\u8bb0\u5f55ID', '\u8425\u9500\u8bb0\u5f55ID', '\u8425\u9500ID', 'localMarketingId', 'marketingRecordId']],
    ['\u5220\u9664\u63d0\u9192\u65e5\u671f', ['\u5220\u9664\u63d0\u9192\u65e5\u671f', '\u5e94\u5220\u9664\u65e5\u671f', '\u5220\u9664\u65e5\u671f']],
    ['\u662f\u5426\u5df2\u5220\u9664', ['\u662f\u5426\u5df2\u5220\u9664', '\u5df2\u5220\u9664', '\u662f\u5426\u5220\u9664']],
    ['\u662f\u5426\u6307\u5b9a\u8425\u9500\u5185\u5bb9', ['\u662f\u5426\u6307\u5b9a\u8425\u9500\u5185\u5bb9', '\u662f\u5426\u4eba\u5de5\u6307\u5b9a\u8425\u9500\u5185\u5bb9', '\u4eba\u5de5\u6307\u5b9a\u8425\u9500\u5185\u5bb9']],
    ['\u6307\u5b9a\u8425\u9500\u5185\u5bb9', ['\u6307\u5b9a\u8425\u9500\u5185\u5bb9', '\u6307\u5b9a\u8425\u9500\u4efb\u52a1', '\u8425\u9500\u4efb\u52a1\u5907\u6ce8', '\u6307\u5b9a\u8425\u9500\u5907\u6ce8']],
    ['\u5f53\u524d\u72b6\u6001', ['\u5f53\u524d\u72b6\u6001', '\u72b6\u6001']],
    ['\u5220\u9664\u5b8c\u6210\u65e5\u671f', ['\u5220\u9664\u5b8c\u6210\u65e5\u671f', '\u5220\u9664\u5b8c\u6210\u65f6\u95f4', '\u5b9e\u9645\u5220\u9664\u65e5\u671f', '\u5df2\u5220\u9664\u65e5\u671f', '\u5220\u9664\u65f6\u95f4', 'deletedAt']],
    ['\u5220\u9664\u5907\u6ce8', ['\u5220\u9664\u5907\u6ce8', '\u5220\u9664\u539f\u56e0', '\u5220\u9664\u8bf4\u660e', '\u5220\u9664\u539f\u56e0\u8bf4\u660e', '\u98ce\u9669\u5907\u6ce8', '\u5907\u6ce8', '\u8bf4\u660e']],
    ['\u8425\u9500\u5185\u5bb9\u6b63\u6587', ['\u8425\u9500\u5185\u5bb9\u6b63\u6587', '\u8425\u9500\u5185\u5bb9', '\u5185\u5bb9\u6b63\u6587', '\u8425\u9500\u6587\u6848', '\u6307\u5b9a\u8425\u9500\u5185\u5bb9']],
    ['\u64ad\u653e / \u9605\u8bfb\u91cf', ['\u64ad\u653e / \u9605\u8bfb\u91cf', '\u64ad\u653e/\u9605\u8bfb\u91cf', '\u64ad\u653e\u91cf', '\u9605\u8bfb\u91cf']],
    ['\u70b9\u8d5e', ['\u70b9\u8d5e', '\u70b9\u8d5e\u91cf']],
    ['\u8bc4\u8bba', ['\u8bc4\u8bba', '\u8bc4\u8bba\u91cf']],
    ['\u6536\u85cf', ['\u6536\u85cf', '\u6536\u85cf\u91cf']],
    ['\u5206\u4eab', ['\u5206\u4eab', '\u8f6c\u53d1', '\u5206\u4eab\u91cf']],
    ['20\u5206\u949f\u68c0\u67e5\u65f6\u95f4', ['20\u5206\u949f\u68c0\u67e5\u65f6\u95f4', 'firstCheckAt']],
    ['20\u5206\u949f\u662f\u5426\u5df2\u67e5\u770b', ['20\u5206\u949f\u662f\u5426\u5df2\u67e5\u770b', 'firstChecked']],
    ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38', ['2\u5c0f\u65f60\u6570\u636e\u5f02\u5e38', 'zeroData2h']],
    ['24\u5c0f\u65f60\u6570\u636e', ['24\u5c0f\u65f60\u6570\u636e', 'zeroData24h']],
    ['\u662f\u5426\u5efa\u8bae\u5220\u9664', ['\u662f\u5426\u5efa\u8bae\u5220\u9664', 'deleteSuggested']],
    ['48\u5c0f\u65f60\u6570\u636e', ['48\u5c0f\u65f60\u6570\u636e', 'zeroData48h']],
    ['\u5220\u9664\u539f\u56e0', ['\u5220\u9664\u539f\u56e0', 'deleteReason']],
    ['\u662f\u5426\u53cd\u9988\u751f\u6210', ['\u662f\u5426\u53cd\u9988\u751f\u6210', 'feedbackToGeneration']],
    ['\u5931\u8d25\u7c7b\u578b', ['\u5931\u8d25\u7c7b\u578b', 'failureType']],
    ['\u5931\u8d25\u6743\u91cd', ['\u5931\u8d25\u6743\u91cd', 'failureWeight']],
    ['\u8fd0\u8425\u8bca\u65ad\u89c4\u5219', ['\u8fd0\u8425\u8bca\u65ad\u89c4\u5219', 'operationDiagnosisRule']],
    ['\u8fd0\u8425\u8bca\u65ad\u5047\u8bbe', ['\u8fd0\u8425\u8bca\u65ad\u5047\u8bbe', 'operationDiagnosisHypothesis']],
    ['\u8fd0\u8425\u8bca\u65ad\u7f6e\u4fe1\u5ea6', ['\u8fd0\u8425\u8bca\u65ad\u7f6e\u4fe1\u5ea6', 'operationDiagnosisConfidence']],
    ['\u6765\u6e90', ['\u6765\u6e90', '\u89e6\u53d1\u6765\u6e90']],
    ['\u98ce\u9669\u5907\u6ce8', ['\u98ce\u9669\u5907\u6ce8', '\u5907\u6ce8', '\u8bf4\u660e', '\u98ce\u9669']],
    ['\u5907\u6ce8', ['\u5907\u6ce8', '\u8bf4\u660e', '\u98ce\u9669\u5907\u6ce8']],
    ['\u521b\u5efa\u65f6\u95f4', ['\u521b\u5efa\u65f6\u95f4', '\u521b\u5efa\u65e5\u671f']]
  ]);
}

function resolveMarketingFieldName(requestedName, fieldTypeByName) {
  if (fieldTypeByName.has(requestedName)) return requestedName;
  const byCanonical = new Map();
  fieldTypeByName.forEach((type, actualName) => {
    byCanonical.set(canonicalPublishFieldName(actualName), actualName);
  });
  const aliases = marketingFieldAliasMap().get(requestedName) || [requestedName];
  for (const alias of aliases) {
    const actualName = byCanonical.get(canonicalPublishFieldName(alias));
    if (actualName) return actualName;
  }
  return '';
}

function normalizeMarketingRecordFieldsForTable(fields, tableFields) {
  const fieldTypeByName = new Map();
  (Array.isArray(tableFields) ? tableFields : []).forEach(field => {
    const name = String(field.field_name || field.name || '').trim();
    if (name) fieldTypeByName.set(name, Number(field.type));
  });

  if (!fieldTypeByName.size) return normalizePublishRecordFields(fields);

  const next = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    const actualName = resolveMarketingFieldName(key, fieldTypeByName);
    if (!actualName) return;
    const normalized = normalizePublishFieldValueByType(value, fieldTypeByName.get(actualName));
    if (normalized !== undefined) next[actualName] = normalized;
  });
  return next;
}

function getMarketingPayloadValueByAlias(fields, requestedName) {
  const source = fields || {};
  if (Object.prototype.hasOwnProperty.call(source, requestedName)) return source[requestedName];
  const aliases = marketingFieldAliasMap().get(requestedName) || [requestedName];
  const byCanonical = new Map();
  Object.entries(source).forEach(([key, value]) => byCanonical.set(canonicalPublishFieldName(key), value));
  for (const alias of aliases) {
    const value = byCanonical.get(canonicalPublishFieldName(alias));
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveMarketingDeletedIntent(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = normalizeFeishuCellValue(value).trim().toLowerCase();
  if (/^(true|yes|y|1|\u662f|\u5df2\u5220\u9664|deleted)$/i.test(text)) return true;
  if (/^(false|no|n|0|\u5426|\u8fdb\u884c\u4e2d|active|undo|reopen)$/i.test(text)) return false;
  return null;
}

function completeMarketingStatusFields(fields) {
  const next = { ...(fields || {}) };
  const deletedValue = getMarketingPayloadValueByAlias(next, '\u662f\u5426\u5df2\u5220\u9664');
  const statusValue = getMarketingPayloadValueByAlias(next, '\u5f53\u524d\u72b6\u6001');
  const deletedIntent = resolveMarketingDeletedIntent(deletedValue);
  const statusText = normalizeFeishuCellValue(statusValue).trim();
  const hasDeletedValue = deletedValue !== undefined && deletedValue !== null && String(deletedValue).trim() !== '';
  const hasStatusValue = statusText !== '';

  if (deletedIntent === true && !hasStatusValue) next['\u5f53\u524d\u72b6\u6001'] = '\u5df2\u5220\u9664';
  if (deletedIntent === false && !hasStatusValue) next['\u5f53\u524d\u72b6\u6001'] = '\u8fdb\u884c\u4e2d';
  if (!hasDeletedValue && statusText === '\u5df2\u5220\u9664') next['\u662f\u5426\u5df2\u5220\u9664'] = '\u662f';
  if (!hasDeletedValue && statusText === '\u8fdb\u884c\u4e2d') next['\u662f\u5426\u5df2\u5220\u9664'] = '\u5426';

  return next;
}

function getMarketingFieldValueByAlias(fields, requestedName, tableFields) {
  const source = fields || {};
  if (Object.prototype.hasOwnProperty.call(source, requestedName)) return source[requestedName];
  const fieldTypeByName = getPublishFieldTypeByName(tableFields);
  const actualName = fieldTypeByName.size ? resolveMarketingFieldName(requestedName, fieldTypeByName) : '';
  if (actualName && Object.prototype.hasOwnProperty.call(source, actualName)) return source[actualName];
  return getMarketingPayloadValueByAlias(source, requestedName);
}

function getMarketingRecordIdentity(fields, tableFields) {
  return {
    localId: normalizeFeishuCellValue(getMarketingFieldValueByAlias(fields, '\u672c\u5730\u8425\u9500\u8bb0\u5f55ID', tableFields)),
    postedAt: normalizePublishIdentityDay(getMarketingFieldValueByAlias(fields, '\u8425\u9500\u53d1\u5e03\u65e5\u671f', tableFields)),
    accountName: normalizeFeishuCellValue(getMarketingFieldValueByAlias(fields, '\u8d26\u53f7\u540d', tableFields)),
    device: normalizeFeishuCellValue(getMarketingFieldValueByAlias(fields, '\u8bbe\u5907\u53f7', tableFields)),
    title: normalizeFeishuCellValue(getMarketingFieldValueByAlias(fields, '\u8425\u9500\u5185\u5bb9\u6807\u9898', tableFields))
  };
}

function normalizeMarketingIdentityText(value) {
  return normalizeFeishuCellValue(value).replace(/\s+/g, '').trim();
}

function normalizeMarketingDeviceIdentity(value) {
  return normalizeMarketingIdentityText(value)
    .toLowerCase()
    .replace(/^(device|dev|\u8bbe\u5907)/, '')
    .replace(/[\u53f7\u865f#\uff03]/g, '');
}

function normalizeMarketingTitleIdentity(value) {
  return normalizeMarketingIdentityText(value)
    .toLowerCase()
    .replace(/[\u3000\s"'“”‘’.,，。:：;；!！?？()（）[\]【】<>《》]/g, '');
}

function isSameMarketingIdentity(recordFields, identity, tableFields) {
  const current = getMarketingRecordIdentity(recordFields, tableFields);
  return current.postedAt === identity.postedAt
    && current.accountName === identity.accountName
    && current.device === identity.device
    && current.title === identity.title;
}

function isSameMarketingBaseIdentity(recordFields, identity, tableFields) {
  const current = getMarketingRecordIdentity(recordFields, tableFields);
  return current.postedAt === identity.postedAt
    && normalizeMarketingIdentityText(current.accountName) === normalizeMarketingIdentityText(identity.accountName)
    && normalizeMarketingDeviceIdentity(current.device) === normalizeMarketingDeviceIdentity(identity.device);
}

function isCompatibleMarketingTitle(recordFields, identity, tableFields) {
  const current = getMarketingRecordIdentity(recordFields, tableFields);
  const currentTitle = normalizeMarketingTitleIdentity(current.title);
  const expectedTitle = normalizeMarketingTitleIdentity(identity.title);
  return Boolean(currentTitle && expectedTitle && (currentTitle === expectedTitle || currentTitle.includes(expectedTitle) || expectedTitle.includes(currentTitle)));
}

function findMarketingIdentityMatches(records, identity, tableFields) {
  const list = Array.isArray(records) ? records : [];
  const localId = normalizeMarketingIdentityText(identity.localId);
  if (localId) {
    const byLocalId = list.filter(record => normalizeMarketingIdentityText(getMarketingRecordIdentity(record?.fields || {}, tableFields).localId) === localId);
    if (byLocalId.length) return { records: byLocalId, matchMode: 'local_id' };
  }

  const exact = list.filter(record => isSameMarketingIdentity(record?.fields || {}, identity, tableFields));
  if (exact.length) return { records: exact, matchMode: 'exact' };

  const base = list.filter(record => isSameMarketingBaseIdentity(record?.fields || {}, identity, tableFields));
  if (base.length === 1) return { records: base, matchMode: 'base_unique' };

  const titled = base.filter(record => isCompatibleMarketingTitle(record?.fields || {}, identity, tableFields));
  if (titled.length === 1) return { records: titled, matchMode: 'base_title_unique' };
  if (titled.length > 1) return { records: [], matchMode: 'base_title_ambiguous', baseCount: titled.length };

  return { records: [], matchMode: base.length ? 'base_ambiguous' : 'none', baseCount: base.length };
}

function getMissingMarketingIdentityFields(identity) {
  const missing = [];
  if (!identity.postedAt) missing.push('\u8425\u9500\u53d1\u5e03\u65e5\u671f');
  if (!identity.accountName) missing.push('\u8d26\u53f7\u540d');
  if (!identity.device) missing.push('\u8bbe\u5907\u53f7');
  if (!identity.title) missing.push('\u8425\u9500\u5185\u5bb9\u6807\u9898');
  return missing;
}

function describeMarketingIdentityMatchFailure(details = {}) {
  const matchMode = String(details.matchMode || '').trim();
  const baseCount = Number(details.baseCount || 0);
  const missingFields = Array.isArray(details.missingFields) ? details.missingFields.filter(Boolean) : [];
  if (missingFields.length) {
    return `营销记录缺少匹配字段：${missingFields.join('、')}。如飞书表已新增“本地营销记录ID”字段，请先重新同步该记录。`;
  }
  if ((matchMode === 'base_ambiguous' || matchMode === 'base_title_ambiguous') && baseCount > 1) {
    return `营销记录匹配到 ${baseCount} 条同日同账号同设备候选，但标题无法唯一确认。请保留唯一标题，或在飞书营销表添加“本地营销记录ID”字段后重试。`;
  }
  if (matchMode === 'none') {
    return '飞书营销表没有找到同一条记录。请核对本地营销记录ID、营销发布日期、账号名、设备号和标题。';
  }
  return '';
}

async function listBitableFields(appToken, tableId, token) {
  const allItems = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${params}`;
    const data = await requestFeishuJson('publish_table_fields', url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (data.code !== 0) {
      const err = new Error(data.msg || '读取飞书表字段失败');
      err.status = 400;
      err.details = {
        code: data.code,
        msg: data.msg || data.message || '',
        raw: summarizeFeishuResponse(data)
      };
      throw err;
    }

    const items = data?.data?.items || [];
    if (Array.isArray(items)) allItems.push(...items);
    pageToken = data?.data?.has_more ? (data?.data?.page_token || '') : '';
  } while (pageToken);

  return allItems;
}

async function createBitableRecord(appToken, tableId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-publish-record] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const normalizedFields = normalizePublishRecordFieldsForTable(fields, tableFields);
  console.log('[feishu-publish-record] normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('发布记录表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('publish_record_create', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '新增飞书发布记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function createAccountBitableRecord(appToken, tableId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-accounts] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const normalizedFields = normalizeAccountRecordFieldsForTable(fields, tableFields);
  const skippedFields = getSkippedAccountFieldNames(fields, tableFields);
  console.log('[feishu-accounts] create normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length),
    skippedFields,
    tableFieldNames: tableFields.map(field => field.field_name || field.name || '').filter(Boolean)
  });
  assertNormalizedFieldsNotEmpty('账号表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('account_record_create', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '新增飞书账号记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  data.skippedFields = skippedFields;
  data.sentFields = Object.keys(normalizedFields);
  data.tableFieldNames = tableFields.map(field => field.field_name || field.name || '').filter(Boolean);
  return data;
}

async function updateAccountBitableRecord(appToken, tableId, recordId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-accounts] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const normalizedFields = normalizeAccountRecordFieldsForTable(fields, tableFields);
  const skippedFields = getSkippedAccountFieldNames(fields, tableFields);
  console.log('[feishu-accounts] update normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length),
    skippedFields,
    tableFieldNames: tableFields.map(field => field.field_name || field.name || '').filter(Boolean)
  });
  assertNormalizedFieldsNotEmpty('账号表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('account_record_update', url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '更新飞书账号记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function createDailyReportBitableRecord(appToken, tableId, fields, token, tableFields = []) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  const normalizedFields = normalizeDailyReportFieldsForTable(fields, tableFields);
  console.log('[feishu-daily-report] create normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length),
    reportLength: String(fields?.['\u4eca\u65e5\u6c47\u62a5\u5168\u6587'] || '').length
  });
  assertNormalizedFieldsNotEmpty('日报表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('daily_report_create', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '新增飞书日报失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function updateDailyReportBitableRecord(appToken, tableId, recordId, fields, token, tableFields = []) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const normalizedFields = normalizeDailyReportFieldsForTable(fields, tableFields);
  console.log('[feishu-daily-report] update normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length),
    reportLength: String(fields?.['\u4eca\u65e5\u6c47\u62a5\u5168\u6587'] || '').length
  });
  assertNormalizedFieldsNotEmpty('日报表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('daily_report_update', url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '更新飞书日报失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function upsertDailyReportBitableRecord(appToken, tableId, fields, token) {
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-daily-report] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const identity = getDailyReportIdentity(fields, tableFields);
  if (!identity.date || !identity.accountSource) {
    const err = new Error('日报缺少日期或账号来源');
    err.status = 400;
    err.details = { identity };
    throw err;
  }

  const records = await listBitableRecords(appToken, tableId, token);
  const matched = records.filter(record => {
    const current = getDailyReportIdentity(record?.fields || {}, tableFields);
    return current.date === identity.date && current.accountSource === identity.accountSource;
  });

  if (matched.length) {
    const recordId = matched[0].record_id || matched[0].id || '';
    const data = await updateDailyReportBitableRecord(appToken, tableId, recordId, fields, token, tableFields);
    return { action: 'updated', data, recordId: getBitableRecordId(data, recordId), updatedCount: matched.length, identity };
  }

  const data = await createDailyReportBitableRecord(appToken, tableId, fields, token, tableFields);
  return { action: 'created', data, recordId: getBitableRecordId(data), updatedCount: 0, identity };
}

async function checkDailyReportBitableRecord(appToken, tableId, identity, token) {
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-daily-report] check field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const normalizedIdentity = {
    date: normalizePublishIdentityDay(identity?.date || ''),
    accountSource: normalizeFeishuCellValue(identity?.accountSource || '')
  };
  if (!normalizedIdentity.date || !normalizedIdentity.accountSource) {
    const err = new Error('日报检查缺少日期或账号来源');
    err.status = 400;
    err.details = { identity: normalizedIdentity };
    throw err;
  }

  const records = await listBitableRecords(appToken, tableId, token);
  const matched = records.filter(record => {
    const current = getDailyReportIdentity(record?.fields || {}, tableFields);
    return current.date === normalizedIdentity.date && current.accountSource === normalizedIdentity.accountSource;
  });
  const first = matched[0] || null;
  return {
    exists: matched.length > 0,
    matchedCount: matched.length,
    recordId: first ? (first.record_id || first.id || '') : '',
    identity: normalizedIdentity
  };
}

async function updatePublishBitableRecord(appToken, tableId, recordId, fields, token, tableFields = []) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const normalizedFields = normalizePublishRecordFieldsForTable(fields, tableFields);
  console.log('[feishu-publish-record] update normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('发布记录表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('publish_record_update', url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '更新飞书发布记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function deletePublishBitableRecord(appToken, tableId, recordId, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const data = await requestFeishuJson('publish_record_delete', url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '删除飞书发布记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function upsertPublishBitableRecord(appToken, tableId, fields, token) {
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-publish-record] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const identity = getPublishRecordIdentity(fields, tableFields);
  if (!identity.publishRecordId && (!identity.publishDate || !identity.accountName || !identity.device)) {
    const err = new Error('Missing publish record identity: 发布日期 + 账号名 + 设备号');
    err.status = 400;
    err.details = { identity };
    throw err;
  }

  const records = await listBitableRecords(appToken, tableId, token);
  const matchResult = findPublishIdentityMatches(records, identity, tableFields, { conservativeFallback: Boolean(identity.publishRecordId) });
  const matchedRecords = matchResult.records;
  const createAfterAmbiguousLegacy = !matchedRecords.length && identity.publishRecordId && matchResult.matchMode !== 'none';
  if (createAfterAmbiguousLegacy) {
    console.log('[feishu-publish-record] ambiguous legacy candidates; creating id-tagged record instead of updating legacy rows', {
      publishRecordId: identity.publishRecordId,
      matchMode: matchResult.matchMode,
      baseCount: matchResult.baseCount || 0
    });
  }

  if (matchedRecords.length) {
    let lastData = null;
    let firstRecordId = '';
    for (const matched of matchedRecords) {
      const recordId = matched.record_id || matched.recordId || '';
      if (!firstRecordId) firstRecordId = recordId;
      lastData = await updatePublishBitableRecord(appToken, tableId, recordId, fields, token, tableFields);
    }
    return {
      data: lastData,
      action: 'updated',
      recordId: getBitableRecordId(lastData, firstRecordId),
      updatedCount: matchedRecords.length,
      identity,
      matchMode: matchResult.matchMode
    };
  }

  const data = await createBitableRecord(appToken, tableId, fields, token);
  return {
    data,
    action: 'created',
    recordId: getBitableRecordId(data),
    identity,
    matchMode: createAfterAmbiguousLegacy ? `created_after_${matchResult.matchMode}` : 'created',
    baseCount: createAfterAmbiguousLegacy ? (matchResult.baseCount || 0) : 0
  };
}

async function deletePublishBitableRecordByIdentity(appToken, tableId, fields, token, explicitRecordId = '') {
  const explicitId = String(explicitRecordId || '').trim();
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-publish-record] delete field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const identity = getPublishRecordIdentity(fields, tableFields);
  if (!explicitId && !identity.publishRecordId && (!identity.publishDate || !identity.accountName || !identity.device)) {
    const err = new Error('Missing publish record delete identity: 发布日期 + 账号名 + 设备号');
    err.status = 400;
    err.details = { identity };
    throw err;
  }

  const recordIds = explicitId ? [explicitId] : [];
  let matchResult = { records: [], matchMode: explicitId ? 'explicit_record_id' : 'none', baseCount: 0 };
  if (!explicitId) {
    const records = await listBitableRecords(appToken, tableId, token);
    matchResult = findPublishIdentityMatches(records, identity, tableFields, { conservativeFallback: Boolean(identity.publishRecordId) });
    matchResult.records
      .forEach(record => {
        const recordId = record.record_id || record.recordId || record.id || '';
        if (recordId && !recordIds.includes(recordId)) recordIds.push(recordId);
      });
  }

  console.log('[feishu-publish-record] delete identity matches', {
    accountName: identity.accountName,
    publishDate: identity.publishDate,
    device: identity.device,
    explicitRecordIdPresent: Boolean(explicitId),
    matchedCount: recordIds.length,
    matchMode: matchResult.matchMode,
    baseCount: matchResult.baseCount || 0
  });

  if (!recordIds.length) {
    return {
      data: { code: 0, msg: 'not found' },
      action: 'not_found',
      deletedCount: 0,
      recordIds: [],
      identity,
      matchMode: matchResult.matchMode,
      baseCount: matchResult.baseCount || 0
    };
  }

  let lastData = null;
  for (const recordId of recordIds) {
    lastData = await deletePublishBitableRecord(appToken, tableId, recordId, token);
  }

  if (explicitId) {
    return {
      data: lastData,
      action: 'deleted',
      deletedCount: recordIds.length,
      recordIds,
      recordId: recordIds[0] || '',
      identity,
      matchMode: matchResult.matchMode
    };
  }

  await wait(500);
  const recordsAfterDelete = await listBitableRecords(appToken, tableId, token);
  const remainingRecords = findPublishIdentityMatches(recordsAfterDelete, identity, tableFields, { conservativeFallback: Boolean(identity.publishRecordId) }).records;
  if (remainingRecords.length) {
    const remainingRecordIds = remainingRecords
      .map(record => record.record_id || record.recordId || record.id || '')
      .filter(Boolean);
    console.log('[feishu-publish-record] delete verification failed', {
      accountName: identity.accountName,
      publishDate: identity.publishDate,
      device: identity.device,
      deletedCount: recordIds.length,
      remainingCount: remainingRecordIds.length,
      remainingRecordIds
    });
    const err = new Error('Publish record delete verification failed: 飞书发布记录仍有残留');
    err.status = 409;
    err.details = {
      identity,
      deletedRecordIds: recordIds,
      remainingRecordIds,
      remainingCount: remainingRecordIds.length
    };
    throw err;
  }

  return {
    data: lastData || { code: 0, msg: 'success' },
    action: 'deleted',
    deletedCount: recordIds.length,
    recordIds,
    recordId: recordIds[0] || '',
    identity
  };
}

async function createDraftBitableRecord(appToken, tableId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-draft] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const identity = getDraftRecordIdentity(fields, tableFields);
  const normalizedFields = normalizeDraftRecordFieldsForTable(fields, tableFields);
  console.log('[feishu-draft] normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('文案库表', fields, normalizedFields, tableFields);

  if (identity.draftId) {
    const records = await listBitableRecords(appToken, tableId, token);
    const matchResult = findDraftIdentityMatches(records, identity, tableFields);
    if (matchResult.records.length) {
      let lastData = null;
      let firstRecordId = '';
      for (const matched of matchResult.records) {
        const recordId = matched.record_id || matched.recordId || matched.id || '';
        if (!recordId) continue;
        if (!firstRecordId) firstRecordId = recordId;
        lastData = await updateDraftBitableRecord(appToken, tableId, recordId, fields, token, tableFields);
      }
      return {
        data: lastData,
        action: 'updated',
        recordId: getBitableRecordId(lastData, firstRecordId),
        updatedCount: matchResult.records.length,
        identity,
        matchMode: matchResult.matchMode
      };
    }
  }

  const data = await requestFeishuJson('draft_create', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '新增飞书文案失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return {
    data,
    action: 'created',
    recordId: getBitableRecordId(data),
    updatedCount: 0,
    identity,
    matchMode: 'created'
  };
}

async function updateDraftBitableRecord(appToken, tableId, recordId, fields, token, tableFields = []) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const normalizedFields = normalizeDraftRecordFieldsForTable(fields, tableFields);
  console.log('[feishu-draft] update normalized fields', {
    requestedCount: Object.keys(fields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(fields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('文案库表', fields, normalizedFields, tableFields);
  const data = await requestFeishuJson('draft_update', url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '更新飞书文案失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function deleteDraftBitableRecord(appToken, tableId, recordId, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const data = await requestFeishuJson('draft_delete', url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '删除飞书文案失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function createMarketingBitableRecord(appToken, tableId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-marketing] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const completedFields = completeMarketingStatusFields(fields);
  const identity = getMarketingRecordIdentity(completedFields, tableFields);
  const normalizedFields = normalizeMarketingRecordFieldsForTable(completedFields, tableFields);
  console.log('[feishu-marketing] normalized fields', {
    requestedCount: Object.keys(completedFields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(completedFields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('营销记录表', completedFields, normalizedFields, tableFields);

  if (identity.postedAt && identity.accountName && identity.device && identity.title) {
    const records = await listBitableRecords(appToken, tableId, token);
    const matchResult = findMarketingIdentityMatches(records, identity, tableFields);
    if (matchResult.records.length) {
      let lastData = null;
      let firstRecordId = '';
      for (const matched of matchResult.records) {
        const recordId = matched.record_id || matched.recordId || matched.id || '';
        if (!recordId) continue;
        if (!firstRecordId) firstRecordId = recordId;
        lastData = await updateMarketingBitableRecord(appToken, tableId, recordId, completedFields, token);
      }
      return {
        data: lastData,
        action: 'updated',
        recordId: getBitableRecordId(lastData, firstRecordId),
        updatedCount: matchResult.records.length,
        identity,
        matchMode: matchResult.matchMode
      };
    }
  }

  const data = await requestFeishuJson('marketing_record_create', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '新增飞书营销记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return {
    data,
    action: 'created',
    recordId: getBitableRecordId(data),
    updatedCount: 0,
    identity,
    matchMode: 'created'
  };
}

async function updateMarketingBitableRecord(appToken, tableId, recordId, fields, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-marketing] field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }
  const completedFields = completeMarketingStatusFields(fields);
  const normalizedFields = normalizeMarketingRecordFieldsForTable(completedFields, tableFields);
  console.log('[feishu-marketing] update normalized fields', {
    requestedCount: Object.keys(completedFields || {}).length,
    sentCount: Object.keys(normalizedFields).length,
    skippedCount: Math.max(0, Object.keys(completedFields || {}).length - Object.keys(normalizedFields).length)
  });
  assertNormalizedFieldsNotEmpty('营销记录表', completedFields, normalizedFields, tableFields);
  const data = await requestFeishuJson('marketing_record_update', url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: normalizedFields
    })
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '更新飞书营销记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function deleteMarketingBitableRecord(appToken, tableId, recordId, token) {
  const url = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  const data = await requestFeishuJson('marketing_record_delete', url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (data.code !== 0) {
    const err = new Error(data.msg || '删除飞书营销记录失败');
    err.status = 400;
    err.details = {
      code: data.code,
      msg: data.msg || data.message || '',
      raw: summarizeFeishuResponse(data)
    };
    throw err;
  }

  return data;
}

async function updateMarketingBitableRecordByIdentity(appToken, tableId, fields, token) {
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-marketing] identity field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const completedFields = completeMarketingStatusFields(fields);
  const identity = getMarketingRecordIdentity(completedFields, tableFields);
  const missingIdentityFields = getMissingMarketingIdentityFields(identity);
  if (!identity.localId && missingIdentityFields.length) {
    const err = new Error('Missing marketing recordId or identity: 营销发布日期 + 账号名 + 设备号 + 营销内容标题');
    err.status = 400;
    err.details = { identity, missingFields: missingIdentityFields };
    throw err;
  }

  const records = await listBitableRecords(appToken, tableId, token);
  const matchResult = findMarketingIdentityMatches(records, identity, tableFields);
  const matchedRecords = matchResult.records;
  if (!matchedRecords.length) {
    const err = new Error('Marketing record not found for update identity');
    err.status = 404;
    err.details = { identity, matchMode: matchResult.matchMode, baseCount: matchResult.baseCount || 0 };
    throw err;
  }

  let lastData = null;
  let firstRecordId = '';
  for (const matched of matchedRecords) {
    const matchedRecordId = matched.record_id || matched.recordId || matched.id || '';
    if (!matchedRecordId) continue;
    if (!firstRecordId) firstRecordId = matchedRecordId;
    lastData = await updateMarketingBitableRecord(appToken, tableId, matchedRecordId, completedFields, token);
  }

  return {
    data: lastData,
    recordId: getBitableRecordId(lastData, firstRecordId),
    updatedCount: matchedRecords.length,
    identity,
    matchMode: matchResult.matchMode
  };
}

async function deleteMarketingBitableRecordByIdentity(appToken, tableId, fields, token, explicitRecordId = '') {
  const explicitId = String(explicitRecordId || '').trim();
  let tableFields = [];
  try {
    tableFields = await listBitableFields(appToken, tableId, token);
  } catch (error) {
    console.log('[feishu-marketing] delete field metadata fallback', {
      code: error.details?.code || error.status || '',
      msg: error.details?.msg || error.message || ''
    });
  }

  const completedFields = completeMarketingStatusFields(fields);
  const identity = getMarketingRecordIdentity(completedFields, tableFields);
  const missingIdentityFields = getMissingMarketingIdentityFields(identity);
  if (!explicitId && !identity.localId && missingIdentityFields.length) {
    const err = new Error('Missing marketing delete identity: 营销发布日期 + 账号名 + 设备号 + 营销内容标题');
    err.status = 400;
    err.details = { identity, missingFields: missingIdentityFields };
    throw err;
  }

  const recordIds = explicitId ? [explicitId] : [];
  let matchResult = { records: [], matchMode: explicitId ? 'explicit_record_id' : 'none', baseCount: 0 };
  if (!explicitId) {
    const records = await listBitableRecords(appToken, tableId, token);
    matchResult = findMarketingIdentityMatches(records, identity, tableFields);
    matchResult.records
      .forEach(record => {
        const recordId = record.record_id || record.recordId || record.id || '';
        if (recordId && !recordIds.includes(recordId)) recordIds.push(recordId);
      });
  }

  console.log('[feishu-marketing] delete identity matches', {
    accountName: identity.accountName,
    postedAt: identity.postedAt,
    device: identity.device,
    title: identity.title,
    explicitRecordIdPresent: Boolean(explicitId),
    matchedCount: recordIds.length,
    matchMode: matchResult.matchMode,
    baseCount: matchResult.baseCount || 0
  });

  if (!recordIds.length) {
    return {
      data: { code: 0, msg: 'not found' },
      action: 'not_found',
      deletedCount: 0,
      recordIds: [],
      identity,
      matchMode: matchResult.matchMode,
      baseCount: matchResult.baseCount || 0
    };
  }

  let lastData = null;
  for (const recordId of recordIds) {
    lastData = await deleteMarketingBitableRecord(appToken, tableId, recordId, token);
  }

  if (explicitId) {
    return {
      data: lastData,
      action: 'deleted',
      deletedCount: recordIds.length,
      recordIds,
      identity,
      matchMode: matchResult.matchMode
    };
  }

  await wait(500);
  const recordsAfterDelete = await listBitableRecords(appToken, tableId, token);
  const remainingRecords = findMarketingIdentityMatches(recordsAfterDelete, identity, tableFields).records;
  if (remainingRecords.length) {
    const remainingRecordIds = remainingRecords
      .map(record => record.record_id || record.recordId || record.id || '')
      .filter(Boolean);
    console.log('[feishu-marketing] delete verification failed', {
      accountName: identity.accountName,
      postedAt: identity.postedAt,
      device: identity.device,
      title: identity.title,
      deletedCount: recordIds.length,
      remainingCount: remainingRecordIds.length,
      remainingRecordIds
    });
    const err = new Error('Marketing record delete verification failed: 飞书营销记录仍有残留');
    err.status = 409;
    err.details = {
      identity,
      deletedRecordIds: recordIds,
      remainingRecordIds,
      remainingCount: remainingRecordIds.length
    };
    throw err;
  }

  return {
    data: lastData || { code: 0, msg: 'success' },
    action: 'deleted',
    deletedCount: recordIds.length,
    recordIds,
    recordId: recordIds[0] || '',
    identity
  };
}

async function handleAccountsList(body) {
  try {
    const { appToken, tableId } = validateAccountsListPayload(body);
    const token = await getTenantAccessToken();
    const records = await listBitableRecords(appToken, tableId, token);
    const accounts = records.map(normalizeAccountRecord).filter(account => account.name || account.device);
    const expectedFields = ['账号名', '设备号', '内容方向', '分组', '是否禁言', '是否指定营销账号', '指定营销内容', '备注'];
    const seenFields = new Set();

    records.forEach(record => {
      Object.keys(record?.fields || {}).forEach(field => seenFields.add(field));
    });

    const missingFields = expectedFields.filter(field => records.length && !seenFields.has(field));

    console.log('[feishu-accounts] records normalized', {
      rawCount: records.length,
      accountCount: accounts.length,
      missingFields
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        accounts,
        count: accounts.length,
        rawCount: records.length,
        missingFields
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '读取飞书账号表失败',
        details: error.details || null
      }
    };
  }
}

async function handleAccountCreate(body) {
  try {
    const { appToken, tableId, fields } = validateAccountsCreatePayload(body);
    const token = await getTenantAccessToken();
    const data = await createAccountBitableRecord(appToken, tableId, fields, token);
    const recordId = getBitableRecordId(data);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: 'created',
        recordId,
        skippedFields: data.skippedFields || [],
        sentFields: data.sentFields || [],
        code: data.code,
        msg: data.msg || data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '同步新增飞书账号失败',
        details: error.details || null
      }
    };
  }
}

async function handleAccountUpdate(body) {
  try {
    const { appToken, tableId, recordId, fields } = validateAccountsUpdatePayload(body);
    const token = await getTenantAccessToken();
    const data = await updateAccountBitableRecord(appToken, tableId, recordId, fields, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: 'updated',
        recordId,
        skippedFields: data.skippedFields || [],
        sentFields: data.sentFields || [],
        code: data.code,
        msg: data.msg || data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '同步更新飞书账号失败',
        details: error.details || null
      }
    };
  }
}

async function handleDailyReportUpsert(body) {
  try {
    const { appToken, tableId, fields } = validateDailyReportUpsertPayload(body);
    const token = await getTenantAccessToken();
    const result = await upsertDailyReportBitableRecord(appToken, tableId, fields, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: result.action,
        recordId: result.recordId,
        updatedCount: result.updatedCount || 0,
        identity: result.identity,
        code: result.data.code,
        msg: result.data.msg || result.data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '同步飞书日报失败',
        details: error.details || null
      }
    };
  }
}

async function handleDailyReportCheck(body) {
  try {
    const { appToken, tableId, date, accountSource } = validateDailyReportCheckPayload(body);
    const token = await getTenantAccessToken();
    const result = await checkDailyReportBitableRecord(appToken, tableId, { date, accountSource }, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        exists: result.exists,
        matchedCount: result.matchedCount,
        recordId: result.recordId,
        identity: result.identity
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '检查飞书日报失败',
        details: error.details || null
      }
    };
  }
}

async function handlePublishRecordCreate(body) {
  try {
    const { appToken, tableId, fields } = validatePublishRecordCreatePayload(body);
    const token = await getTenantAccessToken();
    const result = await upsertPublishBitableRecord(appToken, tableId, fields, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: result.action,
        recordId: result.recordId,
        updatedCount: result.updatedCount || 0,
        matchMode: result.matchMode || '',
        code: result.data.code,
        msg: result.data.msg || result.data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatPublishRecordErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handlePublishRecordUpsert(body) {
  return handlePublishRecordCreate(body);
}

async function handlePublishRecordDelete(body) {
  try {
    const { appToken, tableId, fields, recordId } = validatePublishRecordDeletePayload(body);
    const token = await getTenantAccessToken();
    const result = await deletePublishBitableRecordByIdentity(appToken, tableId, fields, token, recordId);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: result.action,
        recordId: result.recordId || recordId || '',
        recordIds: result.recordIds || [],
        deletedCount: result.deletedCount || 0,
        identity: result.identity,
        code: result.data.code,
        msg: result.data.msg || result.data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatPublishRecordErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handlePublishDuplicatePreview(body) {
  try {
    const { appToken, tableId } = validatePublishDuplicatePreviewPayload(body);
    const token = await getTenantAccessToken();
    const result = await previewPublishRecordDuplicates(appToken, tableId, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...result
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatPublishRecordErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handlePublishDuplicateSuggestions(body) {
  try {
    const { appToken, tableId } = validatePublishDuplicatePreviewPayload(body);
    const token = await getTenantAccessToken();
    const result = await previewPublishDuplicateSuggestions(appToken, tableId, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...result
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatPublishRecordErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handleDraftCreate(body) {
  try {
    const { appToken, tableId, fields } = validateDraftCreatePayload(body);
    const token = await getTenantAccessToken();
    const result = await createDraftBitableRecord(appToken, tableId, fields, token);
    const data = result.data || {};

    return {
      statusCode: 200,
      payload: {
        ok: true,
        recordId: result.recordId || getBitableRecordId(data),
        code: data.code,
        msg: data.msg || data.message || '',
        action: result.action || 'created',
        updatedCount: result.updatedCount || 0,
        matchMode: result.matchMode || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatDraftCreateErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handleDraftDelete(body) {
  try {
    const { appToken, tableId, recordId } = validateDraftDeletePayload(body);
    const token = await getTenantAccessToken();
    const data = await deleteDraftBitableRecord(appToken, tableId, recordId, token);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        recordId,
        code: data.code,
        msg: data.msg || data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatDraftCreateErrorMessage(error),
        details: error.details || null
      }
    };
  }
}

async function handleMarketingRecordCreate(body) {
  try {
    const { appToken, tableId, fields } = validateMarketingRecordCreatePayload(body);
    const token = await getTenantAccessToken();
    const result = await createMarketingBitableRecord(appToken, tableId, fields, token);
    const data = result.data || {};

    return {
      statusCode: 200,
      payload: {
        ok: true,
        recordId: result.recordId || getBitableRecordId(data),
        code: data.code,
        msg: data.msg || data.message || '',
        action: result.action || 'created',
        updatedCount: result.updatedCount || 0,
        matchMode: result.matchMode || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatMarketingRecordErrorMessage(error, 'create'),
        details: error.details || null
      }
    };
  }
}

async function handleMarketingRecordUpdate(body) {
  try {
    const { appToken, tableId, recordId, fields } = validateMarketingRecordUpdatePayload(body);
    const token = await getTenantAccessToken();
    const result = recordId
      ? {
          data: await updateMarketingBitableRecord(appToken, tableId, recordId, fields, token),
          recordId,
          updatedCount: 1
        }
      : await updateMarketingBitableRecordByIdentity(appToken, tableId, fields, token);
    const data = result.data;

    return {
      statusCode: 200,
      payload: {
        ok: true,
        recordId: data?.data?.record?.record_id || data?.data?.record_id || result.recordId || recordId,
        updatedCount: result.updatedCount || 0,
        code: data.code,
        msg: data.msg || data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatMarketingRecordErrorMessage(error, 'update'),
        details: error.details || null
      }
    };
  }
}

async function handleMarketingRecordDelete(body) {
  try {
    const { appToken, tableId, recordId, fields } = validateMarketingRecordDeletePayload(body);
    const token = await getTenantAccessToken();
    const result = await deleteMarketingBitableRecordByIdentity(appToken, tableId, fields, token, recordId);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: result.action,
        recordId: result.recordId || recordId || '',
        recordIds: result.recordIds || [],
        deletedCount: result.deletedCount || 0,
        identity: result.identity,
        code: result.data.code,
        msg: result.data.msg || result.data.message || ''
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: formatMarketingRecordErrorMessage(error, 'delete'),
        details: error.details || null
      }
    };
  }
}

function formatPublishRecordErrorMessage(error) {
  const code = Number(error?.details?.code || 0);
  const msg = String(error?.details?.msg || error?.message || '').trim();
  const identityMessage = describePublishIdentityMatchFailure(error?.details || {});
  if (identityMessage) return identityMessage;
  if (code === 1254064 || /DatetimeFieldConvFail/i.test(msg)) {
    return '飞书日期字段格式不匹配：请重新测试飞书连接确认日期字段类型，系统会自动把日期时间转为飞书需要的时间戳';
  }
  if (code === 91403 || /forbidden/i.test(msg)) {
    return '飞书权限不足：当前应用可以读取表信息，但没有新增发布记录权限，请给应用开通多维表格写入/新增记录权限，并确认应用已安装且有该表访问权限';
  }
  if (code) return `飞书返回 ${code}：${msg || '写入失败'}`;
  return error.message || '飞书发布记录同步失败';
}

function formatDraftCreateErrorMessage(error) {
  const code = Number(error?.details?.code || 0);
  const msg = String(error?.details?.msg || error?.message || '').trim();
  if (code === 1254064 || /DatetimeFieldConvFail/i.test(msg)) {
    return '飞书文案库日期字段格式不匹配：请重新测试飞书连接确认日期字段类型，系统会自动把日期时间转为飞书需要的时间戳';
  }
  if (code === 91403 || /forbidden/i.test(msg)) {
    return '飞书文案库权限不足：当前应用可以读取表信息，但没有新增或更新文案记录权限，请给应用开通多维表格写入/新增记录权限，并确认应用已安装且有该表访问权限';
  }
  if (code) return `飞书返回 ${code}：${msg || '文案库同步失败'}`;
  return error.message || '飞书文案库同步失败';
}

function formatMarketingRecordErrorMessage(error, action) {
  const code = Number(error?.details?.code || 0);
  const msg = String(error?.details?.msg || error?.message || '').trim();
  const identityMessage = describeMarketingIdentityMatchFailure(error?.details || {});
  if (identityMessage) return identityMessage;
  if (code === 1254064 || /DatetimeFieldConvFail/i.test(msg)) {
    return '飞书营销记录日期字段格式不匹配：请重新测试飞书连接确认日期字段类型，系统会自动把日期时间转为飞书需要的时间戳';
  }
  if (code === 91403 || /forbidden/i.test(msg)) {
    return `飞书营销记录表权限不足：当前应用无法${action || '写入'}营销记录，请给应用开通多维表格写入/新增/更新/删除记录权限，并确认应用已安装且有该表访问权限`;
  }
  if (code) return `飞书返回 ${code}：${msg || '营销记录同步失败'}`;
  return error.message || '飞书营销记录同步失败';
}

async function handleDebugNetwork(appToken) {
  const result = {
    ok: true,
    nodeVersion: process.version,
    appTokenPresent: Boolean(appToken),
    checks: {}
  };

  try {
    const appId = requireEnv('FEISHU_APP_ID');
    const appSecret = requireEnv('FEISHU_APP_SECRET');
    const tokenData = await requestFeishuJson('debug_auth_token_endpoint', `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });

    result.checks.auth = {
      ok: tokenData.code === 0 && Boolean(tokenData.tenant_access_token),
      code: tokenData.code,
      msg: tokenData.msg || tokenData.message || '',
      tokenPresent: Boolean(tokenData.tenant_access_token)
    };

    if (!result.checks.auth.ok) {
      result.ok = false;
      return result;
    }

    if (!appToken) {
      result.ok = false;
      result.checks.bitableTables = {
        ok: false,
        message: '缺少 appToken 查询参数'
      };
      return result;
    }

    const tableUrl = `${FEISHU_BASE_URL}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?page_size=1`;
    const tablesData = await requestFeishuJsonWithNetworkRetry('debug_bitable_tables', tableUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenData.tenant_access_token}`
      }
    });

    result.checks.bitableTables = {
      ok: tablesData.code === 0,
      code: tablesData.code,
      msg: tablesData.msg || tablesData.message || '',
      itemCount: normalizeTableListItems(tablesData).length
    };

    if (!result.checks.bitableTables.ok) result.ok = false;
    return result;
  } catch (error) {
    result.ok = false;
    result.error = {
      message: error.message || 'debug network failed',
      status: error.status || null,
      details: error.details || null,
      safeError: summarizeError(error)
    };
    return result;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function healthPayload() {
  return {
    ok: true,
    service: 'feishu-local-sync',
    nodeVersion: process.version,
    port: PORT,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    localServerRequestTimeoutMs: server.requestTimeout,
    localServerHeadersTimeoutMs: server.headersTimeout,
    hasAppId: Boolean(process.env.FEISHU_APP_ID),
    hasAppSecret: Boolean(process.env.FEISHU_APP_SECRET)
  };
}

async function handleFeishuTest(body) {
  try {
    const { appToken, tableIds } = validateTestPayload(body);
    const token = await getTenantAccessToken();
    const actualTables = await listFeishuTables(appToken, token);
    const tableResults = matchRequiredTables(tableIds, actualTables);
    const fieldAudits = await auditFeishuTableFields(tableResults, appToken, token);
    console.log('[feishu-test] field audit summary', Object.entries(fieldAudits).map(([role, audit]) => ({
      role,
      tableId: audit.tableId || '',
      tableName: audit.name || '',
      status: audit.status || '',
      missingRequired: audit.missingRequired || [],
      missingRecommended: audit.missingRecommended || [],
      missingOptional: audit.missingOptional || [],
      fieldCount: audit.fieldCount || 0
    })));

    return {
      statusCode: 200,
      payload: {
        ok: true,
        message: '飞书连接测试通过',
        tables: tableResults,
        fieldAudits,
        actualTables: actualTables.map(item => ({
          tableId: item.tableId,
          name: item.name
        }))
      }
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      payload: {
        ok: false,
        message: error.message || '飞书连接测试失败',
        details: error.details || null
      }
    };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/feishu/health') {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/copywriting/education-question/options') {
    sendJson(res, 200, {
      ok: true,
      options: getEducationQuestionOptions()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/copywriting/education-question/prompt') {
    try {
      const body = await readJsonBody(req);
      const result = buildEducationQuestionPrompt(body);
      sendJson(res, 200, {
        ok: true,
        ...result
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        message: error.message || '生成教育提问提示词失败'
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/feishu/debug/network') {
    console.log('received feishu debug network request', {
      appTokenPresent: Boolean(url.searchParams.get('appToken') || url.searchParams.get('app_token')),
      nodeVersion: process.version
    });
    const appToken = String(url.searchParams.get('appToken') || url.searchParams.get('app_token') || '').trim();
    const payload = await handleDebugNetwork(appToken);
    sendJson(res, payload.ok ? 200 : 500, payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/test') {
    try {
      const body = await readJsonBody(req);
      const tables = body?.tables || {};
      console.log('received feishu test request', {
        appTokenPresent: Boolean(body?.appToken),
        tableIdsPresent: {
          accounts: Boolean(tables.accounts),
          publish: Boolean(tables.publish),
          drafts: Boolean(tables.drafts),
          marketing: Boolean(tables.marketing),
          reports: Boolean(tables.reports)
        }
      });
      const result = await handleFeishuTest(body);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('feishu test request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/accounts/list') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.accountsTableId || body?.tables?.accounts;
      console.log('received accounts list request', {
        appTokenPresent: Boolean(body?.appToken),
        accountsTableIdPresent: Boolean(tableId)
      });
      const result = await handleAccountsList(body);
      console.log('[feishu-accounts] list result', {
        statusCode: result.statusCode,
        count: result.payload?.count || 0,
        rawCount: result.payload?.rawCount || 0
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('accounts list request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/accounts/create') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.accountsTableId || body?.tables?.accounts;
      const fields = body?.fields || {};
      console.log('received account create request', {
        appTokenPresent: Boolean(body?.appToken),
        accountsTableIdPresent: Boolean(tableId),
        accountName: fields['账号名'] || '',
        device: fields['设备号'] || ''
      });
      const result = await handleAccountCreate(body);
      console.log('[feishu-accounts] create result', {
        statusCode: result.statusCode,
        action: result.payload?.action || '',
        recordIdPresent: Boolean(result.payload?.recordId),
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('account create request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/accounts/update') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.accountsTableId || body?.tables?.accounts;
      const fields = body?.fields || {};
      console.log('received account update request', {
        appTokenPresent: Boolean(body?.appToken),
        accountsTableIdPresent: Boolean(tableId),
        recordIdPresent: Boolean(body?.recordId || body?.record_id || body?.feishuRecordId || body?.feishu_record_id),
        accountName: fields['账号名'] || '',
        device: fields['设备号'] || ''
      });
      const result = await handleAccountUpdate(body);
      console.log('[feishu-accounts] update result', {
        statusCode: result.statusCode,
        action: result.payload?.action || '',
        recordIdPresent: Boolean(result.payload?.recordId),
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('account update request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/daily-reports/upsert') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.reportsTableId || body?.tables?.reports;
      const fields = body?.fields || {};
      console.log('received daily report upsert request', {
        reportsTableIdPresent: Boolean(tableId),
        date: fields['日期'] || '',
        accountSource: fields['账号来源'] || '',
        reportLength: String(fields['今日汇报全文'] || '').length
      });
      const result = await handleDailyReportUpsert(body);
      console.log('[feishu-daily-report] upsert result', {
        statusCode: result.statusCode,
        action: result.payload?.action || '',
        recordIdPresent: Boolean(result.payload?.recordId),
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('daily report upsert request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/daily-reports/check') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.reportsTableId || body?.tables?.reports;
      console.log('received daily report check request', {
        reportsTableIdPresent: Boolean(tableId),
        date: body?.date || body?.day || '',
        accountSource: body?.accountSource || body?.source || ''
      });
      const result = await handleDailyReportCheck(body);
      console.log('[feishu-daily-report] check result', {
        statusCode: result.statusCode,
        exists: Boolean(result.payload?.exists),
        matchedCount: result.payload?.matchedCount || 0,
        recordIdPresent: Boolean(result.payload?.recordId),
        code: result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('daily report check request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/feishu/publish-records/create' || url.pathname === '/api/feishu/publish-records/upsert')) {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.publishTableId || body?.tables?.publish;
      const fields = body?.fields || {};
      console.log('received publish record upsert request', {
        publishTableIdPresent: Boolean(tableId),
        accountName: fields['账号名'] || '',
        publishDate: fields['发布日期'] || '',
        device: fields['设备号'] || '',
        isManual: Boolean(fields['是否补记']),
        isMarketing: Boolean(fields['是否营销'])
      });
      const result = await handlePublishRecordUpsert(body);
      console.log('[feishu-publish-record] upsert result', {
        action: result.payload?.action || '',
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('publish record upsert request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/publish-records/delete') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.publishTableId || body?.tables?.publish;
      const fields = body?.fields || {};
      const recordId = body?.recordId || body?.record_id || body?.publishRecordId || body?.publish_record_id;
      console.log('received publish record delete request', {
        publishTableIdPresent: Boolean(tableId),
        recordIdPresent: Boolean(recordId),
        accountName: fields['账号名'] || '',
        publishDate: fields['发布日期'] || '',
        device: fields['设备号'] || ''
      });
      const result = await handlePublishRecordDelete(body);
      console.log('[feishu-publish-record] delete result', {
        action: result.payload?.action || '',
        deletedCount: result.payload?.deletedCount || 0,
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('publish record delete request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/publish-records/duplicates/preview') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.publishTableId || body?.tables?.publish;
      console.log('received publish duplicate preview request', {
        publishTableIdPresent: Boolean(tableId)
      });
      const result = await handlePublishDuplicatePreview(body);
      console.log('[feishu-publish-duplicates] preview result', {
        rawCount: result.payload?.rawCount || 0,
        duplicateGroupCount: result.payload?.duplicateGroupCount || 0,
        duplicateRecordCount: result.payload?.duplicateRecordCount || 0
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('publish duplicate preview request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/publish-records/duplicates/suggestions') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.publishTableId || body?.tables?.publish;
      console.log('received publish duplicate suggestions request', {
        publishTableIdPresent: Boolean(tableId)
      });
      const result = await handlePublishDuplicateSuggestions(body);
      console.log('[feishu-publish-duplicates] suggestions result', {
        rawCount: result.payload?.rawCount || 0,
        duplicateGroupCount: result.payload?.duplicateGroupCount || 0,
        suggestionCount: result.payload?.suggestionCount || 0
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('publish duplicate suggestions request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/drafts/create') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.draftsTableId || body?.tables?.drafts;
      const fields = body?.fields || {};
      console.log('received draft create request', {
        draftsTableIdPresent: Boolean(tableId),
        accountName: fields['\u8d26\u53f7\u540d'] || '',
        topic: fields['\u9009\u9898'] || '',
        format: fields['\u53d1\u5e03\u4f53\u88c1'] || ''
      });
      const result = await handleDraftCreate(body);
      console.log('[feishu-draft] create result', {
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('draft create request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/drafts/delete') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.draftsTableId || body?.tables?.drafts;
      const recordId = body?.recordId || body?.record_id || body?.draftRecordId || body?.draft_record_id;
      console.log('received draft delete request', {
        draftsTableIdPresent: Boolean(tableId),
        recordIdPresent: Boolean(recordId)
      });
      const result = await handleDraftDelete(body);
      console.log('[feishu-draft] delete result', {
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('draft delete request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/marketing-records/create') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.marketingTableId || body?.tables?.marketing;
      const fields = body?.fields || {};
      console.log('received marketing record create request', {
        marketingTableIdPresent: Boolean(tableId),
        accountName: fields['\u8d26\u53f7\u540d'] || '',
        title: fields['\u8425\u9500\u5185\u5bb9\u6807\u9898'] || '',
        postedAt: fields['\u8425\u9500\u53d1\u5e03\u65e5\u671f'] || '',
        deleteReminderAt: fields['\u5220\u9664\u63d0\u9192\u65e5\u671f'] || ''
      });
      const result = await handleMarketingRecordCreate(body);
      console.log('[feishu-marketing] create result', {
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('marketing record create request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/marketing-records/update') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.marketingTableId || body?.tables?.marketing;
      const recordId = body?.recordId || body?.record_id;
      const fields = body?.fields || {};
      console.log('received marketing record update request', {
        marketingTableIdPresent: Boolean(tableId),
        recordIdPresent: Boolean(recordId),
        status: fields['\u5f53\u524d\u72b6\u6001'] || '',
        isDeleted: fields['\u662f\u5426\u5df2\u5220\u9664'] ?? ''
      });
      const result = await handleMarketingRecordUpdate(body);
      console.log('[feishu-marketing] update result', {
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('marketing record update request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/feishu/marketing-records/delete') {
    try {
      const body = await readJsonBody(req);
      const tableId = body?.tableId || body?.marketingTableId || body?.tables?.marketing;
      const fields = body?.fields || {};
      const recordId = body?.recordId || body?.record_id || body?.marketingRecordId || body?.marketing_record_id;
      console.log('received marketing record delete request', {
        marketingTableIdPresent: Boolean(tableId),
        recordIdPresent: Boolean(recordId),
        accountName: fields['账号名'] || '',
        title: fields['营销内容标题'] || '',
        postedAt: fields['营销发布日期'] || ''
      });
      const result = await handleMarketingRecordDelete(body);
      console.log('[feishu-marketing] delete result', {
        action: result.payload?.action || '',
        deletedCount: result.payload?.deletedCount || 0,
        code: result.payload?.code ?? result.payload?.details?.code ?? result.statusCode,
        msg: result.payload?.msg || result.payload?.details?.msg || result.payload?.message || ''
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      console.log('marketing record delete request failed before validation', {
        message: error.message || '请求格式无效'
      });
      sendJson(res, 400, {
        ok: false,
        message: error.message || '请求格式无效'
      });
    }
    return;
  }

  sendJson(res, 404, {
    ok: false,
    message: 'Not found'
  });
});

server.requestTimeout = Number(process.env.LOCAL_SERVER_REQUEST_TIMEOUT_MS || 60_000);
server.headersTimeout = Number(process.env.LOCAL_SERVER_HEADERS_TIMEOUT_MS || 65_000);

server.on('error', error => {
  console.error('[server] failed to start or listen', {
    port: PORT,
    code: error.code || '',
    message: error.message || String(error),
    hint: error.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Close the old backend process or start with another PORT.`
      : 'Check environment variables, permissions, and recent logs.'
  });
  process.exitCode = 1;
});

process.on('unhandledRejection', reason => {
  console.error('[server] unhandled rejection', summarizeError(reason instanceof Error ? reason : new Error(String(reason))));
});

process.on('uncaughtException', error => {
  console.error('[server] uncaught exception', summarizeError(error));
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`Feishu local sync test server listening on http://localhost:${PORT}`, {
    port: PORT,
    requestTimeoutMs: server.requestTimeout,
    feishuRequestTimeoutMs: REQUEST_TIMEOUT_MS,
    hasFeishuAppId: Boolean(process.env.FEISHU_APP_ID),
    hasFeishuAppSecret: Boolean(process.env.FEISHU_APP_SECRET),
    nodeVersion: process.version
  });
});
