# Halloween-Erinnerungen im Twitch-Chat

Die Erinnerung ist Teil des vorhandenen `CommunityTips`-Plans. Es gibt keinen zusätzlichen Timer. Sie kann nur eingeplant werden, wenn Community-Tipps aktiviert sind, das tatsächliche Event `halloween` läuft und dessen Befehl `!trickortreat` verfügbar ist. Der Streamstatus wird weiterhin vor dem Versand live über Twitch geprüft. Reale, unterschiedliche Chatbeiträge und ein freier Spiel-/Nachrichtenstatus bleiben Voraussetzung.

## Häufigkeit und Schutz

- **Normal:** frühestens 45 Minuten nach der letzten Halloween-Erinnerung.
- **Häufiger (Vorgabe):** frühestens 30 Minuten danach.
- Zusätzliche Mindestpause: 20 Minuten.
- Höchstens zwei Halloween-Erinnerungen innerhalb einer rollierenden Stunde.
- Das Chatprofil, mindestens 5/6/8 unterschiedliche Chatbeiträge, die globale Grenze von vier automatischen Meldungen pro Stunde, fünf Minuten Abstand, ChatResponsePolicy, Sendewarteschlange und Spielpausen gelten weiter. Diese können den Versand verschieben oder unterdrücken.
- Der Sondertipp erhält bei Fälligkeit eine höhere Auswahlchance, andere verfügbare Community-Tipps bleiben aber auswählbar.
- Die Zustände für letzte Erinnerung, Stundenlimit und nächste Textvariante bleiben über Neustarts erhalten. `!trickortreat` und `!pumpkins` verschieben eine unmittelbar folgende Erinnerung.

## Nachrichten

Fünf kurze Vorschautexte nutzen ausschließlich die implementierten Befehle `!trickortreat` und `!pumpkins`. Die Texte versprechen keine Gewinne. Nachrichten rotieren nach einem reservierten Sendeversuch.

## Einstellungen

Unter **Einstellungen → Chat & Nachrichten → Community-Tipps → 🎃 Halloween-Event bewerben** lassen sich Erinnerung und Häufigkeit konfigurieren. Die Vorgabe „Häufiger“ wird nur als Standardwert verwendet, wenn noch keine Einstellung gespeichert wurde; vorhandene Werte bleiben erhalten. Vorschau, letzter Zeitpunkt und Eventstatus werden angezeigt.

## Verifikation

- `npm run check`: TypeScript-Build und 151 Tests bestanden.
- `npm run test:browser`: 2 Browser-Tests bestanden; Einstellungsansicht, fünf Vorschauen und Speichern der Halloween-Option geprüft.
- Screenshot: `docs/screenshots/2026-10-14/acy-dashboard-halloween-reminders.png`.
- Keine produktiven Einstellungen, Daten, Twitch-Nachrichten oder Dienste wurden verändert.
