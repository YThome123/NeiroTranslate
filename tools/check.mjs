import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? files(file) : [file];
  });
}
let errors = 0;
for (const file of files(path.join(root, 'src')).filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); errors++; }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const [size, icon] of Object.entries(manifest.icons)) {
  const data = fs.readFileSync(path.join(root, icon));
  if (data.readUInt32BE(16) !== Number(size) || data.readUInt32BE(20) !== Number(size)) {
    console.error('Wrong icon dimensions:', icon); errors++;
  }
}
for (const file of files(path.join(root, 'src')).filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(https?:|#)/.test(match[1])) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), match[1]))) {
      console.error('Missing asset:', path.relative(root, file), match[1]); errors++;
    }
  }
}
if (manifest.host_permissions.includes('<all_urls>')) { console.error('Unexpected blanket host permission'); errors++; }
console.log(`${errors ? 'FAIL' : 'PASS'} JavaScript syntax, extension assets, icon sizes and manifest permissions`);
process.exitCode = errors ? 1 : 0;
