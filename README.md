# Yannick Twitch Community Bot 🎃⭐

Ein einzelner, modularer Node.js-Prozess für Yannicks Twitch-Chat: Das bestehende
Halloween-Spiel bleibt erhalten; saisonale Sammel-Events, XP, Minispiele,
Community-Boss, eigene Chatbefehle und ein OAuth-geschütztes Admin-Dashboard
kommen hinzu. SQLite speichert Spielstände persistent. Es gibt keine Echtgeld-
oder Sachpreisverlosungen.

## Funktionen

- Halloween mit `!trickortreat`, `!pumpkins`, `!top`, den vorhandenen
  Zufallsereignissen und den UTF-8-/Braille-Grafiken
- Saisonale Events für Weihnachten (`!gift`) und Ostern (`!egghunt`),
  getrennte Punktestände, Event-Ranglisten, Zeitplanung und eigene Events
- XP und Level mit Nachrichten-Cooldown, Deduplizierung, Anti-Spam und
  begrenzten Spiel-Belohnungen
- `!level [@user]`, `!xptop`, `!rank`, `!8ball`, `!rps`, `!startguess` / `!guess`,
  `!duel` / `!accept` / `!cancelduel`
- Kooperativer Boss mit `!startboss`, `!attack`, `!boss`, `!bosstop` und
  `!endboss`; Angriffe und einmalige Belohnungen werden transaktionssicher gespeichert
- Eigene Chatbefehle mit Berechtigungsstufe, Alias, Cooldown, Ablauf und sicheren
  Platzhaltern (`{user}`, `{channel}`, `{game}`, `{uptime}`)
- Responsives Admin-Dashboard für Status, Module, Events, Nutzer-XP,
  protokollierte Korrekturen und Chatbefehle; Twitch-OAuth, feste User-ID-Allowlist,
  HttpOnly-/Secure-Cookies, SameSite, CSRF-Prüfung, Rate-Limit und Logout
- Persistenter, typisierter Community-Event-Feed mit authentifiziertem SSE-Endpunkt
  als Grundlage für spätere OBS-Overlays
- Versionierte SQLite-Migrationen im WAL-Modus; vorhandene Halloween-Punkte und
  Cooldowns werden übernommen und nicht zurückgesetzt
- Docker-/Compose-Betrieb für ARM64, Healthcheck, persistente Volumes,
  begrenzte Containerlogs sowie geprüfte Backup-/Restore-Skripte

## Lokal starten und testen

Voraussetzung ist Node.js 24 oder neuer.

```bash
npm ci
cp .env.example .env
npm run check
```

Ein Chat-Simulator benötigt keine Twitch-Verbindung:

```bash
DATABASE_PATH=data/test.sqlite npm run test-mode
```

Beispiele im Simulator:

```text
!startHalloween
alice|Alice|!trickortreat
alice|Alice|!pumpkins
!endHalloween
!startguess
alice|Alice|!guess 42
```

`DATABASE_PATH` sollte für Testläufe von der späteren Live-Datenbank getrennt
sein. Die Tests versenden keine echten Twitch-Nachrichten.

## Twitch-App und Chat-OAuth

1. Eine Twitch-Developer-App anlegen oder eine vorhandene App verwenden.
2. In der Developer Console die Redirect-URLs aus der lokalen oder
   Server-Konfiguration eintragen. Twitch verlangt einen exakten Treffer.
3. Ein Bot-Konto in `.env` als `TWITCH_BOT_LOGIN` eintragen. Es muss Yannicks
   Chat beitreten dürfen; für den hier verwendeten WebSocket-Betrieb sollte es
   im Kanal als Moderator oder VIP zugelassen sein.
4. `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL_LOGIN` und
   `TWITCH_BOT_LOGIN` setzen. Keine Secrets in Git committen.
5. `npm run dev` starten und die vom Bot gemeldete OAuth-URL mit dem Bot-Konto
   autorisieren. Der rotierende Token wird mit Dateirechten `0600` in
   `TOKEN_FILE` gespeichert.

Für den Chat benötigt die Anwendung `user:read:chat user:write:chat` und nutzt
EventSub WebSocket plus Helix Send Chat Message. Sie legt keine öffentliche
EventSub-Webhook-Adresse an. OAuth- und Chat-Token werden nicht im Dashboard,
Chat oder Abschlussbericht angezeigt.

## Admin-Dashboard

Das Dashboard startet nur, wenn `DASHBOARD_ADMIN_IDS`,
`DASHBOARD_REDIRECT_URI`, `TWITCH_CLIENT_ID` und `TWITCH_CLIENT_SECRET` gesetzt
sind. Die Allowlist enthält numerische Twitch User-IDs, niemals Login-Namen.
Twitchs OAuth-Callback und das Dashboard verwenden dieselbe Developer-App,
aber unterschiedliche, exakt eingetragene Redirect-URLs.

Für eine lokale Einrichtung:

```dotenv
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3001
DASHBOARD_REDIRECT_URI=http://localhost:3001/dashboard/oauth/callback
DASHBOARD_ADMIN_IDS=DEINE_NUMERISCHE_TWITCH_USER_ID
```

Im Browser `http://localhost:3001/dashboard/login` öffnen. Der Dashboard-Token
wird nur während des serverseitigen OAuth-Checks verwendet; die Sitzung bleibt
als zufällige, serverseitig gespeicherte Session bis zu 12 Stunden im Speicher.
Ein Neustart meldet bestehende Dashboard-Sitzungen ab. Dashboard-Änderungen
werden in `admin_audit` protokolliert. Das Dashboard ist standardmäßig an
`127.0.0.1` gebunden und nicht für das öffentliche Netz gedacht.

Die Oberfläche umfasst Statusanzeige und Aktualisierung, Modul-Schalter,
Eventstart/-ende und Eventanlage, XP-Korrekturen, Nutzer-XP-Suche und
Custom-Command-Verwaltung sowie erweiterte JSON-Einstellungen für XP-Kurve,
Leveltitel, Minispiele, 8-Ball-Antworten und Eventregeln. Derzeit werden `{game}` und `{uptime}` bei eigenen
Chatantworten als „unbekannt“ ausgegeben, bis verlässliche Twitch-Daten
angeschlossen sind.

## Befehle

| Befehl | Wirkung / Berechtigung |
|---|---|
| `!trickortreat`, `!pumpkins`, `!top`, `!halloween` | Bestehendes Halloween-Spiel und Kürbisrangliste |
| `!startHalloween`, `!endHalloween` | Yannick oder autorisierte Mods; nur ein primäres Sammel-Event gleichzeitig |
| `!resetHalloween CONFIRM` | Nur Yannick; legt vorher ein SQLite-Backup an; betrifft nur Halloween-Punkte |
| `!gift`, `!egghunt` | Sammelbefehl des aktiven Weihnachts- bzw. Oster-Events |
| `!eventscore [event-id]`, `!eventtop [event-id]` | Punktestand bzw. Event-Rangliste |
| `!startevent ID`, `!endevent ID` | Yannick oder Mods; beendet Events archiviert statt sie zu löschen |
| `!level [@user]`, `!xptop`, `!rank` | XP-Stand, Topliste und Rang |
| `!8ball FRAGE`, `!rps schere\|stein\|papier` | Chat-Minispiele; Cooldowns, serverseitige Zufallswahl und XP-Tageslimit |
| `!startguess`, `!guess ZAHL` | Mod startet eine persistente Zahlenrunde; Teilnehmer haben begrenzte Versuche |
| `!duel @user`, `!accept`, `!cancelduel` | Zufälliges Duell ohne Einsatz; Annahme läuft ab |
| `!startboss [Name]`, `!attack`, `!boss`, `!bosstop`, `!endboss` | Kooperativer Bosskampf; Start/Ende nur Yannick oder Mods |
| `!addcommand name \| Antwort` | Nur Yannick; eigene Antwort mit sicheren Platzhaltern |
| `!setcommand name \| Antwort`, `!delcommand name` | Yannick; Mods dürfen nur ausdrücklich freigegebene Befehle verwalten |

## Docker und Oracle Cloud ARM64

Die Compose-Datei bindet OAuth- und Dashboard-Port ausschließlich an Loopback
des Hosts (`127.0.0.1`). Die bestehenden Volume-Namen `halloween-data` und
`halloween-backups` bleiben erhalten. Das Dockerfile nutzt Node 24 und kann für
ARM64 gebaut werden.

```bash
cp .env.example .env
# .env mit Twitch- und Dashboard-Werten ausfüllen
docker compose up -d --build halloween-bot
docker compose ps
docker compose logs -f halloween-bot
```

Für öffentliches HTTPS zuerst eine Domain auf die VM zeigen lassen, in `.env`
`BOT_DOMAIN`, `TWITCH_REDIRECT_URI=https://DEINE-DOMAIN/oauth/callback` und
`DASHBOARD_REDIRECT_URI=https://DEINE-DOMAIN/dashboard/oauth/callback` setzen
und beide URLs in der Twitch-App registrieren. Danach im Cloud-Firewall-/NSG-
Ingress nur SSH (bevorzugt eigene Quell-IP), TCP 80 und TCP 443 freigeben.
Keinen eingehenden Port 3000 oder 3001 öffnen. SSH-Schlüssel, deaktivierte
Passwortanmeldung und kein Root-Login werden empfohlen.

Caddy stellt TLS bereit und leitet ausschließlich OAuth- und Dashboard-Pfade an
die internen Container weiter:

```bash
docker compose --profile https up -d --build
```

Port 80/443 werden mit dem HTTPS-Profil öffentlich gebunden. Ohne Domain kann
das Dashboard per SSH-Tunnel administriert werden, z. B.:

```bash
ssh -L 3001:127.0.0.1:3001 ubuntu@DEINE-VM
```

Dann lokal `http://localhost:3001/dashboard/login` öffnen. Oracle-Kapazität und
Always-Free-Verfügbarkeit hängen von Region, Kontingent und freier Ampere-
Kapazität ab; dieses Projekt legt keine Oracle-Ressourcen automatisch an.

### Backup und Wiederherstellung

Ein konsistentes, integritätsgeprüftes SQLite-Backup erstellen:

```bash
docker compose exec -T halloween-bot node scripts/backup.mjs
```

Backupdateien liegen im persistenten Volume `/app/backups` und haben restriktive
Dateirechte. `.env` und `data/oauth-tokens.json` enthalten separate Secrets und
müssen außerhalb des Repositories zusätzlich geschützt gesichert werden.

Vor der Wiederherstellung den Bot stoppen. Das Skript prüft die Quelldatei und
legt vom bestehenden Ziel automatisch eine `before-restore`-Sicherung an:

```bash
docker compose stop halloween-bot
docker compose run --rm --no-deps --entrypoint node halloween-bot \
  scripts/restore.mjs /app/backups/DATEINAME.sqlite
docker compose up -d --build halloween-bot
```

`docker compose down -v` löscht die persistenten Volumes und ist für normale
Updates nicht erforderlich. Updates erfolgen mit `docker compose up -d --build`.

## Entwicklung und Tests

```bash
npm run build
npm test
npm run check
```

Die Tests decken die erhaltene Halloween-Mechanik, Migration, Neustart-
Persistenz, XP-Deduplizierung/Anti-Spam, Eventwechsel/-archivierung,
Minispielbefehle, Duel-Timeout, Boss-Angriffe und einmalige Belohnung,
Custom-Command-Validierung, Dashboard-OAuth-Allowlist, Sessions, CSRF,
Logout, Unicode-Art und Chatlimits ab. Twitch- und Dashboard-OAuth werden in
Tests simuliert; keine echten Chatnachrichten werden gesendet.

Ein öffentlicher Oracle-Deploy oder ein echter Twitch-Kanaltest wird nicht
automatisch ausgelöst. Vor dem Livegang müssen die Twitch-App, Redirect-URLs,
Bot-Konto, Admin-User-ID-Allowlist, Domain/DNS, HTTPS, Firewall und Server-
Secrets vom Betreiber gesetzt und geprüft werden.
