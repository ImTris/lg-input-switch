'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');

const execute = promisify(execFile);
const INPUTS = Object.freeze({
  hdmi1: { label: 'HDMI 1', standard: 17, lg: 144 },
  hdmi2: { label: 'HDMI 2', standard: 18, lg: 145 },
  displayport: { label: 'DisplayPort', standard: 15, lg: 208 },
  usbc: { label: 'USB-C', standard: 27, lg: 209 },
});

function parseDisplays(output) {
  const displays = [];
  let display;
  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/^\[\d+\] (.+) \(([0-9a-f-]{36})\)$/i);
    if (heading) {
      display = { id: heading[2], name: heading[1] };
      displays.push(display);
    } else if (display) {
      const property = line.match(/^ - (AN Serial|Manufacturer|Vendor|Model):\s+(.*)$/);
      if (property) {
        const key = { 'AN Serial': 'serial', Manufacturer: 'manufacturer', Vendor: 'vendor', Model: 'model' }[property[1]];
        display[key] = property[2].trim();
      }
    }
  }
  // Ambiguous identities must never select an arbitrary physical screen.
  if (new Set(displays.map(item => item.id)).size !== displays.length) {
    throw new Error('Schermen hebben dezelfde identificatie. Sluit één scherm aan en probeer opnieuw.');
  }
  if (output.trim() && !displays.length && output.trim() !== 'No external display found, aborting') {
    throw new Error('De schermlijst kon niet worden gelezen.');
  }
  return displays;
}

function parseValue(output) {
  if (!/^\d+$/.test(output.trim())) throw new Error('De monitor gaf geen geldige waarde terug.');
  const value = Number(output.trim());
  if (!Number.isInteger(value) || value > 65535) throw new Error('Ongeldige monitorwaarde.');
  return value;
}

function inputCommand(request) {
  if (!request || typeof request.displayId !== 'string' || !request.displayId || request.displayId.length > 512) {
    throw new Error('Selecteer eerst een monitor.');
  }
  if (!Object.hasOwn(INPUTS, request.input)) throw new Error('Onbekende ingang.');
  if (!['standard', 'lg', 'pbp'].includes(request.mode)) throw new Error('Onbekende schakelmethode.');
  if (request.mode === 'pbp') {
    if (!['usbc', 'displayport'].includes(request.input)) throw new Error('De PBP-route ondersteunt alleen DisplayPort en USB-C.');
    return { control: 'lg-pbp', value: 2, label: INPUTS[request.input].label };
  }
  let value = INPUTS[request.input][request.mode];
  if (request.mode === 'lg' && request.input === 'usbc') {
    value = request.usbCCode ?? 209;
    if (![209, 210].includes(value)) throw new Error('Ongeldige LG USB-C-code.');
  }
  return { control: request.mode === 'lg' ? 'input-alt' : 'input', value, label: INPUTS[request.input].label };
}

function createMonitorService({ platform = process.platform, arch = process.arch,
  nativeDir = path.resolve(__dirname, '../native').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), run = execute, wait = delay } = {}) {
  async function command(file, args) {
    try {
      const result = await run(file, args, { timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
      return result.stdout.trim();
    } catch (error) {
      if (error.killed) throw new Error('De monitor reageert niet op tijd. Controleer de kabel en probeer opnieuw.');
      if (error.code === 'ENOENT') throw new Error('De schermhelper ontbreekt. Bouw de app opnieuw met npm run build:native.');
      const detail = [error.stdout, error.stderr].filter(Boolean).join(' ').trim().slice(0, 500);
      throw new Error(detail || 'De monitor kon niet worden bereikt. Controleer de verbinding en DDC/CI-instelling.');
    }
  }
  function mac(args) {
    if (arch !== 'arm64') throw new Error('Deze Mac-versie ondersteunt Apple Silicon (M1 of nieuwer).');
    return command(path.join(nativeDir, 'm1ddc'), args);
  }
  function windows(args) {
    return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(nativeDir, 'windows-ddc.ps1'), ...args]);
  }
  async function discover() {
    if (platform === 'darwin') {
      try { return parseDisplays(await mac(['display', 'list', 'detailed'])); }
      catch (error) {
        if (error.message === 'No external display found, aborting') return [];
        throw error;
      }
    }
    if (platform === 'win32') {
      const result = JSON.parse(await windows(['-Action', 'list']));
      return Array.isArray(result) ? result : result ? [result] : [];
    }
    throw new Error('Deze app ondersteunt macOS en Windows.');
  }
  async function list() {
    const displays = await discover();
    if (platform === 'darwin') {
      // DDC requests share a hardware bus: send reads one at a time.
      for (const display of displays) {
        const errors = [];
        for (const [property, control] of [['currentInput', 'input'], ['brightness', 'luminance']]) {
          try { display[property] = parseValue(await mac(['--read-wait', '80', 'display', display.id, 'get', control])); }
          catch (error) { display[property] = null; errors.push(`${property === 'currentInput' ? 'Ingang' : 'Helderheid'}: ${error.message}`); }
        }
        if (errors.length) display.readError = errors.join(' ');
      }
    }
    return { displays, platform, mode: platform === 'darwin' && displays.some(item => /\bLG\b/i.test(item.name)) ? 'lg' : 'standard',
      note: platform === 'win32' ? 'De Windows-versie is nog niet op jouw laptop getest. Controleer bij PBP of DisplayPort als tweede ingang is ingesteld.' : undefined };
  }
  async function switchViaPbp(display, displays, input) {
    if (parseInt(display.vendor, 10) !== 7789 || parseInt(display.model, 10) !== 40582) {
      throw new Error('Deze PBP-route is alleen getest voor de LG 49WQ95C-W.');
    }
    const serial = display.serial;
    if (!serial || serial === '(null)' || displays.filter(item => item.serial === serial).length !== 1) {
      throw new Error('PBP vereist een monitor met een uniek serienummer.');
    }
    // PBP changes the display's EDID and can change its UUID. The native helper
    // resolves this serial afresh for every command and rejects ambiguous matches.
    const selector = `serial=${serial}`;
    const label = INPUTS[input].label;
    const origin = platform === 'darwin' ? 'DisplayPort' : 'USB-C';
    const read = async control => {
      if (platform === 'darwin') return parseValue(await mac(['--read-wait', '100', 'display', selector, 'get', control]));
      const result = JSON.parse(await windows(['-Action', control === 'input' ? 'read-input' : 'read-pbp', '-Serial', serial]));
      return parseValue(String(result.value));
    };
    const write = value => platform === 'darwin'
      ? mac(['display', selector, 'set', 'lg-pbp', String(value)])
      : windows(['-Action', 'set-pbp', '-Serial', serial, '-Value', String(value)]);
    const initialInput = await read('input');
    const allowedOrigin = platform === 'darwin' ? [15] : [16, 27];
    if (!allowedOrigin.includes(initialInput)) throw new Error(`Begin op ${origin}, met ${label} als tweede PBP-ingang in het monitormenu.`);
    const initialPbp = await read('lg-pbp');
    if (![1, 5].includes(initialPbp)) throw new Error(`Zet PBP uit of kies de 50/50-indeling met ${label} als tweede ingang.`);

    async function restore() {
      try { await write(initialPbp); return true; } catch { return false; }
    }
    try {
      if (initialPbp !== 5) {
        await write(5);
        let enabled = false;
        // Reconnect after the PBP hotplug, with bounded reads and no repeat writes.
        for (let attempt = 0; attempt < 3; attempt++) {
          await wait(1000);
          try { if (await read('lg-pbp') === 5) { enabled = true; break; } } catch { /* transient hotplug */ }
        }
        if (!enabled) throw new Error(`PBP werd niet actief. Stel ${origin} en ${label} eerst als PBP-ingangen in via de joystick.`);
      }
      await write(2);
    } catch (error) {
      const restored = await restore();
      throw new Error(`${error.message} ${restored ? 'Herstelopdracht voor de vorige PBP-stand verstuurd.' : `Herstellen lukte niet; gebruik de joystick om ${origin} te kiezen.`}`);
    }

    await wait(1200);
    let currentInput = null;
    try { currentInput = await read('input'); } catch { /* Switching away can disconnect the current computer's DDC link. */ }
    if (currentInput === null) {
      return { status: 'unverified', currentInput, message: `PBP-wisselopdracht naar ${label} verstuurd. Deze computer kan de ingang niet meer uitlezen. Controleer het beeld; via de joystick kun je terug.` };
    }
    const expected = input === 'usbc' ? [16, 27] : [15];
    if (expected.includes(currentInput)) {
      return { status: 'verified', currentInput, message: `De monitor meldt ${label} als actieve ingang.` };
    }
    await restore();
    return { status: 'unchanged', currentInput, message: `De monitor bevestigt ${label} niet. Herstel van de vorige PBP-stand is geprobeerd; controleer de tweede PBP-ingang via de joystick.` };
  }
  async function switchInput(request) {
    const { control, value, label } = inputCommand(request);
    if (request.mode === 'pbp' && !((platform === 'darwin' && request.input === 'usbc') || (platform === 'win32' && request.input === 'displayport'))) {
      throw new Error('Gebruik de PBP-route op de Mac naar USB-C, en op Windows naar DisplayPort.');
    }
    if (platform === 'win32' && request.mode === 'lg') {
      throw new Error('LG-alternatief vereist op Windows een GPU-specifieke koppeling; die is nog niet ingebouwd.');
    }
    // Resolve again immediately before a write; never fall back to display 1.
    const displays = await discover();
    const display = displays.find(item => item.id === request.displayId);
    if (!display) throw new Error('Deze monitor is niet meer verbonden. Klik op Vernieuwen.');
    if (request.mode === 'pbp') return switchViaPbp(display, displays, request.input);
    if (platform === 'darwin') await mac(['display', request.displayId, 'set', control, String(value)]);
    else await windows(['-Action', 'set', '-DisplayId', request.displayId, '-Value', String(value)]);

    // Sending a write does not prove that the monitor accepted it. Read only
    // the original target after allowing time for its input to settle.
    let currentInput = null;
    try {
      await wait(1200);
      if (platform === 'darwin') {
        currentInput = parseValue(await mac(['--read-wait', '80', 'display', request.displayId, 'get', 'input']));
      } else {
        const target = (await discover()).find(item => item.id === request.displayId);
        if (Number.isInteger(target?.currentInput) && target.currentInput >= 0 && target.currentInput <= 65535) {
          currentInput = target.currentInput;
        }
      }
    } catch {
      // Switching away can disconnect the DDC link. That is unknown, not failure
      // or success, and must never trigger another write to a different screen.
    }
    if (currentInput === null) {
      return { status: 'unverified', currentInput, message: `Opdracht voor ${label} verstuurd; de actieve ingang is niet uit te lezen. Controleer het beeld op je monitor.` };
    }
    const expected = request.input === 'usbc' ? [16, 27] : [INPUTS[request.input].standard];
    if (expected.includes(currentInput)) {
      return { status: 'verified', currentInput, message: `De monitor meldt ${label} als actieve ingang.` };
    }
    const currentLabel = { 15: 'DisplayPort', 16: 'DisplayPort 2 / USB-C', 17: 'HDMI 1', 18: 'HDMI 2', 27: 'USB-C' }[currentInput] || `ingang ${currentInput}`;
    return { status: 'unchanged', currentInput, message: `De monitor meldt nog ${currentLabel}. Wisselen naar ${label} is niet bevestigd.` };
  }
  return { list, switchInput };
}

module.exports = { createMonitorService, parseDisplays, parseValue, inputCommand };
