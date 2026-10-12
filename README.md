# Twitch Halloween Bot – Yannick 🎃

Ein eigenständiger, schlanker Twitch-Chatbot für ein virtuelles Halloween-Spiel.
Der Bot vergibt ausschließlich Kürbispunkte – kein Echtgeld, keine Preise und
keine öffentliche Admin-API.

## Enthalten

- `!trickortreat` mit TREAT, TRICK, JACKPOT, GHOST, WITCH, EMPTY HOUSE und GOLDEN PUMPKIN
- persistent gespeicherte Punkte und Cooldowns in SQLite
- Twitch-User-ID als Primärschlüssel, Anzeigename nur für Antworten
- EventSub WebSocket für Chat-Events und Helix Send Chat Message API für Antworten
- OAuth Authorization Code Flow mit Refresh-Token-Rotation und lokaler Token-Datei
- Deduplizierung von EventSub-Events und Ignorieren eigener Bot-Nachrichten
- case-insensitive Befehle, Moderator-Rechte, sichere Reset-Bestätigung und Backup
- Testmodus ohne Twitch-Verbindung
- UTF-8-/Braille-Art-Loader mit Zeichenprüfung und kontrolliertem Chat-Splitting
- Dockerfile, Compose-Datei und persistente Volumes

## 1. Lokal installieren und starten

Voraussetzung ist Node.js 24 LTS oder neuer.

```bash
npm install
cp .env.example .env
npm run check
```

Für einen lokalen Chat-Simulator:

```bash
npm run test-mode
```

Beispiele im Testmodus:

```text
!startHalloween
alice|Alice|!trickortreat
alice|Alice|!pumpkins
alice|Alice|!top
!endHalloween
```

Der Testmodus verwendet `DATABASE_PATH` aus `.env`. Für einen frischen Lauf
kann eine separate Datei wie `data/test.sqlite` verwendet werden.

## 2. Twitch-Konto und Developer-App

1. Für Yannicks Kanal ein separates Twitch-Bot-Konto anlegen oder verwenden.
2. Das Bot-Konto muss Yannicks Chat beitreten können. Für ein getrenntes
   Bot-Konto sollte es als Moderator oder VIP zugelassen werden; das ist für die
   Kanalberechtigung und die normalen Chat-Ratelimits relevant.
3. Im [Twitch Developer Console](https://dev.twitch.tv/console/apps) eine
   Anwendung anlegen.
4. Als OAuth-Redirect-URL exakt den Wert aus `TWITCH_REDIRECT_URI` eintragen,
   lokal zunächst `http://127.0.0.1:3000/oauth/callback`.
5. `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL_LOGIN=yannick`
   und `TWITCH_BOT_LOGIN` in `.env` setzen.

## 3. OAuth-Verbindung durchführen

Live starten:

```bash
npm run dev
```

Wenn noch kein Token vorhanden ist, meldet der Bot eine lokale Autorisierungs-URL.
Diese im Browser öffnen und mit dem separaten Bot-Konto bestätigen. Alternativ
ist sie während des Betriebs unter `http://127.0.0.1:3000/oauth/start` erreichbar.

Der Bot fordert für die angeforderte WebSocket-/Chat-Client-Variante nur
`user:read:chat` und `user:write:chat` an. Access- und
Refresh-Token werden nicht geloggt. Nach dem OAuth-Flow liegt der rotierende
Token in `TOKEN_FILE` (standardmäßig `data/oauth-tokens.json`, Dateirechte 0600).
Die Datei muss in Backups und bei Cloud-Übertragung genauso geschützt werden
wie `.env`.

Die Umsetzung folgt Twitchs aktueller Chat-Client-Dokumentation:

- [Authenticating and Setting up EventSub](https://dev.twitch.tv/docs/chat/authenticating/)
- [Sending and Receiving Chat Messages](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [EventSub Subscription Types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [OAuth Authorization Code Flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Refreshing Access Tokens](https://dev.twitch.tv/docs/authentication/refresh-tokens/)

Für die WebSocket-Variante wird ein User-Access-Token des autorisierten
Chat-/Bot-Kontos verwendet. Der Bot legt danach `channel.chat.message` für
Yannicks Kanal und die Bot-User-ID an. Für Antworten werden `broadcaster_id`
und `sender_id` an Helix übergeben.

Twitch unterscheidet daneben aktuell einen „Cloud Chatbot“: Dafür beschreibt
Twitch eine App-Authorization des Bot-Kontos mit `user:read:chat`,
`user:write:chat`, `user:bot` sowie eine separate Broadcaster-Authorization mit
`channel:bot`; für Cloud Chatbots empfiehlt Twitch EventSub Webhooks statt
WebSockets. Dieses Projekt implementiert bewusst die angeforderte einzelne
WebSocket-Verbindung für einen schlanken Ein-Kanal-Bot. Wenn Twitch die
separate Bot-Authorization in Yannicks Kanal damit ablehnt, darf nicht einfach
ein zusätzlicher Scope in Produktion ergänzt werden; dann muss vorab zwischen
Moderator/VIP-WebSocket-Betrieb und einer späteren Cloud-Webhook-Erweiterung
entschieden werden.

## 4. Befehle testen

| Befehl | Wirkung |
|---|---|
| `!trickortreat` | Spielt einmal, sofern Halloween aktiv ist und der Cooldown abgelaufen ist |
| `!pumpkins` | Zeigt den eigenen Punktestand |
| `!top` | Zeigt die Top 10 |
| `!halloween` | Zeigt Status, Regeln und Cooldown |
| `!startHalloween` | Yannick oder autorisierter Moderator |
| `!endHalloween` | Yannick oder autorisierter Moderator; nennt den Gewinner |
| `!resetHalloween` | Nur Yannick; fordert eine separate `CONFIRM`-Bestätigung an |

`!resetHalloween` löscht keine Datei. Nach der Bestätigung wird zuerst ein
SQLite-Backup unter `backups/` erstellt, danach werden Punkte und Cooldowns in
einer Transaktion auf null gesetzt.

## 5. Docker

```bash
cp .env.example .env
# .env ausfüllen
docker compose up -d --build
docker compose logs -f halloween-bot
```

`halloween-data` hält SQLite und OAuth-Token persistent; `halloween-backups`
hält die Reset-Backups. Niemals `docker compose down -v` verwenden, wenn diese
Daten erhalten bleiben sollen.

Für einen Cloud-Server sollte OAuth über eine eigene HTTPS-Domain bzw. einen
Reverse Proxy geführt werden. Dann `TWITCH_REDIRECT_URI` und die Twitch-App auf
dieselbe HTTPS-Callback-URL setzen, den OAuth-Port nur lokal am Proxy erreichbar
machen und das Token- sowie Datenvolume sichern. Der Bot hat keine Dashboard-
oder Admin-Routen; `/oauth/start` und `/oauth/callback` dienen ausschließlich
dem OAuth-Flow.

## 6. Logs und Fehlerbehebung

- `Twitch-OAuth ist abgelaufen`: `/oauth/start` erneut öffnen; der Refresh-Token
  wird bei gültiger Authorization automatisch verwendet.
- `Kanal- oder Bot-Konto nicht gefunden`: Logins prüfen; keine Anzeigenamen als
  Primärschlüssel oder feste User-ID erfinden.
- EventSub `403`: prüfen, ob das Bot-Konto autorisiert ist, dem Kanal beitreten
  kann und nicht gebannt/timeoutet ist.
- Antworten erscheinen nicht: `TWITCH_BOT_USER_ID`, Scopes und die Twitch-API-
  Fehlermeldung prüfen. Chatantworten werden bewusst seriell mit einem
  konservativen Abstand von 1,5 Sekunden gesendet.
- Bei Neustart bleibt `DATABASE_PATH` unverändert; so bleiben Punkte und
  Cooldowns erhalten.

## ASCII-/Braille-Art

Die Vorlagen liegen unter [`assets/ascii-art/`](assets/ascii-art/). Die vier
Originalgrafiken wurden noch nicht geliefert; dafür existieren die Dateien
`original-01.txt` bis `original-04.txt` als klar markierte Platzhalter. Beim
Import die gelieferten Originale bytegetreu als UTF-8 ersetzen. Der Loader
bewahrt führende Leerzeichen und Unicode-Zeichen und verweigert zu lange
Chatblöcke. Große Varianten bleiben für ein späteres OBS-Overlay verfügbar.

## Entwicklung und Tests

```bash
npm run build
npm test
npm run check
```

Die Tests decken deterministische Ereignisse, Punkte, Cooldowns, Deduplizierung,
Rangliste, Start/Ende, Berechtigungen, Reset-Backup, Neustart-Persistenz,
Unicode-Art, OAuth-Tokenrotation, Nachrichtenlimits und Sendewarteschlange ab.

## Erster echter Test

1. Bot-Konto und Developer-App anlegen.
2. `.env` ohne echte Tokens committen und lokal OAuth abschließen.
3. Yannicks Kanal öffnen und mit `!startHalloween` aktivieren.
4. Mit einem zweiten Zuschauer-Konto `!trickortreat` testen.
5. `!pumpkins`, `!top`, Cooldown und `!endHalloween` prüfen.
6. Erst danach den Prozess als Dienst bzw. per Docker auf einen Server verschieben.

Es wird nichts automatisch auf einem öffentlichen Server deployed und der Bot
sendet ohne deine separate Zustimmung keine Nachrichten in Yannicks Kanal.
