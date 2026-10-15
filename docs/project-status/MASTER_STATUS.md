# ACY Twitch Bot — Projektstatus

Stand: 15.10.2026
Repository: `Gater-App/Acyjannik-Twitch-Bot`
Produktionshost: `https://twitch.gater-app.de`

## Aktueller Arbeitsstand

- Produktionsruntime: `22700942de6223d5f83508dd070272605a432e96` (15.10.2026). Der dazugehörige Caddy-Healthpfad wurde mit PR #10, Mergecommit `10e2be7ca71130d851eb5e8c7d1ff1728162a953`, auf `main` veröffentlicht und in Production geladen. Details: [Health-Hotfix-Releasebericht](../release-report-2026-10-15-health-hotfix.md).
- Arbeitsbaum enthält vorhandene Screenshot-Arbeiten sowie 18 unversionierte Screenshots unter `artifacts/`. Die Browserregression schreibt selbst Dateien nach `docs/verification/`; beim nötigen Browserlauf wurden dadurch mehrere Screenshots erneuert. Sie bleiben ungestaged und uncommitted.
- Night Shift 001: Codeänderungen wurden mit PR #9 committed, gepusht, gemerged und deployed; der Caddy-Pfad folgte mit PR #10.
- Build und Unit-/Integrationstests: 194/194 bestanden. Browserregression: 5/5 bestanden.

## Statusregeln

- **VERIFIED**: Der konkrete Pfad wurde mit Code und passendem lokalen Test oder beobachtetem HTTP-/Browser-Ergebnis geprüft.
- **PARTIALLY VERIFIED**: Ein Teil des Ablaufs ist getestet; ein echter externer Dienst, vollständiger Browserablauf oder Production-Zugang fehlt.
- **NOT VERIFIED**: Es liegt für den genannten Lauf kein belastbarer Nachweis vor.
- **BLOCKED**: Die nötige sichere Testumgebung oder externe Berechtigung fehlt.

Die ausführliche [Feature-Matrix](FEATURE_MATRIX.md), [offene Punkte](OPEN_ISSUES.md) und der [Night-Shift-Bericht](NIGHT_SHIFT_001_REPORT.md) beschreiben Grenzen und Nachweise.

## Production-Schutz

Der Release hat keine Produktionsmigration ausgeführt und keine SQLite-Datei ersetzt. Das vorhandene Datenbankbackup wurde erstellt und geprüft. Der Twitch-Bot wurde einmal kontrolliert neu gestartet; Caddy wurde nach Konfigurationsprüfung neu geladen. Der separate Discord-Prozess blieb unverändert. Der öffentliche `/health`-Endpunkt meldet ausschließlich HTTP-Prozess-Liveness, nicht Datenbank-, Twitch- oder OBS-Gesundheit. Es wurde kein separates Live-Spiel, keine OBS-Aktion und keine Chatnachricht ausgelöst.

Twitch-/Spotify-/OBS-Integrationen brauchen weiterhin separat autorisierte Staging-Zugänge. Ein authentifizierter Production-Login wurde in diesem Release nicht durchgeführt.
