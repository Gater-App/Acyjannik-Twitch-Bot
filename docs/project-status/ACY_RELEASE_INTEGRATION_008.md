# ACY Twitch Bot – Release Integration 008

**Stand:** 15.10.2026 (Europe/Berlin)
**Repository:** `Gater-App/Acyjannik-Twitch-Bot`
**Integration branch:** `codex/acy-release-integration-008`
**Production:** `https://twitch.gater-app.de`

## 1. Ergebnis

Der Releasekandidat enthält ausschließlich Security & Operations 004 und Community & Live Control 007. Beide wurden konfliktfrei auf dem aktuellen GitHub-`main` integriert. Die integrierten Tests und Browserläufe bestanden. Der Kandidat ist gepusht und als [PR #14](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/14) gegen `main` offen. Es wurde nichts gemergt oder deployed.

| Bereich | Status | Nachweis |
|---|---|---|
| GitHub `main` | **VERIFIED** | `f075663790263e59256f49130f00274dd4067fea`, auch nach erneutem Fetch unverändert |
| Security 004 | **IMPLEMENTED · COMMITTED · PUSHED · PR OPEN** | `9f36883`, `d9de3b1`; [PR #12](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/12) |
| Community 007 | **IMPLEMENTED · COMMITTED · PUSHED · PR OPEN** | `2d932530ea69d8f1a8812c86453bb8c9ee6fb641`; [PR #13](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/13) |
| Integration 008 | **COMMITTED · PUSHED · PR OPEN** | Merge-Commit `a375301`, Community-Commit `5357a4b`; [PR #14](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/14) |
| Unit-/Build-/Browser-Regression | **TESTED** | `npm run check`, `npm run build`, `npm test`, `npm run test:browser` bestanden; Details unten |
| Imposter Secret Word 006 | **LOCAL · UNCOMMITTED · NOT VERIFIED · EXCLUDED** | Separater Worktree; keine Dateien übernommen oder verändert |
| Production-Runtime | **NOT VERIFIED** | Öffentliche HTTP-Antworten geprüft, aber kein Commit-/Version-Endpunkt vorhanden |
| GitHub CI | **NOT VERIFIED / NO CHECK RUNS** | PR #12, #13 und #14 melden keine Statuschecks |

## 2. Ausgangsstand und Git-Integration

- Nach `git fetch origin` stimmten `origin/main` und `git ls-remote` überein: `f075663790263e59256f49130f00274dd4067fea`.
- Security 004 war bereits auf GitHub veröffentlicht. PR #12 ist offen, Ziel `main`, Head `d9de3b1`, Merge-Status `CLEAN`.
- Community 007 lag zunächst als erwarteter uncommitteter Arbeitsstand im eigenen Worktree auf Basis von `f075663`. Nach Diff- und Berechtigungsprüfung wurde ausschließlich der geprüfte Umfang committet: `2d93253` (`feat: polish community portal and live control`). Branch und [PR #13](https://github.com/Gater-App/Acyjannik-Twitch-Bot/pull/13) sind veröffentlicht/offen.
- Integration begann in einem neuen Worktree auf `origin/main`. Security wurde per regulärem Merge aufgenommen; Community wurde danach als eigener Commit übernommen. Es gab keine Konflikte und keine manuelle Konfliktauflösung.
- Der Vergleich `origin/main...HEAD` zeigt die Security- und Community-Dateiänderungen je einmal. Die Imposter-006-Dateien, insbesondere `secret-word-imposter*`, sind nicht enthalten.
- Der Integrationsbranch wurde ohne Force-Push veröffentlicht. PR #14 ist offen, Ziel `main`, Merge-Status `CLEAN`; es gab keinen automatischen Merge.

Der geschützte Hauptcheckout blieb auf `feature/halloween-haunted-house` bei `886826ca7bd882eadceb629f86eaaa13f3f27746`. Seine drei vorhandenen VIP-Screenshot-Änderungen und `artifacts/` blieben unangetastet. In den drei Arbeitszweigen wurden keine fremden Änderungen verworfen. Browser-generierte Bildänderungen im Integrationsworktree wurden auf genau dessen Branchstand zurückgesetzt.

## 3. Enthaltene Änderungen

### Security & Operations 004

- `.gitignore` ignoriert `.env`, `.env.*` (mit Ausnahme von `.env.example`), `data/` und `backups/`.
- Das Runtime-Verzeichnis `data/` umfasst Standard-Tokenpfade, Sessions, Zustandsdateien und temporäre Dateien. `git check-ignore` bestätigte die Standard-Bot-, Broadcaster-, VIP- und Spotify-Tokenpfade. Die Git-Indexprüfung ergab keine versionierten Runtime-Token-Dateien; `.env.example` ist die einzige passende versionierte Beispieldatei.
- Release-Manifest-Generator, dazugehörige Tests und Dokumentation sind enthalten. Der Generator lehnt Symlinks im Artefakt ab und kann Quellen-/Runtime-Aussagen als unbekannt kennzeichnen.
- Geschützte Readiness-Diagnose ergänzt Datenbank-/Schema- und EventSub-Status; der öffentliche `/health`-Endpunkt bleibt ein Liveness-Check.
- `Caddyfile` und `ops/Caddyfile.oracle` enthalten statisch passende Routen für Community, Hilfe und Streamer.
- Ein begrenzter Secret-Pattern-Scan fand genau einen Treffer in `src/twitch-api.test.ts`: ein synthetischer OAuth-Testfixture-Wert. Es wurden keine echten Zugangsdaten im Diff gefunden oder ausgegeben.

**Grenze der Ignore-Regel:** Per `*_TOKEN_FILE` außerhalb des ignorierten `data/`-Verzeichnisses konfigurierte Pfade werden nicht automatisch von Git ausgeschlossen. Solche Runtime-Dateien müssen außerhalb des Repositories liegen oder individuell ignoriert werden. Das Security-004-README dokumentiert diese Grenze. Gitignore schützt außerdem nicht vor bereits committeten Geheimnissen.

### Community & Live Control 007

- Mobile Community-Navigation als aufklappbares Menü mit Touchflächen, Tastaturbedienung und ARIA-Zustand; Desktop-Navigation bleibt erhalten.
- Moderationsübersicht mit Zählern und Verknüpfungen zu Ideen, Erinnerungen, Quests, Chat-Ideen, Zitaten und VIP-Anfragen. Die API liefert nur Aufgabenmetadaten (ID, Status, Zeitstempel); Moderatorbereiche werden serverseitig anhand der Rolle gefiltert.
- Bestehende Moderationsseiten werden weiterverwendet. Bereits bearbeitete Einreichungen werden durch bestehende Statusübergänge abgewiesen.
- Live Control unterscheidet Verarbeitung im Bot, Chatversand bestätigt/nicht verfügbar/unklar und nicht erforderliche Chatmeldung. Bei mehrdeutigem Fehler wird auf doppeltes erneutes Auslösen hingewiesen. Das bestätigt keine OBS-Sichtbarkeit.
- Portal-/Dashboard-Abfragen verwenden Deduplizierung, kurzlebigen Arbeitsspeicher-Cache, Jitter, Sichtbarkeitsprüfung und Retry-Backoff. Es wurde keine neue Infrastruktur eingeführt.
- Keine Datenbankmigration hinzugefügt.

## 4. Twitch-Authentifizierung und Token-Sicherheit

Die vorhandene Chat-Authentifizierung wurde nicht umgebaut. `src/twitch-api.ts` verwendet weiter den User-Token-WebSocket-Weg für `channel.chat.message`; die Security-Tests prüfen diesen Pfad und einen begrenzten Refresh nach 401. Der getrennte Broadcaster-OAuth-Pfad für Kanalpunkte/VIP bleibt getrennt. Die GitHub-Änderungen ändern keine echten Tokens.

Die offizielle Twitch-Dokumentation beschreibt den WebSocket-Subscription-Pfad mit User-Access-Token; der alternative Webhook-Weg verwendet ein App-Access-Token. Das ist kein Grund, den hier bestehenden WebSocket-Pfad ohne konkreten Bedarf umzubauen: [EventSub subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/), [EventSub WebSocket handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events), [Chat authentication](https://dev.twitch.tv/docs/chat/authenticating).

Production-Scopes, Tokeninhalt und laufende Twitch-Verbindung wurden nicht geprüft. Es gab keine Live-Twitch-Aktion.

## 5. Tests und Sicherheitsprüfung

Auf dem kombinierten Integrationsstand, in isoliertem Worktree und ohne Installation/Aktualisierung von Abhängigkeiten:

| Befehl | Ergebnis |
|---|---|
| `npm run check` | **BESTANDEN**; TypeScript-Build und Unit-Tests |
| `npm run build` | **BESTANDEN** |
| `npm test` | **203 bestanden, 0 fehlgeschlagen** |
| `npm run test:browser` | **5 bestanden, 0 fehlgeschlagen** |
| `git diff --check` | **BESTANDEN** |

Die Browser-Suite deckt Community-Welt und Community-Navigation mobil, Dashboard-Navigation, Moderations-Inbox mit direktem Aufgabenlink, OBS-Wheel-Widget, Elio-Aktionen sowie VIP-Lounge und Dashboard auf Desktop/Mobil ab. Unit-/Integrationstests prüfen außerdem Moderationsrollen und Metadaten, OAuth-/CSRF-Grenzen, EventSub-WebSocket, Reconnect, SQLite, XP-/Quest-Idempotenz, Release-Manifest, Caddy-Routen und Token-Ignoreregeln.

Die Tests verwenden lokale Datenbanken, Browser und synthetische Providerantworten. Sie beweisen weder die Twitch-Livezustellung noch OBS im aktiven Stream oder Verhalten unter Produktionslast.

## 6. Production-Readiness und offene Abhängigkeiten

Read-only GETs an `twitch.gater-app.de` am 15.10.2026 ergaben:

| Pfad | Antwort | Aussage |
|---|---:|---|
| `/health` | 200 | Liveness antwortet mit `{"status":"alive"}`; enthält keinen Runtime-Commit |
| `/community` | 200 | Portalroute erreichbar |
| `/hilfe` | 200 | Hilferoute erreichbar |
| `/streamer` | 302 | Ohne Sitzung geschützt/Weiterleitung |
| `/healthz` | 404 | Kein aktiver Alias unter diesem Pfad beobachtet |
| `/version` | 404 | Kein öffentlicher Versionsendpunkt unter diesem Pfad beobachtet |
| `/` | 404 | Root liefert Not Found |

Der bekannte Runtime-Commit `2270094` ist ein historischer Stand aus vorhandenen Unterlagen und wurde nicht erneut auf Oracle bestätigt. Aktive Oracle-Dateien, Caddy-Konfiguration, Prozesszustand, Produktionsdatenbank, Backup/Restore, OAuth-Scopes und EventSub-Verbindung bleiben **NOT VERIFIED**. Die beiden Caddy-Dateien in diesem Repository wurden statisch verglichen; dies verifiziert nicht die aktive Serverkonfiguration. Der Security-004-Bericht dokumentiert, dass der frühere Oracle-SSH-Zugriff mit `Permission denied (publickey)` abgewiesen wurde.

PR #12, #13 und #14 zeigen derzeit keine GitHub-Statuschecks. `CLEAN` bedeutet hier GitHub-Mergezustand ohne gemeldete Konflikte, nicht erfolgreiche CI oder Production-Freigabe.

## 7. Imposter 006

Der separate Worktree `codex/imposter-secret-word-006` liegt weiterhin auf `f075663` mit uncommittierten Quell-, Test-, Browser-Test-, Screenshot- und Statusberichtdateien. Ein Remote-Branch und ein PR wurden nicht gefunden. Der lokale Bericht beschreibt ein Secret-Word-Spiel und Migration v33; diese Angaben wurden in diesem Integrationslauf nicht unabhängig ausgeführt oder verifiziert. Daher: **IMPLEMENTIERUNG LOKAL VORHANDEN, NOT COMMITTED, NOT PUSHED, NOT VERIFIED, AUS RELEASEKANDIDAT AUSGESCHLOSSEN**. Der Imposter-Worktree blieb unangetastet.

## 8. Rollback-Vorbereitung und nächste Schritte

- Es wurde nicht deployed; es gibt deshalb keinen ausgeführten Production-Rollback.
- Der Kandidat enthält keine Datenbankmigration. Das reduziert, beseitigt aber nicht, das Risiko eines späteren Rollbacks.
- Vor einer späteren Freigabe müssen ein aktuelles SQLite-Backup mit geprüftem Restore, ein verfügbares vorheriges Runtime-Artefakt und das aktive Caddy-Rückfallziel auf Oracle verifiziert werden. Frühere Dateipfade aus historischen Berichten sind keine Bestätigung, dass sie heute vorhanden sind.
- Caddy muss auf dem Zielsystem mit dem dort installierten Validator geprüft werden. Anschließend sind Quelle, Manifest-Prüfsumme, Build-Artefakt und Runtime-Commit gegenzuprüfen.
- Danach ist eine gesonderte bewusste Freigabe für Staging/Production nötig. Erst dann dürfen Deployment- und Neustartmaßnahmen erfolgen; hier wurden diese nicht ausgeführt.

**Release-Empfehlung:** PR #14 ist für Code-Review bereit, aber der Gesamtstand ist noch **BLOCKED FOR PRODUCTION RELEASE** bis aktive Oracle-/Caddy-Konfiguration, Runtime-Commit, SQLite-Backup/Restore und OAuth/EventSub-Betrieb read-only beziehungsweise in einer freigegebenen Staging-Prüfung verifiziert sind und CI-/Reviewstatus vorliegt.
