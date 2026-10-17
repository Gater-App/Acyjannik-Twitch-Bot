# Phase 3 – Twitch-Live-Ankündigungen

Status: lokal implementiert und getestet, nicht für Production aktiviert.

## Verhalten

- Der Twitch-Bot nutzt seinen vorhandenen Streamstatus und dieselbe Outbox; es entsteht keine zweite EventSub-Verbindung.
- Beim erstmaligen Aktivieren während eines laufenden Streams wird eine aktuelle Ankündigung erzeugt.
- Titel- und Spieländerungen erzeugen `twitch.live.update`-Ereignisse, sofern „Laufende Ankündigung aktualisieren“ eingeschaltet ist.
- Streamende bearbeitet den vorhandenen Discord-Beitrag, sofern „Streamende markieren“ eingeschaltet ist.
- Discord bearbeitet denselben Beitrag anhand des gespeicherten Message-Pointers und eines stabilen Stream-Markers. Wiederholungen oder ein verlorenes Discord-HTTP-Ergebnis suchen den bestehenden Marker im Verlauf, bevor gesendet wird.
- Updates oder Streamenden erzeugen niemals ersatzweise einen zweiten Beitrag, wenn der ursprüngliche Beitrag fehlt. Updates werden dann mit Fehlerstatus erneut versucht; Streamende ohne vorhandenen Beitrag werden ohne Nachricht quittiert.
- Discord-Zustellstatus wird atomar in einer Datei mit restriktiven Dateirechten gespeichert. Keine Rollenmentions.

## Einstellungen

Die bestehende Dashboard-Seite „Discord“ steuert den Live-Kanal und den Hauptschalter. Zwei zusätzliche, standardmäßig aktivierte Optionen steuern Metadatenänderungen und das Markieren des Streamendes. Die gesamte Integration bleibt standardmäßig deaktiviert. Es ist keine SQLite-Migration erforderlich.

## Verifikation

- Twitch: Build und 200 Unit-/Integrationstests bestanden; Browser-Ende-zu-Ende 5/5 bestanden, einschließlich Einstellungen auf Desktop/Mobil.
- Discord: Syntaxprüfung und 23 Tests bestanden; darunter einmalige Live-Ankündigung, Editieren desselben Beitrags, Streamende, Neustart-/Replay-Abgleich und abgeschaltete Zusatzoptionen.
- Keine echten Discord-Nachrichten, Live-Twitch-Aktionen, Produktionsmigrationen oder Neustarts ausgeführt.

## Einschränkung

Discord-Senden und lokales Statusspeichern können nicht transaktional gekoppelt werden. Daher wird nach einem uneindeutigen Sendeergebnis über den Stream-Marker im Kanalverlauf abgeglichen. Der Bot benötigt zum Lesen des letzten Kanalverlaufs zusätzlich `Read Message History`; ohne dieses Recht wird ein uneindeutiger Sendefehler nicht blind erneut veröffentlicht.
