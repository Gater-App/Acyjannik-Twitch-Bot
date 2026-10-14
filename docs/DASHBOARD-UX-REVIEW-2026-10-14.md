# Dashboard UX-Review – 14.10.2026

## Bestandsaufnahme und Zielbild

Die bisherige Oberfläche enthielt verstreute Verwaltungsbereiche, technische Unterseiten und mehrere getrennte Karten für zusammengehörige Abläufe. Ein Admin-Tool in der Streamer-Ansicht erschwerte besonders das schnelle Finden von Spielen, Quest-Vorschlägen und OBS-Links. Außerdem zeigte die Startseite unbestätigte Chat-Nachweise als Warnungen an.

Die Navigation ist auf fünf Aufgabenbereiche gebündelt:

| Bereich | Zweck | Rollenbild |
| --- | --- | --- |
| Übersicht | Bereitschaft, aktive Spiele, nächste Schritte | Streamer und Mods |
| Spiele & Aktionen | Spiele, Runden und Chaos & Pranks | Streamer und berechtigte Mods |
| Community | Elio, Fortschritt, Events, Quests, Chat-Ideen, Begrüßungen und Musikwünsche | Streamer und berechtigte Mods |
| Stream-Einrichtung | OBS-Widgets, Links und Einrichtung | Streamer und Admin |
| Einstellungen | Chatverhalten, Befehle, Funktionen, Verbindungen und Erweitert | Admin; technische Details bleiben getrennt |

Die vorhandenen Spiel- und Funktionsbereiche bleiben erhalten. „Chaos & Pranks“ ist unter Spiele & Aktionen erreichbar. Die Dashboard-Umordnung ändert keine Backend-Berechtigungen; serverseitige Autorisierung und CSRF-Schutz bleiben maßgeblich.

## Überarbeitete Abläufe

### Übersicht

Die Startseite priorisiert Bot-/Twitch-Status, laufendes Spiel, Schnellzugriffe und die Einrichtungsliste. Chatempfang und Chatversand erscheinen als „noch nicht geprüft“, solange kein echter Nachweis vorliegt. Das ist kein Warnzustand. Warnungen erscheinen bei einem tatsächlichen technischen Hinweis oder explizit getrennter Twitch-Verbindung. Optionale OBS-Einrichtung wird als optional dargestellt.

### Spiele und Moderatoraktionen

Spiele und Pranks sind im Bereich „Spiele & Aktionen“ gruppiert. Die existierenden Detailseiten und Aktionen bleiben zuständig; es gibt keine zusätzliche Spiel-Engine. Pranks behalten ihre Moderator-Autorisierung.

### Community-Aufgaben

Der Ablauf ist als zusammenhängender Prozess dargestellt:

1. Neue Zuschauervorschläge prüfen und freigeben oder ablehnen.
2. Freigegebene Aufgaben bei Bedarf zur Abstimmung stellen.
3. Eine Aufgabe ausdrücklich starten.
4. Laufende Aufgaben abschließen oder abbrechen.
5. Vergangene Aufgaben in der Historie ansehen.

Eine Abstimmung startet keine Aufgabe automatisch. Chat-Ideen-Vorschläge bleiben intern und benötigen weiterhin eine Freigabe.

### OBS-Einrichtungsassistent

Der Assistent zeigt alle acht tatsächlich vorhandenen Widget-Arten zur Auswahl, eine beispielhafte Vorschau, empfohlene Größe/Position, den Status sicher gespeicherter Links, Link-Erstellung und Abrufprüfung sowie die OBS-Schritte. Der Test ruft die Widget-Ressource im gleichen Ursprung ab und bestätigt HTTP/HTML-Antwort; er behauptet ausdrücklich nicht, die Quelle in OBS sehen zu können. Der Tresorcode oder sonstige Geheimzustand wird nicht in der Vorschau ausgegeben. Erweiterte Linkverwaltung und ältere Vorschauoptionen sind eingeklappt.

OBS verwendet derzeit separate, typisierte Widget-Routen und Zugriffstokens. Eine gemeinsame Browserquelle ist grundsätzlich denkbar, benötigt aber eine neue zusammengesetzte Ausgabe und ein klares Modell dafür, wie die unterschiedlichen Daten und Sichtbarkeitsregeln zusammengeführt werden. Sie wurde deshalb nicht stillschweigend als vorhandene Funktion dargestellt. Als nächster Produktentscheid sollte geklärt werden, ob ein einzelnes Kombi-Overlay tatsächlich einfacher ist als mehrere gezielte Browserquellen.

## Geprüfte Funktionsgruppen

Der gerenderte Dashboard-Aufbau und die zugehörigen UI-Skripte wurden für Übersicht, Spielkatalog und Detailseiten, Pranks, Community, Elio, XP/Level, Events, Quests/Abstimmungen, Chat-Ideen, Begrüßung, Song-Wünsche, OBS, Chatnachrichten, Befehle, Funktionen, Integrationen, Verwaltung und Diagnose geprüft. Verfügbare OBS-Typen stammen aus der implementierten Widget-Auswahl; keine zusätzliche Widget-Art wurde erfunden.

Die bestehende getrennte Zugriffspolitik für Zuschauerportal, Moderatoraktionen und Adminverwaltung bleibt bestehen. Browser-Tests decken die durch diese Änderung berührten Rollen-/Navigationspfade sowie die serverseitig geschützten APIs ab; ein vollständiger produktiver Twitch- oder OBS-Livebetrieb wurde nicht simuliert.

## Offene Punkte

- Chatempfang und -versand besitzen im Status-Endpunkt derzeit keinen belastbaren Echtzeit-Nachweis. Die Oberfläche behauptet daher keine erfolgreiche Chatprüfung.
- Die OBS-Sichtbarkeit in einer laufenden Szene kann lokal nicht bestätigt werden; der Assistent sagt das ausdrücklich.
- Ein Kombi-Overlay benötigt eine Produktentscheidung und eine separate Sicherheits-/Datenzugriffsprüfung.
- Produktivdaten, Oracle-Konfiguration und Dienste wurden nicht verändert.
