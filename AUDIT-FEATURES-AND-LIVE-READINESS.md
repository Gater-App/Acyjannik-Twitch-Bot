# Technischer Feature-Audit und Live-Readiness

Stand: 13. Oktober 2026

Repository: `Gater-App/Acyjannik-Twitch-Bot`
Geprüfter Stand: `2a3aaa7a2291c48ecf0b4419ab18656d4f709b3d` (`main`)

## Kurzfazit

Der lokale TypeScript-Build ist erfolgreich; `npm run check` besteht mit **61/61 Tests**. Beide synthetischen Demos (`npm run demo:games`, `npm run demo:arcade`) liefen ohne Twitch-Verbindung. Der Working Tree war beim Audit sauber; `main` lag sechs Commits vor `origin/main`.

Das belegt lokale Logik und gemockte Integrationen – nicht, dass Twitch-OAuth, Chatversand, öffentliches HTTPS, OBS von einem externen Rechner oder Oracle live funktionieren. Es wurde nichts gepusht, kein Twitch-Kanal verändert und nichts auf Oracle deployed.

**Wichtige Einschränkung:** Community-Pet, Mystery Drops und Chaos Wheel sind eine getestete MVP-Ausbaustufe, nicht der vollständige Funktionsumfang aus dem Auftrag. Bei Mystery-Drop-XP gibt es außerdem ein Crash-Fenster zwischen dem persistenten Abschluss des Drops und der separaten XP-Gutschrift. Bis das atomar gelöst und die unten genannten Arcade-Punkte entschieden sind, diese drei Features nicht live aktivieren.

## Prüfungsmethode und Umgebung

- `npm run check`: TypeScript-Build erfolgreich, 61 Tests bestanden, 0 fehlgeschlagen.
- `npm run demo:games` und `npm run demo:arcade`: synthetische Durchläufe erfolgreich.
- `git diff --check`: ohne Beanstandungen; keine lokalen Änderungen durch den Audit.
- Lokale Maschine ist `x86_64`, Node `v24.20.0`. Docker ist vorhanden, Docker Compose und `docker buildx` jedoch nicht. Ein ARM64-Build/-Start konnte daher nicht nachgewiesen werden.
- In diesem Checkout liegt keine `.env`; die vom Betreiber erwähnte lokale Datei war hier nicht auffindbar. Es wurden keine Secret-Werte gelesen oder ausgegeben.

## Feature-für-Feature-Status

### 1. Halloween-Spiel und Kürbispunkte

**Funktioniert/lokal belegt:** `!trickortreat`, Punktestände, Rangliste, Cooldown, Start/Ende, Eventauswahl und Schutz vor negativen Punkteständen sind in Tests abgedeckt. Vorhandene Punkte bleiben bei getesteten Migrationen erhalten.

**Fehlt/vor Live nötig:** echter Bot-OAuth-/EventSub-/Chatversandtest; Betreiber muss bestätigen, ob Halloween auf dem Server standardmäßig aus bleibt (empfohlen) und welche Texte/Punktespannen live gelten. Keine Live-Datenbankmigration wurde ausgeführt.

### 2. Saisonale Events

**Funktioniert/lokal belegt:** getrennte Events/Punktestände, exklusive Aktivierung, Archivierung/erneutes Beenden und zugehörige Chatbefehle; persistente Zustände sind getestet.

**Fehlt/vor Live nötig:** reale Start-/Endzeiten, Zeitzone und gewünschte Eventdefinitionen festlegen. Zeitplanung und Bot-Neustart unter echter Oracle-Laufzeit sind nicht erprobt.

### 3. XP, Level, Rangliste und Anti-Spam

**Funktioniert/lokal belegt:** XP-Ledger, Deduplizierung, Aktivitäts-Cooldown, Levelkurve, Rangabfragen und Tageslimits vorhandener Bonuspfade sind getestet.

**Fehlt/vor Live nötig:** Live-Balance (XP-Werte/Tageslimits) festlegen und unter echtem Chatvolumen beobachten. Kein Produktions-XP-Datensatz wurde geprüft.

### 4. Chat-Minispiele, Duelle und Community-Boss

**Funktioniert/lokal belegt:** 8-Ball/RPS/Zahlenraten, Duel-Annahme/-Ablauf/-Auflösung sowie persistenter Bosskampf und einmalige Belohnungen. Befehlsrouting, Berechtigungen und ausgewählte Neustartfälle sind getestet.

**Fehlt/vor Live nötig:** Echtgeld-/Sachpreisfreiheit und Chatfrequenz beibehalten; reale Moderationsrollen und Twitch-Chat-Rate unter Testkanal verifizieren. Nicht jede Kombination aus gleichzeitig laufenden Spielen wurde als Last-/Paralleltest geprüft.

### 5. Eigene Chatbefehle

**Funktioniert/lokal belegt:** anlegen/ändern/löschen, Rollen, Alias, Cooldown, Ablauf und sichere Platzhalter; Tests decken Reservierung und ungültige Vorlagen ab.

**Fehlt/vor Live nötig:** bestehende Custom Commands in der Live-Datenbank gegen neue reservierte Namen (z. B. Pet-/Drop-/Wheel-Befehle) prüfen. Eine Kollision in Altbeständen könnte einen zuvor bestehenden Befehl überdecken.

### 6. Quests und botinterne Umfragen

**Funktioniert/lokal belegt:** Vorschläge bleiben bis Freigabe intern; Moderation, Warteschlangenlimits, Statusübergänge, XP einmalig, Chatumfragen, Abstimmungen, Timer, Stimmenänderung und Gleichstand sind getestet. Eine Questumfrage startet eine Quest nicht automatisch.

**Fehlt/vor Live nötig:** reale Moderatoren-Allowlist und Community-Hinweise festlegen; Chatbefehle und OBS-Ausgabe in einem privaten Test prüfen. Dies sind botinterne Umfragen, keine nativen Twitch-Polls.

### 7. Twitch-Kanalpunkte-Quests

**Funktioniert/lokal belegt:** separates Broadcaster-OAuth-Modell, Redemption-ID-Deduplizierung, Reward-/Kanalprüfung, private Warteschlange, Fulfillment-/Cancellation-Zustände und Fehlerpfade sind mit gemockten Twitch-Antworten getestet.

**Fehlt/vor Live nötig:** Jannik muss das separate `channel:manage:redemptions`-OAuth für sein Broadcaster-Konto genehmigen. Danach muss ein von derselben Developer-App verwaltbarer Reward ausgewählt/erstellt und eine echte Testeinlösung einschließlich Fulfillment bzw. Stornierung im Twitch-Dashboard abgeglichen werden. Das wurde nicht live ausgeführt.

### 8. Gesprächs-Funken

**Funktioniert/lokal belegt:** regelbasierte Themenzuordnung, Sliding Window, Teilnehmer-/Nachrichtenschwellen, Cooldowns, Deduplizierung, Feature-Flag standardmäßig aus und explizite Moderatorentscheidung sind getestet. Es wird kein vollständiger Chatverlauf dafür archiviert.

**Fehlt/vor Live nötig:** nur nach Community-/Datenschutzhinweis aktivieren; echte Twitch-Chat-Signale und Moderatorenfreigabe mit niedrigem Risiko testen. Themenmatching bleibt regelbasiert und kann Ironie, Synonyme und Schreibfehler nur begrenzt erkennen.

### 9. Chat-Imposter

**Funktioniert/lokal belegt:** Zustandswechsel, Mindest-/Maximalteilnehmer, eine geheime Rolle, Teilnehmerprüfung, Abstimmung, Gleichstand/XP und Wiederherstellung ausgewählter Rundenzustände. Tests belegen die serverseitige Twitch-ID-Bindung und dass OBS vor Auflösung keine Rolle/Regel erhält.

**Fehlt/vor Live nötig:** tatsächlichen HTTPS-Callback in der Twitch Developer Console exakt registrieren, von außen erreichbaren OAuth-Flow testen und Teilnehmerseite durch fremde Twitch-Konten sowie OBS auf echten OBS-Versionen abnehmen. Rollen-Webseite/-Session wurde nur lokal/mockbasiert getestet.

### 10. Chat-Detektiv und freiwillige Zitate

**Funktioniert/lokal belegt:** kein automatisches Chatarchiv; explizite `!savequote`-Einreichung nach Opt-in, Moderationsfreigabe, Widerruf/Löschung, Quote-Auswahl, Tipp und Auflösung sind in Tests abgedeckt. Widget-Snapshot veröffentlicht die Autoridentität erst nach Spielende.

**Fehlt/vor Live nötig:** Jannik muss Teilnehmerhinweis/Datenschutzhinweis und öffentliche Wiedergabe freigeben. Aufbewahrungsfrist, Löschablauf und die tatsächliche öffentlich abrufbare HTTPS-Seite müssen vor Aktivierung geprüft werden. Kein pauschaler DSGVO-Konformitätsnachweis.

### 11. Community-Pet, Mystery Drops und Chaos Wheel

**Funktioniert/lokal belegt:**

- Pet ist gemeinschaftlich und persistent, Werte werden begrenzt, pro Nutzer gibt es einen Pflege-Cooldown; einfache Stufen/Level und Emoji-basierte Widget-Zustände sind vorhanden.
- Drops können manuell gestartet werden; eindeutige Claims, Countdown/Auflösung, virtuelle XP, Feature-Flag und 90-Tage-Bereinigung sind implementiert.
- Wheel zieht serverseitig gewichtet, speichert Ergebnis und Cooldown; die Dashboard-Schalter sowie grundlegende Startaktionen und widerrufbare Widget-Tokens sind vorhanden.
- Tests decken Grundabläufe, Claim-Deduplizierung, einmalige XP im Normalablauf, deaktivierte Standards, Pet-Berechtigung und Retention ab.

**Bekannte Lücken/Fehler vor Live:**

1. **Drop-XP ist nicht atomar mit der Drop-Auflösung.** Der Drop wird zuerst als `completed` committed, anschließend werden XP-Einträge separat geschrieben. Ein Prozessabbruch dazwischen lässt den Drop abgeschlossen, aber die XP fehlen; beim Neustart wird er nicht erneut aufgelöst.
2. **Pet-Fortschritt hat keinen globalen Zeitraumdeckel.** Es existiert ein per-User-Cooldown, aber keine globale Fortschrittsbegrenzung; viele Accounts können gemeinsam sehr schnell Pet-XP/Level farmen.
3. **Wheel-Widget dreht technisch nicht sichtbar.** Der Spin wird sofort als `completed` gespeichert; die CSS-Drehanimation wird nur für `spinning` angewendet. Das Ergebnis ist da, die angeforderte synchronisierte Dreh-Animation nicht.
4. **Nicht bestätigte Wheel-Auswahl kann bereits das Pet ändern.** Enthält ein Challenge-Titel den Text „Drache“, werden Energie/Zufriedenheit sofort geändert – noch bevor Jannik die Challenge annimmt und auch dann, wenn das Pet-Modul aus ist. Das widerspricht der angekündigten Bestätigung und muss in eine explizite, idempotente Bestätigungsaktion überführt werden.
5. Ein Drop mit Claims verändert ebenfalls Pet-XP/-Freude automatisch, unabhängig davon, ob das Pet aktiviert ist. Das braucht ein klares Feature-Flag/Opt-in und eine idempotente Cross-Feature-Aktion.
6. `autoDrops` ist nur ein gespeicherter Schalter ohne Scheduler. Drop-Seltenheit ist eine manuelle Auswahl mit festen XP-Werten, keine gewichtete Seltenheitsauswahl. Community-Meilensteine, Kosmetik, Titel und andere Belohnungstypen fehlen.
7. Pet-Kosmetik/-Sammlung, ein echtes individuelles SVG-Drachenmotiv, vollständige Evolutions-/Meilenstein-Konfiguration und Dashboard-Namens-/Kurvenverwaltung fehlen. Die Animationsdarstellung verwendet derzeit Emoji.
8. Wheel-Challenges lassen sich über den API-Upsert hinzufügen/ändern, aber das Dashboard bietet nur Hinzufügen und eine JSON-Anzeige; komfortables Bearbeiten, Archivieren/Entfernen, Historie und Freigabezustände fehlen. Eine Rad-Challenge startet weder Quest noch Drop als echte Aktion.
9. Drop-Dashboard bietet keine vollständige Status-/Konfigurations-/Historienverwaltung; `!dropconfig` ist nur ein statischer Verweis. Automatik-, Wahrscheinlichkeits- und Belohnungswerte sind nicht im UI konfigurierbar.
10. Es fehlen spezifische Tests für Absturz genau zwischen Dropstatus und XP, Wiederanlauf/Idempotenz von Wheel und Drop, gewichtete Verteilungsgrenzen, globale Anti-Farming-Limits, OBS-Neuverbindung/-Animation sowie neue Dashboard-API-/Widget-Endpunkte.

**Empfehlung:** Arcade bis zur Behebung der Punkte 1–5 deaktiviert lassen; anschließend zuerst private Demo, dann begrenzter Streamtest mit niedrigen virtuellen XP.

### 12. Dashboard, Authentifizierung und OBS allgemein

**Funktioniert/lokal belegt:** Dashboard-Allowlist anhand numerischer Twitch-IDs, OAuth-Identitätsprüfung, Sessions, CSRF, Cookies, API-Berechtigungen und Admin-Audit sind in Tests abgedeckt. OBS-Tokens sind typgebunden, widerrufbar und read-only; SSE-Snapshots enthalten öffentliche Zustände.

**Fehlt/vor Live nötig:** erreichbarer HTTPS-Origin und Twitch-Redirects, Reverse-Proxy-/Caddy-Konfiguration, externer Zugriffstest, OBS Browser Source Reconnect/Rendering und Token-Rotation auf der echten URL. Session-Speicher ist laut README serverseitig im Speicher und verliert Sitzungen bei Neustart; das ist für Admins erwartbar, muss aber im Betriebsablauf bekannt sein.

### 13. SQLite, Backup/Restore, Docker und Oracle

**Funktioniert/lokal belegt:** WAL/Fremdschlüssel, versionierte Migrationen, Vorab-Backups und ausgewählte Restore-/Integritätstests bestehen lokal.

**Fehlt/vor Live nötig:** ARM64-Containerbuild und Start, persistent gemountete Datenbank, echter Backup-/Restore-Test auf einer Wegwerf-VM, Oracle-Healthcheck/Restart/Logrotation, DNS/HTTPS und Firewall-Abnahme. Die Entwicklerumgebung ist x86_64 und hat weder `docker compose` noch `docker buildx`; daher ist ARM64 lediglich vorgesehen, nicht abgenommen. Oracle-Ressourcen wurden weder angelegt noch verändert.

## Was für einen Livebetrieb noch gebraucht wird

### Betreiber (Basti)

1. Die aktualisierte `.env` in genau den tatsächlichen Deployment-Checkout/Server übertragen. Im aktuell geprüften Checkout fehlt `.env`; keine Werte wurden geprüft. Secret-/Tokenwerte niemals in Git, Chat, Screenshot oder Dashboard-Ausgabe übernehmen.
2. Die eigene Twitch Developer App und die exakt passenden Redirects für Chat-OAuth, Broadcaster-Redemption-OAuth, Dashboard-OAuth und Imposter-Teilnehmer-OAuth kontrollieren. Den geheimen Client Secret sicher auf dem Server ablegen.
3. Numerische Twitch-ID(s) für `DASHBOARD_ADMIN_IDS` und gewünschte Moderatorrechte festlegen.
4. Öffentliche Domain/DNS, Oracle-VM, Caddy/HTTPS, Firewall, `.env`, persistente Volumes, Logs und Backupziel konfigurieren. Die ersten Produktionsmigrationen nur mit aktuellem verifiziertem Backup durchführen.
5. Commit-Stand auf GitHub bringen, falls freigegeben. Aktueller Stand ist lokal sechs Commits voraus und nicht gepusht.
6. Live-Featureflags zunächst aus lassen, nach gestuftem Test jeweils einzeln einschalten und Monitoring/Abbruchverantwortung festlegen.

### Von Jannik

1. Broadcaster-OAuth nur für Kanalpunkte mit Scope `channel:manage:redemptions` genehmigen, falls diese Funktion live soll.
2. Bot in den eigenen Kanal lassen; wenn Twitch die gewählte Chatverbindung erfordert, dem Bot die erforderliche VIP-/Moderatorrolle geben.
3. Dashboard-Adminzugriff erlauben (seine numerische Twitch-ID muss der Betreiber eintragen) und reale Moderatoren benennen, die Spiele/Drops steuern dürfen.
4. Community-Minigame-Regeln, sichere Wheel-Challenges, Preise ausschließlich virtuell und die Texte für die Zitateinwilligung/Datenschutzhinweise prüfen und freigeben.
5. Vor Livegang einen privaten Techniktest und danach einen klar angekündigten, begrenzten Streamtest mit dem Betreiber durchführen.

Jannik benötigt dafür **keine Client-Secrets, Passwörter oder Tokens**. OAuth-Freigaben ausschließlich über die offiziellen Twitch-Consent-Seiten durchführen.

## Noch nötige Produkt-/Betriebsentscheidungen

- Welche Features gehen beim ersten Start live? Empfehlung: Chat, Dashboard, Quest/Poll zuerst; Kanalpunkte, Spark, Minispiele und Arcade separat und nach Einwilligung freischalten.
- Welche XP-Werte, Tageslimits, Cooldowns und Pet-Evolutionsgrenzen gelten?
- Sollen Drops nur manuell ausgelöst werden? Bis zur Implementierung eines kontrollierten Schedulers: ja.
- Dürfen Drop/Wheel-Aktionen Pet-XP/Energie ändern? Falls ja: explizite Bestätigung, Featureflags, einmalige Ledger-IDs und sichtbare Chat-/Dashboard-Rückmeldung definieren.
- Welche Challenge-Typen sind sicher und von Jannik genehmigt? Ohne Liste keine freie Zuschauer-Challenge.
- Welche Retention soll für Aktivitäts-, Drop- und Wheel-Daten gelten; wer beantwortet Löschanfragen?
- Ist der Bot für einen öffentlichen Kanal oder zuerst für einen privaten/testweisen Stream vorgesehen?
- Wer beobachtet Logs/Healthchecks und wer kann den Bot bzw. einzelne Module sofort pausieren?

## Empfohlene Reihenfolge bis Live

1. Arcade-Crashfenster, unbestätigte Pet-Nebenwirkungen, globale Limits und Wheel-Animation reparieren; fehlende Regressionstests ergänzen.
2. Externe Twitch-/OAuth-Callbacks und tatsächliche `.env` nur lokal/serverseitig validieren; keine Secrets teilen.
3. ARM64-Build/Start sowie Backup/Restore auf einer Wegwerf-Oracle-VM nachweisen.
4. Dashboard und OBS unter HTTPS mit privaten Testtokens prüfen; Token danach rotieren.
5. Bot-OAuth im Testkanal, Chat-Lesen/-Senden und Kanalbindung verifizieren.
6. Janniks Broadcaster-OAuth/Reward nur dann testen, wenn Kanalpunkte tatsächlich gestartet werden.
7. Datenschutz-/Teilnehmerhinweise freigeben, die Module einzeln konfigurieren und einen angekündigten kontrollierten Test durchführen.

**Keine Live-Abnahme liegt vor.** Erst nach diesen Schritten sollte der Bot als live-bereit bezeichnet werden.
