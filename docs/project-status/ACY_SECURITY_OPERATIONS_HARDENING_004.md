# ACY Twitch Bot – Security & Operations Hardening 004

**Stand:** 15.10.2026
**Repository:** `Gater-App/Acyjannik-Twitch-Bot`
**Arbeitsbranch:** `codex/security-operations-hardening-004`

## Ergebnisstatus

- **IMPLEMENTED:** Runtime-Datenverzeichnis vollständig von Git ausgeschlossen; Caddy-Routen für Community, Hilfe und Streamer ergänzt; geschützte Readiness-Diagnose ergänzt; Release-Manifest-Generator und Dokumentation ergänzt.
- **TESTED:** `npm run check` (Build plus Unit-/Integrationstests) bestanden, 203 Tests; `npm run test:browser` bestanden, 5 Tests; `git diff --check` ohne Befund.
- **READY FOR REVIEW:** Lokaler Implementierungs-Commit `9f3688383f7b64d3539eba54e6333737ccafefce` auf einem eigenen Branch ab `origin/main`.
- **BLOCKED:** Aktive Oracle-Caddy-Konfiguration konnte wegen abgewiesenem SSH-Zugriff nicht geprüft werden; der lokale Caddy-Validator ist nicht installiert.
- **NOT VERIFIED:** Aktuell laufender Production-Commit, aktive Caddy-Datei und tatsächliche Production-Credentials/Scopes. Es gab kein Deployment.

## 1. Ausgangs- und Endstand

`origin/main` wurde abgerufen und stand bei `f075663790263e59256f49130f00274dd4067fea`. Der neue, isolierte Arbeitsbaum wurde genau auf diesem Commit angelegt. Die Implementierung endete mit Commit `9f3688383f7b64d3539eba54e6333737ccafefce`; er enthält 13 gezielt ausgewählte Dateien. Der Statusbericht wird danach separat committed.

Die zuerst vorgefundene Hauptarbeitskopie liegt unter:

`/Users/basti/Documents/Codex/2026-10-14/und-gleich-das-erste-problem-das/work/Acyjannik-Twitch-Bot`

Sie blieb auf `feature/halloween-haunted-house`, HEAD `886826ca7bd882eadceb629f86eaaa13f3f27746`, fünf Commits vor `origin/main`. Vorhanden waren drei geänderte VIP-Verifikationsscreenshots und `artifacts/`. Diese Dateien wurden nicht bearbeitet. Der Chat-Arbeitsordner war ein separates leeres Git-Repository und wurde nicht als Projektquelle verwendet.

Weitere bereits vorhandene Worktrees beim Abschlussabgleich:

| Worktree | Commit/Branch | Vorgefundener Status |
|---|---|---|
| `/private/tmp/acy-bot-release-2270094` | detached, `22700942de6223d5f83508dd070272605a432e96` | drei VIP-Screenshots geändert, `node_modules` unversioniert; nicht bearbeitet |
| `/private/tmp/acy-health-proxy` | `fix/health-proxy-route`, `37d9fc448cd7a3fc48db61b89a4c510cf4c4d001` | sauber |
| `/private/tmp/acy-release-report` | `docs/health-hotfix-production-report`, `743795ed92991c3b0c7a8ad2cecf55d932ab97ab` | sauber |
| `.../work/acy-security-operations-hardening-004` | `codex/security-operations-hardening-004` | eigener Implementierungs- und Berichtsbranch |

Im aktuellen Agententeam war kein weiterer Agent aktiv. Der lokale Prozessabgleich fand keinen anderen Prozess mit dem neuen Arbeitsbaum als Arbeitsziel. Solche Momentaufnahmen schließen Änderungen durch externe oder nicht sichtbare Prozesse nicht grundsätzlich aus; die ursprüngliche Hauptarbeitskopie wurde am Ende erneut kontrolliert.

## 2. Veränderte Dateien und behobene Risiken

- `.gitignore`: `data/` wird vollständig ignoriert. Damit fallen auch `.broadcaster`, `.vip`, `.oauth-state`, atomare temporäre Dateien sowie eigene Token-/Session-Dateinamen unter diesem Verzeichnis unter den Schutz.
- `README.md`: Runtime-Dateipfade, Grenzen individueller Pfade und Nutzung des Release-Manifests dokumentiert.
- `Caddyfile`, `ops/Caddyfile.oracle`: `/community`, `/community/*`, `/hilfe` und `/streamer` an den vorhandenen Dashboard-Listener weitergeleitet. Die vorhandenen `/health`, `/oauth/*`, `/dashboard*`, `/widgets/*` und `/games/*`-Routen sowie Root-404 bleiben bestehen.
- `src/feature-store.ts`: read-only SQLite- und Schema-Prüfung ergänzt; erwartete Schema-Version ist 32.
- `src/dashboard.ts`, `src/main.ts`: vorhandenen authentifizierten Admin-Status um Readiness, SQLite-/Schema-Status, EventSub-Verbindung und Zeitstempel der letzten erfolgreich verarbeiteten Chat-/konfigurierten Redemption-Events ergänzt.
- `src/dashboard.test.ts`: Diagnose ohne Sitzung muss 401 liefern; Diagnosefelder und Ready-Zustand mit Testdaten werden geprüft.
- `src/operations-hardening.test.ts`: Ignore-Regeln, keine versionierten Dateien unter `data/`, SQLite-Readiness und statische Caddy-Routenabdeckung geprüft.
- `src/twitch-api.test.ts`: WebSocket-Chat-Subscription mit User-Token, einmaliger Refresh nach 401 und kein Refresh/Retry nach 403 geprüft.
- `scripts/create-release-manifest.mjs`, `scripts/create-release-manifest.test.mjs`, `package.json`: Generator und Tests ergänzt; `npm run release:manifest` verfügbar.

Die Git-Prüfung fand keine versionierten Dateien unter `data/` und keine versionierten Token-/Session-Dateien in den abgefragten Pfaden. Es wurden keine Tokeninhalte gelesen oder ausgegeben. Ignore-Regeln entfernen keine bereits versionierten Dateien aus der Historie; in den geprüften aktuellen Pfaden wurde kein solcher Fall gefunden.

Eigene Dateipfade, die per Umgebungsvariable außerhalb von `data/` gesetzt werden, sind nicht automatisch geschützt. Die README weist an, Runtime-Dateien innerhalb des Runtime-Verzeichnisses oder vollständig außerhalb des Repositories abzulegen und restriktive Dateirechte zu verwenden. `.gitignore` ist kein Schutz vor einem bereits erfolgten Secret-Commit oder vor Zugriff auf dem Server.

## 3. Twitch-Authentifizierungsentscheidung

Der aktuelle Chatpfad blieb bewusst unverändert. `src/config.ts` und `README.md` weisen dem Bot-User-Token die Scopes `user:read:chat` und `user:write:chat` zu. `src/main.ts` registriert `channel.chat.message` über EventSub-WebSocket mit Broadcaster- und Bot-User-ID; `src/twitch-api.ts` verwendet den User-Token für Helix. Die Tokenklasse unterstützt Refresh. Ein 401 führt im API-Pfad zu einem begrenzten Refresh und Retry; ein 403 wird nicht als abgelaufener Token behandelt.

Die offizielle Twitch-Dokumentation beschreibt User-Token plus EventSub-WebSocket als unterstützten Chatpfad. Für einen als Cloud-Chatbot betriebenen Bot beschreibt Twitch außerdem App-Token plus EventSub-Webhook als passendes Betriebsmodell. Der zweite Weg ist eine Architekturentscheidung und kein zwingender Umbaugrund für den aktuellen WebSocket-Pfad. Der dokumentierte Bot-Badge-/Cloud-Bot-Weg benötigt zusätzliche Bot- und Broadcaster-Freigaben (`user:bot` und `channel:bot`); diese Scopes werden vom aktuellen Code nicht angefordert. Der Bot erhält aktuell keinen App-Access-Token.

Separat gespeicherte Broadcaster-OAuth-Flows dienen den Kanalpunkte-Redemptions (`channel:manage:redemptions`) und VIP-Funktionen (`channel:read:vips`). Sie werden nicht mit dem Bot-Chat-Token zusammengelegt. Die tatsächliche Identität, Laufzeit-Scopes und Gültigkeit der Production-Tokens wurden nicht geprüft.

Der EventSub-Code hat Keepalive-Überwachung, begrenzten exponentiellen Reconnect und behandelt Subscription-Widerrufe durch erneute Sitzung/Subscription. Vorhandene Tests prüfen Backoff und Erholung nach Widerruf. Die neuen API-Tests verwenden ausschließlich synthetische Test-Tokens. Es gab keine Live-Autorisierung oder Twitch-Aktion.

Quellen, jeweils offizielle Twitch-Dokumentation:

- [Authenticating with Twitch](https://dev.twitch.tv/docs/authentication/)
- [Twitch Chat](https://dev.twitch.tv/docs/chat/)
- [Send and Receive Chat Messages](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [EventSub subscription types – channel.chat.message](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage)

## 4. Deployment, Caddy und Release-Manifest

Quellcode, Runtime und Deployment bleiben getrennte Aussagen:

- **GitHub-Quelle:** abgerufener `origin/main`-Commit `f075663790263e59256f49130f00274dd4067fea`.
- **Zuletzt dokumentierte Runtime:** `22700942de6223d5f83508dd070272605a432e96`, laut vorhandenen Release-Unterlagen. Dieser Stand wurde hier nicht erneut auf Oracle ausgelesen.
- **Dieser lokale Stand:** Implementierungscommit `9f3688383f7b64d3539eba54e6333737ccafefce` auf dem lokalen Branch; weder gepusht noch deployed.

Der neue Manifest-Generator erfasst Quellcommit und Sauberkeitsstatus, optionalen Runtime-Commit, sortierte Dateipfade samt SHA-256, eine deterministische `sha256-tree-v1`-Prüfsumme, SHA-256 der beiden Repository-Caddy-Dateien und einen optionalen Deploymentzeitpunkt. Unbekannter Runtime-Commit oder fehlender Deploymentzeitpunkt werden als `null`/`not_verified` ausgegeben. Symlinks im Build-Artefakt werden abgelehnt. Das Manifest enthält keine Credentials.

Das Manifest ist weder Signatur noch Deploymentnachweis: Ein gesetzter Runtime-Commit oder Zeitpunkt wird als Eingabe übernommen. Der Generator wurde mit Testartefakten geprüft; für Production wurde kein Manifest erstellt. Eine automatische Caddy-Parservalidierung oder Laufzeitroute-Erzeugung ist nicht implementiert.

Die beiden Repository-Konfigurationen stimmen statisch über die oben aufgeführten Proxy-Routen und Listener überein: Container-Listener in `Caddyfile`, localhost-Listener in `ops/Caddyfile.oracle`, OAuth jeweils auf Port 3000. Ein automatisierter Test vergleicht die erwarteten Route-Blöcke als Text, nicht anhand eines Caddy-Parsers.

Am 15.10.2026 lieferten öffentliche GET-Prüfungen `/health` 200, `/community` 200, `/hilfe` 200, `/streamer` 302 und `/` 404. Das belegt die zu diesem Zeitpunkt beobachteten HTTP-Antworten, aber weder die Identität des aktiven Runtime-Artefakts noch die aktive Caddy-Konfiguration. Ein read-only SSH-Versuch zu Oracle wurde mit `Permission denied (publickey)` abgewiesen; das lokale `caddy`-Programm war nicht verfügbar. Aktive Caddy-Konfiguration und Deploymentabgleich sind damit **BLOCKED / NOT VERIFIED**.

Die bekannte Root-Route `/` bleibt 404. Es wurde keine Startseite ergänzt.

## 5. Healthcheck und Readiness

Der öffentliche `GET /health` bleibt ein schneller Liveness-Endpunkt. Er führt keine Datenbank-, OAuth-, EventSub- oder OBS-Prüfung aus und bleibt unabhängig von externen Provider-Ausfällen.

Der vorhandene `GET /dashboard/api/status` ist an die Dashboard-Admin-Sitzung gebunden; ohne Sitzung liefert er 401. Er prüft SQLite lokal mit `SELECT 1`, vergleicht `MAX(schema_migrations.version)` mit Version 32 und meldet `ready` nur bei erreichbarer DB, passendem Schema und verbundener EventSub-Sitzung. Sonst meldet er `degraded` samt den einzelnen Statusfeldern. Der Status enthält zusätzlich den letzten erfolgreichen Eventverarbeitungszeitpunkt sowie Broadcaster-OAuth-Status, soweit konfiguriert. Er gibt keine Token oder Providerantworten zurück und triggert keine Neustarts.

OBS ist keine serverseitige Verbindung im betrachteten Laufzeitstatus: Widgets werden als Browserquellen über HTTP/SSE geladen. Daher wird kein OBS-Verbindungsstatus erfunden. `lastEventProcessedAt` ist seit dem Prozessstart zunächst `null`; der Ready-Status verlangt derzeit kein kürzlich verarbeitetes Chat-Event. Dieser Zeitstempel ist Diagnoseinformation, kein Frischekriterium.

## 6. Build, Tests und Regression

Tatsächlich ausgeführt:

- `npm run check`: **bestanden**; darin `npm run build` und `npm test`.
- `npm test`: **203 bestanden, 0 fehlgeschlagen**, einschließlich der hinzugefügten Token-, Readiness-, Routen- und Manifesttests.
- `npm run test:browser`: **5 bestanden, 0 fehlgeschlagen**. Abgedeckt waren Community World, Dashboard-Navigation/Logout, Chaos-Wheel-OBS, Elio sowie VIP Desktop/Mobil. Währenddessen erzeugte Screenshot-Änderungen im eigenen Arbeitsbaum wurden auf den Branchstand zurückgesetzt.
- `git diff --check`: bestanden, keine Whitespace-Fehler.

Es wurden keine Abhängigkeiten installiert oder aktualisiert. Keine Tests griffen auf Production-Datenbanken oder echte OAuth-Credentials zu. Die Browser-Suite prüft lokale App-Flows; sie beweist weder Twitch-Livebetrieb noch OBS in einem laufenden Stream.

## 7. Offene Risiken und Production-Schritte

Vor einem separaten, freigegebenen Production-Release:

1. Den zu veröffentlichenden Branch und Commit reviewen und in einem sauberen Release-Checkout bauen; anschließend Manifest mit echten Quell- und Runtime-Werten erzeugen und Build-Prüfsummen außerhalb des Quell-Repositories ablegen.
2. Auf dem Server aktuelle aktive Release-Verknüpfung, Runtime-Dateien und Caddy-Konfiguration read-only abgleichen. Vor jeder Änderung verifizieren, dass Backup und Rückfallziel tatsächlich existieren.
3. Caddy-Konfiguration mit installiertem Caddy `validate` prüfen und die Proxy-Routen gegen den lokalen statischen Test abgleichen.
4. SQLite-Backup und getesteten Rückfallpfad für Anwendung und Proxy dokumentieren, bevor Änderungen freigegeben werden.
5. Nach gesonderter Release-Freigabe die HTTPS-Routen, Liveness und geschützte Diagnose ohne echte Community-Aktionen prüfen. Keine Testnachricht und keine Redemption auslösen.

Der vorhandene Health-Hotfix-Bericht dokumentiert historisch den Code-Rollback-Link `/home/ubuntu/twitch-community-bot/dist.rollback-pre-2270094-20261015` auf `releases/e409596-20261015/dist` und ein Caddy-Backup `Caddyfile.backup-health-2270094-20261015`. Diese Pfade wurden in diesem Auftrag nicht auf dem Server verifiziert und dürfen vor einer Rückfallaktion nicht als aktuell vorausgesetzt werden.

## 8. Rollback und nicht ausgeführte Aktionen

Es wurde kein Production-Release begonnen, daher ist kein Production-Rollback erforderlich. Der lokale Implementierungsbranch kann nach Review über seinen Commit `9f3688383f7b64d3539eba54e6333737ccafefce` identifiziert werden; es gab keinen Push, Merge oder Reset. Datenbankschema und Migrationen wurden nicht geändert.

Nicht ausgeführt: Push/Merge, Deployment, PM2-Neustart, Caddy-Reload, Production-Datenbankzugriff oder -änderung, OAuth-Tokenwechsel, Live-Autorisierung, echte Twitch-Chatnachricht, OBS-Aktion und Discord-Änderung.
