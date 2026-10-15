# ACY Production Preflight & Release Gate 009

**Prüfdatum:** 15. Oktober 2026
**Repository:** `Gater-App/Acyjannik-Twitch-Bot`
**Ziel:** `https://twitch.gater-app.de`
**Preflight-Branch:** `codex/acy-production-preflight-009`
**Integrations-PR:** [#14](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/14)
**Entscheidung:** **Kein Merge und kein Production-Release.** PR #14 besteht die automatisierte Codeprüfung, aber die Review-Freigabe fehlt. Ein read-only SSH-Preflight hat PM2, die aktive Release-Verzeichniskennung und SQLite-Schema/Lesbarkeit bestätigt. Der ausgelieferte Artefakt-Commit ist mangels Release-Manifest nicht kryptografisch belegt; die aktive Caddy-Konfiguration weicht im Hash von beiden Repository-Konfigurationen ab. Das neueste lesbare Backup ist mehr als zehn Stunden älter als die Beobachtung.

Statuswerte bedeuten:

- **PASSED** – im angegebenen lokalen oder GitHub-Kontext tatsächlich geprüft.
- **PARTIALLY PASSED** – statisch oder teilweise geprüft; ein Teil bleibt offen.
- **BLOCKED** – notwendiger Zugang oder notwendige Freigabe fehlt.
- **NOT VERIFIED** – es liegt keine belastbare aktuelle Produktions- oder Live-Evidenz vor.

## 1. GitHub-Ausgangsstand und Worktrees

| Gegenstand | Ergebnis |
|---|---|
| `origin/main` | **PASSED** – `f075663790263e59256f49130f00274dd4067fea` |
| PR #12 Security 004 | **PASSED** – offen, Head `d9de3b140d99713fe505d502b3a16ca2bd2257b6` |
| PR #13 Community 007 | **PASSED** – offen, Head `2d932530ea69d8f1a8812c86453bb8c9ee6fb641` |
| PR #14 Integration 008 | **PASSED** – offen, sauberer Merge-Stand gegen main, getesteter Code-HEAD `b52aed9081d7db90ed8d9fd081ecf994cedff7c9` |
| PR-Reviews | **BLOCKED** – für PR #14 liegen keine Reviews oder Freigaben vor. |
| Branch-Schutz | **PARTIALLY PASSED** – GitHub meldet keine Branch-Protection-Regel und keine Repository-Rulesets. Merge dennoch nicht ausgeführt. |
| Main-Konflikte | **PASSED** – `origin/main` ist Vorfahr des Integrationsstands; keine Konfliktauflösung war erforderlich. |
| PR-Änderungsduplikate | **PASSED** – PR #12 ist durch den Security-Merge enthalten. Die Community-Änderung in PR #13 entspricht inhaltlich der integrierten Community-Änderung; die Patch-ID-Prüfung ergab dieselbe Änderung. PR #12 und #13 bleiben offen, bis ihre Beziehung nach einem späteren bewussten Merge geklärt wird. |

Der geschützte Hauptcheckout blieb unverändert auf `feature/halloween-haunted-house`, HEAD `886826ca7bd882eadceb629f86eaaa13f3f27746`. Dort lagen weiterhin die drei vorhandenen Änderungen an `docs/verification/vip-dashboard-desktop-local.png`, `docs/verification/vip-dashboard-mobile-local.png`, `docs/verification/vip-lounge-desktop-local.png` und der unversionierte Ordner `artifacts/`.

Der Imposter-006-Worktree blieb unverändert: Branch `codex/imposter-secret-word-006`, HEAD `f075663790263e59256f49130f00274dd4067fea`, mit bereits vorhandenen uncommitteten Implementierungsdateien, Tests und Screenshots. Keine dieser Änderungen wurde in PR #14 übernommen. Die Migration v33 wurde nicht ausgeführt.

Weitere Worktrees wurden nur inventarisiert. Der alte Integrationscheckout steht weiterhin auf `b311e21`, liegt hinter dem veröffentlichten Integrationsbranch und wurde nicht angepasst; die Security-004- und Community-007-Checkouts sind sauber. Der temporäre Checkout auf `2270094` hat weiterhin seine vorherigen Screenshot-Änderungen und `node_modules`; die Worktrees `acy-health-proxy` und `acy-release-report` sind sauber. Diese fremden Zustände wurden nicht geändert.

## 2. Review von PR #14

**Ergebnis: PARTIALLY PASSED.** Der vollständige Integrationsdiff gegen `origin/main` wurde statisch geprüft. Es wurde kein konkreter Codebefund der Stufe BLOCKER oder HIGH gefunden. Das ist kein Ersatz für einen autorisierten Production-Preflight.

### Sicherheitsprüfung

- **PASSED:** `.gitignore` schließt `.env`, `.env.*` (außer `.env.example`), `data/` und `backups/` aus; es sind keine Datenbankdateien unter `data/` versioniert.
- **PASSED:** Diff- und Testprüfung ergaben keine echten Zugangsdaten. Die Treffer im Secret-Pattern-Scan stammen ausschließlich aus synthetischen Test-Fixtures; keine Tokenwerte wurden ausgegeben.
- **PASSED:** OAuth-State ist zufällig, kurzlebig und einmalig; Callback und Redirect werden eingegrenzt. Session-Cookies sind Secure/HttpOnly/SameSite und Sessions laufen serverseitig ab. CSRF-Token und Origin werden für schreibende Dashboard-Aufrufe geprüft.
- **PASSED:** geschützte Dashboard- und Moderationsrouten prüfen Session und Rolle serverseitig; die Moderationsübersicht liefert Aufgabenmetadaten und verwendet vorhandene Statusübergänge.
- **PASSED:** Twitch-EventSub verwendet weiterhin den vorhandenen User-Token/WebSocket-Pfad. Der PR baut nicht auf App-Token/Webhooks um. Die Tests hierfür verwenden Mocks.
- **PARTIALLY PASSED:** Token-Dateien werden mit restriktiven Dateirechten geschrieben. Ein individuell konfigurierter `*_TOKEN_FILE`-Pfad außerhalb der ignorierten Laufzeitverzeichnisse ist nicht automatisch von Git ausgeschlossen; Betreiber müssen dafür einen außerhalb des Repositories liegenden Pfad verwenden.
- **PARTIALLY PASSED:** Session-Persistenz ist prozesslokal. Ein Bot-Neustart beendet Browser-Sessions; das ist eine Verfügbarkeits-/Bedienungsgrenze, kein nachgewiesener Session-Diebstahl.

### Community, Live Control und Deployment

- **PASSED:** Moderations-Inbox ist geschützt, filtert die sichtbaren Aufgaben nach Berechtigung und gibt geschützte Inhalte nicht im Inbox-Datensatz aus.
- **PASSED:** Live-Control unterscheidet gespeicherte Aktion und Twitch-Chat-Zustellstatus; doppelte Auslösung wird begrenzt und eine unklare Zustellung wird nicht als sicherer Erfolg dargestellt.
- **PASSED:** Portal-Abfragen werden dedupliziert/kurz zwischengespeichert und in versteckten Ansichten pausiert. Es liegen keine Lastmessungen vor.
- **PARTIALLY PASSED:** Release-Manifest und beide Repository-Caddy-Dateien sind vorhanden und statisch prüfbar; die aktive Oracle-Konfiguration konnte nicht verglichen werden.
- **PARTIALLY PASSED:** `scripts/backup.mjs` und `scripts/restore.mjs` prüfen SQLite-Integrität und verwenden die SQLite-Backup-API. Es wurde kein Produktionsbackup gelesen und kein Restore ausgeführt.

### Befunde nach Schwere

| Stufe | Befund |
|---|---|
| BLOCKER | **Kein bestätigter Code-Sicherheitsfehler im PR-Diff.** Der Production-Gate bleibt wegen fehlender Oracle-Verifikation und fehlender Review-Freigabe geschlossen. |
| HIGH | Kein bestätigter HIGH-Codebefund im statischen Review. |
| MEDIUM | `better-sqlite3` wurde von Version 12 auf `13.0.3` angehoben, damit der native Add-on-Abbau unter Node 24.21 im CI nicht mehr abstürzt. Vor Production ist die Kompatibilität des Major-Upgrades mit einer isolierten Kopie der tatsächlichen Datenbank zu prüfen. |
| MEDIUM | Die Dokumentation beschreibt Docker Compose/Caddy und PM2-/Releaseverzeichnisse. Auf Oracle wurde PM2 bestätigt und das Docker-CLI nicht gefunden; die Compose-Anweisungen sind deshalb kein verifizierter Production-Betriebsweg. |
| LOW | `/health` bestätigt nur HTTP-Prozess-Liveness (`{"status":"alive"}`), keine SQLite-, Twitch-, EventSub- oder OBS-Bereitschaft. |
| LOW | Automatisch konfigurierte Token-Dateipfade außerhalb der ignorierten Laufzeitverzeichnisse benötigen eine Betreiberregel, damit sie nicht versehentlich ins Repository gelangen. |

## 3. CI-Konfiguration und tatsächliche Ergebnisse

`.github/workflows/ci.yml` führt Pull-Request-, main- und Merge-Queue-Prüfungen aus. Es verwendet Node.js 24, `npm ci`, Chromium/Playwright, 30 Minuten Timeout, einen isolierten npm- und Playwright-Cache unter `RUNNER_TEMP`, minimale `contents: read`-Berechtigungen und keine Production-Secrets oder Deployment-Schritte. Actions sind auf Commit-SHAs gepinnt.

`package.json` erlaubt Installationsskripte versionsgebunden nur für `better-sqlite3@13.0.3` und `esbuild@0.28.2`; diese werden für den nativen SQLite-Build und den Test-Runner benötigt. Der frühere Cache-Rechtefehler wird durch einen job-eigenen Runner-Temp-Pfad vermieden.

**Tatsächlicher GitHub-Lauf:** [CI Run 38790045487](https://github.com/Gater-App/Acyjannik-Twitch-Bot/actions/runs/38790045487) auf Code-HEAD `b52aed9081d7db90ed8d9fd081ecf994cedff7c9`: **SUCCESS**. Erfolgreich waren Install, `npm run check`, Build, `npm test`, Browsertests und `git diff --check`.

| Prüfung | Ergebnis |
|---|---:|
| `npm run check` | **PASSED** |
| `npm run build` | **PASSED** |
| `npm test` | **PASSED – 203/203** |
| `npm run test:browser` | **PASSED – 5/5** |
| `git diff --check` | **PASSED** |

Der erste CI-Lauf deckte zuerst einen ungültigen Workflow-Kontext und danach den Node-24-Absturz des alten SQLite-Add-ons auf. Nach dem Dependency-Update fand der Browserlauf den unten beschriebenen mobilen Grid-Überlauf. Diese Probleme wurden in PR #14 behoben; der zuletzt genannte CI-Lauf ist grün. CI- und Browserprüfungen verwenden lokale Testdaten und Mocks; sie beweisen keine Live-Twitch-, OBS- oder Oracle-Funktion.

## 4. Behobener mobiler Layoutfehler

Der Linux-Browser meldete bei 390 Pixeln Viewport 420 Pixel Dokumentbreite. Die CI-Diagnose zeigte, dass `#automatic-chat-hints-form` eine implizite Grid-Spalte mit 393 Pixel Mindestbreite erzeugte, obwohl nur 336 Pixel verfügbar waren. Die Formspalte ist nun explizit `minmax(0, 1fr)`; Chat-Hinweis-Panels und deren mobiles Untergrid dürfen ihre Containerbreite nicht mehr durch automatische Mindestgrößen erweitern.

Die Korrektur wurde lokal mit der vollständigen Regression und im grünen Linux-CI-Lauf geprüft. Die vom Browsertest aktualisierten lokalen Vergleichsscreenshots wurden im isolierten Preflight-Worktree zurückgesetzt; keine Screenshots im geschützten Hauptcheckout wurden angefasst.

## 5. Oracle Production Preflight

### SSH-Zugriff, PM2 und Release-Identität

**PASSED (read-only, Beobachtungsfenster 15. Oktober 2026, ca. 19:20–19:24 UTC).** SSH als `ubuntu` erreichte den Host `acy-discord-bot`. Die Instanz betreibt getrennte PM2-Prozesse für Discord und Twitch; keine Prozesse wurden verändert oder neu gestartet.

| PM2-Prozess | Status | Node | Neustarts | Laufzeitpfad |
|---|---|---:|---:|---|
| `acy-discord-bot` | online | 22.23.2 | 0 | `/home/ubuntu/discord-bot/index.js` |
| `twitch-community-bot` | online | 24.21.0 | 20 | `/home/ubuntu/twitch-community-bot/dist/main.js` |

Der Twitch-Prozess lief bei der Erhebung seit ungefähr 10 Stunden. Die 20 Neustarts sind ein kumulativer PM2-Zähler ohne hier geprüften Zeitraum oder Fehlerursachen und sollten in den Logs des Betreibers eingeordnet werden.

`dist` zeigt auf `/home/ubuntu/twitch-community-bot/releases/2270094-20261015/dist`. Das Präfix `2270094` löst im lokalen Git-Verlauf auf Commit `22700942de6223d5f83508dd070272605a432e96` (Merge PR #9). Damit stimmt die aktive Verzeichniskennung mit dem zuletzt bekannten Runtime-Label `2270094` überein; ein neueres Release-Label wurde nicht beobachtet. Das Verzeichnis enthält kein Git-Repository und an den erwarteten Orten wurde kein Release-Manifest gefunden. Daher ist die Zuordnung der laufenden Dateien zu genau diesem Commit **nicht kryptografisch verifiziert**. Das vorhandene Release-Verzeichnis `e409596-20261015` wurde nicht als funktionierendes Rollback getestet.

Die installierte Runtime-Abhängigkeit `better-sqlite3` ist `12.11.1`; PR #14 enthält `13.0.3`. Das bestätigt, dass der Integrationskandidat nicht in der beobachteten Runtime installiert ist.

### Caddy, Docker und Healthcheck

**PASSED (teilweiser Routenabgleich):** `caddy.service` ist `active/running`; der Caddy-Prozess verwendet `/etc/caddy/Caddyfile`. Die Datei ist 735 Bytes groß, Modus `0644`, Änderungszeit 15. Oktober 2026, 09:07 UTC und SHA-256 `c3ef47e30401f44d8e622fc6e1157e855373bce6eb062f1dfc40186f5df1c63a`. Dieser Hash stimmt weder mit dem Repository-`Caddyfile` (`533a4275…`) noch mit `ops/Caddyfile.oracle` (`a7e709d7…`) überein. Ein auf Pfadmatcher und Loopback-Upstreams begrenzter Vergleich fand die erwarteten Route-Familien: `/health`, `/community*`, `/hilfe`, `/streamer*`, `/dashboard*`, `/widgets/*` und `/games/*` gehen an Port 3001; `/oauth/*` geht an Port 3000. Die aktiven Matcher `/community*` und `/streamer*` sind breiter als die Repository-Matcher `/community` plus `/community/*` beziehungsweise `/streamer`. Das belegt eine Konfigurationsabweichung, aber keinen nachgewiesenen Auth-Bypass oder Ausfall. Andere Caddy-Direktiven wurden nicht offengelegt oder geprüft.

**PASSED:** Ein lokaler GET an `127.0.0.1:3001/health` lieferte HTTP 200. Die nicht authentifizierten öffentlichen GET-Ergebnisse sind in der Tabelle unten dokumentiert. Das bestätigt nur die Prozess-Liveness. Das Docker-CLI war auf dem Host nicht verfügbar; der beobachtete Startmechanismus ist PM2.

### SQLite und Backups

**PARTIALLY PASSED (read-only):** Der Twitch-Prozess hielt `/home/ubuntu/twitch-community-bot/data/halloween.sqlite` sowie WAL-/SHM-Dateien offen. Die Datenbank umfasst 933.888 Bytes; `PRAGMA quick_check` lieferte `ok`. Das Projekt speichert seine Migrationsversion in `schema_migrations`: Maximum 32 bei 32 Einträgen, passend zur im Repository erwarteten Schema-Version 32. `PRAGMA user_version` ist 0; das ist hier nicht die verwendete Projektversionsquelle. Die aktive WAL-Datei war 428.512 Bytes groß und zuletzt um 18:27 UTC geändert.

Im Backup-Verzeichnis lagen 49 Dateien. Das neueste Backup war 933.888 Bytes groß, zuletzt geändert um 09:04:04 UTC; sein read-only `quick_check` lieferte `ok` und `schema_migrations` meldete Version 32. Es war zum Erhebungszeitpunkt etwa 10 Stunden und 20 Minuten alt und älter als die später geänderte WAL-Datei. Das belegt einen lesbaren Backup-Kandidaten, aber weder die Vollständigkeit der jüngsten Änderungen noch eine erfolgreiche Wiederherstellung. Es wurde kein Restore ausgeführt.

### Weiterhin nicht live verifiziert

**NOT VERIFIED:** genaue Zuordnung des laufenden Artefakts zu einem Quellcommit, Inhalt und Funktionsgleichheit der aktiven Caddy-Regeln, Backup-Wiederherstellung, OAuth-Login mit gültiger Session, Twitch-Token-Gültigkeit, EventSub-Socket/Chat-Empfang, Chatversand, OBS-Zustand und aktuelle Fehlerursachen der PM2-Neustarts. Keine Twitch-, OBS-, OAuth- oder Produktionsschreibaktion wurde durchgeführt.

### Öffentliche HTTP-Prüfung

Nur nicht authentifizierte GET-Anfragen; keine POSTs oder Live-Aktionen. Geprüft am 15. Oktober 2026:

| Route | Status | Aussage |
|---|---:|---|
| `/health` | 200 | Prozess-Liveness, keine Readiness-Bestätigung |
| `/community` | 200 | öffentliche Portalroute erreichbar |
| `/hilfe` | 200 | öffentliche Hilferoute erreichbar |
| `/streamer` | 302 | Weiterleitung/Schutz aktiv |
| `/dashboard` | 302 | Weiterleitung/Schutz aktiv |
| `/dashboard/login` | 302 | Weiterleitung aktiv |
| `/dashboard/oauth/callback` ohne Parameter | 400 | ungültiger Callback wird abgewiesen |
| `/` | 404 | kein automatischer Fehlerbefund |
| `/healthz` | 404 | kein automatischer Fehlerbefund |
| `/version` | 404 | kein automatischer Fehlerbefund |

Diese Antworten verifizieren die öffentliche HTTP-Kante, nicht den Code-Commit hinter ihr.

## 6. SQLite, Backup und Release-Manifest

- **PARTIALLY PASSED:** der Repository-Code zielt auf Schema-Version 32. PR #14 fügt keine SQLite-Migration hinzu.
- **PARTIALLY PASSED:** Produktionsdatenbankpfad wurde aus den offenen Prozessdateideskriptoren festgestellt; `quick_check` ist `ok` und `schema_migrations` steht auf 32/32. WAL-/SHM-Dateien sind vorhanden. `integrity_check`, Busy-Verhalten, Dateirechte und laufende Aufbewahrungsrichtlinie wurden nicht geprüft.
- **PARTIALLY PASSED:** das jüngste gefundene Backup besteht `quick_check` und hat Schema 32, ist aber ca. 10h20 vor der Erhebung erstellt/geändert worden. Ein Restore wurde nicht getestet.
- **BLOCKED für Production:** `better-sqlite3@13.0.3` ist ein Major-Upgrade. Vor Freigabe sind ein konsistentes Backup, Restore-Test auf einer isolierten Kopie, `integrity_check` vor/nach dem Kopieren und die DB-Kompatibilität mit dem neuen Add-on nachzuweisen.
- **PASSED:** Imposter 006 und seine vorgesehene Migration v33 sind nicht Teil des Releasekandidaten.

Lokaler Release-Manifest-Snapshot des getesteten Code-Commits `b52aed9081d7db90ed8d9fd081ecf994cedff7c9` (sauberer Quellbaum beim Erzeugen; `dist` aus dem lokalen Build):

| Feld | Wert |
|---|---|
| Artefakt-Hash | `sha256-tree-v1: 96acf2b52c0110aa9000a4de6762e7b6deb00985be5f5c7227adfc7e2b3ec426` |
| Artefaktdateien | 198 |
| `Caddyfile` SHA-256 | `533a4275d75e78704ace4970351c8475c7a892a045e93f1bd47529e6315f0ef2` |
| `ops/Caddyfile.oracle` SHA-256 | `a7e709d7a831c39d4502dcc6486b3f9fa9c0a336d12a1f4b63d4907af0a68c19` |
| Deploymentstatus im Manifest | `not_verified` |

Dieser Hash beschreibt einen lokalen, nicht ausgelieferten Build. Auf dem Oracle-Host wurde unter den erwarteten Release-Metadatenpfaden kein Manifest gefunden. Der aktive Caddy-Datei-Hash weicht von beiden Repository-Konfigurationen ab. Für einen später freigegebenen Release muss der Build aus dem endgültigen freigegebenen Commit neu erstellt und der Manifest-Hash mit dem Zielartefakt abgeglichen werden.

## 7. Twitch, EventSub, OBS und Discord

| Bereich | Status | Nachweisgrenze |
|---|---|---|
| Twitch OAuth/Scopes | **PARTIALLY PASSED** | OAuth- und Scope-Prüfpfade statisch und mit Mocks getestet; kein Live-Login und keine Tokenprüfung. |
| Chat/EventSub | **PARTIALLY PASSED** | User-Token-/WebSocket-Verarbeitung und Reconnect-Pfade in lokalen Tests; kein aktueller Oracle-Socket oder Produktionsereignis verifiziert. |
| Twitch-Nachrichten | **NOT VERIFIED** | keine Nachricht gesendet. |
| OBS | **NOT VERIFIED** | keine aktive Konfiguration, Verbindung oder Logs gelesen; keine Szene oder Quelle verändert. |
| Discord-Bot | **PASSED** | keine Discord-Datei oder kein Discord-Prozess wurde verändert oder neu gestartet. |

## 8. Merge- und Release-Entscheidung

PR #14 ist auf GitHub offen, Merge-Stand `CLEAN`, und sein Code-HEAD hat einen erfolgreichen CI-Lauf. **Der Merge ist trotzdem BLOCKED:** Es gibt keine Review-Freigabe. Die Merge-Regel aus dem Auftrag verlangt eine Freigabe; sie wird nicht durch einen grünen CI-Check ersetzt. Kein Merge wurde ausgeführt.

**Production-Release ist BLOCKED:** PM2- und SQLite-Zustand wurden lesend beobachtet, aber der exakte Artefakt-Commit ist nicht durch ein Manifest belegt, die aktive Caddy-Konfiguration weicht im Hash von den Repository-Dateien ab, und das jüngste lesbare Backup ist deutlich älter als die später geänderte WAL-Datei. Twitch-/EventSub-/OBS-Bereitschaft bleibt unbekannt. Ein öffentlicher oder lokaler `/health`-200 reicht als Bereitschaftsnachweis nicht aus. Ein Merge wäre außerdem keine Deployment-Freigabe.

## 9. Nächster sicherer Releaseplan

1. **Review:** PR #14 durch einen zuständigen Reviewer prüfen und freigeben. PR #12/#13 bis nach der bewussten Integrationsentscheidung offen lassen; keine doppelten Merges durchführen.
2. **Runtime-Identität und Architektur:** Der Host ist über PM2 erreichbar; der Betreiber sollte für das aktive Release `2270094-20261015` ein belastbares Manifest mit Quellcommit und Artefakt-Hash bereitstellen. Die aktive Caddy-Datei muss mit den für den Release erwarteten Routen abgeglichen werden. Keine Werte von Secrets protokollieren.
3. **Build:** endgültigen freigegebenen Commit in sauberem Checkout bauen, `npm ci`, Check/Build/Unit-/Browsertests ausführen, Manifest mit Quellcommit und Artefakt-SHA-256 erstellen. Das Artefakt unveränderlich versioniert übertragen und vor Start auf dem Ziel gegen den Hash prüfen.
4. **Datenbank:** vor jeglicher Änderung den dokumentierten Backup-Pfad verwenden, Backup-Hash und `integrity_check` festhalten und Restore ausschließlich auf einer isolierten Kopie testen. `better-sqlite3@13.0.3` gegen diese Kopie validieren. Keine Migration v33 einbeziehen.
5. **Freigaben:** Jannik/Produkteigner und der autorisierte Oracle-/Betriebsverantwortliche bestätigen Quellcommit, Backup, Zielruntime, Rollbackziel und Wartungsfenster.
6. **Deployment:** erst nach diesen Freigaben die durch den Betreiber verifizierte Deployment-Methode benutzen. In diesem Auftrag wurden keine Deployment-Kommandos ausgeführt.
7. **Nachprüfung:** Runtime-Commit und Prozesszustand, Caddy-Routen, `/health`, authentifizierten Dashboard-OAuth-Pfad, SQLite-Integrität, Bot-/EventSub-Verbindung und Fehlerlogs nur lesend abgleichen. Keine Twitch-Nachricht oder OBS-Live-Aktion als Smoke-Test verwenden.

### Rollback-Vorbereitung

Vor Release müssen Betreiber das tatsächliche vorherige Artefakt/Image, Runtime-Verzeichnis bzw. Image-Digest, Startmechanismus, aktive Caddy-Datei und ein aktuelles geprüftes Datenbankbackup dokumentieren. Die Verzeichnisse `2270094-20261015` und `e409596-20261015` existieren, aber das vorherige Release ist nicht als funktionsfähiges Rollback verifiziert. Rollback auslösen, wenn Healthcheck/Readiness, OAuth, DB-Integrität, Twitch-Verbindungsaufbau oder Prozessstabilität fehlschlagen. Zuerst auf den vorherigen unveränderlichen Code-/Image-Stand zurückschalten; Datenbank nur dann aus Backup wiederherstellen, wenn eine nachgewiesene Dateninkompatibilität es verlangt, und ausschließlich nach Stoppen des Bot-Prozesses und Prüfung der Sicherung.

Das Repository-README beschreibt Backup/Restore für Docker Compose (`docker compose exec -T halloween-bot node scripts/backup.mjs` und `node scripts/restore.mjs`); diese Kommandos passen nicht zum beobachteten PM2-Betrieb. Zwar existiert ein vorheriges Release-Verzeichnis, doch weder dessen Funktion noch der PM2-Rollback-Ablauf wurden verifiziert. Es gibt derzeit **keinen verifizierten, ausführbaren Production-Rollback-Befehl**. Der Betreiber muss den vorgesehenen PM2-/Releasewechsel und den Rückfallpfad bestätigen.

## 10. Verbleibende Risiken und nächste Freigaben

1. Aktives Release-Verzeichnis trägt weiter das bekannte Label `2270094`; die Dateizuordnung zum Git-Commit `22700942…` ist ohne Release-Manifest/Artefakt-Hash **NOT VERIFIED**.
2. Caddy läuft und die erforderlichen Route-Familien/Upstreams wurden teilweise bestätigt; aktive Pfadmatcher sind breiter als im Repository und der Datei-Hash weicht ab. Vollständiger Konfigurations-/TLS-Abgleich bleibt **NOT VERIFIED**.
3. Das neueste lesbare Backup besteht `quick_check`, ist aber ca. 10h20 alt und älter als die später geänderte aktive WAL-Datei; Aktualität/Restore bleiben **BLOCKED für Release**.
4. Produktionsschema 32 und Datenbank-`quick_check` passen zum erwarteten Stand; ein `integrity_check` und Restore auf isolierter Kopie wurden nicht durchgeführt (**PARTIALLY PASSED**).
5. Production nutzt `better-sqlite3@12.11.1`, während PR #14 `13.0.3` enthält; die Kompatibilität des Major-Upgrades benötigt einen isolierten Test (**BLOCKED für Release**).
6. Twitch-/EventSub-/OBS-Live-Zustand und Token-Gültigkeit wurden nicht geprüft (**NOT VERIFIED**).
7. PR #14 hat keine menschliche Review-Freigabe (**BLOCKED für Merge**).
8. Imposter 006 bleibt separat, uncommittet und nicht freigegeben; keine v33-Migration oder Deployment (**NOT VERIFIED für das Feature, PASSED für den Ausschluss aus PR #14**).

**Ausgeführte Grenzen:** ausschließlich lesender SSH-Zugriff, PM2-Metadaten, Dateimetadaten/Hashes, lokale Health-GETs und SQLite-`quick_check`/Schemaabfragen mit read-only Verbindungen. Kein Merge, Deployment, PM2-Neustart, Caddy-Reload, Produktionsdatenbank-Schreibzugriff/-migration, Tokenrotation, Twitch-Chatversand, OBS-Live-Eingriff oder Discord-Eingriff. Der geschützte Hauptcheckout und die fremden Worktrees blieben unangetastet.
