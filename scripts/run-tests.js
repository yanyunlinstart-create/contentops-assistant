const { spawnSync } = require('child_process');
const fs = require('fs');

const tests = fs.readdirSync('.').filter((file) => file.endsWith('.test.js')).sort();

for (const file of tests) {
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
