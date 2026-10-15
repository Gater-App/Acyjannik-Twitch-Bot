# ACY Twitch Bot — Night Shift 001

## Management-Zusammenfassung

Der lokale Stand ist nachvollziehbar und die volle vorhandene Testbasis ist grün. Das Community-Portal ist öffentlich erreichbar und zeigt auf dem realen mobilen Browser die zentralen Bereiche. OAuth, Session-/CSRF-Schutz, Moderatoren-Allowlist, Imposter-Rollen und Spielstände sind lokal durch Tests abgesichert. Das tatsächliche Imposter-Wortspiel und echte externe Twitch-/Spotify-/OBS-Staging-Abläufe sind noch nicht verfügbar oder nicht verifiziert.

Heute Nacht wurden zwei kleine, risikoarme Qualitätskorrekturen lokal vorbereitet:

1. Ein öffentlicher, schreibgeschützter `/health`-Liveness-Pfad, weil Production zuvor 404 lieferte. Er sagt nur, dass der HTTP-Prozess antwortet; er behauptet keine Datenbank-, Twitch- oder OBS-Gesundheit.
2. Eine klare Unterscheidung in Hilfe und Portal zwischen geheimer Portalabstimmung und öffentlich sichtbarer Chatstimme über `!sus`.

Keine Änderung wurde committed, gepusht, gemerged oder deployed.

## 1. Ausgangszustand

- Checkout: `/Users/basti/Documents/Codex/2026-10-14/und-gleich-das-erste-problem-das/work/Acyjannik-Twitch-Bot`.
- Branch: `feature/halloween-haunted-house`; HEAD `9b7e7e7261b116d5530da8c7cf85beb5adff4311`.
- `origin/main` nach erneutem Fetch: derselbe Commit. Lokaler Feature-Branch liegt einen Commit vor `origin/feature/halloween-haunted-house`, aber der zusätzliche Commit ist bereits in `origin/main` enthalten. Keine offenen PRs.
- GitHub meldet drei offene Issues: #4 Imposter-Wortspiel, #5 Browser-E2E-Ausbau, #6 externe Staging-Prüfungen.
- Vor dem Testlauf waren drei versionierte Prüfscreenshots geändert und 18 Bilddateien unter `artifacts/` unversioniert. Die Browserregression schreibt selbst nach `docs/verification/` (darunter VIP- und Wheel-Screenshots); sie hat diese Testbilder beim Lauf erneuert. Die Dateien bleiben ungestaged und uncommitted. Die 18 unversionierten `artifacts/` wurden nicht angefasst.
- Letzter nachweisbarer Production-Code: `e409596eddf0e579833c295e23f3dce259b541b4`; der GitHub-`main`-Commit `9b7e7e7` ist ein nachfolgender Dokumentationsmerge. Produktionszustand aus [Releasebericht](../release-report-2026-10-15.md) übernommen, nicht per Serverzugriff erneut geprüft.

## 2. Untersuchte Bereiche

Dashboard und Streamer Live Control, Twitch-OAuth, Zuschauerportal und Profile, XP/Level, Quests, Ideen und Abstimmungen, Chaos Wheel, Mystery Drops, Elio, Imposter/Detektiv, VIP, Erinnerungswand, Community-Tresor, Songwünsche/Kanalpunkte/Spotify, Halloween/Spukhaus, automatische Nachrichten, OBS-Widgets, EventSub, SQLite-Migrationen und Lifecycle-Neustartmarker.

Die Status- und Evidenztabelle steht in [FEATURE_MATRIX.md](FEATURE_MATRIX.md). Vorhandene Screenshots aus früheren lokalen Prüfungen liegen weiterhin in `docs/verification/` und `docs/screenshots/2026-10-14/`.

## 3. Befunde und Änderungen

### Imposter und Rollen

- **VERIFIED lokal:** Registrierung, Rollenauswahl, geheime Rolle nur für die eigene verifizierte Twitch-ID, Portalabstimmung, Ergebnis und idempotente XP sind durch `src/mini-games.test.ts` und `src/community-portal.test.ts` abgedeckt.
- Der aktuelle Spielmodus ist ein geheimes Regel-Erkennungsspiel. Ein geheimes Begriff-/Hinweiswortspiel mit Wortbeiträgen je Runde existiert nicht.
- Twitch-Whispers werden nicht verwendet oder technisch unterstützt. Die geheime Rolle wird stattdessen nach Twitch-Anmeldung ausschließlich im persönlichen Portal-Endpunkt gezeigt. Keine Rolle wird an das öffentliche OBS-Widget ausgegeben.
- Gefundene UX-Inkonsistenz: Die Portalbeschreibung nannte die Abstimmung geheim, während die Hilfe `!sus @Name` als Alternative anbot und der Bot im öffentlichen Chat den Zielnamen bestätigt. Hilfe und Portal sagen jetzt ausdrücklich, dass Portalstimmen geheim bleiben und Chatstimmen öffentlich sind. Das ändert keine Spielregel.

### Anmeldung und Dashboard-Sicherheit

- **VERIFIED lokal:** OAuth-State wird zufällig erzeugt, im selben Browser gebunden und einmalig verbraucht. Identität wird gegen Twitch validiert und Admin-/Moderatorzugriff anhand serverseitiger Allowlist vergeben. Sessions sind HttpOnly/Secure/SameSite-Lax; schreibende Dashboard-Aktionen verlangen CSRF-Token und passende Origin.
- Logout ist im Playwright-Browserlauf geprüft.
- **PARTIALLY VERIFIED Production:** GET `/dashboard` und `/streamer` leiten ohne Sitzung weiter; `/dashboard/login` startet OAuth mit Redirect; Callback ohne gültigen State wird verworfen. Kein Login wurde mit einem echten Nutzerkonto abgeschlossen und keine Sitzung im Browser übernommen.

### Dashboard, Portal und Mobilansicht

- Lokale Playwright-Suite: 5/5 Tests bestanden. Sie deckt echte Dashboardnavigation/Logout, Community-Welt am Desktop/Mobilgerät, Elio-Aktionen, Wheel-OBS-Rendering und VIP-Lounge-/Dashboardklicks ab.
- Öffentliche Produktionsseite `/community` wurde am 15.10. lesend im Browser geöffnet. Accessibility-Ansicht zeigte Navigation für Imposter, Quests, Ideen, Erinnerungen, Spukhaus, VIP-Lounge und Profil sowie Portalhinweise für nicht angemeldete Personen. Der mobile Screenshot zeigt eine horizontal scrollbare Navigation; die unteren Inhalte sind als Karten gestapelt. Dashboard mobil wurde in diesem Lauf nicht im Live-Browser geöffnet.
- Browserregression fängt JavaScript-Fehler für ihre getesteten lokalen Pfade ab. Es wurde kein vollständiger Browser-Lauf für alle Live-Control- und Moderationsaktionen durchgeführt.

### Production-Routen

Am 15.10. wurden ausschließlich öffentliche GETs mit manuellem Redirect-Verhalten abgerufen:

| Route | HTTP | Interpretation |
|---|---:|---|
| `/` | 404 | Keine Root-Startseite konfiguriert. |
| `/dashboard` | 302 | Geschützt; Redirect zu Anmeldung. |
| `/dashboard/login` | 302 | OAuth-Start. |
| `/dashboard/oauth/callback` ohne Code/State | 400 | Ungültiger Callback abgewiesen. |
| `/streamer` | 302 | Geschützt. |
| `/hilfe` | 200 | Öffentliche Hilfe erreichbar. |
| `/community` | 200 | Öffentliches Portal erreichbar. |
| `/health` | 404 | Belegt die fehlende Liveness-Route im damaligen Production-Code. |

Die Route `/health` wurde lokal als `{status:"alive"}` ergänzt, unterstützt nur GET und setzt `Cache-Control: no-store`. Sie prüft bewusst weder SQLite noch Twitch und ist noch nicht deployed.

## 4. Reliability, Performance und Migrationen

- EventSub hat Keepalive-Überwachung, Twitch-Reconnect-Handoff und begrenzten exponentiellen Retry. Die Chat-/Redemptionpfade enthalten Deduplizierung bzw. Idempotenztests. Es gab keinen echten Last- oder Langzeittest.
- Dashboard-Polling wird für versteckte Tabs/Ansichten begrenzt; häufige Werte liegen im Bereich 8–30 Sekunden. OBS-Widget-Streams aktualisieren sich im Abstand von 2,5 Sekunden. Die Produktionslast wurde nicht gemessen; daraus wird kein Engpass behauptet.
- SQLite nutzt WAL, Foreign Keys und 5-Sekunden-`busy_timeout`. Schemaversion 1–32 wird im `FeatureStore` verwaltet. Tests decken ältere Upgradepfade wie v29/v31 und einzelne kritische Daten-Erhaltungsfälle ab. Alle Migrationstests laufen lokal isoliert.
- Der letzte Releasebericht dokumentiert Production-Schema v32 und `integrity_check=ok` am 15.10. Beim Night Shift wurden weder Produktionsdatenbank noch Oracle-Host geöffnet oder geändert.

## 5. Sicherheit und Datenschutz

- VIP-Berechtigung wird serverseitig über Twitch-API/ID geprüft und schließt bei API-Fehlern sicher; Admin-/Moderator-Allowlist ist getrennt.
- XP/Belohnungspfade verwenden eindeutige Ereignis-IDs/Transaktionen; unklare externe Schreibvorgänge werden nicht blind wiederholt.
- Öffentliche und private Imposter-Antworten sind getrennt; nur der angemeldete eigene Teilnehmer erhält seine geheime Rolle. Whispers sind nicht implementiert.
- Keine Angriffstests auf Production, Secrets ausgelesen oder Live-Aktionen ausgeführt.

## 6. Tests

- `npm run check` nach den Korrekturen: Build erfolgreich; 194/194 Unit-/Integrationstests bestanden.
- `npm run test:browser` nach den Korrekturen: 5/5 Browserregressionen bestanden.
- `git diff --check`: bestanden.

## 7. Priorisierte nächste Schritte

### Die fünf wichtigsten Probleme

1. Offizielles, getrenntes Twitch-/Spotify-/OBS-Staging verfügbar machen und reale Auth-/Providerabläufe prüfen (Issue #6).
2. Imposter-Wortspiel fachlich entscheiden und als klar getrennte Funktion planen; aktueller Modus nicht als Wortspiel bewerben (Issue #4).
3. Browser-E2E für jede privilegierte Live-Control- und Moderationsaktion erweitern, insbesondere Fehler-/Cooldownzustände (Issue #5).
4. Authentifizierten Production-Login kontrolliert mit Janniks Sitzung abnehmen, ohne Einstellungen oder Liveaktionen auszuführen.
5. Lokalen `/health`-Pfad erst in einem normalen Releasezyklus veröffentlichen und als Liveness, nicht als vollständigen Abhängigkeitscheck, dokumentieren.

### Die drei größten UX-Verbesserungen

1. Einheitliche Lade-/Erfolgs-/Fehlermeldungen für alle Live-Control-Aktionen mit echten Browser-E2E-Nachweisen.
2. Imposter-Ablauf auf der Portal-Seite und im Chat entlang „Anmelden → Regel sehen → Diskutieren → geheim abstimmen → Ergebnis“ erklären; `!sus`-Transparenz ist lokal korrigiert.
3. Offene Moderationsaufgaben (Ideen, Erinnerungen, Quests) in einer konsistenten, mobil gut erreichbaren Inbox zusammenführen, ohne bestehende Einreichungen zu verstecken.

## 8. Änderungen und Arbeitsbaum

Änderungen dieses Auftrags:

- `src/dashboard.ts` — schreibgeschützter Liveness-Endpunkt.
- `src/dashboard.test.ts` — Auth-freier GET, Antwort, Cacheheader und Schreibmethoden-Ablehnung.
- `src/help.ts`, `src/help.test.ts` — öffentliche `!sus`-Stimme klar gekennzeichnet.
- `src/community-portal.ts`, `src/community-portal.test.ts` — Abstimmungsprivatsphäre klargestellt.
- `docs/project-status/MASTER_STATUS.md`
- `docs/project-status/FEATURE_MATRIX.md`
- `docs/project-status/OPEN_ISSUES.md`
- `docs/project-status/NIGHT_SHIFT_001_REPORT.md`

Die Testsuite hat zusätzlich fest verdrahtete Screenshot-Ausgaben unter `docs/verification/` aktualisiert; die in `artifacts/` vorhandenen 18 Bilder blieben unangetastet. Keine Commits, Pushes, Merges oder Deployments.
