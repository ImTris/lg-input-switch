'use strict';
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('native DDC reply decoding and validation (synthetic packets, no hardware I/O)', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
  timeout: 60_000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temporary = mkdtempSync(path.join(tmpdir(), 'lg-ddc-packet-'));
  const binary = path.join(temporary, 'ddc-packet');
  try {
    execFileSync('clang', [
      '-Wall', '-Wextra', '-Werror', '-fmodules',
      '-I', path.join(root, 'vendor/m1ddc/headers'),
      path.join(__dirname, 'ddc-packet.m'),
      path.join(root, 'vendor/m1ddc/sources/i2c.m'),
      '-framework', 'CoreDisplay', '-o', binary,
    ], { timeout: 30_000 });
    execFileSync(binary, [], { timeout: 5_000 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
