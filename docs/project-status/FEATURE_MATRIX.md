# ACY Twitch Bot — Feature-Matrix

Stand: 15.10.2026 · Production-Code `2270094` · Caddy-Konfiguration `10e2be7`.

`lokal` und `Production` sind getrennte Aussagen. Ein lokal bestandener Test beweist keine Live-Verfügbarkeit. Details zum Produktionsrelease stehen in [docs/release-report-2026-10-15.md](../release-report-2026-10-15.md).

| Bereich | Lokal | Production | UX / Integration | Nachweis und offene Grenze |
|---|---|---|---|---|
| Admin-Dashboard / Adminrechte | VERIFIED | PARTIALLY VERIFIED | Navigation, Rollen, Fehlerfeedback und Logout im Browser geprüft. | `src/dashboard.test.ts`, `browser-tests/dashboard.browser.test.ts`; Live `/dashboard`→302. Kein authentifizierter Production-Browserlauf. |
| Twitch-OAuth Admin | VERIFIED | PARTIALLY VERIFIED | State einmalig und browsergebunden; Twitch-Identität gegen Allowlist; sichere Session-/CSRF-Prüfung. | `src/oauth.test.ts`, `src/dashboard.test.ts`; live Login-Start→302, Callback ohne State→400. Kein interaktiver Live-Login. |
| Zuschauer-OAuth / Profile | VERIFIED | PARTIALLY VERIFIED | Twitch-ID-basierte Session, HttpOnly-Cookie, CSRF, Logout und öffentliche/private Daten getrennt. | `src/community-portal.test.ts`; `/community` live→200. Keine authentifizierte Live-Session verwendet. |
| Streamer Live Control | PARTIALLY VERIFIED | PARTIALLY VERIFIED | Bestehende Spiele-, Quest-, Drop-, Wheel-, Event- und Tresoraktionen serverseitig verdrahtet; Browser-Tests decken die komplette Aktionsmenge nicht ab. | `src/live-control.ts`, `src/dashboard.ts`, `browser-tests/dashboard.browser.test.ts`; Live `/streamer`→302. Titel-/Kategorie-Änderung fehlt. |
| Chatbefehle / Hilfe | VERIFIED | PARTIALLY VERIFIED | Befehle werden zentral nach Rollen, Aktivierung und Cooldowns geprüft; Hilfe bleibt öffentlich und mobil. Imposter-Stimmhinweis präzisiert. | `src/command-handler.test.ts`, `src/help.test.ts`; `/hilfe` live→200. Live-Chatversand wurde nicht ausgelöst. |
| XP, Level, Saisonpunkte | VERIFIED | PARTIALLY VERIFIED | Ledger- und Ereignis-IDs schützen gegen doppelte Vergabe; Caps und saisonale Werte getestet. | `src/community-arcade.test.ts`, `src/community-world.test.ts`, `src/game.test.ts`; öffentliche Portalwerte sichtbar. Kein produktiver Schreibtest. |
| Quests / Challenges | VERIFIED | PARTIALLY VERIFIED | Moderation, Freigabe, Aktivierung, Abstimmung und Abschluss verwenden vorhandene Datenpfade; automatische Zusage wird vermieden. | `src/quest-poll.test.ts`, `src/dashboard-community-ui.test.ts`, Browserregression. |
| Chaos Wheel 3.0 | VERIFIED | PARTIALLY VERIFIED | Serverseitige Auswahl, aktive Chatteilnehmende, idempotenter XP-Pfad und Gewinner-Overlay lokal geprüft. | `src/community-arcade.test.ts`, Browser-OBS-Test; kein Live-OBS-/Twitch-Staging. |
| Mystery Drops | VERIFIED | PARTIALLY VERIFIED | Claim- und XP-Idempotenz sowie Wiederaufnahme nach Neustart lokal geprüft. | `src/community-arcade.test.ts`; keine Live-Auslösung. |
| Elio | VERIFIED | PARTIALLY VERIFIED | Feed/Play, Werte, Stimmung, Cooldowns, Privatsphäre, Historie und Browser-Feedback geprüft. | `src/community-features.test.ts`, `src/community-portal.test.ts`, Browserregression; reale Portalansicht live lesend sichtbar. |
| Imposter | PARTIALLY VERIFIED | PARTIALLY VERIFIED | Anmeldung, einmalige Rollenvergabe, Portalrolle nur für eigene verifizierte Twitch-ID, Abstimmung, Ergebnis, XP und Neustart getestet. | `src/mini-games.test.ts`, `src/community-portal.test.ts`. Es ist ein geheimes Regel-Erkennungsspiel, kein geheimes Begriff-/Hinweiswortspiel. Twitch-Whispers sind nicht implementiert; geheime Rollen werden im Portal gezeigt. Chat-`!sus` ist öffentlich. |
| VIP Experience | PARTIALLY VERIFIED | BLOCKED | Zentrale VIP-API-Prüfung und lokale Mock-Tests; Funktionen sind standardmäßig deaktiviert. | `src/twitch-vip.test.ts`, `src/vip-experience.test.ts`, `browser-tests/vip.browser.test.ts`; echte Broadcaster-VIP-Autorisierung/Staging fehlen (Issue #6). |
| Live-Abstimmungen | PARTIALLY VERIFIED | PARTIALLY VERIFIED | Stimmen, Einmaligkeit, Ergebnis und Ablauf lokal geprüft; nicht jeder Verwaltungsablauf hat Browserklick-E2E. | `src/quest-poll.test.ts`, `src/community-portal.test.ts`; keine Live-Abstimmung gestartet. |
| Community-Ideen | VERIFIED | PARTIALLY VERIFIED | `!idee`, Portal, Moderation, Status und Abstimmung verwenden gemeinsame Persistenz. | `src/community-portal.test.ts`, `src/dashboard.test.ts`, Browser-Dashboard-Test. |
| Erinnerungswand | PARTIALLY VERIFIED | PARTIALLY VERIFIED | Schema, Freigabe und Reaktionen getestet; Moderationsseite nicht vollständig per Browser-E2E geprüft. | `src/community-memories.test.ts`; Migration v29 lokal isoliert. |
| Community-Tresor | VERIFIED | PARTIALLY VERIFIED | Start, sichere öffentliche Daten, Codehinweise, Ablauf und Cooldown lokal geprüft. | `src/community-vault.test.ts`, Dashboard-Tests; keine Live-Runde. |
| Songwünsche / Kanalpunkte / Spotify | PARTIALLY VERIFIED | BLOCKED | OAuth-State und externe Schreibvorgänge mock-basiert, Wiederholungsschutz und manuelle Klärung bei unklarem Ergebnis. | `src/song-requests.test.ts`, `src/channel-points.test.ts`; echtes Twitch-/Spotify-Staging fehlt (Issue #6). |
| Halloween / Spukhaus | VERIFIED | PARTIALLY VERIFIED | Eventwerte bleiben getrennt und zusätzliche Beiträge sind nachvollziehbar; keine Änderung an Wahrscheinlichkeiten. | `src/community-haunted-house.test.ts`, `src/game.test.ts`; Live-Eventkonfiguration nicht ausgelesen. |
| Automatische Chatnachrichten / Tipps | VERIFIED | PARTIALLY VERIFIED | Gemeinsamer Scheduler, Aktivitätsfenster, Sendelimits und Profile sind getestet. | `src/automatic-chat-messages.test.ts`, `src/community-tips.test.ts`; keine Live-Nachricht gesendet. |
| OBS-Widgets | PARTIALLY VERIFIED | BLOCKED | Token- und Overlaypfade sowie Wheel-Rendering lokal geprüft. | `src/dashboard.test.ts`, Browser-Wheel-Test; Live-OBS-Endpunkte ohne freigegebenes Widget-Token nicht verifiziert. |
| EventSub / Reconnect | PARTIALLY VERIFIED | PARTIALLY VERIFIED | Keepalive, Twitch-Reconnect und Backoff im Code; Chatduplikate werden in den nachgelagerten Pfaden geprüft. | `src/eventsub.ts`, `src/eventsub.test.ts`, `src/chat.test.ts`; keine Netzwerklast-/Langzeitmessung. |
| Neustart / Persistenz / Migrationen | VERIFIED lokal | PARTIALLY VERIFIED | Neustartmarker, sichere einmalige Rückkehr und SQLite-Migrationen 1–32 getestet. | `src/bot-lifecycle.test.ts`, `src/feature-store-migration.test.ts`; Production v32 und SQLite-Integrität wurden beim Release am 15.10. bestätigt. Night-Shift hat keine Live-Migration ausgeführt. |
| Liveness-Health | VERIFIED | VERIFIED | Öffentlicher `GET /health` liefert nur `{status:"alive"}`; kein DB-/Twitch-Abhängigkeitsversprechen. | `src/dashboard.ts`, `src/dashboard.test.ts`, `ops/Caddyfile.oracle`; Production nach Release 2270094 öffentlich 200. |

## Abdeckung in diesem Lauf

- Lokaler Build und gesamte Unit-/Integrationssuite: 194/194 bestanden.
- Playwright-Browserregression: 5/5 bestanden. Echte Klickpfade decken Dashboardnavigation/Logout, Community-Welt Desktop/Mobil, Elio, Chaos-Wheel-OBS und VIP-Lounge ab.
- Öffentliche Production-GETs nach Deployment: `/health` 200; `/dashboard` 302; `/dashboard/login` 302; Callback ohne Code/State 400; `/streamer` 302; `/hilfe` 200; `/community` 200; Root `/` 404.
- Kein authentifizierter OAuth-Login und keine Production-Chat-, Spiel- oder OBS-Aktion ausgeführt.
