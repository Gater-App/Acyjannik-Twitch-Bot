# ACY Twitch Bot – Imposter 2.0 Geheimwort

Stand: 15.10.2026
Repository: `Gater-App/Acyjannik-Twitch-Bot`
Branch: `codex/imposter-secret-word-006`
Basis und aktueller HEAD: `f075663790263e59256f49130f00274dd4067fea` (`origin/main`)

## Ergebnis

Der neue Geheimwort-Modus ist als eigenständige, standardmäßig ausgeschaltete Variante implementiert. Das bestehende Regel-Imposter bleibt erhalten; die Modi blockieren sich gegenseitig, ebenso der Detektiv. Änderungen liegen ausschließlich lokal im isolierten Worktree. Es gab keinen Commit, Push, Merge, Production-Start, keine Twitch-Live-Aktion und keine OBS-Production-Aktion.

## Spielablauf

1. Jannik oder ein Mod öffnet die Anmeldung im Minispiel-Dashboard oder mit `!startwordimposter`. Das Spiel muss dafür aktiviert sein.
2. Zuschauer melden sich mit `!joinword` oder im angemeldeten Community-Portal an. `!leaveword` ist während der Anmeldung verfügbar. Die Teilnehmerzahl ist konfigurierbar; Standard sind mindestens 4 und höchstens 20 Personen.
3. Nach Ablauf der Anmeldung startet die Rollenverteilung automatisch, sofern genug Personen angemeldet sind. Ein Mod kann sie auch früher auslösen. Eine Person wird zufällig zum Imposter; die übrigen erhalten dasselbe deutsche Geheimwort.
4. Die Teilnehmenden geben nacheinander je ein Hinweiswort im Portal ab. Der aktuelle Hinweis wird erst nach Moderationsfreigabe öffentlich. Jannik oder Mods können ihn überspringen.
5. Nach den Hinweisen läuft eine Diskussionsphase. Mods können sie verlängern oder die geheime Portalabstimmung starten. Die Abstimmung endet automatisch oder kann manuell geschlossen werden.
6. Selbststimmen, Nichtteilnehmende, Mehrfach- und verspätete Stimmen werden serverseitig abgewiesen. Bei Gleichstand gewinnt der Imposter. Wird er erkannt, kann er – sofern aktiviert – privat den Begriff erraten.
7. Die Auflösung erscheint im Portal und Imposter-OBS-Widget. Einrichtungswerte für Teilnahme- und Sieges-XP verwenden den bestehenden XP-Pfad und eindeutige Auszahlungs-IDs.

`!sus @Name` bleibt die öffentliche Chatabstimmung des vorhandenen Regel-Imposters. Sie wird nicht als geheime Stimme des neuen Spiels interpretiert.

## Umsetzung

- Spiellogik und Zustandsmaschine: `src/secret-word-imposter.ts`.
- Eigenständige Portalansicht unter `/community/imposter-word`, Teilnehmeraktionen und Status-API: `src/secret-word-imposter-ui.ts`, `src/community-portal.ts`.
- Moderationssteuerung und Einstellungen: Minispiele-Bereich im Streamer-Dashboard (`src/dashboard.ts`, `src/mini-games-ui.ts`).
- Öffentliche Statusdaten für das vorhandene Imposter-OBS-Widget: `src/dashboard.ts`, `src/dashboard-community-ui.ts`.
- Twitch-Chatbefehle und Tick-/Timeout-Integration: `src/community-features.ts`, `src/main.ts`.
- `!help imposter` nennt die aktive Variante und deren Befehle (`src/help.ts`).

## Datenbank

Migration v33 ergänzt `word_imposter_rounds`, `word_imposter_players`, `word_imposter_hints` und `word_imposter_votes` in `src/feature-store.ts`.

- Rundenphasen und Rollen sind durch `CHECK`-Constraints begrenzt.
- Eindeutige Schlüssel verhindern doppelte Teilnahme, doppelte Hinweise und Mehrfachstimmen. Ein partieller Unique-Index erlaubt nur eine gleichzeitig aktive Geheimwort-Runde.
- Foreign Keys verknüpfen Hinweise und Stimmen mit Teilnehmenden und Runden.
- XP und Spielauszahlung werden innerhalb der SQLite-Transaktion verarbeitet und über `mini_game_awards.event_id` dedupliziert.
- Der bestehende Migrationspfad erstellt vor v33 ein Datenbankbackup. Backup-Verzeichnis, Schreibrechte und Wiederherstellung müssen vor dem Production-Start mit der tatsächlichen Oracle-Konfiguration geprüft werden.

Für Production wurde keine Migration ausgeführt. Beim späteren Release ist v33 auf einer gesicherten Datenbankkopie zu validieren; anschließend Backup/Restore sowie den einmaligen Start mit der produktiven Datenbank kontrollieren.

## Sicherheit und Twitch-Abhängigkeiten

- Private Rolle und Begriff kommen ausschließlich aus der bereits verifizierten, gehashten Community-OAuth-Sitzung. Die API ignoriert frei übermittelte Twitch-IDs. Anonyme Statusabfragen enthalten nur öffentliche Spielinformationen.
- Schreibaktionen benötigen Sitzung, CSRF-Token und bestehendes Portal-Rate-Limit. Spielteilnahme, aktuelle Hinweisrunde, Kandidaten, Fristen und Rollen prüft der Server erneut.
- Öffentliche Portal- und OBS-Snapshots enthalten vor der Auflösung weder Rollen, Twitch-IDs, Stimmenziele, geheime Wörter noch ungeprüfte Hinweise. Der Dashboard-Moderationssnapshot ist nur über die bestehende geschützte Admin-Sitzung verfügbar.
- Der Geheimwort-Modus nutzt die vorhandene Twitch-Anmeldung. Es wurden keine OAuth-Scopes ergänzt und keine Whisper-Funktion eingebaut. Portalzustellung ist der verbindliche Weg; Twitch-Whispers sind hier nicht für die Zustellung vorausgesetzt.
- Lokale OAuth-Tests verwenden einen Stub. Twitch-Anmeldung, produktive Callback-URL und echte Nutzerkonten wurden nicht live verifiziert.

Das Wort liegt während einer Runde im SQLite-Datensatz im Klartext. Die Zugriffstrennung schützt API- und Widget-Ausgaben; sie verschlüsselt die Datenbankdatei oder Backups nicht. Hinweisfilter verhindern die direkte normalisierte Eingabe des geheimen Worts, erkennen aber keine semantischen oder indirekten Spoiler. Die Moderationsfreigabe bleibt deshalb wichtig.

## Tests und lokale Ansichten

- `npm run check`: Build erfolgreich; **204/204 Unit- und Integrationstests bestanden**.
- `npm run test:browser`: **6/6 Browser-Tests bestanden**.
- Geheimwort-Browsertest nach der letzten Portaländerung: **1/1 bestanden**. Prüft Mobil- und Desktopbreite, Rollenanzeige nach Portal-Reload (Reconnect), Seitenfehler und anonymen öffentlichen Snapshot.
- Zusätzliche Geheimwort-Tests prüfen Rollen, fremde/anonyme Zugriffe, Hinweisfreigabe, Zeitlimits, Registrierung, Abstimmung, Gleichstand, letzten Tipp, idempotente XP, Neustart und OBS-Geheimhaltung.
- `git diff --check`: sauber.

Die Browserkonten und OAuth-Antworten sind Testdaten. Generierte Desktop- und Mobil-Screenshots bleiben als lokale Debug-Artefakte außerhalb des Git-Branches.

## Offene Grenzen und Release-Risiken

- **Nicht live geprüft:** OAuth-Callback-Konfiguration, Portalzugriff über Caddy/Oracle, Twitch-Chatbefehle, OBS-Browserquelle und produktive SQLite-Migration.
- **Kein Whisper-Fallback:** Absichtlich nicht implementiert; Spieler brauchen Zugriff auf das authentifizierte Community-Portal.
- **Moderationslast:** Jeder Hinweis wartet auf Freigabe. Bei vielen Spielenden muss ein Mod die Freigabe oder das Überspringen zügig durchführen.
- **Polling:** Die Portalseite aktualisiert alle drei Sekunden. Das ist für einen kleinen Stream realistisch, aber keine gemessene Kapazitätszusage für hohe gleichzeitige Nutzerzahlen.
- **Datenaufbewahrung:** Abgeschlossene Runden werden derzeit nicht durch eine neue Retention-Policy bereinigt. Langfristiges Tabellenwachstum sollte nach einem realen Nutzungszeitraum gemessen werden.
- **Keine Live-Abnahme:** Ein lokaler grüner Lauf bestätigt nicht die Oracle-, Caddy-, Twitch- oder OBS-Konfiguration.

## Testablauf mit Jannik vor einem Release

1. In einer Staging-Kopie v33 migrieren und Restore aus dem zuvor geprüften Backup üben.
2. Bestehende Twitch-Portal-OAuth-Callback-URL und HTTPS/Caddy-Routing prüfen; anmelden und ausloggen. Keine neuen Scopes erwarten.
3. Geheimwort-Modus einschalten, Mindestzahl auf 3 setzen und eine Runde starten. Mit mehreren separaten Testkonten beitreten; Doppelt- und Vollbeitritt prüfen.
4. Als jedes Konto die eigene Rolle prüfen. Mit einem anderen Konto und anonym darf die Rolle nicht abrufbar sein.
5. Hinweise einzeln abgeben, direkten Begriff testen, Moderationsfreigabe/Überspringen und Timeout beobachten. In OBS und anonymen API-Antworten darf das Wort nicht erscheinen.
6. Diskussion verlängern, geheime Stimmen abgeben und Doppel-/Selbst-/Fremdstimmen prüfen. Separat Gleichstand, nicht erkannter Imposter, richtiger und falscher letzter Tipp testen.
7. Ergebnisse, XP-Ledger, Reload/Browser-Reconnect und Neustart in Staging prüfen. OBS darf das Wort erst nach Auflösung zeigen.
8. Erst nach bewusster Freigabe Production-Migration und Deployment planen; anschließend Healthcheck, Logs, Portal-OAuth und OBS ohne erzwungenen Chatversand kontrollieren.
