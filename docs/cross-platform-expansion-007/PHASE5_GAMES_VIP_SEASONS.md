# Phase 5 – Minispiele, VIP und Saison-Events

## Gelieferter Teilumfang

Diese Änderung erweitert Discord zunächst um zwei sichere Einzelspieler-Minispiele:

- `/8ball` verwendet die bestehende Antwortauswahl, globale/persönliche Cooldowns und Antwortwiederholungslogik aus `CommunityFeatures`.
- `/rps` verwendet die vorhandene Zufallsauswahl, den RPS-Cooldown, den zentralen Tages-XP-Deckel und den Twitch-XP-Ledger.
- Beide Spiele benötigen eine Twitch-/Discord-Kontoverknüpfung und bleiben im Dashboard standardmäßig ausgeschaltet.
- Das interne API speichert Discord-Interaction-IDs in der vorhandenen Inbox und gibt bei Replay exakt dieselbe Antwort zurück. Ein wiederholter Gewinn wird nicht erneut verbucht.
- Die Discord-Interaktionen antworten ephemer; sie senden keine öffentlichen Chatnachrichten.
- Keine Migration hinzugefügt. Verwendet werden die vorhandene Inbox aus v33 und Account-Link-Tabellen aus v34.

## Sicherheits- und Architekturregeln

- Discord leitet Spielaktionen ausschließlich per Integrations-API an den Twitch-Prozess weiter.
- Die Twitch-ID stammt aus der serverseitigen Verknüpfungstabelle, nicht aus dem Request.
- Das API validiert Spiel, Eingabegrenzen, Discord-Snowflake und Feature-Schalter und begrenzt Aufrufe pro Konto.
- RPS-Belohnungen laufen über denselben Twitch-XP-Tagesdeckel und Ledger wie Twitch-Chatspiele.
- Kein separater Discord-XP-Speicher und keine Live-Nachrichten.

## Noch nicht geliefert

`/duell` und `/raten` sind weiterhin Twitch-only. Für sichere Discord-Duelle ist ein vollständiger, gemeinsamer Session-/Einladungsablauf nötig; für Zahlenraten muss die bestehende Twitch-Rollenprüfung (Streamer/Moderation/VIP) unverändert serverseitig durchgesetzt werden. VIP-Chaos, VIP-Drop, Elio Party, Bless, Royal und Discord-VIP-Synchronisierung sind nicht freigeschaltet. Saisonale Inhalte werden noch nicht als interaktive Discord-Aktionen gespiegelt; vorhandene Saison-Statusereignisse bleiben unabhängig nutzbar.

Diese Funktionen bleiben blockiert, bis die serverseitigen Berechtigungs-, Status- und Ablaufverträge geprüft und getestet sind. Keine halbfertigen Discord-Kommandos werden registriert.

## Tests

Lokale Backend-Regressionen prüfen `/8ball`, `/rps`, Kontoverknüpfung, Feature-Schalter, Integrationsauthentifizierung, ungültige Antworten, Replay, Cooldown und einmalige XP. Browser-Tests prüfen, dass beide Dashboard-Schalter standardmäßig aus und nach Speicherung erhalten bleiben. Voller lokaler Twitch-Build, 203/203 Backend-Tests und Browser 5/5 bestanden.

## Betrieb

Neue Slash-Commands werden nur in den bestehenden sicheren Guild-Upsert aufgenommen. Keine produktive Slash-Command-Registrierung oder Feature-Aktivierung wurde ausgeführt. Voraussetzungen sind die passenden Twitch-/Discord-Phase-5-Versionen, die Phasen-1-Verknüpfung, v33 Inbox sowie das gemeinsame Integrationsgeheimnis.
