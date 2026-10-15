# ACY Twitch Bot — Offene Punkte

Stand: 15.10.2026. GitHub Issues wurden live abgefragt; drei Issues sind offen, keine offenen Pull Requests.

## Priorisiert

| Priorität | Punkt | Status / Nachweis | Nächster sicherer Schritt |
|---|---|---|---|
| P1 | OAuth und VIP-/Kanalpunkte-/Spotify-Staging | BLOCKED: lokale Mocks bestehen; echte Broadcaster- und Provider-Abläufe sind nicht verifiziert. GitHub #6. | Getrennte Staging-Konten und OAuth-Scopes bereitstellen; reale Einlösungen/Playlist-Schreibvorgänge nur in Staging. |
| P1 | Imposter-Wort-/Hinweiswortmodus | NOT IMPLEMENTED: jetziger Imposter erkennt eine geheime Regel; keine Begriffe oder privaten Hinweiswörter. GitHub #4. | Spielregeln und private Zustellung entscheiden; Portal ist vorhandener sicherer Zustellweg, Whisper nicht implementiert. |
| P1 | Production-Login und Berechtigungen | PARTIALLY VERIFIED: öffentliche Login-Weiterleitung und lokale Allowlist-/Session-/CSRF-Tests bestanden; kein authentifizierter Live-Dashboardlauf. | Bei freigegebenem Abnahmetermin Anmeldung mit Janniks Browser-Sitzung prüfen, ohne Rollen oder Einstellungen zu ändern. |
| P2 | Dashboard-/Moderations-Browser-E2E | PARTIALLY VERIFIED: 5 Browserregressionen, aber nicht alle Live-Control-Aktionen, Poll-Ende und Erinnerungsmoderation. GitHub #5. | E2E für jede privilegierte Aktion ergänzen; Status/Fehlerzustände gegen isolierte Testdaten prüfen. |
| P2 | Public health monitoring | FIXED / LIVE: `/health` liefert öffentlich 200 und nur `{status:"alive"}`. | Health-Check-Verbraucher auf Liveness-Semantik abstimmen; DB/Twitch/OBS werden bewusst nicht geprüft. |
| P2 | Imposter-Abstimmungserklärung | FIXED / LIVE: Portal und Hilfe kennzeichnen Portalstimmen als geheim und `!sus`-Chatstimmen als öffentlich. | Keine weitere Aktion erforderlich; Spielregeln blieben unverändert. |
| P2 | Production-Status-/Chat-/OBS-Beobachtbarkeit | PARTIALLY VERIFIED: HTTP-Liveness, PM2-Status und SQLite-Integrität nach Release geprüft; keine authentifizierte Live-OBS-/OAuth-Prüfung. | In Staging OBS-/OAuth-Prüfung dokumentieren; keine Tokens öffentlich oder in Reports erfassen. |
| P3 | Root-Landingpage | NOT CONFIGURED: `/` gibt 404; vorhandene Startpunkte sind `/hilfe` und `/community`. | Nur ändern, falls ein klarer Produktzweck für eine Root-Seite besteht. |
| P3 | Imposter-Hinweisrunde / längere Chatmoderation | NICHT VORHANDEN als eigenes Wortspiel; aktuelles Regelspiel hat Timer für Anmeldung, Diskussion und Abstimmung. | Keine neue Phase vor Entscheidung über den Wortspielmodus hinzufügen. |

## Externe GitHub-Issues

- [#4 Imposter: clue-word round mode](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/4)
- [#5 Complete browser E2E coverage for dashboard and moderation workflows](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/5)
- [#6 Staging verification for Twitch VIP, channel points, Spotify, and OBS](https://github.com/Gater-App/Acyjannik-Twitch-Bot/issues/6)

Diese Liste dokumentiert vorhandene Issues. Sie wurden in diesem Audit weder verändert noch geschlossen.
