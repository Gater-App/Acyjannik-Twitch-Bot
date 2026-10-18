# Lokaler Entwicklungs- und Prüfprozess

## Laufzeit

- Verwende Node.js 24 (Production läuft mit Node.js 24.21.0) und die im `package-lock.json` festgelegten npm-Abhängigkeiten.
- Abhängigkeiten reproduzierbar mit `npm ci` installieren.

## Pflichtprüfungen vor einem Commit oder Review

1. `npm run check` führt TypeScript-Build und vollständige Unit-/Integrationstests aus.
2. `npm run test:browser` führt die Browser-Regressionstests für Dashboard und Community-Portal aus. Falls Playwright Chromium lokal noch fehlt: `npx playwright install chromium`.
3. `git diff --check` muss sauber sein.

Führe zeitabhängige und zufällige Tests nur mit den vorhandenen kontrollierten Uhren, Fixtures und Zufallsquellen aus. Lege Browser-Artefakte in ein temporäres Verzeichnis außerhalb gemeinsam genutzter Arbeitskopien.

## Sicherheitsgrenzen

- GitHub Actions sind für dieses Repository deaktiviert. Starte keine Actions-Workflows; lokale Prüfungen sind der vorgesehene Standard.
- Verwende für normale Tests ausschließlich Mocks, isolierte SQLite-Fixtures und Test-Credentials. Lies oder kopiere keine Production-Secrets in lokale Testumgebungen.
- Tests dürfen keine echten Twitch-/Discord-Nachrichten, Community-Belohnungen, Datenbankmigrationen oder Slash-Command-Registrierungen in Production auslösen.
- Oracle-Deployment, PM2-Neustarts und produktive Migrationen benötigen einen ausdrücklichen Betreiberauftrag.
