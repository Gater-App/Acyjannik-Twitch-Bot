# Twitch-Chatbefehle

Vollständige Übersicht der im aktuellen Bot-Code fest eingebauten Chatbefehle. Ob ein Befehl antwortet, hängt zusätzlich von Modulschaltern und dem aktiven Event ab. `!help` ist die kurze Chat-Hilfe; `!help <thema>` zeigt eine Kategorie. `!help mods` ist Mods vorbehalten, `!help admin` zeigt Jannik zusätzlich seine Owner-Befehle.

## Zuschauer

| Befehl | Zweck / Voraussetzung |
|---|---|
| `!help [basics\|events\|xp\|games\|quests\|spark\|imposter\|detective\|pet\|drops\|wheel\|chaos]` | Themenhilfe; `!help mods` nur Mods/Jannik, `!help admin` nur Jannik. |
| `!community` | Öffnet den Wegweiser zum öffentlichen Community-Portal; persönliche Werte und Spielaktionen können Twitch-Anmeldung erfordern. |
| `!discord` | Gibt den eindeutigen Discord-Einladungslink aus einer aktivierten automatischen Chatnachricht aus. `!help discord` erklärt den Befehl. |
| `!trickortreat`, `!pumpkins`, `!top`, `!halloween` | Halloween spielen, Stand, Topliste und Status ansehen. |
| `!gift`, `!egghunt` | Sammeln, wenn das aktive Event so konfiguriert ist. |
| `!eventscore [event-id]`, `!eventtop [event-id]` | Event-Punktestand bzw. Topliste. |
| `!level [@user]`, `!rank`, `!xptop` | XP-Level, eigener Rang und XP-Topliste. |
| `!8ball FRAGE`, `!rps schere\|stein\|papier` | 8-Ball: 40 % JA, 40 % NEIN, 20 % VIELLEICHT; Themenantworten und Cooldowns. |
| `!guess ZAHL` | Bei aktiver Zahlenrunde raten; Versuche sind begrenzt. |
| `!startguess` | Jannik, Moderatoren und Twitch-VIPs dürfen eine gemeinsame Zahlenrunde starten, wenn noch keine läuft. Alle Zuschauer können mit `!guess ZAHL` mitraten. |
| `!duel @user`, `!accept`, `!cancelduel` | Duell herausfordern, annehmen oder eigene Herausforderung zurückziehen. |
| `!boss`, `!attack`, `!bosstop` | Bossstatus, angreifen, Schadensrangliste bei aktivem Boss. |
| `!quest TEXT`, `!quests`, `!myquest`, `!questhelp` | Quest-Idee einreichen (wird moderiert), Status und Details ansehen. |
| `!idee TEXT`, `!ideen`, `!idee status ID`, `!idee top` | Allgemeine Stream-/Community-Idee einreichen, Portal öffnen oder öffentlichen Status/Favoriten ansehen. Cooldown und Prüfung gelten; konkrete Stream-Aufgaben bleiben `!quest`. |
| `!poll`, `!vote NUMMER`, `!pollresults` | Aktive Umfrage ansehen, abstimmen und Ergebnis abrufen. |
| `!spark`, `!sparkhelp`, `!sparktopics` | Conversation-Spark-Status, Erklärung und aktuelle Themen. |
| `!imposter`, `!imposterstatus`, `!joinimposter`, `!leaveimposter`, `!sus @Name` | Imposter-Runde ansehen, freiwillig anmelden/abmelden und abstimmen. |
| `!quoteoptin`, `!quoteoptout`, `!savequote TEXT`, `!myquotes`, `!deletequote ID` | Detektiv-Zitateinstellungen und einzeln eingereichte eigene Zitate verwalten. Opt-in allein speichert keine Chatnachrichten. |
| `!detektiv`, `!quote`, `!wer @Name` | Detektiv-Runde/Zitat ansehen und Autorentipp abgeben. |
| `!pet`, `!feed`, `!play`, `!petcare`, `!petstats`, `!petname`, `!pethelp`, `!petevolution` | Elio 🐱 ansehen, mit Katzenfutter füttern, pflegen und mit Spielangel/Wollknäuel spielen; sofern aktiviert. |
| `!drops`, `!drop`, `!claim`, `!dropstats` | Drop-Hilfe/-Status, teilnehmen und eigene Claims ansehen, sofern aktiviert. |
| `!wheel`, `!wheelstatus`, `!spin` | Wheel-Status; `!spin` nur Mod/Jannik, sofern Chat-Dreh freigegeben. |
| `!retten`, `!rot`, `!blau`, `!gruen`, `!schatz`, `!aufwachen`, `!portal`, `!bodyguard` | Community-Chaos-Teilnahme. Nur der zum gerade aktiven Minispiel passende Befehl zählt; Antworten gelten einmal je Twitch-Konto innerhalb des gespeicherten 40-Sekunden-Fensters. `!help chaos` zeigt die Kurzregeln. |

## Jannik und/oder Moderatoren

Die genaue Prüfung ist featureabhängig: Broadcaster, Twitch-Mod-Badge oder ausdrücklich konfigurierte Mod-IDs. Quest-Moderation kann zusätzlich eingeschränkt sein; eine Mod-Rolle allein genügt dafür nicht immer.

| Befehl | Zweck / Berechtigung |
|---|---|
| `!starthalloween`, `!endhalloween` | Halloween starten/beenden; Jannik oder autorisierte Mods. |
| `!startevent ID`, `!endevent ID` | Saison-Event starten/beenden; Jannik oder autorisierte Mods. |
| `!startboss [Name]`, `!endboss` | Bosskampf starten/beenden; Jannik oder Mods. |
| `!questqueue` | Wartende Quest-IDs; Zugriff gemäß Quest-Moderationseinstellungen. |
| Dashboard → „Ideen verwalten“ | Einreichungen prüfen, kategorisieren, freigeben/ablehnen und 2–5 freigegebene Ideen zur Portalabstimmung stellen. Abstimmungssieg ist keine automatische Zusage. |
| `!approvequest ID`, `!rejectquest ID` | Quest moderieren; Jannik oder ausdrücklich freigegebene Mods. Text vor Freigabe im Dashboard prüfen. |
| `!skipquest` | Aktive Quest überspringen; Jannik oder eigens freigegebene Skip-Mods. |
| `!sparks` | Offene Spark-Vorschläge anzeigen. |
| `!sparkapprove ID`, `!sparkreject ID` | Vorschlag freigeben/ablehnen; Jannik oder Twitch-Mods. Freigabe startet keine Aktion automatisch. |
| `!startimposter` | Imposter-Anmeldung starten; Jannik, Mods oder Twitch-VIPs. |
| `!closeimposter`, `!cancelimposter` | Anmeldung schließen/Rollenphase auslösen bzw. abbrechen; nur Jannik oder Mods. |
| `!startdetektiv`, `!skipdetektiv`, `!enddetektiv` | Detektiv-Runde starten/überspringen/beenden; Jannik oder Mods. |
| `!startdrop [common\|rare\|epic\|legendary\|community]`, `!canceldrop` | Mystery Drop starten/abbrechen; Jannik oder Mods, wenn aktiviert. |
| `!startwheel`, `!cancelwheel` | Wheel-Dreh starten/abbrechen; Jannik oder Mods, wenn aktiviert. |

## Nur Jannik (Broadcaster)

| Befehl | Zweck |
|---|---|
| `!resethalloween CONFIRM` | Kürbispunkte zurücksetzen; vorherige Bestätigung und SQLite-Backup. |
| `!setpetname NAME`, `!petpause`, `!petresume` | Pet umbenennen bzw. Pflege pausieren/fortsetzen. |
| `!wheelpause`, `!wheelresume` | Chaos Wheel pausieren/fortsetzen. |
| `!sparkpause`, `!sparkresume` | Conversation Spark pausieren/fortsetzen. |

## Dashboard und dynamische Befehle

`!addcommand name | Antwort`, `!setcommand name | Antwort`, `!delcommand name` verwalten benutzerdefinierte Chatantworten. Jannik darf sie verwalten; Mods nur bei ausdrücklicher Freigabe. Die Namen dieser dynamischen Befehle entstehen im Dashboard und sind daher nicht einzeln statisch auflistbar. Channel-Points-Zuordnungen, Pet-/Drop-/Wheel-Einstellungen, Regeln und Themen werden im Dashboard gesteuert und sind keine Chatbefehle.

## Pflegehinweis

Bei Änderungen an Command-Registry, Modulen oder Berechtigungen diese Übersicht mitpflegen. Die Chat-Hilfe ist bewusst kurz und auf Themen verteilt, damit sie den Chat nicht mit einer einzigen langen Nachricht flutet.
