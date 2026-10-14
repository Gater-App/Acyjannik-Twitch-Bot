# VIP-Erlebnis

Die VIP-Funktionen sind neu und standardmäßig ausgeschaltet. Normale Zuschauer melden sich weiterhin mit dem bestehenden Twitch-Viewer-Login ohne zusätzliche Scopes an.

## Twitch-Berechtigung

Die VIP-Prüfung verwendet ausschließlich ein separates Broadcaster-OAuth-Token mit `channel:read:vips`. Es wird im nicht öffentlichen Tokenfile gespeichert, getrennt vom Bot- und Kanalpunkte-Token. Twitch-User-IDs sind die Identität; die Prüfung läuft über `GET /helix/channels/vips` und schlägt bei fehlendem Token, falschem Twitch-Konto, fehlendem Scope oder API-Ausfall geschlossen fehl. Positive Rollenabfragen werden höchstens 60 Sekunden zwischengespeichert.

Für einen späteren Produktivbetrieb muss Jannik die konfigurierte `TWITCH_VIP_REDIRECT_URI` in der Twitch-Entwicklerkonsole registrieren und den Broadcaster-OAuth-Ablauf einmal selbst autorisieren. Die Standardadresse lautet `http://127.0.0.1:3000/oauth/vips/callback`; bei einem anderen Deployment muss die registrierte URL exakt mit der dort konfigurierten HTTPS-Callback-Adresse übereinstimmen. Der Start ist im geschützten Dashboard unter „Community → VIP-Erlebnis“ verlinkt. Die Autorisierung wurde in dieser lokalen Arbeit nicht gegen ein produktives Twitch-Konto ausgeführt.

## Funktionen und Grenzen

- VIP-Lounge: Profil, vorhandene Community-XP/Level, VIP-Abzeichen und freigegebene Challenges.
- Elio: nutzt die vorhandene Portal-Spielaktion, dieselben Cooldowns und denselben Elio-XP-Wert. Es gibt keinen VIP-XP-Bonus und keine öffentliche Chatnachricht.
- VIP-Chaos: pro Twitch-ID und bestätigtem Stream höchstens eine Anfrage; Moderation muss sie freigeben. Freigabe verwendet bestehende Pranks und deren Cooldowns/Spielkonflikte. Der Pet-OBS-Widgetpfad zeigt vorhandene `chief`- und Tresor-Alarmphasen.
- VIP-Challenges: werden als bestehende Quest eingereicht und durch dieselbe Moderation und Abstimmungslogik geführt. VIP-Stimmen erhalten kein Zusatzgewicht.
- VIP-Abzeichen: nur serverseitig und idempotent; normale XP- oder Punktebelohnungen werden dadurch nicht erzeugt.

Alle VIP-Schalter starten ausgeschaltet. Eine Produktionsmigration ist erforderlich, da das Feature-Store-Schema um Migration 32 erweitert wurde. Diese lokale Änderung hat keine produktive Datenbank, Twitch-Konfiguration, Chatnachricht, OBS-Szene oder Serverinstanz verändert.
