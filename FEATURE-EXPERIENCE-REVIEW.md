# ACY Twitch Community Bot – Funktions-Erlebnisprüfung

Stand: 14. Oktober 2026  
Geprüfter lokaler Stand: `ux/dashboard-5.0` auf `0f2a7d1` plus der unten beschriebene lokale Hotfix.  
Scope: Code, Oberfläche und automatisierte lokale Tests. Kein Twitch-Livebetrieb, kein Browser gegen Production, kein Oracle-Zugriff und kein Deployment geprüft.

## Kompakte Funktionsübersicht

„Lokal belegt“ bedeutet: Codepfad und Tests im Repository; es beweist keine funktionierende Twitch-Verbindung oder Oracle-Laufzeit. Sichtbare Zuschaueraktionen finden überwiegend im Chat statt. Das Portal ist für persönliche Profile und geheime Imposter-Rollen gedacht; Dashboard und Streamer-Modus bleiben geschützt.

| Funktion | Status / Rollenpfad | Bedienung und Automatik | Hauptproblem / nächster Schritt |
|---|---|---|---|
| 8-Ball | Lokal implementiert; Zuschauer fragen im Chat | Ein Befehl, sofortige Antwort | Experimentell und nicht prominent auffindbar; `!help games` deckt es ab. Live-Chatantwort nicht belegt. |
| Schere, Stein, Papier | Lokal implementiert; Zuschauer gegen Bot | Sofortige Runde und Ergebnis | Im Spielkatalog unter „Weitere Spiele“; Ergebnis ist Bot-Zufall, kein Wettbewerb mit echter Person. Im Chat klar als Spiel gegen den Bot benennen. |
| Zahlenraten | Lokal implementiert; Mod/Streamer startet, Chat rät | Begrenzte Versuche und Zeitfenster; Rundenzustand persistent | Startbefehl ist `!startguess`, während die anderen Spiele im Dashboard steuerbar sind. Chatpfad im Streamer-Modus sichtbar, aber nicht einheitlich. |
| Duelle | Lokal implementiert; Zuschauer fordern heraus und nehmen an | Annahme/Ablehnung und Auflösung im Chat | Gegenläufige/gleichzeitige Duelle sollten bei Live-Chatvolumen beobachtet werden; kein Produktionsnachweis. |
| Imposter | Lokal implementiert; Mod/Streamer öffnet Anmeldung, Zuschauer melden sich im Chat und sehen geheime Rolle im Portal | Rollenphase und Abstimmungsschritt manuell; Timer/Auswertung/XP automatisch; Neustart ausgewählter Phasen getestet | Externer Twitch-OAuth-Callback, fremde Konten und OBS müssen live abgenommen werden. Rollen bleiben privat und werden nicht im OBS offengelegt. |
| Chat-Detektiv | Lokal implementiert; Zuschauer opten ein, reichen einzelne Zitate ein; Mod prüft; Chat rät | Timer und Auswertung automatisch | Einwilligung, Widerruf, Aufbewahrung und öffentliche HTTPS-Seite vor Aktivierung festlegen. Kein Chatarchiv, aber der Portalpfad ist erklärungsbedürftig. |
| Community-Quests | Lokal implementiert; Chat oder Portal schlägt vor, Mod/Streamer prüft und startet | Status/OBS aktualisieren automatisch; Start verlangt Freigabe | Doppelte Eingabewege (Chat und Dashboard) sind funktional gleich, aber für Zuschauer könnte eine einzige Empfehlung in `!questhelp` klarer sein. |
| Kanalpunkte-Quests | Lokal implementiert, standardmäßig optional; Zuschauer löst Twitch-Reward ein, Broadcaster-OAuth und Mod-Freigabe nötig | Redemption-Deduplizierung; Fulfillment/Abbruch hat Statusabgleich | Echte Broadcaster-Freigabe, passende Reward-Konfiguration und eine Testeinlösung fehlen. Oberfläche ist einrichtungsintensiv und sinnvoll hinter „Erweitert“. |
| Mystery Drops | Lokal implementiert, aus bis aktiviert; Mod/Streamer startet, Chat schreibt `!claim` | Countdown, Claims, XP und OBS automatisch; Crash-Wiederanlauf durch diesen Hotfix idempotent | Keine automatische Dropplanung: `autoDrops` ist kein Scheduler. Chat-/OBS-Anzeige und XP noch im privaten Stream testen. |
| Chaos Wheel | Lokal implementiert, aus bis aktiviert; Mod/Streamer startet, Auto-Pilot optional | Gewichtet wählt nur verfügbare, automatisch ausführbare Aktionen; Neustart/Abstände getestet | Wheel speichert sofort das Ergebnis; keine sichtbare Raddrehung. Größerer UX-Fix benötigt zeitlich gestützte Spin-Phase. Manuelle Ingame-Challenges werden als Janniks Aufgabe markiert; Abschluss ist nicht prüfbar. |
| Elio | Lokal implementiert, aus bis aktiviert; Zuschauer pflegen gemeinsam im Chat | Persistente Bedürfnisse, Cooldown und OBS-Status | Viele Accounts können Fortschritt schnell gemeinsam steigern; globales Farm-Limit ist Produkt-/Balancefrage. Drops erhöhen zusätzlich Elios Werte, bislang ohne eigenen Schalter. |
| XP und Level | Lokal implementiert; Chat sieht Rang/Level, XP kommen aus Aktivität/Spielen/Quests | Ledger, Deduplizierung, Cooldowns und Tageslimits in Tests | Balance/Tageslimits unter echtem Volumen prüfen. Saisonpunkte sind getrennt und werden nicht als allgemeine XP dargestellt. |
| Saison-Events | Lokal implementiert; Mod/Streamer startet/beendet, Zuschauer sammeln im Chat | Ranglisten und getrennte Eventpunkte persistent; Ende löscht nicht | Eventdefinitionen, Zeitraum und Zeitzone sind Betreiberentscheidungen; echtes Saisonverhalten nicht live geprüft. |
| Gesprächs-Funken | Lokal implementiert, standardmäßig aus; Erkennung schlägt Themen vor, Mod muss freigeben | Regelbasierte Themenfenster; Start von Umfrage/Quest bleibt ausdrücklich manuell | Kann Ironie und Schreibvarianten verfehlen. Community-Hinweis vor Aktivierung; keine gespeicherten Chattexte. Chatvorschläge zusätzlich zur Webwarteschlange nur bei bewusst gewünschter Öffentlichkeit aktivieren. |
| Begrüßungen | Lokal implementiert, optional; erste Chatnachricht eines Nutzers triggert eine Begrüßung | Einmal pro User, Bot-Ausnahmen, keine Speicherung des Chattexts | Twitch „First chatter“ ist keine zuverlässige Anwesenheits-/Follow-Erkennung. Im Chatprofil auf Sichtbarkeit und Bot-Ausnahmen achten. |
| Community-Tipps | Lokal implementiert; Bot schlägt bei passender Aktivität ein Thema vor | Stream-, Aktivitäts-, Abstand- und Verfügbarkeitsbedingungen; persistent pro Stream begrenzt | Abhängigkeit von Live-Status und gemessener Chataktivität führt erwartbar zu keinem Tipp bei wenig Chat. Vorschau/Status im Dashboard weiter verständlich halten. |
| Automatische Chatnachrichten | Lokal implementiert; Jannik konfiguriert, Bot sendet nur live nach Plan | Gemeinsamer Nachrichtenplan reserviert Sendeslots und begrenzt Wiederholung | Mehrere unabhängige Auto-Nachrichten können den Chat trotzdem füllen; Profil/Abstände bei realem Stream beobachten. Keine zweite Antwort bei bereits versendeten Webaktionen bekannt. |
| Songwünsche | Lokal implementiert; Zuschauer lösen Kanalpunkte ein, Jannik richtet Twitch/Spotify ein | Playlistaufnahme und Statusabgleich automatisch; Verarbeitung nach Neustart wird auf Prüfung gesetzt statt blind erneut zu senden | Einrichtung verlangt zwei Konten/Verbindungen und Playlist. Live-Einlösung und manuelle Fehlerklärung fehlen. Erklärte Setup-Schritte sind vorhanden. |
| OBS-Widgets | Lokal implementiert; Jannik richtet schreibgeschützte, typgebundene Tokens ein; Zuschauer sehen öffentliche Zustände | SSE plus Fallback-Aktualisierung; widerrufbar; geheime Rollen bleiben verborgen | Externe OBS-Reconnects, echte URL, Tokenrotation und Darstellung auf Produktions-OBS nicht geprüft. Widget-Tokens wie Passwörter behandeln. |
| Streamer-Modus | Lokal implementiert; geschützter Zugriff für Jannik | Schnellaktionen und Status, keine Konfigurationsformulare; aktualisiert regelmäßig | Funktional zweite Oberfläche neben Dashboard; auf Live-Status und Buttons für dieselben Aktionen achten. Nicht alle Community-/Integrationsaufgaben sind dort verfügbar. |
| Zuschauer-Portal | Lokal implementiert; Zuschauer melden sich mit Twitch an; persönliche Daten/Imposter-Rolle privat | Portalstatus wird zwischengespeichert und aktualisiert; Quest/Imposter/Profile getrennt | Externer OAuth-Callback und mehrere unabhängige Twitch-Konten fehlen als Live-Abnahme. Für spontane Spiele bleibt Chat der primäre Ort. |

## Chat, Oberfläche und Rechte

- Öffentliche Bot-Antworten durchlaufen am Ausgang einen Kategorie-Präfix (`【🎁 DROP】`, `【📜 QUEST】`, `【⭐ XP】` usw.) und eine Längenbegrenzung. Der Nachrichtenschutz dämpft Routine-/persönliche Antworten und wiederholte Permission-Fehler.
- Profile: **Ruhig** reduziert Routineantworten und setzt stärkere Abstände; **Normal** ist Standard mit mittlerer Antwortgrenze; **Lebhaft** erlaubt persönliche Status- und Routineantworten häufiger. Kritische Start-/Endmeldungen können die normale Unterdrückung umgehen. Die genaue Wirkung ist in `chat-response-policy.test.ts` beschrieben.
- Dashboard, Chat und Portal haben unterschiedliche Aufgaben. Das Portal ist nicht nötig, um im Chat spontan mitzuspielen; es wird für geheime Rollen und persönliche Daten verwendet. Quests und Imposter bieten teils Chat- und Web-Einstiege und sollten bei der nächsten UX-Runde auf einen klaren empfohlenen Weg reduziert werden.
- Berechtigungsprüfungen für Mod-/Streamer-Aktionen, OAuth-Identität, CSRF, Session-Cookies, private Portalaktionen und read-only OBS-Tokens sind lokal getestet. Normale Zuschauer erhalten keine Adminrechte. Produktions-OAuth, echte Mod-Badges und Allowlist müssen live verifiziert werden.
- Community-Boss und allgemeine Chat-Umfrage bleiben in der Standardoberfläche ausgeblendet; Quests-Abstimmungen bleiben als Teil des Quest-Ablaufs sichtbar. Die verborgenen Module und Bestandsdaten werden nicht entfernt.
- Die frühere pauschale API-Rate-Limit-Sorge wurde durch gezielte Routenlimits und Portal-GET-Caching/Anfragebündelung adressiert. Grenzen wurden nicht deaktiviert. Der Browser-Regressionslauf prüft, dass Navigation/Einrichtung keine 429 auslösen; Oracle- oder Mehrtab-Last ist damit nicht abgenommen.

## Kleine Korrektur und Regression

Mystery-Drops wurden bisher auf `completed` gesetzt, bevor die separaten XP-Buchungen fertig waren. Ein Prozessabbruch in diesem Zeitfenster konnte den Drop ohne vollständige Belohnungen zurücklassen. Die Auswertung bleibt nun bis nach den XP-Buchungen im wiederaufnehmbaren Zustand `resolving`. Ledger-IDs deduplizieren bereits gebuchte XP; nach Neustart kann die Auswertung fortgesetzt werden. Spielregeln und XP-Werte ändern sich nicht.

Regressionstest simuliert einen Neustart während `resolving`, bestätigt XP-Wiederanlauf und prüft, dass weder XP noch Abschlussmeldung beim nächsten Tick doppelt vergeben werden.

## Offene Entscheidungen / erforderliche Live-Nachweise

1. Soll Elio durch Drop-Teilnahmen Fortschritt erhalten? Falls ja, eigener Schalter und globaler Anti-Farm-Rahmen.
2. Soll das Chaos Wheel eine sichtbare Drehphase erhalten oder ist das sofortige, ehrliche Ergebnis ausreichend?
3. Drop-Automatik bleibt aus, bis ein echter persistenter Scheduler und seine Häufigkeit festgelegt sind.
4. Freigabe von Eventkalendern, XP-Balance, Community-Hinweisen und Zitat-Einwilligung.
5. Private Twitch-Abnahme: OAuth-Redirects, echte Rollen, Kanalpunkte-Einlösung, Songwunsch, Bot-Chatversand, OBS-Reconnects und Neustart/Backup auf der tatsächlichen Oracle-Instanz.

Es erfolgte kein Push, keine Änderung an Oracle und kein Deployment.
