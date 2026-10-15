# Twitch-Deployment über GitHub Actions vorbereiten

Stand: 15.10.2026. Diese Anleitung bereitet einen manuellen, geschützten Deployment-Weg vor. Sie dokumentiert keine ausgeführte Oracle-Verbindung und erteilt keine Produktionsfreigabe.

## Ziel und Schutzgrenzen

Der Workflow `.github/workflows/deploy-twitch.yml` kennt nur `workflow_dispatch` mit `preflight` und `deploy`. Er akzeptiert ausschließlich `main` und die Repository-Identität `Gater-App/Acyjannik-Twitch-Bot`. Der Build-Job erhält keine Production-Secrets. Der zweite Job wartet auf die geschützte GitHub-Environment `production-twitch`.

Der Host-Zugang verwendet einen eigenen SSH-Schlüssel mit einem erzwungenen Gateway. Dieses akzeptiert ausschließlich `preflight` und `deploy <vollständige-Commit-SHA> <Artefakt-SHA-256>`. SSH-Port-, Agent-, X11- und TTY-Weiterleitung sind für diesen Schlüssel gesperrt. Die Shell ist nicht frei verfügbar. `StrictHostKeyChecking=yes` und ein vorab verifizierter `known_hosts`-Eintrag sind zwingend; der Workflow ruft kein `ssh-keyscan` auf.

Das Gateway ist hart auf `/home/ubuntu/twitch-community-bot`, dessen `data/halloween.sqlite`, Schema 32 und PM2-Prozess `twitch-community-bot` begrenzt. Es adressiert weder `acy-discord-bot` noch andere PM2-Prozesse. Es führt keine Migration aus und verändert Caddy nicht. Der Preflight verlangt mindestens 1 GiB freien Speicher. Vor dem Umschalten prüft es den Release-Hash und das Manifest, installiert die festgeschriebenen Production-Abhängigkeiten in einem neuen Release-Verzeichnis, erstellt mit dem Release-Treiber ein neues SQLite-Backup und testet dessen Wiederherstellung in einer temporären, isolierten Kopie. Nach dem atomaren Wechsel startet es nur `twitch-community-bot` neu und prüft den lokalen Liveness-Endpunkt. Bei einem Fehler schaltet es den vorherigen Twitch-Symlink zurück und startet nur diesen Prozess erneut. Das Datenbank-Backup wird bei einem Code-Rollback nicht automatisch zurückgespielt.

`/health` beweist nur HTTP-Liveness. Der automatische Check bestätigt weder OAuth, Chat/EventSub, OBS noch die Twitch-Token-Gültigkeit.

## Dokumentierter Ist-Stand und Reichweite

Die Cloud-Handover- und Oracle-Infrastrukturdokumentation aus PR #16 nennt die VM `acy-discord-bot`, den Twitch-PM2-Prozess `twitch-community-bot`, den getrennten Discord-Prozess `acy-discord-bot`, das Projektverzeichnis `/home/ubuntu/twitch-community-bot`, den SQLite-Pfad `/home/ubuntu/twitch-community-bot/data/halloween.sqlite`, Release-Verzeichnisse unter `releases/` sowie den Backend-Port 3001. Die aktive `dist`-Symlink-Struktur wurde in der älteren Bestandsaufnahme dem Release `2270094-20261015` zugeordnet.

Diese Werte stammen aus einer read-only Bestandsaufnahme vom 15.10.2026 und wurden für diese Arbeit nicht live neu erhoben. Insbesondere fehlen weiterhin eine von GitHub-hosted Runnern erreichbare, verifizierte Hostadresse, SSH-Portbestätigung, Host-Key-Fingerprint, PM2-Executable-/Node-Pfade und der bestätigte PM2-Arbeitsordner. Der lokale Host-Alias `acy-discord-bot` ist kein Nachweis eines öffentlich auflösbaren DNS-Namens. Deshalb wurde keine Verbindung versucht und die Erreichbarkeit von GitHub-hosted Runnern ist **nicht verifiziert**. Nach sicherer Einrichtung prüft die manuelle `preflight`-Ausführung echte DNS-, TCP-, SSH-Host-Key- und Gateway-Erreichbarkeit.

Keinen SSH-Zugang für `0.0.0.0/0` öffnen und die SSH-Prüfung nicht abschalten. Wenn sich kein eng begrenzter, vom Betreiber genehmigter Netzwerkpfad von GitHub-hosted Runnern zur VM einrichten lässt, bleibt der SSH-Weg deaktiviert. Die sichere Alternative ist im Abschnitt „Pull-basierte Alternative“ beschrieben.

## Blocker aus PR #14

Der Release-Stand aus `docs/project-status/ACY_PRODUCTION_PREFLIGHT_009.md` bleibt maßgeblich. Die letzte dokumentierte Prüfung ist älter und kein aktueller Produktionsnachweis.

- PR #14 hatte zum dokumentierten Stand keine menschliche Review-Freigabe. CI-Erfolg ersetzt keine Freigabe.
- Das aktive Produktionsartefakt war keinem exakten Commit- und Manifest-Hash zugeordnet.
- Die aktive Caddy-Konfiguration wich im Hash und teilweise in Matchern von der Repository-Konfiguration ab. Dieser Workflow fasst Caddy nicht an; die Abweichung muss separat geprüft und freigegeben werden.
- Das neueste dort gefundene Backup war etwa 10 Stunden und 20 Minuten älter als spätere WAL-Änderungen; ein Restore war nicht getestet.
- Production nutzte `better-sqlite3@12.11.1`, PR #14 dagegen `13.0.3`. Die Major-Version muss mit einer frischen, isolierten Kopie der Produktionsdatenbank geprüft werden.
- Der vorherige Release-Link war vorhanden, aber PM2-Rollback und vorheriger Release waren nicht als funktionierender Rollback verifiziert.
- Twitch-, EventSub-, OAuth- und OBS-Live-Zustand waren nicht vollständig verifiziert.

Das Skript `scripts/create-deployment-metadata.mjs` blockiert jede Schemaänderung über Version 32 und markiert keine Datenbankänderung als Teil dieses Deployments. Das Gateway prüft zur Laufzeit, dass die Production-Datenbank weiter Schema 32 hat. Der frische Backup- und isolierte Restore-Test prüft den eingesetzten `better-sqlite3`-Treiber gegen den gesicherten Datenbankstand. Diese Prüfungen ersetzen weder die menschliche Review von PR #14 noch die gesonderte Caddy-, Runtime-, Twitch- und Releasefreigabe.

Bis sämtliche Releaseblocker außerhalb dieses Setup-PRs geprüft und ausdrücklich freigegeben wurden, muss `ACY_TWITCH_APPROVED_COMMIT` leer bleiben. Der hier vorbereitete Workflow soll zunächst ausschließlich als `preflight` laufen.

## Einrichtung in GitHub

Die Änderungen liegen zunächst in einem separaten, auf PR #17 aufbauenden Branch. Der Workflow kann erst manuell aus `main` gestartet werden, wenn die Basis und dieser Workflow geprüft und in den Default-Branch übernommen wurden. Dieser PR ist keine Merge- oder Deployment-Freigabe.

### 1. Environment anlegen und schützen

Unter **Settings → Environments** `production-twitch` anlegen und setzen:

1. Mindestens eine verantwortliche Person als Required Reviewer eintragen. Wenn verfügbar, Selbstfreigabe deaktivieren.
2. Administrator-Bypass für Environment-Regeln deaktivieren.
3. Deployment-Branches auf `main` beschränken.
4. Environment-Secrets und -Variables ausschließlich in dieser Environment hinterlegen.
5. `ACY_TWITCH_APPROVED_COMMIT` zunächst **nicht setzen**. Der `deploy`-Modus bleibt damit absichtlich gesperrt.

### 2. Verifizierten Host-Zugang vorbereiten

Der SSH-Schlüssel muss ausschließlich für diese GitHub-Environment bestimmt sein. Auf einem sicheren Betreibergerät ein eigenes Ed25519-Schlüsselpaar ohne Passphrase erzeugen, damit der geschützte GitHub-Runner es nicht interaktiv entsperren muss:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/acy-twitch-deploy -C github-actions-acy-twitch-deploy
```

Den privaten Schlüssel weder hier im Chat noch im Repository, in Logs oder auf der VM ablegen. Den öffentlichen Schlüssel (`~/.ssh/acy-twitch-deploy.pub`) direkt auf dem Oracle-Host unter dem bestehenden `ubuntu`-Servicekonto installieren; ein zweites OS-Konto wäre ohne bestätigte PM2-Berechtigungen nicht gleichwertig. Den privaten Schlüssel aus der lokalen Datei direkt in das GitHub-Environment-Secret eintragen.

Vorher müssen Betreiber auf der VM aus einer vertrauenswürdigen Console/Verwaltungsverbindung bestätigen:

- den extern oder über ein freigegebenes privates Netz erreichbaren DNS-Namen bzw. die feste IPv4-Adresse und den SSH-Port;
- den Fingerprint des Host-Schlüssels, zum Beispiel durch `ssh-keygen -lf` auf dem öffentlichen Host-Key an der VM;
- den tatsächlichen absoluten Pfad zu Node 24, npm, PM2, `tar` und `sha256sum`;
- PM2-Name, PM2-`pm_cwd`, Prozessdatei, aktive `dist`-Symlink-Auflösung, Datenbankpfad und Dateirechte.

Die Host-Key-Zeile für `known_hosts` muss aus einem vertrauenswürdigen Kanal stammen und ihr Fingerprint muss mit der Oracle-Console übereinstimmen. Nicht `ssh-keyscan`-Ausgabe als Vertrauensanker benutzen. Für Port 22 hat eine Zeile das Format `host ssh-ed25519 <öffentlicher-host-key>`; bei anderem Port ist der Hostteil `[host]:port`.

Die folgenden Gateway-Dateien müssen nach Review auf der VM unter `/home/ubuntu/twitch-community-bot/deploy/` installiert werden:

- `ops/oracle/twitch-deploy-gateway.sh` mit Modus `0755`;
- `ops/oracle/twitch-deploy-gateway.mjs` mit Modus `0644`.

Nach Merge der geprüften Infrastrukturänderung kann ein Betreiber sie aus einem vertrauenswürdigen Checkout der freigegebenen `main`-Version über die bestehende Admin-Verbindung installieren. Die Befehle installieren nur das feste Gateway und lassen vorhandene Dateien unangetastet:

```bash
sudo install -d -o ubuntu -g ubuntu -m 0750 /home/ubuntu/twitch-community-bot/deploy
sudo install -o ubuntu -g ubuntu -m 0755 ops/oracle/twitch-deploy-gateway.sh /home/ubuntu/twitch-community-bot/deploy/twitch-deploy-gateway.sh
sudo install -o ubuntu -g ubuntu -m 0644 ops/oracle/twitch-deploy-gateway.mjs /home/ubuntu/twitch-community-bot/deploy/twitch-deploy-gateway.mjs
```

Die echte Node/npm/PM2-Pfadkonfiguration erstellt ein Administrator über die vertrauenswürdige Host-Console mit den oben ermittelten absoluten Pfaden. Sie gehört `root:root`, Modus `0644`, und wird nicht aus dem Repository oder einem GitHub-Secret geladen. Keine `.env`- oder Token-Datei in diesem Pfad ablegen.

`/etc/acy-twitch-deploy.conf` muss von `root:root` verwaltet werden, nicht für `ubuntu` schreibbar sein und die bestätigten absoluten Pfade enthalten:

```bash
NODE_BIN=/bestätigter/pfad/zu/node
NPM_BIN=/bestätigter/pfad/zu/npm
PM2_BIN=/bestätigter/pfad/zu/pm2
TAR_BIN=/usr/bin/tar
SHA256_BIN=/usr/bin/sha256sum
```

Der Wrapper prüft nur vorhandene absolute Tool-Pfade. Er liest keine `.env`-Datei. Die `authorized_keys`-Zeile für genau diesen öffentlichen Schlüssel muss zusätzlich zu allen bestehenden Schlüsseln angehängt werden; vorhandene `authorized_keys` niemals ersetzen. Sie ersetzt für den neuen Schlüssel die freie Shell durch das feste Gateway und sperrt alle Forwardings/TTY; das OpenSSH-`restrict`-Flag ist erforderlich. Muster (Platzhalter durch den öffentlichen Schlüssel ersetzen):

```text
restrict,command="/bin/bash /home/ubuntu/twitch-community-bot/deploy/twitch-deploy-gateway.sh" ssh-ed25519 AAAA... github-actions-acy-twitch-deploy
```

Vor Aktivierung muss der Betreiber prüfen, dass OpenSSH `restrict` unterstützt, die Konfigurationsdatei unveränderlich für `ubuntu` ist und ein normaler Test mit dem neuen Schlüssel ausschließlich `preflight` erreicht. Keine PM2- oder Caddy-Konfiguration ändern. Den SSH-Schlüssel ohne diese erzwungene Gateway-Zeile nicht in GitHub eintragen.

### 3. Environment-Werte eintragen

**Environment-Secrets** (Inhalt nie in Chat oder Workflow-Logs kopieren):

| Name | Inhalt |
|---|---|
| `ORACLE_TWITCH_DEPLOY_KEY` | Privater Schlüssel des separaten, gateway-beschränkten Deployment-Schlüssels. |
| `ORACLE_TWITCH_KNOWN_HOSTS` | Vollständige, zuvor out-of-band verifizierte `known_hosts`-Zeile(n) für den exakten Host und Port. |

**Environment-Variables**:

| Name | Inhalt |
|---|---|
| `ORACLE_TWITCH_SSH_HOST` | Bestätigter DNS-Name oder feste IPv4-Adresse; kein lokaler SSH-Alias. |
| `ORACLE_TWITCH_SSH_PORT` | Bestätigter Port als Zahl, üblicherweise `22`. |
| `ORACLE_TWITCH_SSH_USER` | `ubuntu`, passend zum PM2-Eigentümer und zur erzwungenen Gateway-Zeile. |
| `ACY_TWITCH_APPROVED_COMMIT` | Exakte vollständige SHA-1 des geprüften `main`-Commits; leer/unset bis Releaseblocker und Freigabe erledigt sind. |

Der private Schlüssel wird über die GitHub-Einstellungsseite in das Environment-Secret eingefügt. GitHub Actions prüft ein leeres Passphrase-Feld, den SSH-Key und den exakten `known_hosts`-Eintrag. Es verwendet ausschließlich `StrictHostKeyChecking=yes` und ignoriert globale Host-Key-Dateien, damit nur der Environment-Pin gilt.

### 4. Netzwerkzugang aus GitHub Actions prüfen

GitHub-hosted Runner benötigen einen vom Oracle-Host akzeptierten SSH-Netzwerkpfad. Vorher mit dem Infrastrukturverantwortlichen eine belastbare Ingress-Regel festlegen. Dynamische Shared-Runner-Adressen dürfen nicht pauschal als unbegrenzte Quelle zugelassen werden. Falls kein vom Betreiber genehmigter, enger Egress-Pfad (zum Beispiel statische Runner-Egress-Adressen des verwendeten GitHub-Plans oder ein separat überprüfter privater Zugang) verfügbar ist, keine Firewallregel verbreitern: stattdessen den SSH-Pfad verwerfen und die Pull-Alternative planen.

Nach Einrichtung aus dem Default-Branch unter **Actions → Manual Twitch deployment → Run workflow** ausschließlich `preflight` wählen. Der Environment-Reviewer gibt diesen read-only Lauf frei. Ein erfolgreicher Lauf belegt, dass genau der GitHub-hosted Runner DNS/TCP/SSH mit dem gepinnten Host-Key erreicht hat und das Gateway den Twitch-/SQLite-/Health-Preflight bestanden hat. Bei DNS-, Timeout-, Host-Key- oder Gatewayfehlern nichts lockern; auf Pull umstellen.

### 5. Erstmalige Aktivierung: ausschließlich Preflight

1. PR #17 und anschließend diesen Infrastruktur-PR getrennt prüfen; beide müssen im Default-Branch liegen. PR #15 bleibt eigenständig und wird nicht in dieses Release aufgenommen.
2. Alle oben genannten Hostdaten out-of-band bestätigen und die Hostdateien/Gateway-Beschränkung installieren.
3. `production-twitch` mit Required Reviewer konfigurieren, Secrets/Variables eintragen und die Environment nur auf `main` begrenzen.
4. `ACY_TWITCH_APPROVED_COMMIT` ungesetzt lassen.
5. Workflow manuell mit `operation=preflight` aus `main` ausführen und den Environment-Reviewer um Freigabe bitten.
6. Das sichere Ergebnis prüfen: nur `twitch-community-bot`, Node/npm-Version, aktives Release, `better-sqlite3`-Version, SQLite-Integrität/Schema 32 und `/health`. Gateway und Workflow geben keine PM2-Umgebungsvariablen, Tokens oder DB-Inhalte aus.
7. Ein Preflight-Erfolg ist keine Deployment-Freigabe. Der erste Lauf und dieser Setup-PR führen keinen Deploy aus.

## Voraussetzungen vor einem späteren Deploy

Erst nachdem zuständige Reviewer PR #14 und den konkreten finalen Commit freigegeben haben, die alte Runtime-/Caddy-Abweichung bewertet, ein geprüftes Release-Manifest/Rollbackziel dokumentiert und der aktuelle Twitch-Betriebszustand separat beurteilt haben, kann ein autorisierter Environment-Owner `ACY_TWITCH_APPROVED_COMMIT` auf genau den freigegebenen `main`-SHA setzen. Die GitHub-Environment-Required-Reviewer bleiben zusätzlich aktiv.

Für den späteren Lauf muss der manuell ausgewählte `main`-Commit exakt diesem Environment-Wert entsprechen. Er benötigt außerdem die Checkbox `confirm_release_gate=true`. Der Workflow erstellt dann zuerst den Build, Check, Unit- und Browserlauf und ein Commit-/Tree-/Archiv-manifestiertes Artefakt. Nur bei Erfolg erhält der geschützte Job Zugriff auf SSH-Secrets. Das Gateway lehnt falschen Prozess, falschen PM2-Arbeitsordner, falsche aktive Symlink-Struktur, nicht-Schema-32, fehlerhafte Hashes, unerwartete Archivpfade und jede erkannte höhere Migration ab.

Der Workflow startet keine Migration. Da der App-Start selbst Migrationen ausführen kann, bleibt die Schema-32-Prüfung vor Freigabe und vor Start zwingend. Wird eine Schemaänderung benötigt, ist dieser Workflow/Releasepfad gesperrt; sie braucht eine separate, ausdrücklich geprüfte Migration und einen eigenen Betriebsplan.

## Pull-basierte Alternative ohne SSH-Ingress

Wenn GitHub-hosted Runner die VM nicht sicher erreichen können, sollte die VM nichts aus dem Internet annehmen. Einen lokalen, von `ubuntu` ausgeführten systemd-Pull-Dienst einrichten, der nur ausgehend über HTTPS arbeitet. Keinen GitHub Actions Self-hosted Runner auf der Production-VM installieren.

Die spätere Pull-Implementierung sollte ausschließlich Folgendes erlauben:

1. Eine manuell gestartete und durch `production-twitch`-Reviewer genehmigte GitHub-Aktion baut und testet den festen Commit.
2. Dieselbe genehmigte Aktion veröffentlicht ein unveränderliches Artefakt plus signierte Commit-/Hash-/Schema-Metadaten und einen expliziten, einmal verwendbaren Deployment-Auftrag. Pushes und Merges veröffentlichen oder autorisieren nichts.
3. Ein nur lesender, fein eingegrenzter Token liegt als systemd-Credential auf Oracle. Der Pull-Dienst lädt nur den explizit autorisierten Auftrag/Release über HTTPS, prüft Signatur, vollen Commit, Artefakt-SHA, Schema 32, Ablauf und Twitch-Ziel und verwirft bereits erledigte Aufträge.
4. Derselbe geprüfte lokale Twitch-only-Deploy-Code führt Backup, isolierten Restore-Test, Symlink-Wechsel, Twitch-only-Healthcheck und Rollback aus. Es gibt keinen eingehenden SSH-Port, keine frei erreichbare Webhook-Schnittstelle und keinen allgemeinen GitHub-Runner auf der VM.

Diese Pull-Variante ist eine alternative Architektur und benötigt einen eigenen Review-PR sowie einen Credential-/Signaturschlüsselplan; sie ist nicht Teil des hier vorbereiteten SSH-Workflows.

## Was diese Vorbereitung nicht ausführt

Es wurde keine Verbindung zu Oracle versucht. Keine Produktionsdatei, kein SSH-Schlüssel, keine GitHub-Environment, kein Host-Key und kein Production-Secret wurde erstellt oder geändert. Kein Deployment, PM2-Neustart, Datenbankrestore/-migration, Caddy-Reload, Discord-Änderung oder Twitch-/OBS-Live-Aufruf wurde ausgeführt. Der Workflow soll erst nach vollständiger Review, sicherem Host-Setup und separater ausdrücklicher Deployment-Freigabe eingesetzt werden.
