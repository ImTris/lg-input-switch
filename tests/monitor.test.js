'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitorService, parseDisplays, parseValue, inputCommand } = require('../app/monitor');

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const firstDisplay = `[1] LG ULTRAWIDE (${firstId})
 - Manufacturer:  GSM
 - AN Serial:     TEST-LG-001
 - Vendor:        7789 (0x1e6d)
 - Model:         40582 (0x9e86)
`;
const twoDisplays = firstDisplay + `[2] Other monitor (${secondId})
 - AN Serial:     TEST-OTHER-002
`;

function macService(run, wait = async () => {}) {
  return createMonitorService({ platform: 'darwin', arch: 'arm64', nativeDir: '/synthetic/native', run, wait });
}

test('detailed enumeration preserves identity and attributes for each monitor', () => {
  const displays = parseDisplays(twoDisplays);
  assert.equal(displays.length, 2);
  assert.deepEqual(displays[0], {
    id: firstId, name: 'LG ULTRAWIDE', manufacturer: 'GSM', serial: 'TEST-LG-001',
    vendor: '7789 (0x1e6d)', model: '40582 (0x9e86)',
  });
  assert.deepEqual(displays[1], { id: secondId, name: 'Other monitor', serial: 'TEST-OTHER-002' });
  assert.deepEqual(parseDisplays(''), []);
  assert.throws(() => parseDisplays(firstDisplay + firstDisplay), /dezelfde identificatie/);
  assert.throws(() => parseDisplays('DDC communication failure'), /schermlijst/);
});

test('read values preserve zero and reject error text or invalid numbers', () => {
  assert.equal(parseValue('0\n'), 0);
  assert.equal(parseValue(' 100\n'), 100);
  for (const value of ['', '-1', '1.5', '65536', '15 garbage', 'Unsupported VCP code']) {
    assert.throws(() => parseValue(value));
  }
});

test('listing performs only targeted reads; failed reads remain unknown', async () => {
  const calls = [];
  const service = macService(async (file, args) => {
    calls.push({ file, args });
    if (args[1] === 'list') return { stdout: twoDisplays };
    if (args[3] === firstId && args[5] === 'input') return { stdout: '15\n' };
    if (args[3] === firstId) return { stdout: '0\n' };
    if (args[5] === 'input') throw Object.assign(new Error('DDC failed'), { stdout: 'Unsupported VCP code 0x60' });
    return { stdout: 'invalid reply' };
  });
  const result = await service.list();
  assert.equal(result.mode, 'lg');
  assert.equal(result.displays[0].currentInput, 15);
  assert.equal(result.displays[0].brightness, 0);
  assert.equal(result.displays[1].currentInput, null);
  assert.equal(result.displays[1].brightness, null);
  assert.match(result.displays[1].readError, /Unsupported VCP code/);
  assert.match(result.displays[1].readError, /geen geldige waarde/);
  assert.deepEqual(calls.slice(1).map(call => call.args), [
    ['--read-wait', '80', 'display', firstId, 'get', 'input'],
    ['--read-wait', '80', 'display', firstId, 'get', 'luminance'],
    ['--read-wait', '80', 'display', secondId, 'get', 'input'],
    ['--read-wait', '80', 'display', secondId, 'get', 'luminance'],
  ]);
  assert.ok(calls.every(call => !call.args.includes('set')));
});

test('standard and LG commands target the selected UUID with their documented input codes', async t => {
  const mappings = [
    ['standard', 'displayport', 15, 15], ['standard', 'hdmi1', 17, 17],
    ['standard', 'hdmi2', 18, 18], ['standard', 'usbc', 27, 27],
    ['lg', 'displayport', 208, 15], ['lg', 'hdmi1', 144, 17],
    ['lg', 'hdmi2', 145, 18], ['lg', 'usbc', 209, 16], ['lg', 'usbc', 210, 27, 210],
  ];
  for (const [mode, input, value, reportedInput, usbCCode] of mappings) {
    await t.test(`${mode} ${input} ${value}`, async () => {
      const calls = [];
      const service = macService(async (file, args) => {
        calls.push({ file, args });
        return { stdout: args[1] === 'list' ? twoDisplays : args[4] === 'get' ? String(reportedInput) : `Writing ${value}` };
      });
      const result = await service.switchInput({ displayId: secondId, mode, input, usbCCode });
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0].args, ['display', 'list', 'detailed']);
      assert.deepEqual(calls[1], { file: '/synthetic/native/m1ddc', args: [
        'display', secondId, 'set', mode === 'lg' ? 'input-alt' : 'input', String(value),
      ] });
      assert.deepEqual(calls[2].args, ['--read-wait', '80', 'display', secondId, 'get', 'input']);
      assert.equal(result.status, 'verified');
      assert.equal(result.currentInput, reportedInput);
      assert.match(result.message, /als actieve ingang/);
    });
  }
});

test('disconnecting the selected display never falls back to another connected monitor', async () => {
  const calls = [];
  const service = macService(async (_file, args) => {
    calls.push(args);
    return { stdout: firstDisplay };
  });
  await assert.rejects(service.switchInput({ displayId: secondId, input: 'hdmi1', mode: 'lg' }), /niet meer verbonden/);
  assert.deepEqual(calls, [['display', 'list', 'detailed']]);
});

test('the native no-display exit is an empty list, while genuine helper failures still reject', async () => {
  const disconnected = macService(async () => {
    throw Object.assign(new Error('exit 1'), { code: 1, stdout: 'No external display found, aborting' });
  });
  assert.deepEqual((await disconnected.list()).displays, []);
  await assert.rejects(disconnected.switchInput({ displayId: firstId, input: 'hdmi1', mode: 'lg' }), /niet meer verbonden/);
  const broken = macService(async () => {
    throw Object.assign(new Error('exit 1'), { code: 1, stdout: 'DDC communication failure' });
  });
  await assert.rejects(broken.list(), /DDC communication failure/);
});

test('ambiguous display identity prevents a write', async () => {
  const calls = [];
  const service = macService(async (_file, args) => {
    calls.push(args);
    return { stdout: firstDisplay + firstDisplay };
  });
  await assert.rejects(service.switchInput({ displayId: firstId, input: 'hdmi1', mode: 'lg' }), /dezelfde identificatie/);
  assert.equal(calls.length, 1);
});

test('malformed switch requests are rejected before any helper runs', async () => {
  const valid = { displayId: firstId, input: 'hdmi1', mode: 'standard' };
  const invalid = [null, {}, { ...valid, displayId: '' }, { ...valid, input: '__proto__' },
    { ...valid, input: 'volume' }, { ...valid, mode: 'arbitrary' },
    { ...valid, input: 'usbc', mode: 'lg', usbCCode: 211 },
    { ...valid, input: 'usbc', mode: 'lg', usbCCode: '209' }];
  let calls = 0;
  const service = macService(async () => { calls++; return { stdout: twoDisplays }; });
  for (const request of invalid) {
    assert.throws(() => inputCommand(request));
    await assert.rejects(service.switchInput(request));
  }
  assert.equal(calls, 0);
});

test('helper timeout is bounded and shown as an actionable error', async () => {
  const service = macService(async (_file, _args, options) => {
    assert.equal(options.timeout, 12000);
    assert.equal(options.killSignal, 'SIGKILL');
    throw Object.assign(new Error('killed'), { killed: true });
  });
  await assert.rejects(service.list(), /niet op tijd/);
});

test('a failed write does not produce a success response', async () => {
  const service = macService(async (_file, args) => {
    if (args[1] === 'list') return { stdout: firstDisplay };
    throw Object.assign(new Error('exit 1'), { stdout: 'DDC communication failure: no valid reply' });
  });
  await assert.rejects(service.switchInput({ displayId: firstId, input: 'hdmi1', mode: 'lg' }), /no valid reply/);
});

test('an ignored USB-C command reports the actual DisplayPort input after waiting', async () => {
  const events = [];
  const service = macService(async (_file, args) => {
    if (args[1] === 'list') return { stdout: firstDisplay };
    if (args[2] === 'set') { events.push('write'); return { stdout: 'Writing 209' }; }
    events.push('read');
    assert.deepEqual(args, ['--read-wait', '80', 'display', firstId, 'get', 'input']);
    return { stdout: '15' };
  }, async milliseconds => { events.push(`wait ${milliseconds}`); });
  const result = await service.switchInput({ displayId: firstId, input: 'usbc', mode: 'lg' });
  assert.deepEqual(events, ['write', 'wait 1200', 'read']);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.currentInput, 15);
  assert.match(result.message, /nog DisplayPort/);
  assert.match(result.message, /niet bevestigd/);
});

test('losing the DDC link after a write returns unverified without another write', async () => {
  const calls = [];
  const service = macService(async (_file, args) => {
    calls.push(args);
    if (args[1] === 'list') return { stdout: twoDisplays };
    if (args[2] === 'set') return { stdout: 'Writing 144' };
    throw Object.assign(new Error('exit 1'), { stdout: 'The specified display does not exist.' });
  });
  const result = await service.switchInput({ displayId: secondId, input: 'hdmi1', mode: 'lg' });
  assert.equal(result.status, 'unverified');
  assert.equal(result.currentInput, null);
  assert.match(result.message, /niet uit te lezen/);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(args => args.includes('set')).length, 1);
  assert.deepEqual(calls[2], ['--read-wait', '80', 'display', secondId, 'get', 'input']);
});

test('Windows rejects LG alternate before enumeration or writes', async () => {
  let calls = 0;
  const service = createMonitorService({ platform: 'win32', run: async () => { calls++; } });
  await assert.rejects(service.switchInput({ displayId: 'windows-monitor', input: 'hdmi1', mode: 'lg' }), /GPU-specifieke/);
  assert.equal(calls, 0);
});

test('Windows standard mode passes a selected device ID and validated value as separate arguments', async () => {
  const id = '\\\\?\\DISPLAY#GSM1234#TEST#physical=0';
  const calls = [];
  const service = createMonitorService({ platform: 'win32', nativeDir: '/synthetic/native', wait: async () => {}, run: async (file, args) => {
    calls.push({ file, args });
    return { stdout: args.at(-1) === 'list' ? JSON.stringify([{ id, name: 'LG ULTRAWIDE', currentInput: 27 }]) : '{}' };
  } });
  const result = await service.switchInput({ displayId: id, input: 'usbc', mode: 'standard' });
  assert.equal(calls.length, 3);
  assert.equal(result.status, 'verified');
  assert.equal(result.currentInput, 27);
  assert.equal(calls[1].file, 'powershell.exe');
  assert.deepEqual(calls[1].args.slice(-6), ['-Action', 'set', '-DisplayId', id, '-Value', '27']);
});

test('Windows readback never uses a different monitor after the target disconnects', async () => {
  let scans = 0;
  const service = createMonitorService({ platform: 'win32', wait: async () => {}, run: async (_file, args) => {
    if (args.at(-1) !== 'list') return { stdout: '{}' };
    const displays = ++scans === 1 ? [{ id: firstId, currentInput: 15 }] : [{ id: secondId, currentInput: 17 }];
    return { stdout: JSON.stringify(displays) };
  } });
  const result = await service.switchInput({ displayId: firstId, input: 'hdmi1', mode: 'standard' });
  assert.equal(scans, 2);
  assert.equal(result.status, 'unverified');
  assert.equal(result.currentInput, null);
});
