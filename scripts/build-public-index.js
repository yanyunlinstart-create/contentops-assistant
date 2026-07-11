const fs = require('fs');
const path = require('path');

const DEMO_ACCOUNTS = [
  { id: 1, name: '演示账号 A', device: 'demo-001', type: 'edu', emoji: '📚', group: '教育示例' },
  { id: 2, name: '演示账号 B', device: 'demo-002', type: 'edu', emoji: '📖', group: '教育示例' },
  { id: 3, name: '演示账号 C', device: 'demo-003', type: 'parenting', emoji: '💝', group: '亲子示例' },
  { id: 4, name: '演示账号 D', device: 'demo-004', type: 'life', emoji: '🌿', group: '生活示例' }
];

const REQUIRED_REVIEW_MARKERS = [
  'POST_PUBLISH_REVIEW_GROUPS',
  'renderPostPublishReviewMetricButton',
  'bulkSelectedPostPublishReviewAction',
  'applyPostPublishBulkAction',
  'renderPostPublishMoreActions',
  '.post-review-bulkbar.active'
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function scanBalancedExpression(text, start) {
  const opener = text[start];
  const closer = opener === '[' ? ']' : opener === '{' ? '}' : '';
  if (!closer) throw new Error(`Unsupported const expression opener: ${opener}`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || '';

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === opener) {
      depth += 1;
      continue;
    }
    if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  throw new Error('Could not find the end of const expression');
}

function findConstDeclaration(text, name) {
  const re = new RegExp(`const\\s+${escapeRegExp(name)}\\s*=`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  const valueStart = skipWhitespace(text, match.index + match[0].length);
  const valueEnd = scanBalancedExpression(text, valueStart);
  let end = skipWhitespace(text, valueEnd);
  if (text[end] === ';') end += 1;
  return {
    start: match.index,
    end,
    expression: text.slice(valueStart, valueEnd),
    declaration: text.slice(match.index, end)
  };
}

function replaceConstDeclaration(text, name, expression) {
  const found = findConstDeclaration(text, name);
  if (!found) throw new Error(`Missing const declaration: ${name}`);
  return `${text.slice(0, found.start)}const ${name}=${expression};${text.slice(found.end)}`;
}

function formatDemoAccounts() {
  const rows = DEMO_ACCOUNTS.map((account) => {
    return `  {id:${account.id},name:'${account.name}',device:'${account.device}',type:'${account.type}',emoji:'${account.emoji}',group:'${account.group}'}`;
  });
  return `[\n${rows.join(',\n')}\n]`;
}

function isPublicDemoValue(value) {
  return /^演示账号\s+[A-Z]$/.test(value) || /^demo-\d+$/i.test(value);
}

function extractAccountIdentityStrings(sourceHtml) {
  const found = findConstDeclaration(sourceHtml, 'ACCS');
  if (!found) return [];
  const values = [];
  for (const match of found.expression.matchAll(/\b(?:name|device)\s*:\s*'([^']+)'/g)) {
    const value = match[1].trim();
    if (value && !isPublicDemoValue(value)) values.push(value);
  }
  return [...new Set(values)];
}

function publicReplacementForPrivateValue(value) {
  return /\d+号$/.test(value) || /^fixture-device-\d+$/i.test(value) ? 'demo-001' : '演示账号 A';
}

function replacePrivateValues(html, privateValues) {
  let output = html;
  for (const value of privateValues) {
    output = output.replace(new RegExp(escapeRegExp(value), 'g'), publicReplacementForPrivateValue(value));
  }
  return output;
}

function buildPublicIndex(sourceHtml) {
  const privateValues = extractAccountIdentityStrings(sourceHtml);
  let output = sourceHtml;
  output = replaceConstDeclaration(output, 'ACCS', formatDemoAccounts());
  output = replaceConstDeclaration(output, 'TODAY_RECOVERY_SNAPSHOT', '{}');
  output = replacePrivateValues(output, privateValues);
  return output;
}

function summarizeIssues(issues) {
  const counts = new Map();
  for (const issue of issues) counts.set(issue.type, (counts.get(issue.type) || 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${type}: ${count}`).join(', ');
}

function scanPublicHtml(html, options = {}) {
  const issues = [];
  const sourceHtml = options.sourceHtml || html;
  const privateValues = extractAccountIdentityStrings(sourceHtml);

  for (const value of privateValues) {
    if (value && html.includes(value)) {
      issues.push({ type: 'private-account-value' });
    }
  }

  const snapshot = findConstDeclaration(html, 'TODAY_RECOVERY_SNAPSHOT');
  if (snapshot && snapshot.expression.replace(/\s+/g, '') !== '{}') {
    issues.push({ type: 'recovery-snapshot' });
  }

  const secretPatterns = [
    { type: 'feishu-app-id', pattern: /cli_[A-Za-z0-9]{8,}/ },
    { type: 'api-key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
    { type: 'feishu-table-id', pattern: /tbl[A-Za-z0-9]{8,}/ },
    { type: 'feishu-base-token', pattern: /bascn[A-Za-z0-9]{8,}/ }
  ];
  for (const item of secretPatterns) {
    if (item.pattern.test(html)) issues.push({ type: item.type });
  }

  const compact = html.replace(/\s+/g, ' ');
  for (const marker of REQUIRED_REVIEW_MARKERS) {
    if (!compact.includes(marker)) {
      issues.push({ type: 'missing-review-marker' });
    }
  }

  if (!html.includes("name:'演示账号 A'") || !html.includes("device:'demo-001'")) {
    issues.push({ type: 'missing-demo-accounts' });
  }

  return issues;
}

function readFile(filePath) {
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

function runCli(argv = process.argv.slice(2)) {
  if (argv[0] === '--check') {
    const htmlPath = argv[1] || 'index.html';
    const sourcePath = argv[2] || '';
    const html = readFile(htmlPath);
    const sourceHtml = sourcePath ? readFile(sourcePath) : html;
    const issues = scanPublicHtml(html, { sourceHtml });
    if (issues.length) {
      console.error(`public index check failed: ${summarizeIssues(issues)}`);
      process.exitCode = 1;
      return;
    }
    console.log('public index check passed');
    return;
  }

  const sourcePath = argv[0];
  const outputPath = argv[1] || 'index.html';
  if (!sourcePath) {
    console.error('Usage: node scripts/build-public-index.js <source-html> [output-html]');
    console.error('   or: node scripts/build-public-index.js --check [public-html] [source-html]');
    process.exitCode = 1;
    return;
  }

  const sourceHtml = readFile(sourcePath);
  const publicHtml = buildPublicIndex(sourceHtml);
  const issues = scanPublicHtml(publicHtml, { sourceHtml });
  if (issues.length) {
    console.error(`public index generation failed: ${summarizeIssues(issues)}`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.resolve(outputPath), publicHtml, 'utf8');
  console.log(`public index generated: ${path.resolve(outputPath)}`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  buildPublicIndex,
  scanPublicHtml,
  extractAccountIdentityStrings,
  findConstDeclaration,
  replaceConstDeclaration
};
