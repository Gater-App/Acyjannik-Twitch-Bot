# ACY Community & Live Control Polish 007

Stand: 15.10.2026

## Ausgangsstand

- `origin/main` wurde direkt gegen GitHub geprüft und zeigte auf `f075663790263e59256f49130f00274dd4067fea`.
- Umsetzung in einem separaten Worktree auf Branch `codex/community-live-control-007`, ausgehend von genau diesem Commit.
- Der bestehende Checkout `feature/halloween-haunted-house` (HEAD `886826ca7bd882eadceb629f86eaaa13f3f27746`) blieb unberührt. Seine drei geänderten Verifikationsbilder und `artifacts/` waren am Ende weiterhin vorhanden.
- Keine Änderungen an Discord, Oracle, Production, Caddy, PM2, Twitch- oder OBS-Livebetrieb. Kein Commit, Push, Merge oder Deployment.

## Änderungen

### Community-Navigation

In [community-portal.ts](../../src/community-portal.ts) bleibt die Desktop-Navigation erhalten. Auf schmalen Ansichten öffnet ein sichtbarer Menüschalter ein zweispaltiges, umbrechendes Menü. Links und Schalter haben mindestens 44 px Touchhöhe. `aria-expanded`, `aria-controls`, aktive Linkzustände, Tastaturfokus und Escape-zum-Schließen sind berücksichtigt. Die Links laufen nicht mehr als abgeschnittene horizontale Leiste.

### Moderationsübersicht

[feature-store.ts](../../src/feature-store.ts) liefert Zähler und reine Aufgabenmetadaten für Erinnerungen, Ideen, Quests, Chat-Ideen, Detektiv-Zitate und VIP-Chaos-Anfragen. Einträge enthalten ID, Status und Zeitstempel, keine Einreichungstexte. Zähler sind vollständig; die neuesten 100 Einträge je Bereich werden angezeigt.

[moderation-inbox.ts](../../src/moderation-inbox.ts) stellt Gesamtzähler, Bereichsfilter, Status und Direktlinks bereit. Die Seite und `GET /dashboard/api/moderation/inbox` verwenden die vorhandene Dashboard-Sitzungsprüfung. Admins sehen alle Bereiche; Moderatoren nur Erinnerungen, Ideen und VIP-Anfragen. Der API-Routenfilter weist nicht freigegebene Moderator-Routen weiter mit 403 ab. Die Einträge verlinken auf die bestehenden Moderationsansichten; es gibt in der Inbox keine zweite Aktionslogik. Bestehende statusgebundene Serverübergänge verhindern eine erneute erfolgreiche Verarbeitung veralteter Aktionen.

Bei mehr als 100 offenen Einträgen pro Bereich zeigt die Inbox nur die neuesten 100; Gesamtzähler bleiben exakt. Die jeweilige Moderationsseite bleibt der Weg zu älteren Aufgaben.

### Streamer Live Control

[live-control.ts](../../src/live-control.ts) und [dashboard.ts](../../src/dashboard.ts) zeigen laufende, bestätigte und fehlgeschlagene Aktionen, den letzten erfolgreichen Aktualisierungszeitpunkt und verständlichere Fehler. Doppelte Klicks während einer Anfrage werden gesperrt. Bei uneindeutiger externer Zustellung wird dieselbe Aktion in der geöffneten Seite vorsorglich gesperrt.

Die API unterscheidet Bot-Verarbeitung von Chat-Zustellung (`chatDelivery`). Eine bestätigte Chatmeldung wird nicht als OBS-Sichtbarkeitsnachweis dargestellt. Ein HTTP-Erfolg allein wird ausdrücklich nicht als Twitch- oder OBS-Bestätigung ausgegeben. Ungewisse Ergebnisse fordern dazu auf, die Aktion nicht erneut auszulösen.

### Abfragen und Caching

- Portalzustand: zufälliger Polling-Abstand von 20 bis 26 Sekunden statt eines festen kurzen Takts; versteckte Tabs pausieren und werden bei Rückkehr aktualisiert.
- Doppelte gleichzeitige Portal-State-GETs innerhalb eines Tabs werden geteilt. Erfolgreiche POST-Aktionen invalidieren den lokalen Cache; weitere geöffnete Tabs erhalten über `BroadcastChannel` ausschließlich ein Cache-Invalidierungssignal, keine Nutzerdaten.
- Portal-GETs berücksichtigen `Retry-After`. Die bestehende Rate-Limitierung bleibt bestehen.
- Community-Memory- und Ideenaktualisierungen sind zeitlich versetzt und pausieren in versteckten Tabs; der Pet-UI-Timer läuft dort nicht weiter.
- Das Streamer-Dashboard nutzt Single-Flight, kurze GET-Antwortzwischenspeicherung, `Retry-After`, zufällige Zeitabstände und Pausen für versteckte Ansichten. Ein Ansichtswechsel weckt die dazugehörigen Abfragen.

Das sind statische Änderungen an der Abfrageplanung. Es wurden keine Last- oder Kapazitätsmessungen durchgeführt; es gibt daher keine gemessenen Durchsatz- oder CPU-Aussagen.

## Tests und Prüfung

- `npm run check`: TypeScript-Build erfolgreich; 194 Unit-Tests bestanden, 0 fehlgeschlagen.
- `npm run test:browser`: 5 Browsertests bestanden, 0 fehlgeschlagen. Darin sind mobile Community-Navigation, Moderations-Inbox-Direktlink und Fokus, Live-Control-Fehlerstatus sowie Schutz vor erneutem Auslösen abgedeckt.
- `git diff --check`: sauber.
- Browsertests aktualisierten in diesem Worktree drei getrackte Dateien unter `docs/verification/`; diese Testausgaben wurden danach exakt auf den Ausgangsstand dieses Worktrees zurückgesetzt. Der bestehende Hauptcheckout wurde nicht für Tests verwendet.
- Ein temporärer `node_modules`-Symlink auf die vorhandene lokale Abhängigkeitsinstallation wurde nur zum Ausführen von Build und Tests verwendet und vor Abschluss entfernt. Es wurden keine Abhängigkeiten installiert oder aktualisiert.

Die Tests verwenden lokale Testserver, SQLite-Dateien in temporären Verzeichnissen und gemockte externe Antworten. Sie belegen keine Live-Twitch-, OBS-, Oracle- oder Production-Funktion.

## Datenbank, Risiken und offene Abhängigkeiten

- Keine Schema- oder Migrationsänderung; die Inbox nutzt bestehende Tabellen und benötigt keine Production-Migration.
- Die Inbox begrenzt die angezeigten Einträge pro Bereich auf 100. Bei großen Rückständen bleiben Zähler korrekt, ältere Aufgaben müssen in der Bereichsmoderation geöffnet werden.
- `BroadcastChannel` ist eine Browserfunktion ohne zentrale Infrastruktur. Fehlt sie, bleiben Request-Deduplizierung und Cache innerhalb des jeweiligen Tabs aktiv.
- Der vorsorgliche Sperrstatus für unklare Live-Aktionen gilt für die geöffnete Seite. Nach einem Neuladen muss der Betreiber den tatsächlichen Zustand über Dashboard/Chat prüfen, bevor er erneut auslöst.
- Oracle-Erreichbarkeit, installierte Release-Dateien, Caddy-Routing, Secrets, Healthchecks und Produktionsmonitoring wurden nicht lesend verifiziert. Sie bleiben Release-Abhängigkeiten.

## Release-Empfehlung

Der Stand ist für Review und eine isolierte Staging-Prüfung vorbereitet. Vor einer bewussten Production-Freigabe die Route unter der tatsächlich verwendeten Proxy-Konfiguration, Rollenprüfung mit real konfigurierten Allowlisten, Polling-Verhalten mit mehreren Browser-Tabs und Live-Control-Status auf einer Testumgebung verifizieren. Erst danach Release-Artefakt und Rollback-Verfahren prüfen. Kein Deployment wurde ausgeführt.
