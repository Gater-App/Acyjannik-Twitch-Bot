# Phase 4 – Elio und Mystery Drops in Discord

## Ergebnis

Die Twitch-Anwendung bleibt die maßgebliche Datenquelle. Discord-Aktionen rufen die bestehende Twitch-API auf; Discord greift weder direkt auf SQLite zu noch führt es ein eigenes Pet-, Teilnahme- oder XP-Konto.

### Elio

- Die Dashboard-Schalter `elioEnabled` und `accountLinkEnabled` sind standardmäßig aus.
- Das interne API liefert nur Elio-Status und eine kurze Aktivitätshistorie, wenn Integration, Discord-Elio und das bestehende Pet-Modul eingeschaltet sind.
- `/elio` zeigt eine private, ephemere Statuskarte. Füttern, Spielen und Streicheln senden private Rückmeldungen.
- Aktionen benötigen eine serverseitig gespeicherte Discord↔Twitch-Verknüpfung. Die Twitch-ID wird ausschließlich aus der Verknüpfungstabelle aufgelöst.
- Discord-Interaktions-ID wird als Idempotenzkennung verwendet; bestehende Pet-Cooldowns und Pet-Werte gelten plattformübergreifend.
- Portalaktionen bleiben ohne einzelne öffentliche Twitch-Chat-Nachricht.

### Mystery Drops

- Die Discord-Schalter `discordDropsEnabled` und `dropChannelId` sind standardmäßig aus.
- Bestehende Drop-Starts und -Abschlüsse schreiben Outbox-Ereignisse. Der öffentliche Discord-Beitrag wird beim Start angelegt und bei Abschluss oder Abbruch aktualisiert.
- `/drop` zeigt den aktuellen Drop privat. Der Teilnahmebutton läuft durch dieselbe Twitch-API und die bestehende eindeutige Tabelle `(drop_id, Twitch user_id)`.
- Die Bot-Consumer-Seite speichert Kanal- und Nachrichten-IDs in ihrer bestehenden privaten Zustellstatusdatei. Nach einem Neustart wird eine fehlende Zeigerdatei durch Suche nach dem stabilen Drop-Marker in der Kanalhistorie abgeglichen. Ein Abschluss ohne auffindbaren Startbeitrag erzeugt keinen irreführenden Ersatzbeitrag.
- XP werden ausschließlich beim vorhandenen Twitch-Drop-Abschluss vergeben. Wiederholte Teilnahme und Wiederholungszustellung erzeugen keine zusätzliche Teilnahme oder XP-Buchung.
- Drop-Abbrüche aktualisieren bei vorhandener Startnachricht dieselbe Karte. Ein Abbruch erzeugt keine neue Nachricht.

## Schnittstellen und Änderungen

Neue interne, durch den vorhandenen Integrationsschlüssel geschützte Routen:

- `GET /api/discord/v1/community/elio`
- `POST /api/discord/v1/community/elio/action`
- `GET /api/discord/v1/community/drop`
- `POST /api/discord/v1/community/drop/claim`

Neue Slash-Commands: `/elio` und `/drop`. Der vorhandene sichere Upsert erhält fremde Guild-Befehle; produktive Registrierung wurde nicht ausgeführt.

Für diese Phase wurde keine Datenbankmigration hinzugefügt. Benötigte Verknüpfungstabellen stammen aus der vorhandenen Phase-1-Migration v34; Drop- und Elio-Tabellen gehören zum bestehenden Twitch-Schema.

## Tests

- Twitch: Build, 201 Unit-/Integrationstests, Browser-E2E 5/5 und `git diff --check` bestanden.
- Discord: 24 Tests, Syntax-/Build-Prüfung und `git diff --check` bestanden.
- Getestet wurden private Antworten, Feature-Schalter, Account-Link-Auflösung, Pet-Idempotenz, Drop-Deduplizierung, einmalige XP-Auszahlung und Neustart-/Replay-Abgleich der Drop-Nachricht.
- Alle Tests verwenden lokale SQLite-Datenbanken und simulierte Discord-/Twitch-Schnittstellen.

## Deployment-Abhängigkeiten und Grenzen

- Twitch muss Phase 1 (v34 Account-Verknüpfung) enthalten, bevor Elio-Aktionen und Drop-Claims aus Discord funktionieren.
- Beide Services müssen kompatible Phase-4-Codeversionen verwenden. Vor Aktivierung sind der vorgesehene Drop-Kanal sowie die minimale Bot-Berechtigung `View Channel`, `Send Messages`, `Embed Links` und `Read Message History` zu prüfen.
- Die tatsächliche Twitch-Pet- und Drop-Funktion muss separat aktiviert sein; Discord-Schalter überschreiben keine Twitch-Schalter.
- Keine produktive Migration, Slash-Command-Registrierung, Aktivierung, Nachricht oder Neustart wurde durchgeführt.

## Status

Implementierung und lokale Tests sind abgeschlossen. Pull Request und GitHub-CI folgen nach Abschluss der Paketprüfung; Zusammenführung bleibt abhängig von Reviews der vorherigen Phasen.
