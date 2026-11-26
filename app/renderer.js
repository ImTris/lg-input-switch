'use strict';

const displaySelect = document.querySelector('#display');
const modeSelect = document.querySelector('#mode');
const usbCCodeSelect = document.querySelector('#usb-c-code');
const refreshButton = document.querySelector('#refresh');
const inputButtons = [...document.querySelectorAll('[data-input]')];
const status = document.querySelector('#status');
const inputNames = new Map([[15, 'DisplayPort'], [16, 'USB-C / DisplayPort 2'], [17, 'HDMI 1'], [18, 'HDMI 2'], [27, 'USB-C']]);
const inputKeys = new Map([[15, 'displayport'], [16, 'usbc'], [17, 'hdmi1'], [18, 'hdmi2'], [27, 'usbc']]);
const buttonCaptions = { hdmi1: 'Ingang 01', hdmi2: 'Ingang 02', displayport: 'Ingang DP', usbc: 'Ingang USB-C' };
let displays = [];
let selectedId = '';
let busy = false;
let platform = '';

function selectedDisplay() {
  return displays.find((display) => String(display.id) === selectedId);
}

function supportsPbp() {
  const display = selectedDisplay();
  return ['darwin', 'win32'].includes(platform) && /^7789\b/.test(String(display?.vendor))
    && /^40582\b/.test(String(display?.model)) && Boolean(String(display?.serial || '').trim());
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function restorePreferences() {
  let preferences;
  try {
    preferences = JSON.parse(localStorage.getItem(`lg-switch:${selectedId}`));
  } catch {
    // Missing or invalid preferences should not prevent monitor control.
  }
  const defaultMode = supportsPbp() ? 'pbp'
    : platform === 'darwin' && /\bLG\b/i.test(selectedDisplay()?.name || '') ? 'lg' : 'standard';
  modeSelect.value = preferences?.mode === 'pbp' && supportsPbp() ? 'pbp'
    : preferences?.mode === 'standard' ? 'standard'
    : preferences?.mode === 'lg' ? (platform === 'win32' ? 'standard' : 'lg') : defaultMode;
  usbCCodeSelect.value = preferences?.usbCCode === 210 ? '210' : '209';
}

function savePreferences() {
  if (!selectedDisplay()) return;
  try {
    localStorage.setItem(`lg-switch:${selectedId}`, JSON.stringify({ mode: modeSelect.value, usbCCode: Number(usbCCodeSelect.value) }));
  } catch {
    setStatus('De keuze is actief, maar kon niet worden opgeslagen.');
  }
  render();
}

function errorMessage(error, fallback) {
  return error.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback;
}

function render() {
  const display = selectedDisplay();
  displaySelect.disabled = busy || displays.length < 2;
  modeSelect.disabled = busy || !display;
  const pbpOption = modeSelect.querySelector('[value="pbp"]');
  const pbpTarget = platform === 'win32' ? 'displayport' : 'usbc';
  pbpOption.hidden = !supportsPbp();
  pbpOption.disabled = !supportsPbp();
  pbpOption.textContent = platform === 'win32' ? 'PBP (USB-C → DisplayPort)' : 'PBP (DisplayPort → USB-C)';
  usbCCodeSelect.disabled = busy || !display;
  document.querySelector('#usb-c-setting').hidden = modeSelect.value !== 'lg';
  document.querySelector('#mode-description').textContent = modeSelect.value === 'pbp'
    ? `${platform === 'win32' ? 'DisplayPort' : 'USB-C'} moet als tweede PBP-ingang ingesteld zijn. De monitor schakelt kort naar twee beelden.`
    : platform === 'win32'
      ? 'Windows gebruikt standaard DDC. LG alternatief is nog niet beschikbaar op Windows.'
    : modeSelect.value === 'lg'
      ? 'Voor LG-schermen die niet reageren op standaard DDC. Geen reactie op USB-C? Probeer variant B.'
      : 'Gebruik LG alternatief als je monitor niet reageert op standaard DDC.';
  refreshButton.disabled = busy;
  document.querySelector('main').setAttribute('aria-busy', String(busy));
  document.querySelector('#connection').classList.toggle('connected', Boolean(display));
  document.querySelector('#connection-label').textContent = display ? 'Verbonden' : busy ? 'Zoeken' : 'Niet verbonden';
  document.querySelector('#device-detail').textContent = display
    ? display.serial ? `Serienummer ${display.serial}` : 'Extern scherm'
    : 'Sluit je monitor aan en klik op vernieuwen.';
  const currentInput = display?.currentInput;
  document.querySelector('#current-input').textContent = currentInput == null
    ? 'Niet uitgelezen'
    : inputNames.get(currentInput) || `Ingang ${currentInput}`;
  document.querySelector('#brightness').textContent = display?.brightness == null ? '—' : `${display.brightness}%`;
  const warning = document.querySelector('#read-warning');
  warning.hidden = !display?.readError;
  warning.textContent = display?.readError || '';
  for (const button of inputButtons) {
    const current = inputKeys.get(currentInput) === button.dataset.input;
    button.disabled = busy || !display || (modeSelect.value === 'pbp' && button.dataset.input !== pbpTarget);
    button.classList.toggle('current', current);
    if (current) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    button.querySelector('.input-state').textContent = current ? 'Laatst actief' : buttonCaptions[button.dataset.input];
    button.setAttribute('aria-label', `Wissel naar ${button.querySelector('span').textContent}${current ? ', laatst gelezen ingang' : ''}`);
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  setStatus('Schermen worden uitgelezen…');
  render();
  try {
    const result = await window.monitor.list();
    platform = result.platform;
    modeSelect.querySelector('[value="lg"]').disabled = platform === 'win32';
    displays = result.displays;
    if (!displays.some((display) => String(display.id) === selectedId)) {
      selectedId = displays.length ? String(displays[0].id) : '';
    }
    displaySelect.replaceChildren(...displays.map((display) => new Option(display.name, String(display.id))));
    if (!displays.length) displaySelect.add(new Option('Geen monitor gevonden', ''));
    displaySelect.value = selectedId;
    restorePreferences();
    setStatus(result.note || (displays.length ? 'Klaar. Kies een ingang om te wisselen.' : 'Geen bedienbare monitor gevonden. Controleer de kabel en probeer opnieuw.'));
  } catch (error) {
    displays = [];
    selectedId = '';
    displaySelect.replaceChildren(new Option('Uitlezen niet gelukt', ''));
    setStatus(errorMessage(error, 'Het uitlezen is niet gelukt. Probeer opnieuw.'), 'error');
  } finally {
    busy = false;
    render();
  }
}

async function switchInput(input) {
  const display = selectedDisplay();
  if (busy || !display) return;
  busy = true;
  setStatus(modeSelect.value === 'pbp' ? 'Omschakelen via PBP…' : 'Wisselopdracht wordt verstuurd…');
  render();
  try {
    const result = await window.monitor.switchInput({ displayId: display.id, input, mode: modeSelect.value, usbCCode: Number(usbCCodeSelect.value) });
    display.currentInput = result.currentInput;
    setStatus(result.message, result.status === 'verified' ? 'success' : result.status === 'unchanged' ? 'error' : '');
  } catch (error) {
    setStatus(errorMessage(error, 'Wisselen is niet gelukt. Probeer opnieuw.'), 'error');
  } finally {
    busy = false;
    render();
  }
}

displaySelect.addEventListener('change', () => {
  selectedId = displaySelect.value;
  restorePreferences();
  setStatus('Klaar. Kies een ingang om te wisselen.');
  render();
});
refreshButton.addEventListener('click', refresh);
modeSelect.addEventListener('change', savePreferences);
usbCCodeSelect.addEventListener('change', savePreferences);
for (const button of inputButtons) button.addEventListener('click', () => switchInput(button.dataset.input));
refresh();
