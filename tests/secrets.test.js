const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checker = path.resolve('tools/check-secrets.mjs');
const packager = path.resolve('tools/package.py');
const sampleKey = 'sk_' + 'a'.repeat(48);

function fixture(t, git = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-secrets-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('nt-secrets-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  if (git) command('git', ['init', '-q', root]);
  return root;
}

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function check(root, ...args) {
  return spawnSync(process.execPath, [checker, '--root', root, ...args], { encoding: 'utf8' });
}

function packageFixture(t) {
  const root = fixture(t, true);
  for (const directory of ['tools', 'assets/icons', 'docs']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.copyFileSync(checker, path.join(root, 'tools/check-secrets.mjs'));
  fs.copyFileSync(packager, path.join(root, 'tools/package.py'));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"3.4.0"}');
  for (const name of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/README.en.md',
    'docs/PRIVACY.md', 'docs/VERIFICATION.md', 'docs/CODE_REVIEW.md', 'docs/VOICE_QUALITY.md', 'assets/cover.svg']) {
    fs.writeFileSync(path.join(root, name), 'Safe fixture content.');
  }
  return root;
}

test('publication scan accepts empty keys and documented environment-variable names', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/settings.js'), "const settings = {elevenApiKey:'',geminiApiKey:''};");
  fs.writeFileSync(path.join(root, 'README.md'), 'Use NT_ELEVEN_API_KEY and NT_GEMINI_API_KEY. invalid-test-key');
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('publication scan rejects an untracked credential without printing its value', t => {
  const root = fixture(t, true);
  fs.writeFileSync(path.join(root, 'accidental.txt'), sampleKey);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /accidental\.txt/);
  assert.ok(!result.stdout.includes(sampleKey));
  assert.ok(!result.stderr.includes(sampleKey));
});

test('publication scan recognizes both Google credential formats', t => {
  const root = fixture(t);
  const tokens = ['AIza' + 'Z'.repeat(35), 'AQ.' + 'B'.repeat(48)];
  fs.writeFileSync(path.join(root, 'README.md'), tokens.join('\n'));
  const result = check(root);
  assert.equal(result.status, 1);
  assert.ok(tokens.every(token => !(result.stdout + result.stderr).includes(token)));
  assert.match(result.stdout, /Google/);
});

test('history scan detects a committed key even after the file was removed', t => {
  const root = fixture(t, true);
  fs.writeFileSync(path.join(root, 'old.txt'), sampleKey);
  command('git', ['add', 'old.txt'], root);
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], root);
  fs.unlinkSync(path.join(root, 'old.txt'));
  const result = check(root, '--history');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git:/);
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});

test('source-folder scan works without Git and checks public files', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/settings.js'), sampleKey);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src[/\\]settings\.js/);
});

test('packaging refuses a credential leak before overwriting an existing release', t => {
  const root = packageFixture(t);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'README.md'), sampleKey);
  const archive = path.join(root, 'dist/neirotranslate-3.4.0.zip');
  fs.writeFileSync(archive, 'previous-safe-release');
  const result = spawnSync('python', ['tools/package.py'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL credential:.*README\.md/);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'previous-safe-release');
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});

test('packaging also scans an ignored asset selected by the release allowlist', t => {
  const root = packageFixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'assets/icons/private.png\n');
  fs.writeFileSync(path.join(root, 'assets/icons/private.png'), sampleKey);
  fs.writeFileSync(path.join(root, 'README.md'), 'No credential here.');
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"3.4.0"}');
  const result = spawnSync('python', ['tools/package.py'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL credential:.*assets[/\\]icons[/\\]private\.png/);
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});

test('packaging checks an ignored Unicode-named asset using explicit UTF-8 paths', t => {
  const root = packageFixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'assets/icons/*.svg\n');
  fs.writeFileSync(path.join(root, 'assets/icons/приватный.svg'), sampleKey);
  const result = spawnSync('python', ['tools/package.py'], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'cp1251' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL credential:.*assets[/\\]icons/);
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});

test('explicit archive input scan refuses a missing path instead of reporting success', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [checker, '--root', root, '--paths-stdin'],
    { input: 'src/missing.js', encoding: 'utf8' });
  assert.equal(result.status, 1);
});

test('publication scan finds credentials in filenames without exposing them in diagnostics', t => {
  const root = fixture(t, true);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', sampleKey + '.js'), 'Harmless contents.');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});

test('history scan finds a credential left only in a committed tree filename', t => {
  const root = fixture(t, true), name = sampleKey + '.txt';
  fs.writeFileSync(path.join(root, name), 'Harmless contents.');
  command('git', ['add', name], root);
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], root);
  command('git', ['rm', '-q', name], root);
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'remove'], root);
  const result = check(root, '--history');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git:/);
  assert.ok(!(result.stdout + result.stderr).includes(sampleKey));
});
