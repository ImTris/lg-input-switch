'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const { packager } = await import('@electron/packager');
  const platform = process.argv[2] || process.platform;
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Kies darwin of win32.');
  const paths = await packager({
    dir: path.resolve(__dirname, '..'),
    name: 'LG Input Switch',
    appBundleId: 'nl.local.lg-input-switch',
    platform,
    arch: platform === 'win32' ? 'x64' : 'arm64',
    out: path.resolve(__dirname, '../dist'),
    overwrite: true,
    asar: { unpack: '**/native/**' },
    ignore: [/^\/dist($|\/)/, /^\/vendor($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/],
    appCopyright: 'LG Input Switch — onafhankelijke lokale app',
  });
  if (platform === 'darwin') {
    for (const output of paths) execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(output, 'LG Input Switch.app')], { stdio: 'inherit' });
  }
  console.log(paths.join('\n'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
