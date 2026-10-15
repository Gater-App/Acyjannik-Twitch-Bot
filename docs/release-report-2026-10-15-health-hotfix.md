# ACY Twitch Bot — Health-Hotfix Release

Datum: 15.10.2026, ca. 09:06 UTC
Website: `https://twitch.gater-app.de`

## Veröffentlichung

- PR #9 wurde gemerged. Codecommit `886826ca7bd882eadceb629f86eaaa13f3f27746`; Runtime-Release-Mergecommit `22700942de6223d5f83508dd070272605a432e96`.
- PR #10 ergänzt die Caddy-Route für `/health`; Mergecommit `10e2be7ca71130d851eb5e8c7d1ff1728162a953`.
- Der Produktionsprozess verwendet Runtime-Code aus `/home/ubuntu/twitch-community-bot/releases/2270094-20261015/dist`.
- Der Produktions-Releaseordner wurde aus einem lokal gebauten Archiv übertragen. SHA-256: `b5c1feeadd4be04d9e0dc8bf573288dc5b028c06209fd96ada9186c514627aa5`.

## Änderungen

- `GET /health` liefert `{ "status": "alive" }`, setzt `Cache-Control: no-store` und erlaubt keine Schreibmethoden. Der Endpunkt bestätigt nur, dass der HTTP-Prozess antwortet.
- Die Community-Hilfe und Imposter-Seite erklären nun konsistent: Portalabstimmungen bleiben bis zur Auflösung geheim; `!sus @Name` im Twitch-Chat ist öffentlich.
- Caddy leitet `/health` jetzt ausdrücklich an `127.0.0.1:3001` weiter. Die übrigen Proxy-Routen wurden nicht geändert.

## Tests und Live-Verifikation

- `npm run build`: bestanden.
- `npm test`: 194/194 bestanden.
- `npm run test:browser`: 5/5 bestanden, einschließlich echter Dashboard-/Portal-Klickpfade auf Desktop und Mobil.
- `git diff --check`: bestanden.
- Oracle-Datenbank vor und nach Deployment: `integrity_check=ok`, Schema 32. Keine Migration ausgeführt.
- Caddy-Konfiguration validiert und per Reload übernommen.
- Öffentliche HTTP-Ergebnisse nach Deployment:

| Route | Status | Ergebnis |
|---|---:|---|
| `/health` | 200 | `{"status":"alive"}` |
| `/dashboard` | 302 | Login-Weiterleitung |
| `/dashboard/login` | 302 | OAuth-Start |
| `/dashboard/oauth/callback` ohne Parameter | 400 | Ungültiger Callback abgewiesen |
| `/streamer` | 302 | Geschützt |
| `/hilfe` | 200 | Erreichbar |
| `/community` | 200 | Erreichbar |
| `/` | 404 | Root-Seite ist nicht konfiguriert |

## Betrieb, Backup und Rollback

- `twitch-community-bot`: online, Node 24.21.0, Restart-Zähler 20.
- `acy-discord-bot`: online, PID und Restart-Zähler gegenüber dem Preflight unverändert; kein Zugriff auf seinen Checkout oder Prozess.
- Vor dem Umschalten erstelltes, integritätsgeprüftes SQLite-Backup: `/home/ubuntu/twitch-community-bot/backups/community-bot-2026-10-15T09-04-04-377Z.sqlite`, Modus `0600`.
- Code-Rollback-Link: `/home/ubuntu/twitch-community-bot/dist.rollback-pre-2270094-20261015` zeigt auf `/home/ubuntu/twitch-community-bot/releases/e409596-20261015/dist`.
- Caddy-Konfigurationsbackup: `/etc/caddy/Caddyfile.backup-health-2270094-20261015`.
- Der Twitch-Bot wurde einmal kontrolliert neu gestartet; Caddy wurde neu geladen. Es wurde keine Chatnachricht manuell gesendet und kein Live-Spiel oder OBS-Effekt ausgelöst.

## Grenzen

- Der Healthcheck misst keine SQLite-, Twitch-, EventSub- oder OBS-Verbindung.
- Es wurde keine interaktive OAuth-Anmeldung abgeschlossen.
- Die Tests belegen lokale Regressionen; echte Twitch-/Spotify-/OBS-Stagingabläufe bleiben separat offen.
- Bestehende lokale Screenshot-Änderungen und `artifacts/` wurden nicht committed oder deployed.
