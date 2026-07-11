const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const htmlFile = fs.readdirSync('.').find((name) => name.endsWith('.html'));
assert(htmlFile, 'html file not found');

const html = fs.readFileSync(htmlFile, 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);

assert(scripts.length > 0, 'html should contain at least one script block');

scripts.forEach((script, index) => {
  new vm.Script(script, { filename: `${htmlFile}#script-${index + 1}` });
});

console.log('html script syntax tests passed');
