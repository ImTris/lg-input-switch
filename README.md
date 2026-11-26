# LG Input Switch

Een kleine desktop-app met knoppen voor HDMI 1, HDMI 2, DisplayPort en USB-C.
De interface draait met Electron op macOS en Windows. Geen server, account of
netwerkverbinding nodig tijdens gebruik.

## Starten op je Mac

Open `dist/LG Input Switch-darwin-arm64/LG Input Switch.app`. Je kunt de app ook
naar je map Programma’s slepen. De gebouwde app bevat alle benodigde software;
Node.js is alleen nodig voor ontwikkeling.

De app leest het aangesloten scherm bij het openen. Via het vernieuw-icoon lees
je de monitor opnieuw uit. Er wordt alleen geschakeld als je op een ingang klikt.

## Wisselen tussen jouw Mac en Windows via PBP

Voor jouw LG 49WQ95C-W gebruikt de app tijdelijk PBP (twee beelden naast elkaar)
en maakt daarna het tweede beeld schermvullend. De Mac hangt aan DisplayPort,
de Windows-laptop aan USB-C. **Deze route is op de Mac fysiek bevestigd. De
omgekeerde route vanuit Windows is ingebouwd, maar nog niet op de laptop getest.**

1. Zorg dat beide computers aanstaan en beeld geven.
2. Stel via de joystick onder **Instellingen → Ingang → PBP/PIP** de gewenste
   tweede ingang in: op de Mac is dat USB-C; vanuit Windows is dat DisplayPort.
   Controleer dat beide beelden verschijnen. Je kunt daarna PBP weer uitschakelen
   met behoud van het hoofdbeeld.
3. Kies in de app onder **Geavanceerd → Bediening** de PBP-methode. Op een nieuwe
   installatie is dit de standaard voor dit model. Een eerder opgeslagen keuze
   blijft behouden; verander die dan eenmalig naar PBP.
4. Klik op de Mac op **USB-C**, of op Windows op **DisplayPort**. De monitor toont
   kort twee beelden en schakelt vervolgens naar de andere computer.

De app stelt de tweede PBP-ingang niet zelf in. Als de monitor die keuze niet
onthoudt na het wisselen, moet je hem via de joystick opnieuw instellen. Gebruik
ook de joystick als een wissel niet lukt. Nadat USB-C schermvullend wordt, valt de
DDC-verbinding met de Mac weg: terugschakelen moet dus vanaf de actieve
Windows-computer of via de joystick. De app op beide computers hoeft niet via
het netwerk verbonden te zijn.

Tijdens de overgang zoekt de app dezelfde monitor opnieuw op serienummer. Een
ontbrekend of dubbel serienummer blokkeert deze route. Groen betekent dat de
gewenste ingang is teruggelezen. Als de verbinding wegvalt, meldt de app dat de
opdracht is verstuurd maar het resultaat niet gecontroleerd kon worden.

De bestaande methoden **Standaard DDC** en **LG alternatief** blijven beschikbaar
voor andere schermen en HDMI-ingangen. Ze werkten bij jouw geteste aansluiting
niet voor het omschakelen naar USB-C.

## Starten op Windows

Kopieer `dist/LG-Input-Switch-Windows-x64.zip` naar de Windows-laptop, pak de
**hele ZIP** uit en open `LG Input Switch.exe` in de uitgepakte map. Laat de
bijbehorende bestanden en mappen bij de executable staan. Node.js is niet nodig;
de app gebruikt de ingebouwde Windows PowerShell en monitor-API.

Kies de LG-monitor en de PBP-methode, met DisplayPort als tweede PBP-ingang.
Gebruik bij meerdere schermen **Uitbreiden**; gedupliceerde schermgroepen waarbij
Windows geen unieke monitor kan aanwijzen worden geweigerd.
De Windows-build is niet ondertekend en is nog niet op echte Windows-hardware
getest; de code en schakelvolgorde zijn lokaal met synthetische antwoorden getest.

## Gecontroleerd op jouw scherm

Op 26 november 2026 is de LG 49WQ95C-W (door macOS gerapporteerd als
`LG ULTRAWIDE`, vendor `0x1e6d`, product `0x9e86`) succesvol uitgelezen op een
Apple M1 Max: huidige ingang **15 / DisplayPort**, helderheid **100**.
Het model heeft [twee HDMI-poorten, DisplayPort en USB-C](https://www.lg.com/nl/monitoren/ultrawide-monitoren/49wq95c-w/).
De schakelopdrachten zijn inmiddels getest: standaard-DDC met waarden 17 (HDMI 1)
en 16 (DisplayPort 2 / mogelijke USB-C) en LG-alternatief met waarden 209 en 210
wijzigden de ingang niet. De monitor bleef ingang 15 melden. De Windows-laptop
geeft volgens de gebruiker wel beeld via USB-C bij handmatig omschakelen.
Na handmatig omschakelen naar USB-C verdwijnt de DDC-verbinding met de Mac.
Een vergelijkbaar probleem met dit model is
[eerder gemeld bij ddcutil](https://github.com/rockowitz/ddcutil/issues/100#issuecomment-1348662143).
Een afzonderlijke schrijfcontrole wijzigde de helderheid succesvol van 100 naar
99 (tweemaal teruggelezen) en herstelde deze naar 100. DDC-schrijfverkeer werkt
dus in het algemeen; het waargenomen probleem zit specifiek in ingangswisselen.
Daarna is de PBP-route succesvol getest: PBP naar alleen Mac, opnieuw PBP,
en vervolgens alleen Windows. De gebruiker bevestigde de zichtbare overgang.
Hiervoor gebruikt de Mac-helper VCP `0xD7` met bronadres `0x51`: waarde `5`
activeert PBP, `1` behoudt alleen het hoofdbeeld en `2` maakt het tweede beeld
schermvullend. Dit bouwt voort op een
[melding bij ddcutil](https://github.com/rockowitz/ddcutil/issues/100#issuecomment-7070881098).
De app controleert dat PBP actief is voordat hij de tweede stap verstuurt en
probeert bij een fout de vorige PBP-stand te herstellen.

## Platformondersteuning

- **Mac:** Apple Silicon (M1 en nieuwer), met de meegeleverde m1ddc-helper.
  Intel Macs zijn nog niet ondersteund. Kabel, adapter en monitor moeten DDC/CI
  doorgeven. De build is lokaal ad-hoc ondertekend, niet genotariseerd voor distributie.
- **Windows x64:** dezelfde interface; native Windows-DDC via PowerShell en DXVA2,
  inclusief PBP via VCP `0xD7` op het standaard bronadres.
  De helper is op syntax en compilatie gecontroleerd, maar nog niet op een
  Windows-computer of monitor getest. De LG-alternatieve methode gebruikt een
  afwijkend I²C-bronadres dat de standaard Windows-API niet aanbiedt. Daarvoor
  is nog GPU-specifieke ondersteuning nodig. De PBP-route gebruikt die
  alternatieve methode niet.

## Ontwikkelen en bouwen

Node.js 22.12 of nieuwer, npm; op Mac ook Xcode Command Line Tools (`clang`, `make`).

```sh
npm ci
npm start
npm test
npm run diagnose
npm run package
npm run package:win
```

`diagnose` leest alleen schermgegevens. `test` gebruikt synthetische schermantwoorden
en verstuurt geen hardwarecommando’s. `package` bouwt op Mac voor Apple Silicon
en op Windows voor x64. `package:win` bouwt een Windows x64-map, ook vanaf de Mac.
De uitvoer staat in `dist/LG Input Switch-darwin-arm64/` of
`dist/LG Input Switch-win32-x64/`. Zip voor overdracht de volledige Windows-map.
De eerste build heeft internet nodig om Electron te downloaden.

De UI staat in `app/`, de platformkoppeling in `app/monitor.js` en de native helpers
in `native/`. Processen worden zonder shell gestart, met een timeout. De renderer
heeft geen Node-toegang; IPC accepteert alleen toegestane ingangen en een opnieuw
gevonden monitor-ID. Er is geen automatische omschakeling bij starten/vernieuwen.

## Herkomst native Mac-helper

[m1ddc](https://github.com/waydabber/m1ddc), MIT, vastgepind op commit
`9d75fb6c407ac60dc77a9e32c43d60fd0e6d1612`. Broncode en licentie staan onder
`vendor/m1ddc`; de licentie wordt meegeleverd in `native/LICENSE-m1ddc.txt`.
Lokale wijziging: in `sources/i2c.m` lezen `maxValue` en `curValue` elk twee bytes
met `sizeof(maxValue)` / `sizeof(curValue)` in plaats van `sizeof(2)` (vier bytes).
Ook toegevoegd: `lg-pbp` met alleen schrijfwaarden 1, 2 en 5, en weigeren van
dubbele serienummers. Native regressietests controleren de pakketvalidatie,
het decoderen en de LG-PBP-commando’s.

Meer informatie over de [afwijkende LG-ingangscommando’s](https://github.com/rockowitz/ddcutil/wiki/Switching-input-source-on-LG-monitors)
en de [Windows SetVCPFeature-API](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-setvcpfeature).
Dit project is niet verbonden aan LG.
