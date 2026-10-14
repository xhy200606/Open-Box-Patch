import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {apply} from '../scripts/patch-anytls.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-protected-recovery-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const serverDir = path.join(root, 'panel/server');
  fs.mkdirSync(path.join(serverDir, 'cli'), {recursive: true});
  fs.mkdirSync(path.join(root, 'panel/dist/assets'), {recursive: true});
  const originalServer = `import fs from 'node:fs';import {createHash} from 'node:crypto';
const manifest=JSON.parse(fs.readFileSync(new URL('./hardening-manifest.json',import.meta.url)));
const actual=createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
if(actual!==manifest.files['index.mjs'])throw new Error('原生运行组件已被修改: index.mjs');
console.log('startup integrity verified');\n`;
  const originalCli = 'export const originalCli=true;\n';
  fs.writeFileSync(path.join(serverDir, 'index.mjs'), originalServer);
  fs.writeFileSync(path.join(serverDir, 'cli/deploy.mjs'), originalCli);
  fs.writeFileSync(path.join(serverDir, 'hardening-manifest.json'), JSON.stringify({files: {'index.mjs': digest(originalServer), 'cli/deploy.mjs': digest(originalCli)}}));
  fs.writeFileSync(path.join(root, 'panel/dist/index.html'), '<html><head><script type="module" src="./assets/entry.js"></script></head></html>');
  return {root, serverDir, originalServer, originalCli};
}

test('integrity-protected upstream is never injected or assigned modified hashes', t => {
  const {root, serverDir, originalServer} = fixture(t);
  const before = fs.readFileSync(path.join(serverDir, 'hardening-manifest.json'), 'utf8');
  assert.equal(apply(root, '/unused'), false);
  assert.equal(fs.readFileSync(path.join(serverDir, 'index.mjs'), 'utf8'), originalServer);
  assert.equal(fs.readFileSync(path.join(serverDir, 'hardening-manifest.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(serverDir, 'anytls-share.mjs')), false);
});

test('verified recovery restores startup and removes unsupported UI without reinjecting it', t => {
  const {root, serverDir, originalServer, originalCli} = fixture(t);
  for (const [relative, original] of [['index.mjs', originalServer], ['cli/deploy.mjs', originalCli]]) {
    const file = path.join(serverDir, relative);
    fs.copyFileSync(file, file + '.anytls-bak');
    fs.writeFileSync(file, '// buildAnyTlsShare as __obAnyTlsConfig\n' + original);
  }
  assert.throws(() => execFileSync(process.execPath, [path.join(serverDir, 'index.mjs')], {stdio:'pipe'}), /原生运行组件已被修改/);
  fs.writeFileSync(path.join(serverDir, 'anytls-share.mjs'), '// old extension');
  const ui = path.join(root, 'panel/dist/assets/shared.js');
  const originalUi = 'const dialog={__name:"ServerEditDialog"};';
  fs.writeFileSync(ui, '/* openbox-share-v2 */\n' + originalUi);
  fs.writeFileSync(ui + '.anytls-bak', originalUi);
  assert.equal(apply(root, '/unused'), true);
  assert.match(execFileSync(process.execPath, [path.join(serverDir, 'index.mjs')], {encoding:'utf8'}), /startup integrity verified/);
  assert.equal(fs.readFileSync(path.join(serverDir, 'cli/deploy.mjs'), 'utf8'), originalCli);
  assert.equal(fs.readFileSync(ui, 'utf8'), originalUi);
  assert.match(fs.readFileSync(path.join(root, 'panel/dist/index.html'), 'utf8'), /share-original=/);
  assert.equal(fs.existsSync(path.join(serverDir, 'anytls-share.mjs')), false);
  assert.equal(apply(root, '/unused'), false);
});

test('a mismatched backup aborts before restoring either runtime entry point', t => {
  const {root, serverDir, originalServer, originalCli} = fixture(t);
  for (const [relative, original] of [['index.mjs', originalServer], ['cli/deploy.mjs', originalCli]]) {
    const file = path.join(serverDir, relative);
    fs.writeFileSync(file + '.anytls-bak', relative === 'index.mjs' ? original : 'wrong release');
    fs.writeFileSync(file, '// buildAnyTlsShare as __obAnyTlsConfig\n' + original);
  }
  const before = fs.readFileSync(path.join(serverDir, 'index.mjs'), 'utf8');
  assert.throws(() => apply(root, '/unused'), /SHA-256/);
  assert.equal(fs.readFileSync(path.join(serverDir, 'index.mjs'), 'utf8'), before);
});
