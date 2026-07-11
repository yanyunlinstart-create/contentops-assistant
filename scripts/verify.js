const { spawnSync } = require('child_process');

const checks = [
  [process.execPath, ['scripts/run-tests.js']],
  [process.execPath, ['--check', 'server.js']],
  [process.execPath, ['--check', 'scripts/run-tests.js']],
  [process.execPath, ['--check', 'scripts/verify.js']]
];

for (const [command, args] of checks) {
  const label = [command, ...args].join(' ');
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('\nverify passed');
