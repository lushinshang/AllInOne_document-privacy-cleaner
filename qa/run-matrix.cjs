const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const commands = ['test:functional', 'test:clean-download', 'test:capacity', 'test:performance', 'test:security'];
const results = commands.map(script => {
  const started = Date.now();
  const run = spawnSync('npm', ['run', script], { cwd: root, encoding: 'utf8', timeout: 180000, env: { ...process.env, CI: '1' } });
  return { script, status: run.status === 0 ? 'passed' : 'failed', exitCode: run.status, durationMs: Date.now() - started, stdout: run.stdout || '', stderr: run.stderr || '' };
});
const out = path.join(root, 'qa', 'results', 'matrix-results.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, results }, null, 2));
console.log(`Matrix summary: ${results.filter(r => r.status === 'passed').length}/${results.length} passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
