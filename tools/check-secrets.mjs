// Publication guard: report credential locations, never credential values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : fileURLToPath(new URL('../', import.meta.url)));
const history = args.includes('--history');
const patterns = [
  ['ElevenLabs', /\bsk_[a-fA-F0-9]{32,}\b/g],
  ['Google API', /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ['Google AQ', /\bAQ\.[A-Za-z0-9_-]{32,}\b/g],
  ['GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];
// An explicitly FAKE/NEIROTRANSLATE-labelled test token from the original
// history. Exempt this exact digest only in history, never a current file.
const legacyFixture = '3292b1ef0c258ba2decf0fbf7dda6164e1a466e4898e5498265046444ad1c106';
const findings = [];
let fileCount = 0, objectCount = 0, legacyCount = 0;

function inspect(data, location, historical = false) {
  const text = data.toString('latin1');
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (historical && kind === 'Google API' && createHash('sha256').update(match[0]).digest('hex') === legacyFixture) {
        legacyCount++; continue;
      }
      findings.push({ location, kind, line: text.slice(0, match.index).split('\n').length });
    }
  }
}

function git(argv) {
  const result = spawnSync('git', ['-C', root, ...argv], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Git scan could not complete');
  return result.stdout;
}

function walk(directory) {
  const skipped = new Set(['.git', 'dist', 'node_modules', '__pycache__', '.ruff_cache', 'test-results', 'playwright-report']);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || skipped.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

try {
  const isGit = fs.existsSync(path.join(root, '.git'));
  const files = args.includes('--paths-stdin')
    ? fs.readFileSync(0, 'utf8').split('\0').filter(Boolean).map(file => path.resolve(root, file))
    : isGit
      ? [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))].map(file => path.join(root, file))
      : walk(root);
  for (const file of files) {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Path outside project');
    inspect(Buffer.from(relative, 'utf8'), 'filename:' + relative.split(path.sep).join('/'));
    if (args.includes('--paths-stdin') && (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) {
      throw new Error('Archive input is missing or is not a regular file');
    }
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) continue;
    inspect(fs.readFileSync(file), path.relative(root, file).split(path.sep).join('/'));
    fileCount++;
  }
  if (history) {
    if (!isGit) throw new Error('History scan requires the repository .git directory');
    const objects = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).toString('utf8').trim().split('\n');
    for (const object of objects) {
      const [oid, kind] = object.trim().split(' ');
      if (!['blob', 'commit', 'tag', 'tree'].includes(kind)) continue;
      inspect(git(['cat-file', kind, oid]), 'git:' + oid, true);
      objectCount++;
    }
  }
  if (findings.length) {
    for (const finding of findings) {
      const location = patterns.reduce((value, [, pattern]) => value.replace(pattern, '[credential]'), finding.location);
      console.log(`FAIL credential: ${finding.kind} at ${location}:${finding.line} [value hidden]`);
    }
    process.exitCode = 1;
  } else {
    console.log(`PASS credential scan: ${fileCount} public files${history ? `, ${objectCount} Git objects, ${legacyCount} known invalid historical fixtures` : ''}`);
  }
} catch {
  console.error('FAIL credential scan could not complete; publication must stop.');
  process.exitCode = 1;
}
