'use strict';
const { execFileSync } = require('node:child_process');
const { copyFileSync, chmodSync } = require('node:fs');
const path = require('node:path');

if (process.platform === 'darwin') {
  if (process.arch !== 'arm64') throw new Error('Deze Mac-versie vereist Apple Silicon (M1 of nieuwer).');
  const root = path.resolve(__dirname, '..');
  execFileSync('make', ['-C', path.join(root, 'vendor/m1ddc')], { stdio: 'inherit' });
  const target = path.join(root, 'native/m1ddc');
  copyFileSync(path.join(root, 'vendor/m1ddc/m1ddc'), target);
  chmodSync(target, 0o755);
}
