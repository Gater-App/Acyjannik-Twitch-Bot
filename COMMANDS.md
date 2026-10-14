# Twitch-Chatbefehle

Vollständige Übersicht der im aktuellen Bot-Code fest eingebauten Chatbefehle. Ob ein Befehl antwortet, hängt zusätzlich von Modulschaltern und dem aktiven Event ab. `!help` ist die kurze Chat-Hilfe; `!help <thema>` zeigt eine Kategorie. `!help mods` ist Mods vorbehalten, `!help admin` zeigt Jannik zusätzlich seine Owner-Befehle.

## Zuschauer

| Befehl | Zweck / Voraussetzung |
|---|---|
| `!help [basics\|events\|xp\|games\|quests\|spark\|imposter\|detective\|pet\|drops\|wheel]` | Themenhilfe; `!help mods` nur Mods/Jannik, `!help admin` nur Jannik. |
| `!community` | Öffnet den Wegweiser zum öffentlichen Community-Portal; persönliche Werte und Spielaktionen können Twitch-Anmeldung erfordern. |
| `!trickortreat`, `!pumpkins`, `!top`, `!halloween` | Halloween spielen, Stand, Topliste und Status ansehen. |
| `!gift`, `!egghunt` | Sammeln, wenn das aktive Event so konfiguriert ist. |
| `!eventscore [event-id]`, `!eventtop [event-id]` | Event-Punktestand bzw. Topliste. |
| `!level [@user]`, `!rank`, `!xptop` | XP-Level, eigener Rang und XP-Topliste. |
| `!8ball FRAGE`, `!rps schere\|stein\|papier` | Chat-Minispiele. |
| `!guess ZAHL` | Bei aktiver Zahlenrunde raten; Versuche sind begrenzt. |
| `!duel @user`, `!accept`, `!cancelduel` | Duell herausfordern, annehmen oder eigene Herausforderung zurückziehen. |
| `!boss`, `!attack`, `!bosstop` | Bossstatus, angreifen, Schadensrangliste bei aktivem Boss. |
| `!quest TEXT`, `!quests`, `!myquest`, `!questhelp` | Quest-Idee einreichen (wird moderiert), Status und Details ansehen. |
| `!poll`, `!vote NUMMER`, `!pollresults` | Aktive Umfrage ansehen, abstimmen und Ergebnis abrufen. |
| `!spark`, `!sparkhelp`, `!sparktopics` | Conversation-Spark-Status, Erklärung und aktuelle Themen. |
| `!imposter`, `!imposterstatus`, `!joinimposter`, `!leaveimposter`, `!sus @Name` | Imposter-Runde ansehen, freiwillig anmelden/abmelden und abstimmen. |
| `!quoteoptin`, `!quoteoptout`, `!savequote TEXT`, `!myquotes`, `!deletequote ID` | Detektiv-Zitateinstellungen und einzeln eingereichte eigene Zitate verwalten. Opt-in allein speichert keine Chatnachrichten. |
| `!detektiv`, `!quote`, `!wer @Name` | Detektiv-Runde/Zitat ansehen und Autorentipp abgeben. |
| `!pet`, `!feed`, `!play`, `!petcare`, `!petstats`, `!petname`, `!pethelp`, `!petevolution` | Elio 🐱 ansehen, mit Katzenfutter füttern, pflegen und mit Spielangel/Wollknäuel spielen; sofern aktiviert. |
| `!drops`, `!drop`, `!claim`, `!dropstats` | Drop-Hilfe/-Status, teilnehmen und eigene Claims ansehen, sofern aktiviert. |
| `!wheel`, `!wheelstatus`, `!spin` | Wheel-Status; `!spin` nur Mod/Jannik, sofern Chat-Dreh freigegeben. |

## Jannik und/oder Moderatoren

Die genaue Prüfung ist featureabhängig: Broadcaster, Twitch-Mod-Badge oder ausdrücklich konfigurierte Mod-IDs. Quest-Moderation kann zusätzlich eingeschränkt sein; eine Mod-Rolle allein genügt dafür nicht immer.

| Befehl | Zweck / Berechtigung |
|---|---|
| `!starthalloween`, `!endhalloween` | Halloween starten/beenden; Jannik oder autorisierte Mods. |
| `!startevent ID`, `!endevent ID` | Saison-Event starten/beenden; Jannik oder autorisierte Mods. |
| `!startguess` | Zahlenrunde starten; Jannik oder Mods. |
| `!startboss [Name]`, `!endboss` | Bosskampf starten/beenden; Jannik oder Mods. |
| `!questqueue` | Wartende Quest-IDs; Zugriff gemäß Quest-Moderationseinstellungen. |
| `!approvequest ID`, `!rejectquest ID` | Quest moderieren; Jannik oder ausdrücklich freigegebene Mods. Text vor Freigabe im Dashboard prüfen. |
| `!skipquest` | Aktive Quest überspringen; Jannik oder eigens freigegebene Skip-Mods. |
| `!sparks` | Offene Spark-Vorschläge anzeigen. |
| `!sparkapprove ID`, `!sparkreject ID` | Vorschlag freigeben/ablehnen; Jannik oder Twitch-Mods. Freigabe startet keine Aktion automatisch. |
| `!startimposter`, `!closeimposter`, `!cancelimposter` | Anmeldung starten, schließen/Rollenphase auslösen bzw. abbrechen; Jannik oder Mods. |
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
