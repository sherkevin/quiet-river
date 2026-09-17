'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Does NOT contact ECS, start services, read real credentials or execute arbitrary remote commands.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['tools', 'lib', 'public', 'data', 'bin', 'home', 'tmp']) {
    fs.mkdirSync(path.join(root, d));
  }
  fs.copyFileSync(path.join(__dirname, '../tools/deploy-ecs.sh'), path.join(root, 'tools/deploy-ecs.sh'));
  for (const [file, text] of Object.entries({
    'server.js': '// fixture', 'seed.js': '// fixture', 'package.json': '{}',
    'lib/example.js': '// fixture', 'lib/adapters.private.js': '// must not ship',
    'public/index.html': '<!doctype html>', 'data/subscriptions.json': '{"subscriptions":[]}',
    'data/cache.seed.json': '{}', 'data/cache.json': '{"privateRuntime":true}',
  })) fs.writeFileSync(path.join(root, file), text);
  const wb = `#!/usr/bin/env node
const fs=require('node:fs');
const cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='upload') {
  fs.writeFileSync(process.env.MOCK_ARCHIVE,cp.execFileSync('tar',['tzf',args[1]]));
  process.exit(0);
}
const command=args[args.indexOf('-c')+1] || '';
if(command.includes('test -s /opt/quiet-river/data/subscriptions.json') && process.env.MOCK_CONFIG_MISSING==='1') process.exit(7);
if(command.includes('mkdir -p /var/backups/quiet-river') && process.env.MOCK_BACKUP_FAIL==='1') process.exit(8);
if(command.includes('code=000')) {
  // Execute only the health-check fragment. curl and sleep are test doubles.
  const r=cp.spawnSync('bash',['-c',command],{env:process.env,encoding:'utf8'});
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);
}
process.exit(0);
`;
  fs.writeFileSync(path.join(root, 'bin/workbench'), wb, {mode:0o755});
  fs.writeFileSync(path.join(root, 'bin/curl'), `#!/bin/sh\nif [ "\${MOCK_CURL_FAIL:-0}" = 1 ]; then exit 7; fi\nprintf '%s' "\${MOCK_HTTP_STATUS:-401}"\n`, {mode:0o755});
  fs.writeFileSync(path.join(root, 'bin/sleep'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  const env = {...process.env, PATH:path.join(root, 'bin')+path.delimiter+process.env.PATH,
    HOME:path.join(root, 'home'), TMPDIR:path.join(root, 'tmp'),
    QR_ECS_INSTANCE:'i-testfixture', QR_ECS_PORT:'80,4321', QR_ECS_REGION:'',
    MOCK_LOG:path.join(root, 'calls.jsonl'), MOCK_ARCHIVE:path.join(root, 'archive.txt'),
    MOCK_HTTP_STATUS:'401', MOCK_CURL_FAIL:'0', MOCK_CONFIG_MISSING:'0', MOCK_BACKUP_FAIL:'0'};
  return {
    root,
    run(args=[], more={}) { return spawnSync('bash',[path.join(root,'tools/deploy-ecs.sh'),...args],{env:{...env,...more},encoding:'utf8',timeout:15000}); },
    calls() { return fs.existsSync(env.MOCK_LOG) ? fs.readFileSync(env.MOCK_LOG,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; },
    archive() { return fs.readFileSync(env.MOCK_ARCHIVE,'utf8'); },
  };
}

test('dry-run performs no workbench calls and excludes runtime/private data', t => {
  const f=fixture(t), r=f.run(['--dry-run'],{QR_ECS_INSTANCE:''});
  assert.equal(r.status,0,r.stderr); assert.equal(f.calls().length,0);
  assert.match(r.stdout,/DRY RUN/); assert.doesNotMatch(r.stdout,/quiet-river\/data\/subscriptions\.json/);
  assert.doesNotMatch(r.stdout,/adapters\.private\.js|quiet-river\/data\/cache\.json/);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'tmp')),[]);
});
test('explicit config sync includes subscription file', t => {
  const f=fixture(t), r=f.run(['--sync-subscriptions','--dry-run']);
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/quiet-river\/data\/subscriptions\.json/);
});
test('provision includes initial subscriptions without contacting ECS in dry-run', t => {
  const f=fixture(t), r=f.run(['--dry-run','--provision']);
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/quiet-river\/data\/subscriptions\.json/);
  assert.equal(f.calls().length,0);
});
for (const port of ['0','65536','080','80,','80,,4321','80;echo unsafe','80\n4321']) {
  test(`invalid port rejected before remote calls: ${JSON.stringify(port)}`,t => {
    const f=fixture(t),r=f.run([],{QR_ECS_PORT:port});
    assert.equal(r.status,2); assert.equal(f.calls().length,0);
  });
}
test('unknown option rejected',t => { const f=fixture(t),r=f.run(['--typo']); assert.equal(r.status,2); assert.equal(f.calls().length,0); });
test('missing instance rejected for real deployment',t => { const f=fixture(t),r=f.run([],{QR_ECS_INSTANCE:''}); assert.equal(r.status,2); assert.equal(f.calls().length,0); });
test('code update preserves config and checks every port separately',t => {
  const f=fixture(t),r=f.run(); assert.equal(r.status,0,r.stderr);
  assert.doesNotMatch(f.archive(),/subscriptions\.json|adapters\.private\.js|data\/cache\.json/);
  const health=f.calls().filter(a=>a.some(x=>x.includes('code=000'))).map(a=>a[a.indexOf('-c')+1]);
  assert.equal(health.length,2); assert.match(health[0],/127\.0\.0\.1:80\/api\/state/);
  assert.match(health[1],/127\.0\.0\.1:4321\/api\/state/);
  assert.ok(health.every(s=>!s.includes('127.0.0.1:80,4321')));
});
test('missing production config aborts before upload',t => {
  const f=fixture(t),r=f.run([],{MOCK_CONFIG_MISSING:'1'}); assert.notEqual(r.status,0);
  assert.equal(f.calls().filter(a=>a[0]==='upload').length,0);
});
test('explicit sync backs up config before upload and aborts if backup fails',t => {
  const f=fixture(t),r=f.run(['--sync-subscriptions'],{MOCK_BACKUP_FAIL:'1'}); assert.notEqual(r.status,0);
  assert.equal(f.calls().filter(a=>a[0]==='upload').length,0);
});
test('explicit sync includes config and orders backup before upload',t => {
  const f=fixture(t),r=f.run(['--sync-subscriptions']); assert.equal(r.status,0,r.stderr);
  assert.match(f.archive(),/data\/subscriptions\.json/);
  const calls=f.calls(),backup=calls.findIndex(a=>a.some(s=>s.includes('mkdir -p /var/backups/quiet-river')));
  assert.ok(backup>=0 && backup<calls.findIndex(a=>a[0]==='upload'));
});
for (const status of ['200','302','500']) {
  test(`unexpected HTTP ${status} fails deployment health gate`,t => {
    const f=fixture(t),r=f.run([],{MOCK_HTTP_STATUS:status});
    assert.notEqual(r.status,0); assert.doesNotMatch(r.stdout,/==> 完成/);
    assert.match(r.stderr,/本机自检失败/);
  });
}
test('connection failure is bounded and cannot print success',t => {
  const f=fixture(t),r=f.run([],{MOCK_CURL_FAIL:'1'}); assert.notEqual(r.status,0);
  assert.match(r.stderr,/HTTP 000/); assert.doesNotMatch(r.stdout,/==> 完成/);
});
