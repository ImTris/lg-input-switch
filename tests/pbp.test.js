'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitorService } = require('../app/monitor');

const firstId = '11111111-1111-4111-8111-111111111111';
const changedId = '22222222-2222-4222-8222-222222222222';
const serial = 'TEST-LG-PBP';
const monitor = { id: firstId, name: 'LG ULTRAWIDE', serial, vendor: 7789, model: 40582 };
const request = { displayId: firstId, mode: 'pbp', input: 'usbc' };
const disconnected = () => Object.assign(new Error('Disconnected'), { stdout: 'No valid DDC reply' });

function fixture({ platform = 'darwin', displays = [monitor], inputs = [15, 16], pbp = [1, 5],
  onWrite = () => {}, readOutput } = {}) {
  const state = { displays: displays.map(item => ({ ...item })), calls: [], writes: [], reads: [], waits: [] };
  const responses = { input: [...inputs], 'lg-pbp': [...pbp] };
  state.service = createMonitorService({
    platform, arch: 'arm64', nativeDir: '/synthetic/native',
    wait: async milliseconds => { state.waits.push(milliseconds); },
    run: async (file, args) => {
      state.calls.push({ file, args });
      let action, control, target, value;
      if (platform === 'darwin') {
        assert.equal(file, '/synthetic/native/m1ddc');
        if (args[1] === 'list') action = 'list';
        else if (args[0] === '--read-wait') {
          assert.deepEqual(args.slice(0, 3), ['--read-wait', '100', 'display']);
          assert.equal(args[4], 'get');
          [target, control] = [args[3], args[5]];
          action = 'read';
        } else {
          assert.equal(args[0], 'display');
          assert.equal(args[2], 'set');
          assert.equal(args[3], 'lg-pbp');
          [target, value] = [args[1], Number(args[4])];
          action = 'write';
        }
        if (target) assert.equal(target, `serial=${serial}`, 'PBP commands must survive UUID changes');
      } else {
        assert.equal(file, 'powershell.exe');
        const command = args.slice(args.indexOf('-Action'));
        const operation = command[1];
        if (operation === 'list') action = 'list';
        else {
          assert.deepEqual(command.slice(2, 4), ['-Serial', serial]);
          target = command[3];
          if (operation === 'set-pbp') {
            assert.equal(command[4], '-Value');
            value = Number(command[5]);
            action = 'write';
          } else {
            assert.ok(['read-input', 'read-pbp'].includes(operation));
            control = operation === 'read-input' ? 'input' : 'lg-pbp';
            action = 'read';
          }
        }
      }
      if (action === 'list') {
        const stdout = platform === 'win32' ? JSON.stringify(state.displays) : state.displays.map((item, index) =>
          `[${index + 1}] ${item.name} (${item.id})\n - AN Serial:     ${item.serial ?? ''}\n - Vendor:        ${item.vendor}\n - Model:         ${item.model}\n`).join('');
        return { stdout };
      }
      if (action === 'write') {
        state.writes.push({ target, value });
        await onWrite(value, state);
        return { stdout: platform === 'win32' ? '{"message":"Writing"}' : `Writing ${value}` };
      }
      state.reads.push({ target, control });
      assert.ok(responses[control]?.length, `Unexpected extra ${control} read`);
      const result = responses[control].shift();
      if (result instanceof Error) throw result;
      return { stdout: readOutput ? readOutput(result) : platform === 'win32' ? JSON.stringify({ value: result }) : String(result) };
    },
  });
  return state;
}

test('Mac PBP switching keeps the serial target when enabling PBP changes the UUID', async () => {
  const state = fixture({ onWrite: (value, state) => {
    if (value === 5) state.displays[0].id = changedId;
  } });
  const result = await state.service.switchInput(request);
  assert.equal(state.displays[0].id, changedId);
  assert.equal(result.status, 'verified');
  assert.equal(result.currentInput, 16);
  assert.deepEqual(state.writes, [{ target: `serial=${serial}`, value: 5 }, { target: `serial=${serial}`, value: 2 }]);
  assert.deepEqual(state.reads.map(item => item.control), ['input', 'lg-pbp', 'lg-pbp', 'input']);
  assert.deepEqual(state.waits, [1000, 1200]);
});

test('a transient PBP hotplug is retried without repeating the enabling write', async () => {
  const state = fixture({ pbp: [1, disconnected(), 5] });
  assert.equal((await state.service.switchInput(request)).status, 'verified');
  assert.deepEqual(state.writes.map(item => item.value), [5, 2]);
  assert.deepEqual(state.waits, [1000, 1000, 1200]);
});

test('unconfirmed PBP stops after three reads and restores the original state without switching input', async () => {
  const state = fixture({ pbp: [1, disconnected(), 1, disconnected()] });
  await assert.rejects(state.service.switchInput(request), /PBP werd niet actief/);
  assert.deepEqual(state.writes.map(item => item.value), [5, 1]);
  assert.deepEqual(state.waits, [1000, 1000, 1000]);
  assert.equal(state.reads.filter(item => item.control === 'lg-pbp').length, 4);
});

test('ambiguous identity, an unsupported model and an incorrect starting state reject before writes', async t => {
  const cases = [
    ['missing serial', { displays: [{ ...monitor, serial: '' }] }, /uniek serienummer/],
    ['duplicate serial', { displays: [monitor, { ...monitor, id: changedId }] }, /uniek serienummer/],
    ['wrong model', { displays: [{ ...monitor, model: 123 }] }, /alleen getest/],
    ['wrong manufacturer', { displays: [{ ...monitor, vendor: 123 }] }, /alleen getest/],
    ['wrong active input', { inputs: [17] }, /Begin op DisplayPort/],
    ['wrong PBP layout', { pbp: [3] }, /50\/50/],
  ];
  for (const [name, options, error] of cases) {
    await t.test(name, async () => {
      const state = fixture(options);
      await assert.rejects(state.service.switchInput(request), error);
      assert.deepEqual(state.writes, []);
    });
  }
});

test('a failed final write restores only the original serial, even with another monitor present', async () => {
  const state = fixture({
    displays: [monitor, { ...monitor, id: changedId, serial: 'OTHER-MONITOR' }],
    onWrite: value => { if (value === 2) throw disconnected(); },
  });
  await assert.rejects(state.service.switchInput(request), /Herstelopdracht/);
  assert.deepEqual(state.writes, [5, 2, 1].map(value => ({ target: `serial=${serial}`, value })));
});

test('disconnecting after the final write returns unverified and never writes a fallback', async () => {
  const state = fixture({
    inputs: [15, disconnected()],
    onWrite: (value, state) => {
      if (value === 2) state.displays = [{ ...monitor, id: changedId, serial: 'OTHER-MONITOR' }];
    },
  });
  const result = await state.service.switchInput(request);
  assert.equal(result.status, 'unverified');
  assert.equal(result.currentInput, null);
  assert.deepEqual(state.writes.map(item => item.value), [5, 2]);
  assert.equal(state.reads.at(-1).target, `serial=${serial}`);
  assert.equal(state.calls.length, 7, 'No further helper calls may follow the disconnected read');
});

test('an existing 50/50 layout skips enabling, while a confirmed unchanged input restores the previous state', async t => {
  await t.test('already enabled', async () => {
    const state = fixture({ pbp: [5] });
    assert.equal((await state.service.switchInput(request)).status, 'verified');
    assert.deepEqual(state.writes.map(item => item.value), [2]);
    assert.deepEqual(state.waits, [1200]);
  });
  await t.test('ignored final write', async () => {
    const state = fixture({ inputs: [15, 15] });
    const result = await state.service.switchInput(request);
    assert.equal(result.status, 'unchanged');
    assert.equal(result.currentInput, 15);
    assert.deepEqual(state.writes.map(item => item.value), [5, 2, 1]);
  });
});

test('Windows switches USB-C to DisplayPort by serial and requires the JSON value read contract', async t => {
  const windowsRequest = { ...request, input: 'displayport' };
  for (const origin of [16, 27]) {
    await t.test(`USB-C reported as ${origin}`, async () => {
      const state = fixture({ platform: 'win32', inputs: [origin, 15] });
      const result = await state.service.switchInput(windowsRequest);
      assert.equal(result.status, 'verified');
      assert.equal(result.currentInput, 15);
      assert.deepEqual(state.writes, [5, 2].map(value => ({ target: serial, value })));
    });
  }
  for (const invalid of ['15', '{}', '{"value":null}', '{"value":"27 garbage"}']) {
    await t.test(`reject invalid read ${invalid}`, async () => {
      const state = fixture({ platform: 'win32', readOutput: () => invalid });
      await assert.rejects(state.service.switchInput(windowsRequest), /geldige waarde/);
      assert.deepEqual(state.writes, []);
    });
  }
  for (const [platform, input] of [['darwin', 'displayport'], ['win32', 'usbc']]) {
    await t.test(`reject reverse direction on ${platform}`, async () => {
      const state = fixture({ platform });
      await assert.rejects(state.service.switchInput({ ...request, input }), /PBP-route op de Mac/);
      assert.deepEqual(state.calls, []);
    });
  }
});
