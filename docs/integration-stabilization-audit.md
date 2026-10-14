# ACY Twitch Bot – Integrations- und Stabilisierungsaudit

Stand: 15.10.2026 · lokaler Testlauf · keine Produktionszugriffe

## Git-Bestand

- Checkout: `feature/halloween-haunted-house`
- HEAD: `39a5f0ccb304fbe44e2853d18285f57d204c0fab` (`origin/main`)
- Vorhandene lokale Commits wurden nicht verändert.
- Arbeitsbaum: 44 versionierte Dateien geändert; 36 unversionierte Dateien sichtbar mit `git status -uall` (darunter 18 gespeicherte Screenshots in `artifacts/`). Der normale `git status --short` fasst unversionierte Verzeichnisse zu 20 Einträgen zusammen.
- Es wurden keine Konfliktmarker, unmerged Pfade oder separaten Migration-SQL-Dateien gefunden. Die SQLite-Migrationen liegen sequenziell in `src/feature-store.ts`.
- Keine Änderungen verworfen, gestasht, gestaged, committed oder gepusht. Ein zusätzlicher Worktree/Branch wurde nicht angelegt, weil die Arbeit an mehreren gemeinsamen Dateien hängt und ein neuer Branch uncommittete Änderungen nicht isoliert hätte.

## Feature-Matrix

| Bereich | Status | Nachweis / Grenze |
|---|---|---|
| Halloween-Event und Spukhaus | PASSED lokal | Aktivitäts-, Saison-, Punkte- und Persistenztests; Desktop-/Mobil-Browserlauf. Produktive Eventkonfiguration wurde nicht gelesen. |
| VIP Experience | PARTIALLY PASSED | Serverseitige VIP-Abfrage, Lounge, Elio-Aktion, Chaos-Anfrage, Quest-Integration, Abzeichen und Moderatorfreigabe lokal mit Twitch-Mocks und Browser getestet. Echte Broadcaster-Autorisierung und Staging-Twitch-API fehlen. Funktionen bleiben standardmäßig aus. |
| Live Control | PARTIALLY PASSED | Geschützte Seite und bestehende Aktionen für Spiele, Quest, Drop, Rad, Tresor und Saison-Events sind im Code verdrahtet. Kein dedizierter Browser-E2E-Lauf für `/dashboard/live`; Streamtitel/-kategorie bearbeiten ist nicht vorhanden. |
| Magic 8-Ball | PARTIALLY PASSED | Auswahl, Kategorien, Verteilung, Cooldowns und Persistenz unit-getestet; Dashboard-Skript eingebunden. Kein eigener Browserklick-Test des Einstellungsformulars. |
| Live-Abstimmungen und Quest-Abstimmungen | PARTIALLY PASSED | Persistente Stimmen, Rollen, Status und Portalabstimmung getestet; Ideenabstimmung enthält Browserklicks. Allgemeine Live-Abstimmung noch nicht als kompletter Browserablauf abgedeckt. |
| Erinnerungswand | PARTIALLY PASSED | Portal-Einreichung, Moderation über API, Veröffentlichung, Reaktion, Löschung und mobile Portalansicht getestet. Moderationsseite selbst nicht per Browserklick getestet. |
| Community-Ideenkasten | PASSED lokal | `!idee`, Portal, Freigabe, Status, Likes und vorhandene Poll-Engine; Portal- und Dashboard-Browserablauf vorhanden. |
| Imposter | PARTIALLY PASSED | OAuth, geheime Rollen, Chat-/Portalteilnahme, Abstimmung, Ergebnis und XP sind getestet. Das gewünschte Wort-/Begriffsspiel (Hinweiswörter pro Spieler) existiert nicht: derzeit ist es ein geheimes Regelspiel. |
| Chaos Wheel | PASSED lokal | Nur ausführbare Segmente, aktive Zuschauer, idempotente XP, Streamlimits und OBS-Gewinneranzeige getestet; Browserlauf prüft Gewinnerposition. Kein Live-OBS/Twitch-Einsatz. |
| Elio | PASSED lokal | Aktionen, Cooldowns, Zustandswerte, Stimmung, private Portalhistorie, Neustart und Migration getestet; Elio-Aktion in Browser getestet. |
| Community-Tresor | PASSED lokal | Codebewertung, Parallelität, Ende, Cooldown, sichere öffentliche Daten, Dashboardstart und Portal-/OBS-Darstellung getestet. |
| Songwünsche | PARTIALLY PASSED | OAuth-State, idempotente Kanalpunkteverarbeitung, Spotify-Schreibpfad mit Mocks, Einstellungen und Preis-Migration getestet. Keine echten Twitch-/Spotify-Zugangsdaten oder Playlist-Aktion verwendet. |
| Community-Welt / Missionen | PASSED lokal | Fortschritt, Perioden, Berlin-Mitternacht, einmalige Belohnungen und Desktop-/Mobil-Portal getestet. |
| Automatische Nachrichten / Community-Tipps | PASSED lokal | Scheduler-, Aktivitäts-, Cooldown-, Stundenlimit-, Deduplizierungs- und Neustartfälle in Unit-Tests. Kein Live-Chatversand. |

`PASSED` bedeutet hier ausschließlich, dass die lokalen Implementierungen und genannten Tests durchliefen. Es ist keine Aussage über echte Produktionscredentials, Live-Verfügbarkeit oder Deployment.

## Arbeitsbaum nach Bereichen

### Versionierte, geänderte Dateien

- **Chat, Befehle und Hilfe:** `src/chat.ts`, `src/chat.test.ts`, `src/command-handler.ts`, `src/command-handler.test.ts`, `src/help.ts`, `src/help.test.ts`, `src/public-help.ts`, `COMMANDS.md`, `README.md`.
- **Elio, Chaos Wheel, Tresor, saisonale Aktivität:** `src/community-arcade.ts`, `src/community-arcade.test.ts`, `src/community-vault.ts`, `src/community-features.ts`, `src/community-features.test.ts`, `src/community-world.ts`, `src/community-tips.ts`, `src/community-tips.test.ts`, `src/feature-store.ts`.
- **Portal, Dashboard, Rollen und OBS:** `src/community-portal.ts`, `src/community-portal.test.ts`, `src/dashboard.ts`, `src/dashboard.test.ts`, `src/dashboard-community-ui.ts`, `src/dashboard-community-ui.test.ts`, `src/dashboard-ux.ts`, `src/moderator-pranks.ts`, `src/moderator-pranks-ui.ts`, `browser-tests/dashboard.browser.test.ts`, `browser-tests/community-world.browser.test.ts`.
- **Spiele, Abstimmungen und Saisonregressionen:** `src/mini-games.ts`, `src/mini-games.test.ts`, `src/mini-games-dashboard.test.ts`, `src/quest-poll.test.ts`, `src/twitch-api.ts`, `src/twitch-api-live-status.test.ts`.
- **Konfiguration / Integration:** `src/config.ts`, `src/types.ts`, `src/test-config.ts`, `src/main.ts`, `.env.example`, `src/channel-points-ui.ts`, `src/conversation-spark-ui.ts`, `src/eight-ball-answers.ts`.

### Neue, unversionierte Arbeitsdateien

- **VIP:** `src/twitch-vip.ts`, `src/twitch-vip.test.ts`, `src/vip-experience.ts`, `src/vip-experience.test.ts`, `src/vip-experience-ui.ts`, `browser-tests/vip.browser.test.ts`, `docs/vip-experience.md`, vier lokale VIP-Screenshots unter `docs/verification/`.
- **Erinnerungen / Ideen / Saisonhaus:** `src/community-memories.ts`, `src/community-memories.test.ts`, `src/community-ideas.ts`, `src/community-haunted-house.ts`, `src/community-haunted-house.test.ts`.
- **Dashboard:** `src/live-control.ts`, `src/eight-ball-ui.ts`.
- **Visuelle Nachweise:** 18 Screenshots in `artifacts/elio-personality/` und `artifacts/haunted-house/`, plus `docs/verification/chaos-wheel-3.png`.

Diese Gruppen überschneiden sich in `src/dashboard.ts`, `src/main.ts`, `src/feature-store.ts`, `src/community-portal.ts` und `src/community-arcade.ts`. Deshalb sind die Dateigruppen keine konfliktfreien Commit-Chunks.

## SQLite-Migrationen

`schema_migrations` läuft im Code sequenziell von Version **1 bis 32**. Es gibt keine separaten `.sql`-Dateien. Die neuen relevanten Stufen sind:

| Version | Änderung | Prüfergebnis |
|---:|---|---|
| 17 | Alte manuelle Wheel-Felder deaktivieren und laufende manuelle Spins sicher beenden | Isolierter Migrationstest bestanden; Datensätze bleiben erhalten. |
| 28 | Elio-Ereignishistorie | Migrationsfixture korrigiert; Elio-Zustand und Interaktionen bleiben erhalten. |
| 29 | Erinnerungen und Reaktionen | Zusätzlicher isolierter v28→v29-Test prüft Tabellen, Versionszeile und Vorab-Backup. |
| 30 | Community-Ideen und Likes | Vollständige Portal-, Speicher- und Abstimmungstests bestanden. |
| 31 | Aktive Chatidentitäten und Wheel-Gewinnerdaten | Expliziter isolierter v30→v31-Upgrade-Test prüft Backup, neue Tabellen/Spalten, erhaltene laufende Runde und standardmäßig deaktivierte Segmente. |
| 32 | VIP-Anfragen, Achievements, Challenges und Elio-Interaktionen | VIP-Backend- und Browsertests bestanden. |

Alle Migrationsprüfungen verwendeten temporäre lokale SQLite-Dateien. Keine Production-Datenbank wurde geöffnet oder verändert.

## Ursachen und Korrekturen

Die drei zuvor gemeldeten Fehler hatten eine gemeinsame Ursache in den **Testfixtures**, nicht in den erwarteten Endwerten:

1. Elio-Ereignismigration löschte nur Versionszeile 28, ließ aber 29–32 stehen. Weil der Migrationsrunner anhand der höchsten Version sequenziell arbeitet, wurde Migration 28 beim erneuten Öffnen übersprungen; die fehlende Tabelle führte zum `SQLITE_ERROR`.
2. Der Elio-Standardnamen-Test entfernte nur Versionen 13–26, ließ jedoch spätere Versionen stehen. Dadurch wurde Migration 13 nicht ausgeführt und `Fünkchen` blieb bestehen.
3. Der Songpreis-Test entfernte nur Versionen 19–26 und ließ spätere Versionen stehen. Migration 19 lief deshalb nicht; der alte Wert 500 blieb erhalten.

Die Fixtures entfernen nun jeweils die Versionszeile der Zielmigration **und alle späteren Versionszeilen**, sodass sie einen kohärenten älteren Datenbankstand simulieren. Produktions-Migrationslogik und Erwartungen wurden nicht geändert.

Weitere geprüfte Punkte:

- Chaos-Wheel-Migration 17: Test besteht, alte Datensätze bleiben erhalten und werden sicher deaktiviert/abgebrochen.
- Erinnerungswand v29: neuer Upgrade-Test besteht.
- Community-Tresor: alle fünf Backendtests bestehen; Browserregression deckt den Dashboardstart und geschützte Statusdaten ab.
- Elio-Prank-Texterwartung: im aktuellen Testlauf kein Fehler; Verteidigungstexte und Punkteunverändertheit bestehen.

## Tests

- `npm run build`: bestanden.
- `npm test`: **192/192 bestanden**.
- Gezielte Migration-/Integrationsgruppe (Elio, Wheel, Erinnerungen, Tresor, Pranks, Songwünsche): **46/46 bestanden** vor Ergänzung des separaten v29-Tests; v29-Test zusätzlich **1/1 bestanden**.
- `npm run test:browser`: **5/5 bestanden**, einschließlich Dashboardnavigation/Logout, Community-Welt mobil, Elio, Chaos-Wheel-OBS und VIP-Lounge/-Freigabe.
- `git diff --check`: bestanden.

Ein zusätzlicher, eigenständiger Migrationstest für Version 31 wurde nach diesem ursprünglichen Audit ergänzt und lokal mit **1/1 bestanden** verifiziert.

## Priorisierte offene Arbeit

1. **Staging vor Release:** Sichere, getrennte Twitch-Broadcaster-VIP-Autorisierung und Spotify-/Kanalpunkte-Testzugänge bereitstellen; die Funktionen ohne diese bleiben offline bzw. nicht verifiziert.
2. **Imposter-Wortspiel:** Produktablauf und Datenmodell für geheime Begriffe/Hinweiswörter definieren; bisheriges Regelspiel nicht stillschweigend umdeuten.
3. **Live Control:** Browser-E2E für die vorhandene Live-Control-Seite und jede dortige Aktion ergänzen. Danach klären, ob Titel-/Kategorieänderung wirklich benötigt wird und welche Twitch-Scopes das verlangen würden.
4. **Erinnerungsmoderation:** Browserklicks für Freigabe/Ablehnung auf `/dashboard/memories` ergänzen; Serverrechte/API sind bereits getestet.
5. **Abstimmungen und Magic 8-Ball:** Browserklicktests für allgemeine Poll-Erstellung/Ende und das 8-Ball-Einstellungsformular ergänzen.
6. **Release-Splitting:** Änderungen datei- und featureweise reviewen und nur konfliktfrei separierbare Einheiten committen. `dashboard.ts`, `feature-store.ts` und gemeinsame Integrationsdateien benötigen manuelle Aufteilung.

## Freigabegrenze

Der Stand ist lokal gut testbar, aber noch nicht für Production-Abnahme freigegeben. Keine Commits, Pushes, Merges, Deployments, PM2-Neustarts, Produktionsmigrationen, echten Twitch-/Spotify-Aktionen, OAuth-Änderungen oder OBS-Auslösungen wurden vorgenommen.
