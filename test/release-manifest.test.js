'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const script = path.resolve(__dirname, '../tools/release-manifest.py');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, '中文说明.md'), 'A reproducible fixture\n');
  fs.writeFileSync(path.join(dir, 'code.js'), 'module.exports = 1;\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const verify = (...extra) => cp.spawnSync('python3', [script, '--repo', dir, '--root', dir,
    '--commit', commit, ...extra], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return { dir, git, commit, verify };
}
test('release manifest supports non-ASCII tracked paths and exact commit', t => {
  const f = fixture(t); const result = f.verify();
  assert.equal(result.status, 0, result.stderr);
  const m = JSON.parse(result.stdout); assert.equal(m.commit, f.commit);
  assert.equal(m.files.length, 2); assert.ok(m.files.some(x => x.path === '中文说明.md'));
});
test('changed release bytes fail validation', t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.dir, 'code.js'), '// drift\n');
  const result = f.verify(); assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from commit/);
});
test('missing release file fails validation', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.dir, 'code.js'));
  assert.equal(f.verify().status, 1);
});
test('release verifier refuses symlink substitutions', t => {
  const f = fixture(t); const target = path.join(f.dir, 'code.js');
  fs.unlinkSync(target); fs.symlinkSync('中文说明.md', target);
  assert.equal(f.verify().status, 1);
});
test('test report from another commit cannot authorize this release', t => {
  const f = fixture(t); const report = path.join(f.dir, 'mismatched.json');
  fs.writeFileSync(report, JSON.stringify({ commit: 'wrong', tree: 'wrong', exit_code: 0 }));
  const result = f.verify('--test-evidence', report);
  assert.equal(result.status, 1); assert.match(result.stderr, /different commit/);
});
test('existing release manifest is not silently overwritten', t => {
  const f = fixture(t); const output = path.join(f.dir, 'manifest.json');
  fs.writeFileSync(output, 'previous evidence');
  const result = f.verify('--output', output);
  assert.equal(result.status, 1); assert.equal(fs.readFileSync(output, 'utf8'), 'previous evidence');
});
