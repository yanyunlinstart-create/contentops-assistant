const assert = require('assert');
const fs = require('fs');

const htmlFile = fs.readdirSync('.').find((name) => name.endsWith('.html'));
assert(htmlFile, 'html file not found');

const html = fs.readFileSync(htmlFile, 'utf8');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n');
const css = styles.replace(/\/\*[\s\S]*?\*\//g, '');
const ruleMatches = [...css.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)];

const selectorCounts = new Map();
let declarationCount = 0;

for (const match of ruleMatches) {
  const selector = match[1].trim().replace(/\s+/g, ' ');
  const body = match[2].trim();
  if (!selector || selector.startsWith('from') || selector.startsWith('to')) continue;
  selectorCounts.set(selector, (selectorCounts.get(selector) || 0) + 1);
  declarationCount += body.split(';').map((item) => item.trim()).filter(Boolean).length;
}

const repeatedThreeOrMore = [...selectorCounts.values()].filter((count) => count >= 3).length;

assert(ruleMatches.length <= 1034, `CSS rule count should stay <= 1034, got ${ruleMatches.length}`);
assert(declarationCount <= 3708, `CSS declaration count should stay <= 3708, got ${declarationCount}`);
assert(repeatedThreeOrMore <= 44, `selectors repeated 3+ times should stay <= 44, got ${repeatedThreeOrMore}`);

console.log('css visual budget tests passed');
