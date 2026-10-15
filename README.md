# Jannik Twitch Community Bot 🎃⭐

Die vollständige Chat-Befehlsübersicht steht in [COMMANDS.md](COMMANDS.md). Im Chat zeigt `!help` das Themenmenü, z. B. `!help games` oder `!help detective` die Details. `!community` führt zum öffentlichen [Community-Portal](https://twitch.gater-app.de/community); die öffentliche Hilfe bleibt unter `/hilfe` verfügbar.

Ein einzelner, modularer Node.js-Prozess für Janniks Twitch-Chat: Das bestehende
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
- Optionale Begrüßung neuer Chatter mit `{user}`-Platzhalter; standardmäßig aus,
  pro Twitch-ID höchstens einmal je 365 Tage und ohne Speicherung von Chattexten
- Moderierte Zuschauer-Quests mit persistenten Status, Cooldowns, Warteschlange,
  expliziter Freigabe/Start und einmaliger XP-Belohnung bei erfolgreichem Abschluss
- Botinterne Chat- und Quest-Abstimmungen mit einer Stimme pro Twitch-User-ID,
  optionaler Stimmenänderung, Timer, Neustart-Persistenz und manueller Entscheidung
  bei Gleichstand
- Zwei transparente, responsive OBS-Browserquellen für Live-Quest und Umfrage;
  Echtzeitupdates, reconnect-fähige Snapshots und widerrufbare, widgetgebundene
  Lesetokens
- Persistenter, typisierter Community-Event-Feed mit authentifiziertem SSE-Endpunkt
  als Grundlage für spätere OBS-Overlays
- Optionaler, regelbasierter Gesprächs-Funken für gemeinsame Gaming-Themen; standardmäßig deaktiviert, mit Moderatorfreigabe und ohne gespeicherte Chatinhalte
- Freiwillige Chat-Minispiele: Chat-Imposter mit geheimer, persönlich per Twitch-OAuth abrufbarer Rolle; Chat-Detektiv mit einzeln eingereichten, moderierten Zitaten. Beide starten deaktiviert.
- Persistente Runden, eindeutige Twitch-User-IDs, abstimmungs-/tippbasierte Auflösung und idempotente XP-Awards über das bestehende XP-Ledger
- Zwei zusätzliche transparente OBS-Widgets mit eigenen widerrufbaren Lesetokens; öffentliche Snapshots enthalten während des Spiels weder Imposter noch geheime Regel oder Zitatautor
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

Die neuen Minispiele lassen sich ohne Twitch-Verbindung mit synthetischen
Teilnehmern durchspielen:

```bash
npm run demo:games
```

`DATABASE_PATH` sollte für Testläufe von der späteren Live-Datenbank getrennt
sein. Die Tests versenden keine echten Twitch-Nachrichten.

## Twitch-App und Chat-OAuth

1. Eine Twitch-Developer-App anlegen oder eine vorhandene App verwenden.
2. In der Developer Console die Redirect-URLs aus der lokalen oder
   Server-Konfiguration eintragen. Twitch verlangt einen exakten Treffer. Für
   die spätere Teilnehmer-Rollenanmeldung zusätzlich
   `http://localhost:3001/games/imposter/callback` (lokal) und
   `https://DEINE-DOMAIN/games/imposter/callback` (Server) eintragen.
3. Ein Bot-Konto in `.env` als `TWITCH_BOT_LOGIN` eintragen. Es muss Janniks
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

`AUTHORIZED_MODERATOR_IDS` kann numerische Twitch-IDs berechtigter Mods
enthalten. Diese Konten erhalten nach Twitch-OAuth ausschließlich die separate
Ansicht „Chaos & Pranks“; Admin-APIs, Fairnessdaten und Streamer-Steuerung bleiben
gesperrt. Die vier Pranks sind standardmäßig ausgeschaltet und müssen dort einzeln
aktiviert werden.

Die Oberfläche umfasst Statusanzeige und Aktualisierung, Modul-Schalter,
Eventstart/-ende und Eventanlage, XP-Korrekturen, Nutzer-XP-Suche und
Custom-Command-Verwaltung sowie erweiterte JSON-Einstellungen für XP-Kurve,
Leveltitel, Minispiele, 8-Ball-Antworten, Eventregeln, Quest-Cooldowns, Warteschlangen-
und Einreichungsgrenzen sowie Abstimmungsdauer. Derzeit werden `{game}` und `{uptime}` bei eigenen
Chatantworten als „unbekannt“ ausgegeben, bis verlässliche Twitch-Daten
angeschlossen sind.

## Quests, Chat-Umfragen und OBS

Zuschauer reichen mit `!quest AUFGABE` einen Vorschlag ein. Er bleibt zunächst
privat in der Dashboard-Warteschlange und erscheint erst nach Janniks Freigabe
und ausdrücklichem Start im Stream. Texte werden begrenzt und auf Steuerzeichen,
Markup und problematische Unicode-Richtungszeichen geprüft. Cooldown,
Warteschlangenlimit, offene Vorschläge pro Person und Moderatorrechte werden in
    den Dashboard-Einstellungen konfiguriert.

Jannik kann im Dashboard Quests filtern, bearbeiten, genehmigen, ablehnen,
„Als Nächstes“ markieren, starten, abschließen, als gescheitert markieren oder
überspringen. Ein erfolgreicher Abschluss gewährt die konfigurierte XP-Belohnung
genau einmal. Optional kann eine Umfrage aus zwei bis fünf freigegebenen Quests
gestartet werden; die Gewinnerquest wird nur markiert und niemals automatisch
gestartet.

Die Karte **Community-Minispiele** steuert Freigabe, Rundenstart, Rollenvergabe,
Abstimmung, Detektiv-Runden und Zitatmoderation. Dort lassen sich außerdem
Rundenzeiten, XP-Werte und der sichere Regelpool konfigurieren. Zum Starten
müssen `DASHBOARD_REDIRECT_URI` und die zusätzliche Twitch-Callback-URL
`/games/imposter/callback` denselben öffentlichen Host verwenden. Bei jedem
Rollenaufruf meldet sich der Teilnehmer mit Twitch an; der Server liest die
verifizierte Twitch-User-ID und gibt nur die zugehörige eigene Rolle aus. Der
kurzlebige Browserzugang ist serverseitig gespeichert, enthält keine Rolle in
URL oder Client-API und muss nach einem Bot-Neustart erneut angemeldet werden.

Chatbefehle: `!startimposter`, `!joinimposter`, `!leaveimposter`,
`!imposterstatus`, `!closeimposter`, `!sus @Name` und `!cancelimposter`.
Zitate: `!quoteoptin` aktiviert die Möglichkeit zur Einreichung, speichert aber
keinen Chat. Nur `!savequote TEXT` speichert genau diesen Text; er bleibt bis zur
Dashboard-Freigabe unsichtbar. `!myquotes` zeigt die eigenen Zitat-IDs.
`!quoteoptout` löscht sämtliche eigenen Zitate und widerruft die Einwilligung;
`!deletequote ID` löscht einzeln. Detektiv:
`!startdetektiv`, `!detektiv`, `!wer @Name`, `!enddetektiv`.

Im OBS-Bereich je ein Token für **Imposter** und **Detektiv** erzeugen. Caddy
leitet die Teilnehmerseiten unter `/games/*` per HTTPS zum bestehenden Dashboard-
Webserver im selben Bot-Prozess weiter. Für den
Imposter wird vor der Auflösung nur Phase, Teilnehmerzahl und Stimmzahl gezeigt;
für den Detektiv wird der freigegebene Zitattext gezeigt, nicht der Autor. Die
Identität erscheint erst in der Auflösung. Token-URL nicht öffentlich teilen;
Erneuern widerruft die vorherige URL.

### Begrüßung neuer Chatter

Im Dashboard lässt sich eine zurückhaltende Willkommensnachricht aktivieren und
anpassen. Sie erscheint bei der ersten normalen Chatnachricht eines Kontos im
aktiven 365-Tage-Aufbewahrungsfenster; Befehle werden nicht abgefangen. Bereits
im XP-System bekannte Konten werden beim Upgrade als zuvor gesehen übernommen.
Gespeichert werden ausschließlich Twitch-User-ID und Zeitpunkt. Das Feature ist
nach der Migration zunächst ausgeschaltet und muss für den gewünschten Stream
im Dashboard ausdrücklich aktiviert werden.

Datensparsamkeit: Es werden keine Chatverläufe mitgeschnitten. Nur explizit
eingereichte Zitate, Twitch-User-ID/Login/Anzeigename, Einreichungs-/Ablaufzeit,
Freigabestatus und Verwendung werden bis zur Löschung beziehungsweise maximal
zur konfigurierten Aufbewahrung gespeichert (Standard 90 Tage). Das Löschen
oder Opt-out entfernt Zitate unmittelbar aus dem Pool und beendet eine gerade
laufende Runde mit diesem Zitat. Vor öffentlicher Aktivierung muss Jannik die
Teilnehmerinformation und Datenschutzhinweise prüfen/anpassen; diese technische
Implementierung ist keine pauschale DSGVO-Konformitätszusage.

Chat-Umfragen werden im Dashboard erstellt und beendet. Zuschauer sehen Frage
und Optionen mit `!poll`, stimmen mit `!vote 1` bis `!vote 5` ab und sehen den
Stand mit `!pollresults`. Die Laufzeit und das Ändern einer Stimme sind
konfigurierbar. Umfragen sind botintern; der Bot erstellt keine native Twitch-
Umfrage.

Für OBS im Dashboard die Quest- bzw. Umfrage-Widget-URL erzeugen und kopieren.
In OBS eine **Browserquelle** hinzufügen, die passende URL einsetzen und als
Breite/Höhe beispielsweise `1920 × 1080` oder `2560 × 1440` wählen. Der
Hintergrund ist transparent; Größe und Position werden anschließend direkt in
OBS angepasst. Die Vorschau im Dashboard zeigt den aktuellen Inhalt. Die URL
enthält ein geheimes, nur lesendes Token: nicht öffentlich teilen. Erneuern
widerruft die vorherige URL sofort; danach muss die URL auch in OBS ersetzt
werden. Keine Dashboard-Anmeldung oder Twitch-Berechtigung wird in der
Widget-URL gespeichert.

Die Widgets verbinden sich per Server-Sent Events und holen bei einer
Neuverbindung selbstständig einen aktuellen Snapshot. Wenn keine Quest oder
Umfrage sichtbar ist, blendet sich die Browserquelle aus. Der Browser-Widget-
Endpunkt muss von OBS über dieselbe erreichbare HTTPS-Adresse aufrufbar sein;
bei rein lokalem Dashboard funktioniert er nur auf diesem Rechner.

## Twitch-Kanalpunkte-Quests

Die Integration ist standardmäßig ausgeschaltet. Für Verwaltung, Custom-Reward-
EventSub und Erfüllung/Stornierung braucht sie ein separates Broadcaster-Token
von Janniks Twitch-Konto mit ausschließlich `channel:manage:redemptions`. Der
bestehende Chat-Bot-OAuth mit `user:read:chat user:write:chat` bleibt getrennt
und wird nicht erweitert. Im Dashboard unter **Kanalpunkte-Quests** auf
„verbinden/neu autorisieren“ klicken und Jannik selbst das angezeigte Twitch-
OAuth genehmigen lassen. Redirect-URL:
`TWITCH_REDEMPTION_REDIRECT_URI` (bei HTTPS exakt
`https://DEINE-DOMAIN/oauth/redemptions/callback`). Den Redirect zusätzlich in
der Developer Console eintragen. Der geschützte Dashboard-Start erzeugt einen
einmaligen OAuth-State; der Token wird mit restriktiven Dateirechten getrennt
unter `TWITCH_REDEMPTION_TOKEN_FILE` gespeichert und nie im Dashboard oder Log
angezeigt. Der kurzlebige State liegt separat neben der Token-Datei in einer
Datei mit Endung `.oauth-state`, wird nach Callback einmalig verbraucht und
überlebt dadurch einen Bot-Neustart während der Twitch-Anmeldung.

### Lokale Runtime-Secrets

Das Verzeichnis `data/` ist vollständig von Git ausgeschlossen. Dort liegen die
Twitch-Datei `data/oauth-tokens.json`, ihre Broadcaster- und VIP-Varianten
`.broadcaster` und `.vip`, die daraus abgeleiteten `.oauth-state`-Dateien samt
atomaren `.tmp-*`-Schreibdateien sowie `data/spotify-tokens.json`. Dashboard- und
Imposter-Sitzungen liegen im Arbeitsspeicher beziehungsweise in SQLite; sie
werden nicht als separate Sitzungsdateien angelegt. Werte für
`TOKEN_FILE`, `TWITCH_REDEMPTION_TOKEN_FILE`, `TWITCH_VIP_TOKEN_FILE` und
`SPOTIFY_TOKEN_FILE` sollen innerhalb des Runtime-Verzeichnisses bleiben.
Git-Ignore-Regeln schützen keine individuell außerhalb des Repositorys
konfigurierten Dateipfade; solche Dateien müssen außerhalb des Repositories
abgelegt und durch Dateirechte geschützt werden.

Danach im Dashboard entweder einen **von dieser Twitch-App verwaltbaren**,
aktivierten Reward mit verpflichtender Texteingabe und manueller
Einlösungswarteschlange auswählen oder ausdrücklich „Quest für Jannik 🎯“
erstellen. Die Standardkosten sind 2.000 Punkte und lassen sich im Dashboard
ändern. Es gibt keine Erstellung beim Bot-Start. Vor der Erstellung werden
vorhandene Rewards auf denselben Namen geprüft. Reward-ID und Einstellungen
werden lokal in SQLite gespeichert. Für die EventSub-Redemption darf die App
nur Redemptions eines Rewards verwalten, den dieselbe Developer-App erstellt
hat; daher werden nur „manageable“ Rewards zur Auswahl angeboten.

Twitch-Einlösungen werden anhand EventSub-Typ, Broadcaster-ID, Reward-ID,
Eingabe und eindeutiger Redemption-ID geprüft. Die Texteingabe landet erst in
der privaten Quest-Warteschlange des geschützten Dashboards; Chat und OBS zeigen
sie nicht vor Freigabe/Start. SQLite dedupliziert dauerhaft. Bei Neustart fragt
der Bot offene Twitch-Einlösungen ab und gleicht ausstehende Statusaktionen vor
einem erneuten PATCH zuerst über den aktuellen Twitch-Status ab.

Eine Quest-Freigabe markiert die Einlösung standardmäßig als erfüllt, startet
aber **nicht** die Quest im Stream; die vorhandenen Quest-Schritte „Starten“ und
OBS-Widget bleiben eine getrennte ausdrückliche Aktion. Wird eine Quest
abgelehnt, versucht der Bot nur bei einem verwaltbaren, noch `UNFULFILLED`
Reward die Redemption auf `CANCELED` zu setzen. Das ist Twitchs
Rückerstattungsmechanismus, keine eigene Punktebuchung. Bei HTTP 403, unbekanntem
Twitch-Status oder nicht verwaltbarem Reward wird kein Refund versprochen: Der
Fall bleibt sichtbar als manuell zu klären. 401/429/5xx und Netzfehler bleiben
als sicher wiederholbare Status gespeichert; ein Retry liest den Twitch-Status
zuerst erneut. „Fehler sicher abgleichen“ im Dashboard wiederholt keine blinde
Twitch-Aktion.

Damit wird Janniks Kanal geändert. Die Erstellung des Rewards und die
Aktivierung erfordern jeweils eine eigene bewusste Dashboard-Aktion. Bis OAuth,
Reward-ID und die Datenschutzhinweise geprüft sind, Kanalpunkte deaktiviert
lassen. Für den ersten echten Test die Kosten niedrig setzen, eine Einlösung
mit Testtext durchführen, private Dashboard-Annahme und Moderation prüfen,
Fulfillment/Refund im Twitch-Dashboard gegenprüfen und erst danach den
gewünschten Preis einstellen. Diese Anleitung löst keinen echten Test aus.

## Song-Wünsche in Janniks Spotify-Playlist

Die Funktion ist standardmäßig ausgeschaltet und benötigt Spotify-App-Zugangsdaten
in `.env` (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`), den exakt registrierten
Callback `https://DEINE-DOMAIN/dashboard/spotify/callback` sowie Janniks
Spotify-OAuth. Redirect und OAuth-Token-Datei werden nicht in Git eingecheckt;
das Token liegt getrennt mit Dateirechten 0600. Im Dashboard verbindet Jannik
Spotify, wählt eine eigene Playlist und verknüpft/erstellt den Twitch-Kanalpunkte-
Reward „🎵 Song wünschen“. Der Standardpreis beträgt 1.000 Kanalpunkte und die
Einlösung verlangt Titel + Interpret oder einen Spotify-Songlink.

Bei einer gültigen Einlösung löst der Bot den Song auf, fügt ihn einmalig der
ausgewählten Playlist hinzu und schließt danach den Twitch-Reward ab. Ein
unklarer Fehler nach einem Playlist-Schreibversuch wird nicht blind wiederholt;
er erscheint zur Prüfung im Dashboard. Das System startet, steuert oder
überspringt keine Wiedergabe. Eine Playlist-Ergänzung ist keine Freigabe für
öffentliche Musikwiedergabe: Spotify weist in seinen [Developer Policies](https://developer.spotify.com/policy)
die öffentliche Übertragung von Spotify-Inhalten zurück; Stream-Musik muss
separat zulässig lizenziert sein. Details zur Playlist-API:
[Add Items to Playlist](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist).

Die Funktion braucht Janniks Twitch-Broadcaster-OAuth mit dem vorhandenen Scope
`channel:manage:redemptions`; es werden keine zusätzlichen Twitch-Scopes
angefordert. Der Bot legt beim Verbinden keinen Reward an und aktiviert keine
Musikwünsche automatisch. Einrichtung, Reward-Erstellung und Aktivierung sind
separate Aktionen im Dashboard.

## Gesprächs-Funken (Conversation Spark)

Der optionale Gesprächs-Funken wertet ausschließlich normale Nachrichten im
konfigurierten Jannik-Kanal aus. Befehle, Nachrichten aus anderen Kanälen und
der Broadcaster selbst fließen nicht in die Erkennung ein. Ein regelbasierter
Abgleich nutzt die eingebauten Gaming-Themen (Fortnite, Minecraft, Elden Ring
und allgemeine Challenges) sowie optionale eigene Keyword-Regeln. Es werden
keine Nachrichteninhalte oder Teilnehmerlisten für Spark gespeichert; Topic-
Aktivität bleibt während des begrenzten Zeitfensters im Arbeitsspeicher. Die
SQLite-Vorschläge enthalten nur Kanal-/Themenkennung, Score, ungefähre Anzahl
von Teilnehmenden/Nachrichten, Aktionstyp, Status und Ablaufzeit und werden
nach konfigurierbarer Aufbewahrung bereinigt. Andere Bot-Funktionen, etwa das
bereits bestehende XP-System, haben ihre eigenen Speicherregeln.

Spark ist nach Installation ausgeschaltet. Jannik aktiviert es im geschützten
Dashboard unter „Gesprächs-Funken“, passt Zeitfenster, Mindestteilnehmer,
Nachrichten, Score, Cooldowns, Ablauf und Topics an und entscheidet, ob ein
Hinweis zusätzlich im Chat erscheinen darf (standardmäßig aus). Der Standard
ist 10 Minuten, 3 Personen, 5 passende Nachrichten und Score 12. Ein Fund
startet niemals automatisch eine Aktion: Ein Moderator kann den Vorschlag im
Chat freigeben, eine Abstimmung oder Quest muss anschließend ausdrücklich im
Dashboard angelegt werden. Abstimmungen/Quest-Erstellung unterliegen zusätzlich
den jeweiligen bestehenden Modul- und Freigaberegeln. Für eine spätere
semantische/Embedding-Erweiterung ist weder ein externer KI-Dienst noch eine
Übermittlung von Chattext vorgesehen.

Vor Aktivierung muss der Betreiber die Community transparent über die optionale
regelbasierte Verarbeitung der Gaming-Themen informieren und prüfen, ob die
konkrete Datenschutzerklärung diese Funktion abdeckt. Bis dahin Spark
deaktiviert lassen. Streamer kann jederzeit `!sparkpause` und `!sparkresume`
verwenden; der Dashboard-Schalter aktiviert/deaktiviert die Erkennung.

## Elio 🐱, Mystery Drops und Chaos Wheel

Die drei Community-Arcade-Module verwenden dieselbe SQLite-Datei, das vorhandene XP-Ledger und die geschützte Dashboard-/OBS-Token-Infrastruktur. Alle drei Funktionen sind standardmäßig ausgeschaltet; im Dashboard unter **Elio 🐱 · Mystery Drops · Chaos Wheel** einzeln aktivieren. Ein Drop startet nur manuell oder wenn ein Glücksrad-Feld ausdrücklich die Aktion `start_mystery_drop` trägt; dafür müssen sowohl Glücksrad als auch Mystery Drops eingeschaltet sein.

- Elio 🐱: `!pet` zeigt den Zustand, `!feed` füttert mit Katzenfutter/Leckerli, `!play` spielt mit Spielangel/Wollknäuel, `!petcare` pflegt, `!petstats` zeigt Werte; `!petname`, `!petevolution` und `!pethelp` bleiben kompatibel. Nur Jannik kann mit `!setpetname NAME` umbenennen oder mit `!petpause` / `!petresume` pausieren.
- Mystery Drop: `!claim`, `!drop`, `!dropstats`, `!drops`; Jannik/Mods starten mit `!startdrop [common|rare|epic|legendary|community]` und brechen mit `!canceldrop` ab.
- Chaos Wheel: `!wheel`, `!wheelstatus`; Jannik/Mods starten mit `!startwheel` (Alias `!spin`). Glücksrad-Felder haben eine gespeicherte Aktion: `manual_challenge` bleibt eine Aufgabe für Jannik, `start_mystery_drop` startet atomar einen Drop, `boost_pet` löst den Pet-Energieschub aus. Nur virtuelle XP, keine Sachpreise.

Die drei OBS-Widgets werden wie die übrigen Lesewidgets im Dashboard über **OBS-Widgets → Pet/Drop/Wheel-URL erneuern** ausgegeben und können dort widerrufen werden. URLs verwenden `/widgets/pet?token=…`, `/widgets/drop?token=…` und `/widgets/wheel?token=…` mit einem im Dashboard erzeugten Token.

Aktueller Implementierungsumfang: Elio ist die virtuelle Community-Katze mit begrenzten Pflegewerten, erhaltenen Leveln/XP, fünf Katzen-Lebensphasen und einfachen Animationen. Manuell oder per Wheel gestartete kostenlose Drops haben einmalige Claims und XP; das Wheel speichert gewichtete Ergebnisse persistent. Drop-Teilnahmedetails und Wheel-Historie werden standardmäßig nach 90 Tagen bereinigt. Volle Kosmetik-/Sammlungsverwaltung, Community-Meilenstein-Verteilung, vollständige Wheel-Historien-/Segmentverwaltung und Quest-Übergabe sind noch nicht Bestandteil dieser ersten Ausbaustufe. Für Production sind HTTPS/Domain, Tokens und Twitch-Berechtigungen erforderlich.

## Befehle

| Befehl | Wirkung / Berechtigung |
|---|---|
| `!trickortreat`, `!pumpkins`, `!top`, `!halloween` | Bestehendes Halloween-Spiel und Kürbisrangliste |
| `!startHalloween`, `!endHalloween` | Jannik oder autorisierte Mods; nur ein primäres Sammel-Event gleichzeitig |
| `!resetHalloween CONFIRM` | Nur Jannik; legt vorher ein SQLite-Backup an; betrifft nur Halloween-Punkte |
| `!gift`, `!egghunt` | Sammelbefehl des aktiven Weihnachts- bzw. Oster-Events |
| `!eventscore [event-id]`, `!eventtop [event-id]` | Punktestand bzw. Event-Rangliste |
| `!startevent ID`, `!endevent ID` | Jannik oder Mods; beendet Events archiviert statt sie zu löschen |
| `!level [@user]`, `!xptop`, `!rank` | XP-Stand, Topliste und Rang |
| `!8ball FRAGE`, `!rps schere\|stein\|papier` | 8-Ball mit 40 % JA, 40 % NEIN, 20 % VIELLEICHT; 30 Sekunden persönlich und 5 Sekunden global (Standard) |
| `!startguess`, `!guess ZAHL` | Jannik, Moderatoren und Twitch-VIPs starten eine persistente Zahlenrunde; alle Zuschauer können mit begrenzten Versuchen mitraten |
| `!duel @user`, `!accept`, `!cancelduel` | Zufälliges Duell ohne Einsatz; Annahme läuft ab |
| `!startboss [Name]`, `!attack`, `!boss`, `!bosstop`, `!endboss` | Kooperativer Bosskampf; Start/Ende nur Jannik oder Mods |
| `!addcommand name \| Antwort` | Nur Jannik; eigene Antwort mit sicheren Platzhaltern |
| `!setcommand name \| Antwort`, `!delcommand name` | Jannik; Mods dürfen nur ausdrücklich freigegebene Befehle verwalten |
| `!quest AUFGABE`, `!quests`, `!myquest`, `!questhelp` | Quest vorschlagen bzw. Status und Regeln ansehen; Vorschläge erscheinen erst nach Freigabe |
| `!questqueue`, `!approvequest ID`, `!rejectquest ID` | Optional für Jannik und explizit konfigurierte Mods; die Chat-Warteschlange zeigt nur IDs, den Vorschlagstext vorher im Dashboard prüfen |
| `!skipquest` | Jannik; Mods nur bei ausdrücklich freigeschalteter Moderator-ID und passender Einstellung |
| `!spark`, `!sparkhelp`, `!sparks`, `!sparktopics` | Status, Hilfe, Anzahl offener Vorschläge und flüchtige Topic-Aggregate |
| `!sparkapprove ID`, `!sparkreject ID` | Jannik oder Twitch-Moderatoren; Freigabe erstellt noch keine Umfrage/Quest |
| `!sparkpause`, `!sparkresume` | Nur Jannik; pausiert bzw. setzt die Erkennung fort |
| `!poll`, `!vote 1–5`, `!pollresults` | Botinterne Umfrage ansehen, abstimmen und Ergebnisse lesen; Erstellen/Beenden im Dashboard |
| `!pet`, `!feed`, `!play`, `!petcare`, `!petstats`, `!petname`, `!petevolution`, `!pethelp` | Elio 🐱 ansehen, füttern, pflegen und mit ihm spielen; Cooldowns und begrenzte Werte |
| `!setpetname NAME`, `!petpause`, `!petresume` | Nur Jannik: Pet umbenennen, Pflege pausieren oder fortsetzen |
| `!claim`, `!drop`, `!dropstats`, `!drops` | Kostenlos an einem laufenden Mystery Drop teilnehmen oder Regeln/Status ansehen |
| `!startdrop [Seltenheit]`, `!canceldrop`, `!dropconfig` | Jannik/Mods: Drop manuell starten/abbrechen; Automatik bleibt aus |
| `!wheel`, `!wheelstatus`, `!spin` | Wheel ansehen; Dreh nur durch Jannik/Mods, sofern Chat-Dreh nicht freigegeben ist |
| `!startwheel`, `!cancelwheel`, `!wheelpause`, `!wheelresume` | Jannik/Mods steuern den Dreh; Pause/Fortsetzen nur Jannik |

## Oracle Always Free ARM64 – Installation und Abnahme

Hinweis zum aktuellen Live-Host: Die am 13.10.2026 geprüfte VM meldet
`x86_64` und läuft mit Node.js 24; der ARM64-Container-Build wurde nicht
abgenommen. Dieses Kapitel beschreibt das ARM64-Ziel, nicht die nachgewiesene
Architektur des aktuell laufenden Prozesses.

Die Compose-Datei bindet OAuth- und Dashboard-Port ausschließlich an Loopback
des Hosts (`127.0.0.1`); Caddy vermittelt HTTPS auf 80/443. Die vorhandenen
Volume-Namen `halloween-data` und `halloween-backups` bleiben erhalten. Das
Dockerfile nutzt Node 24 LTS und baut native Abhängigkeiten im Zielcontainer.
Oracle Always Free A1-Kapazität gilt über alle A1-Instanzen in der Free-Tenancy
zusammen: derzeit maximal 2 OCPUs und 12 GB RAM pro Monat. Das ist keine
Kapazitätszusage; Oracle kann in der Home Region temporär „out of host
capacity“ melden. Diese Anleitung legt keine Cloud-Ressourcen an.

### 1. VM, Netzwerk und Docker

1. In Oracle eine Ubuntu-ARM64-VM mit `VM.Standard.A1.Flex` in der Home Region
   innerhalb des verbleibenden Always-Free-Kontingents erstellen. Beim Erstellen
   Shape, Boot-Volume und Netzwerk auf kostenpflichtige Optionen prüfen.
2. Eine feste öffentliche IP und DNS-Subdomain auf die VM setzen.
3. Im NSG/Cloud-Firewall nur TCP 22 (möglichst eigene IP), TCP 80 und TCP 443
   freigeben. **Ports 3000 und 3001 nicht öffentlich öffnen.** SSH nur mit Key;
   Passwort- und Root-Login deaktivieren.
4. Auf der VM Docker und Compose installieren:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

5. Repository klonen und `.env` nur auf dem Server anlegen:

```bash
git clone https://github.com/Gater-App/Acyjannik-Twitch-Bot.git
cd Acyjannik-Twitch-Bot
cp .env.example .env
nano .env
```

Die Secrets-Datei nicht committen. SQLite, Bot-OAuth und Broadcaster-OAuth
liegen im persistenten Docker-Datenvolume; `restart: unless-stopped`,
Healthcheck und Docker-Logrotation sind bereits konfiguriert.

### 2. Twitch-App und Konten

6. `.env` mit Janniks Kanal-Login, Bot-Login, `TWITCH_CLIENT_ID` und
   `TWITCH_CLIENT_SECRET` befüllen. Bot-Account-OAuth nutzt nur
   `user:read:chat user:write:chat`.
7. In der Twitch Developer Console alle drei exakten HTTPS-Redirects
   registrieren:

```dotenv
TWITCH_REDIRECT_URI=https://BOT-DOMAIN/oauth/callback
TWITCH_REDEMPTION_REDIRECT_URI=https://BOT-DOMAIN/oauth/redemptions/callback
DASHBOARD_REDIRECT_URI=https://BOT-DOMAIN/dashboard/oauth/callback
```

   Kein Protokoll, Host, Port oder Pfad darf abweichen. `BOT_DOMAIN` in `.env`
   ebenfalls setzen.
8. `DASHBOARD_ADMIN_IDS` mit der numerischen Twitch-User-ID des Betreibers
   befüllen. Den Bot starten und den vom Log ausgegebenen `/oauth/start`-Link
   mit dem Bot-Konto einmal autorisieren. Danach auf das geschützte Dashboard
   unter `https://BOT-DOMAIN/dashboard/login` gehen. Unter Kanalpunkte
   ausdrücklich Broadcaster-OAuth starten; Jannik muss mit seinem Konto
   `channel:manage:redemptions` freigeben. Das bleibt ein eigener Token und
   erweitert nicht die Bot-Chat-Berechtigungen.

### 3. Reward, Dashboard und OBS

9. Im Bereich **Kanalpunkte-Quests** eine verwaltbare, aktive Belohnung mit
   verpflichtender Texteingabe und manueller Warteschlange auswählen oder nach
   der Bestätigungsabfrage **„Quest für Jannik 🎯“** erstellen. Standardkosten:
   2.000 Punkte, im Dashboard änderbar. Reward-ID wird dauerhaft lokal
   gespeichert. Die Option „Kanalpunkte-Quests aktivieren“ erst danach setzen.
10. Für OBS die bestehenden Quest- und Umfrage-Widget-URLs im Dashboard
    erzeugen und als Browserquellen mit der öffentlichen HTTPS-URL einfügen.
    Widget-Tokens sind lesende Geheimnisse und dürfen nicht geteilt werden.

### 4. Test, Backup und Neustart

11. Für den echten Test Janniks Zustimmung einholen, Reward-Kosten zunächst
    niedrig setzen, eine Testeinlösung abschicken und im Dashboard prüfen, dass
    der Text vor Moderation weder im Chat noch im OBS-Widget erscheint. Nach
    Quest-Freigabe Twitch-Fulfillment kontrollieren; eine abgelehnte Einlösung
    separat auf `CANCELED`/Punkteerstattung prüfen. Bei 403 keine Erstattung
    annehmen: Twitch muss bestätigen, dass diese App den Reward verwalten darf.
    Dieser Test wurde nicht automatisch ausgelöst.
12. Backup, Neustart, Healthcheck und Restore vor Livebetrieb anhand der
    Befehle im folgenden Backup-Abschnitt testen. SQLite-Backups enthalten keine
    `.env` oder OAuth-Tokens. Diese zusätzlich verschlüsselt und getrennt sichern:
    `/app/data/oauth-tokens.json` und
    `/app/data/oauth-tokens.json.broadcaster`.

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

### Release-Manifest

Nach dem Build aus dem unveränderten Release-Checkout das Runtime-Artefakt
prüfbar beschreiben. Die Prüfsumme `sha256-tree-v1` wird aus sortierten
Artefaktpfaden und den SHA-256-Prüfsummen ihrer Dateien gebildet. Die beiden
Caddy-Konfigurationen erhalten eigene Prüfsummen. Quelle, Runtime-Commit und
Deploymentzeit werden als getrennte Felder aufgeführt; ohne explizite
Deploymentzeit bleibt der Zustand `not_verified`.

```bash
npm run build
npm run release:manifest -- --artifact dist \
  --output ../release-metadata/release-manifest.json \
  --runtime-commit RUNTIME_COMMIT \
  --deployed-at 2026-10-15T12:00:00Z
```

`source.commit` stammt aus `git rev-parse HEAD`; `source.workingTreeClean`
kennzeichnet, ob der Checkout bei der Manifest-Erstellung sauber war. Das Manifest belegt keine
Deploymentaktion; `runtime.commit` und `deployedAt` müssen aus dem tatsächlich
ausgerollten Runtime-Stand und dem Deploy-Protokoll übernommen werden. Die
Datei enthält keine Credentials und sollte außerhalb des Quell-Repositories
beim jeweiligen Release-Artefakt abgelegt werden.

`docker compose down -v` löscht die persistenten Volumes und ist für normale
Updates nicht erforderlich. Updates erfolgen mit `docker compose up -d --build`.

Wenn im Dashboard unter **Einstellungen → Chat & Nachrichten → Bot-Lebenszeichen**
die Funktion aktiviert ist, kann ein Update vorab angekündigt werden: dort
unmittelbar vor dem Deployment **Geplanten Neustart vorbereiten** wählen und
innerhalb von 15 Minuten `docker compose up -d --build halloween-bot`
ausführen. Der Marker liegt in der persistenten SQLite-Konfiguration. Ohne
Vorbereitung erzeugen SIGTERM, SIGINT, Abstürze und automatische Neustarts
keine Abschieds- oder Rückkehrnachrichten. Die Rückkehr wird nur einmal nach
EventSub-Verbindung, 20 Sekunden Stabilisierung, bestätigtem Live-Status und
angenommenem Chatversand versucht. Es gilt ein Cooldown von 30 Minuten.

## Entwicklung und Tests

```bash
npm run build
npm test
npm run check
```

Die Tests decken die erhaltene Halloween-Mechanik und Punktestände,
SQLite-Migration samt Sicherung, Quest-Freigabe/Rollen/Cooldown/Übergänge und
einmalige XP-Belohnung, Abstimmungsänderungen/Deduplizierung/Gleichstände/
Neustart, Quest-Abstimmungen, Dashboard-OAuth-Allowlist/Sessions/CSRF,
Widget-Token und OBS-Snapshots sowie Chat-Imposter-/Detektiv-Zustände,
Teilnehmer-OAuth, Rollenleckschutz, Quote-Opt-in/Freigabe/Löschung,
Stimmenwechsel, Gleichstand, XP-Deduplizierung und Ablaufbereinigung ab. Twitch-
und Dashboard-OAuth werden simuliert; keine echten Chatnachrichten werden
gesendet. `npm run demo:games` ist eine lokale synthetische Durchspiel-Demo.

Ein öffentlicher Oracle-Deploy oder ein echter Twitch-Kanaltest wird nicht
automatisch ausgelöst. Vor dem Livegang müssen die Twitch-App, Redirect-URLs,
Bot-Konto, Admin-User-ID-Allowlist, Domain/DNS, HTTPS, Firewall und Server-
Secrets vom Betreiber gesetzt und geprüft werden.
