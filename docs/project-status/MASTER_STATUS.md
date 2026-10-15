# ACY Twitch Bot — Projektstatus

Stand: 15.10.2026
Repository: `Gater-App/Acyjannik-Twitch-Bot`
Produktionshost: `https://twitch.gater-app.de`

## Aktueller Arbeitsstand

- GitHub `main` und lokaler `HEAD`: `9b7e7e7261b116d5530da8c7cf85beb5adff4311`.
- Produktionsruntime zuletzt nachweislich deployed: `e409596eddf0e579833c295e23f3dce259b541b4` (15.10.2026; siehe [Releasebericht](../release-report-2026-10-15.md)). `main` enthält danach einen Dokumentationsmerge; dieser Night-Shift-Arbeitsstand ist nicht deployed.
- Arbeitsbaum enthält vorhandene Screenshot-Arbeiten sowie 18 unversionierte Screenshots unter `artifacts/`. Die Browserregression schreibt selbst Dateien nach `docs/verification/`; beim nötigen Browserlauf wurden dadurch mehrere Screenshots erneuert. Sie bleiben ungestaged und uncommitted.
- Night Shift 001 hat lokale Code- und Statusdokument-Änderungen; nichts wurde committed, gepusht, gemerged oder deployed.
- Build und Unit-/Integrationstests: 194/194 bestanden. Browserregression: 5/5 bestanden.

## Statusregeln

- **VERIFIED**: Der konkrete Pfad wurde mit Code und passendem lokalen Test oder beobachtetem HTTP-/Browser-Ergebnis geprüft.
- **PARTIALLY VERIFIED**: Ein Teil des Ablaufs ist getestet; ein echter externer Dienst, vollständiger Browserablauf oder Production-Zugang fehlt.
- **NOT VERIFIED**: Es liegt für den genannten Lauf kein belastbarer Nachweis vor.
- **BLOCKED**: Die nötige sichere Testumgebung oder externe Berechtigung fehlt.

Die ausführliche [Feature-Matrix](FEATURE_MATRIX.md), [offene Punkte](OPEN_ISSUES.md) und der [Night-Shift-Bericht](NIGHT_SHIFT_001_REPORT.md) beschreiben Grenzen und Nachweise.

## Production-Schutz

Der Night-Shift-Lauf hat keine produktiven Daten oder Einstellungen verändert, keine Twitch-Nachrichten oder Spiele ausgelöst und keine Dienste neu gestartet. Es wurden ausschließlich öffentliche GET-Routen gelesen. Der neue `/health`-Liveness-Endpunkt sowie die Imposter-Hinweiskorrektur existieren derzeit nur lokal.

Vor einem späteren Oracle-Release müssen ein neuer geprüfter Commit, Backup-/Rollback-Plan, isolierter Migrationstest bis zur aktuellen Schemaversion 32 sowie ein freigegebener Deployment- und Neustartablauf vorliegen. Twitch-/Spotify-/OBS-Integrationen brauchen separat autorisierte Staging-Zugänge.
