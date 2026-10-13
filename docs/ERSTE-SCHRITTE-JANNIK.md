# Janniks Twitch-Bot – einfache Anleitung

## Das Wichtigste zuerst

Du musst nicht alle Funktionen gleichzeitig einschalten oder sofort verstehen.
Der Bot läuft im Hintergrund. Im Dashboard stellst du ein, was er darf. Viele
Spiele sind zunächst ausgeschaltet und starten nicht von selbst.

Empfohlener Anfang:

1. Oben bei **Bot-Status** prüfen, ob Twitch als verbunden angezeigt wird.
2. Erst einmal nur die Begrüßung neuer Chatter und Gesprächs-Funken ausprobieren,
   wenn ihr sie wirklich nutzen möchtet.
3. Minispiele, Pet, Drops, Glücksrad und Kanalpunkte vorerst ausgeschaltet lassen.
4. Erst OBS einrichten, wenn klar ist, welche Einblendung ihr im Stream sehen wollt.

## Bot-Status und Schalter

Der Bereich **Funktionen ein- und ausschalten** schaltet ganze Bot-Bereiche frei
oder pausiert sie. Ein Schalter startet nicht automatisch jedes Spiel. Zum
Beispiel bleibt ein Imposter-Spiel inaktiv, bis Jannik die Anmeldung öffnet.

## Begrüßung neuer Chatter

Ist die Begrüßung eingeschaltet, begrüßt der Bot ein Twitch-Konto bei seiner
ersten normalen Chatnachricht im gespeicherten Zeitraum. Chat-Befehle lösen die
Begrüßung nicht aus. Der Text kann angepasst werden; `{user}` wird durch den
Anzeigenamen ersetzt. Der Bot speichert dafür keine Nachricht, sondern nur
Twitch-Konto und Zeitpunkt. Zum Testen reicht eine Person, die der Bot in diesem
Zeitraum noch nicht gesehen hat.

## Gesprächs-Funken

Der Gesprächs-Funken schaut nur auf den ausdrücklich aktivierten Kanal und
sucht nach gehäuften Nachrichten mehrerer Leute zu bekannten Gaming-Themen.
Er versteht nicht jedes Gespräch. Er speichert keine vollständigen Chattexte.

Wenn genug passende Aktivität zusammenkommt, kann er einen Vorschlag für eine
Umfrage, Quest oder Challenge erzeugen. Eine Aktion wird nicht allein durch die
Erkennung gestartet: Jannik oder ein berechtigter Moderator prüft den Vorschlag
im Dashboard und startet beziehungsweise verwirft ihn. Die vielen Werte unter
„Für Fortgeschrittene“ sind Stellschrauben; am Anfang bitte bei den
Voreinstellungen bleiben.

## Community-Aufgaben und Umfragen

Zuschauer können mit `!quest IDEE` eine Aufgabe vorschlagen. Sie bleibt zunächst
im Dashboard und wird nicht automatisch öffentlich. Jannik prüft sie und kann
sie freigeben, bearbeiten, starten oder ablehnen.

Bei einer Umfrage wählst du eine Frage, mindestens zwei Antworten und die Dauer.
Der Bot zeigt die Abstimmung im Chat und im passenden Widget. Das Ergebnis
startet eine Quest nicht automatisch.

## Chat-Imposter

1. Im Dashboard **Minispiele erlauben** einschalten.
2. **Imposter: Anmeldung öffnen** drücken. Der Bot kündigt die Runde an.
3. Teilnehmende öffnen die geheime Rollen-Seite, melden sich bei Twitch an und
   nehmen im Chat mit `!joinimposter` teil.
4. Wenn genügend Leute angemeldet sind, **Anmeldung schließen und Rollen
   verteilen** drücken. Jede Person sieht nur die eigene Rolle auf der
   Teilnehmerseite.
5. Nach der Spielzeit **Abstimmung beginnen** drücken; Teilnehmende stimmen mit
   `!sus @Name` ab. Bei Bedarf kann die Runde abgebrochen werden.

Die Teilnehmerseite ist kein OBS-Widget. Sie ist privat und zeigt die geheime
Rolle nur nach Twitch-Anmeldung. Der Twitch-App-Callback
`https://twitch.gater-app.de/games/imposter/callback` muss in der Developer-App
eingetragen sein. Falls Twitch nach der Anmeldung eine Redirect-Fehlermeldung
zeigt, fehlt meistens genau dieser Eintrag.

## Chat-Detektiv

Zuschauer speichern nicht automatisch ihre Nachrichten. Eine Person reicht ein
Zitat bewusst mit `!savequote TEXT` ein. Jannik oder ein berechtigter Moderator
prüft und genehmigt es im Dashboard. Erst genehmigte Zitate können in einer
Detektiv-Runde erscheinen. Der Chat rät mit `!wer @Name`; der Autor wird erst
bei der Auflösung gezeigt. Mit `!deletequote ID` kann die Person ihr Zitat
löschen, mit `!quoteoptout` ihre Zitate entfernen lassen.

## Pet, Überraschungs-Drops und Glücksrad

Diese drei Extras lassen sich getrennt einschalten:

- **Pet:** Zuschauer pflegen gemeinsam ein Community-Pet; Chat-Hilfe: `!pethelp`.
- **Überraschungs-Drop:** Jannik oder ein Moderator startet einen kostenlosen
  virtuellen Drop; Zuschauer nehmen während des Countdowns mit `!claim` teil.
- **Glücksrad:** Jannik oder ein Moderator startet einen Dreh. Zuschauer können
  nur selbst drehen, wenn Jannik diese Möglichkeit ausdrücklich freigibt.

Das sind virtuelle Spiele, keine Echtgeld- oder Sachpreisverlosungen. Schalte
ein Modul erst ein, wenn du seine Chatregeln ausprobieren möchtest.

## OBS – was die Links und Tokens bedeuten

Ein Widget ist eine kleine Webseite, die OBS als **Browserquelle** anzeigt. Es
ist kein Bild, das Jannik vorher speichern muss. Jedes Widget hat einen eigenen
privaten Link, zum Beispiel für Umfrage, Quest, Imposter, Detektiv, Pet, Drop
oder Glücksrad. In der aktuellen Version ist es pro Widget-Typ eine Quelle;
eine gemeinsame Quelle für alle Widgets gibt es noch nicht.

So richtest du ein Widget einmalig ein:

1. Im Dashboard unter **Im Stream anzeigen** den gewünschten Widget-Typ wählen.
2. **Privaten OBS-Link erstellen** drücken. Der Link erscheint nur jetzt auf
   dieser Seite. Mit **Link kopieren** kommt er in die Zwischenablage.
3. In OBS in der gewünschten Szene unter **Quellen** auf **+ → Browser**
   drücken, einen Namen vergeben und den Link als URL einsetzen.
4. Als Anfangsgröße eignen sich meist **900 × 320**; beim Pet eher
   **500 × 600**. Position und Größe kannst du direkt in OBS anpassen.

Das Wort **Token** meint den zufälligen Zugangsteil im privaten Link. Er ist
lesend: Er darf den Widget-Inhalt anzeigen, aber keine Bot-Einstellungen ändern.
Trotzdem sollte er wie ein Passwort behandelt und nicht in den Twitch-Chat,
Discord oder Screenshots kopiert werden.

**Link widerrufen** sperrt den aktuell gespeicherten Link sofort. **Einen neuen
Link erstellen** ersetzt den alten Link ebenfalls. Danach muss die URL in der
OBS-Browserquelle durch die neue ersetzt werden. Das ist nur nötig, wenn ein
Link verloren ging oder versehentlich geteilt wurde – nicht bei jedem Stream.

Die Browserquelle darf in mehreren OBS-Szenen verwendet werden. Wenn sie in
einer Szene leer ist, heißt das normalerweise nur, dass gerade kein passendes
Spiel, keine Umfrage oder kein Ereignis läuft. Die Quelle muss nicht während
des Streams ständig gewechselt werden.

## Kanalpunkte

Kanalpunkte-Quests sind ein optionaler, erweiterter Bereich. Sie brauchen eine
zusätzliche Twitch-Freigabe von Jannik und eine passende Kanalpunkte-Belohnung.
Eine Belohnung wird direkt in seinem Twitch-Kanal angelegt oder verknüpft. Lass
das zunächst ausgeschaltet, bis Jannik das ausdrücklich möchte.

## Kurze Hilfe im Chat

`!help` zeigt das Themenmenü. Nützlich sind außerdem `!help games`,
`!help quests`, `!help spark`, `!help imposter`, `!help detective`,
`!help pet`, `!help drops` und `!help wheel`. Moderatorbefehle zeigt
`!help mods` nur Jannik und Twitch-Moderatoren.

## Wenn etwas nicht funktioniert

- **Teilnehmerseite zeigt „Not Found“:** Das war eine fehlende Weiterleitung im
  öffentlichen Reverse Proxy, nicht Janniks Fehler. Nach dem Proxy-Fix den Link
  erneut öffnen. Wenn danach Twitch eine Redirect-URL bemängelt, den oben
  genannten Callback in der Twitch-Developer-App ergänzen.
- **Widget-Link weg:** Für diesen Typ einen neuen Link erstellen und in OBS
  einsetzen. Dadurch wird der vorherige Link ungültig.
- **Widget bleibt leer:** Prüfen, ob das zugehörige Feature eingeschaltet ist
  und gerade tatsächlich ein passendes Spiel oder Ereignis läuft.
- **Chat reagiert nicht:** Prüfen, ob der Bot in Janniks Kanal verbunden und
  Moderator ist. Bei einem privaten Test zuerst `!help` ausprobieren.

