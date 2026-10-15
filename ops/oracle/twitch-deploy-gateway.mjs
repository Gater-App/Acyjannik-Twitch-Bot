import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const APP_ROOT = '/home/ubuntu/twitch-community-bot';
const RELEASES_DIR = path.join(APP_ROOT, 'releases');
const ACTIVE_DIST = path.join(APP_ROOT, 'dist');
const DATABASE = path.join(APP_ROOT, 'data/halloween.sqlite');
const PROCESS_NAME = 'twitch-community-bot';
const EXPECTED_SCHEMA_VERSION = 32;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DEPLOYMENT_METADATA = 'deployment-metadata.json';
const ARCHIVE_FILES = new Set([
  'release-manifest.json', DEPLOYMENT_METADATA, 'package.json', 'package-lock.json',
  'scripts/backup.mjs', 'scripts/restore.mjs', 'scripts/verify-release-manifest.mjs',
]);

export function parseForcedCommand(command) {
  if (command === 'preflight') return { operation: 'preflight' };
  const match = /^deploy ([0-9a-f]{40}) ([0-9a-f]{64})$/u.exec(command || '');
  if (match) return { operation: 'deploy', commit: match[1], archiveSha256: match[2] };
  throw new Error('Nicht erlaubter SSH-Befehl.');
}

export function validateArchiveEntries(names, typeLines) {
  if (!Array.isArray(names) || names.length === 0 || names.length !== typeLines.length) {
    throw new Error('Release-Archiv hat eine ungültige Dateiliste.');
  }
  const seen = new Set();
  for (const rawName of names) {
    const name = rawName.replace(/\/$/u, '');
    if (!name || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)
        || name.split('/').some((part) => part === '.' || part === '..') || /\s/u.test(name)) {
      throw new Error('Release-Archiv enthält einen unsicheren Pfad.');
    }
    const top = name.split('/')[0];
    const allowed = top === 'dist'
      || (name === 'scripts' || ARCHIVE_FILES.has(name));
    if (!allowed) throw new Error('Release-Archiv enthält nicht freigegebene Dateien.');
    if (name === 'scripts' || name === 'dist') continue;
    if (!seen.has(name) && !name.endsWith('/')) seen.add(name);
    else if (seen.has(name) && !name.endsWith('/')) throw new Error('Release-Archiv enthält doppelte Dateipfade.');
  }
  let unpackedBytes = 0;
  if (typeLines.some((line) => !['-', 'd'].includes(line[0]))) {
    throw new Error('Release-Archiv enthält Links oder spezielle Dateien.');
  }
  for (const line of typeLines) {
    if (line[0] !== '-') continue;
    const size = Number(line.trim().split(/\s+/u)[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Release-Archiv enthält eine ungültige Dateigröße.');
    unpackedBytes += size;
    if (unpackedBytes > MAX_UNPACKED_ARTIFACT_BYTES) throw new Error('Entpacktes Release-Artefakt überschreitet das Größenlimit.');
  }
  for (const required of ['dist', ...ARCHIVE_FILES]) {
    const found = names.some((name) => name.replace(/\/$/u, '') === required || name.startsWith(`${required}/`));
    if (!found) throw new Error(`Release-Archiv unvollständig: ${required}`);
  }
}

function configuredTools() {
  const values = {
    node: process.env.ACY_TWITCH_DEPLOY_NODE_BIN,
    npm: process.env.ACY_TWITCH_DEPLOY_NPM_BIN,
    pm2: process.env.ACY_TWITCH_DEPLOY_PM2_BIN,
    tar: process.env.ACY_TWITCH_DEPLOY_TAR_BIN || '/usr/bin/tar',
    sha256: process.env.ACY_TWITCH_DEPLOY_SHA256_BIN || '/usr/bin/sha256sum',
  };
  for (const [name, value] of Object.entries(values)) {
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) {
      throw new Error(`Deployment-Tool ${name} ist nicht als absoluter, vorhandener Dateipfad konfiguriert.`);
    }
  }
  return values;
}

function run(file, args, { cwd = APP_ROOT, env = process.env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  try {
    return execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer }).trim();
  } catch {
    throw new Error('Ein lokaler Preflight- oder Deployment-Schritt ist fehlgeschlagen.');
  }
}

function runtimeEnv(tools, extra = {}) {
  return {
    ...process.env,
    PATH: `${path.dirname(tools.node)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    ...extra,
  };
}

function databaseMetadata(tools, moduleBase, database) {
  const code = `const path=require('node:path');const fs=require('node:fs');const D=require(require.resolve('better-sqlite3',{paths:[process.argv[1]]}));const db=new D(process.argv[2],{readonly:true,fileMustExist:true});try{const integrity=db.pragma('integrity_check',{simple:true});const row=db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();let p=require.resolve('better-sqlite3',{paths:[process.argv[1]]});let version='unknown';while(p!==path.dirname(p)){p=path.dirname(p);const f=path.join(p,'package.json');if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.name==='better-sqlite3'){version=j.version;break}}}process.stdout.write(JSON.stringify({integrity,schemaVersion:row.version??0,betterSqliteVersion:version}))}finally{db.close()}`;
  const output = run(tools.node, ['--input-type=commonjs', '-e', code, moduleBase, database], { cwd: moduleBase, env: runtimeEnv(tools) });
  return JSON.parse(output);
}

function processMetadata(tools) {
  const records = JSON.parse(run(tools.pm2, ['jlist']));
  const matches = records.filter((record) => record.name === PROCESS_NAME);
  if (matches.length !== 1) throw new Error('Der erwartete Twitch-PM2-Prozess ist nicht eindeutig vorhanden.');
  const record = matches[0];
  const pid = record.pid || record.pm2_env?.pid;
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Twitch-PM2-Prozess hat keine gültige Prozess-ID.');
  if (record.pm2_env?.status !== 'online'
      || path.resolve(record.pm2_env?.pm_cwd || '') !== APP_ROOT
      || path.resolve(record.pm2_env?.pm_exec_path || '') !== path.join(APP_ROOT, 'dist/main.js')) {
    throw new Error('PM2-Metadaten passen nicht zum dokumentierten Twitch-Prozesspfad.');
  }
  let nodeExecutable;
  try { nodeExecutable = fs.realpathSync(`/proc/${pid}/exe`); }
  catch { throw new Error('Die laufende Twitch-Node-Runtime ist nicht lesbar.'); }
  return { name: record.name, status: record.pm2_env.status, nodeExecutable };
}

async function healthCheck() {
  try {
    const response = await fetch('http://127.0.0.1:3001/health', { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) return false;
    const body = await response.json();
    return body?.status === 'alive';
  } catch { return false; }
}

async function waitForHealthyProcess(tools, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      processMetadata(tools);
      if (await healthCheck()) return;
    } catch { /* Retry only the Twitch process and its local liveness endpoint. */ }
    await delay(3000);
  }
  throw new Error('Twitch-PM2-Prozess oder lokaler /health-Check blieb nach Neustart nicht gesund.');
}

function activeReleaseTarget() {
  const stat = fs.lstatSync(ACTIVE_DIST);
  if (!stat.isSymbolicLink()) throw new Error('Aktiver Twitch-dist-Pfad ist kein Symlink; Deployment wird abgebrochen.');
  const resolved = fs.realpathSync(ACTIVE_DIST);
  if (!resolved.startsWith(`${RELEASES_DIR}${path.sep}`) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Aktiver Twitch-dist-Symlink zeigt nicht in das dokumentierte Release-Verzeichnis.');
  }
  return resolved;
}

async function performPreflight(tools) {
  if (os.userInfo().username !== 'ubuntu') throw new Error('Deployment-Gateway läuft nicht als erwarteter ubuntu-Servicebenutzer.');
  const nodeVersion = run(tools.node, ['--version'], { env: runtimeEnv(tools) });
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(nodeVersion);
  if (!match || Number(match[1]) !== 24) throw new Error('Der konfigurierte Node-Runtime-Pfad ist nicht Node.js 24.');
  const activeTarget = activeReleaseTarget();
  const backupDirectory = path.join(APP_ROOT, 'backups');
  const releaseStats = fs.statfsSync(APP_ROOT);
  const freeBytes = releaseStats.bavail * releaseStats.bsize;
  if (freeBytes < 1024 * 1024 * 1024) throw new Error('Weniger als 1 GiB freier Speicher; Deployment wird vorsorglich blockiert.');
  const releasesStat = fs.lstatSync(RELEASES_DIR);
  const backupsStat = fs.lstatSync(backupDirectory);
  if (!releasesStat.isDirectory() || !backupsStat.isDirectory()) {
    throw new Error('Dokumentierte Release- oder Backup-Verzeichnisse fehlen.');
  }
  fs.accessSync(RELEASES_DIR, fsConstants.W_OK);
  fs.accessSync(backupDirectory, fsConstants.W_OK);
  const process = processMetadata(tools);
  const processNodeVersion = run(process.nodeExecutable, ['--version'], { env: runtimeEnv(tools) });
  if (!/^v24\./u.test(processNodeVersion)) throw new Error('Der laufende Twitch-PM2-Prozess verwendet nicht Node.js 24.');
  const database = databaseMetadata(tools, path.dirname(activeTarget), DATABASE);
  if (database.integrity !== 'ok' || database.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error('Production-SQLite ist nicht integrity-ok auf dem aktuell freigegebenen Schema 32.');
  }
  if (!(await healthCheck())) throw new Error('Lokaler Twitch /health-Liveness-Check ist fehlgeschlagen.');
  const npmVersion = run(tools.npm, ['--version'], { env: runtimeEnv(tools) });
  return {
    status: 'preflight-ok',
    process: process.name,
    gatewayNode: nodeVersion,
    processNode: processNodeVersion,
    npm: npmVersion,
    activeRelease: path.basename(path.dirname(activeTarget)),
    freeSpaceMiB: Math.floor(freeBytes / (1024 * 1024)),
    betterSqlite3: database.betterSqliteVersion,
    databaseIntegrity: database.integrity,
    schemaVersion: database.schemaVersion,
    health: 'alive',
  };
}

async function writeStdinFile(filePath) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) throw new Error('Release-Artefakt überschreitet das Größenlimit.');
      fs.writeSync(descriptor, chunk);
    }
  } finally { fs.closeSync(descriptor); }
  if (bytes === 0) throw new Error('Kein Release-Artefakt über SSH empfangen.');
}

function verifyAndExtractArchive(tools, archivePath, incomingPath) {
  const names = run(tools.tar, ['-tzf', archivePath]).split('\n').filter(Boolean);
  const verbose = run(tools.tar, ['-tvzf', archivePath]).split('\n').filter(Boolean);
  validateArchiveEntries(names, verbose);
  run(tools.tar, ['-xzf', archivePath, '-C', incomingPath, '--no-same-owner', '--no-same-permissions']);
}

function validateDeploymentMetadata(incomingPath, commit) {
  const metadata = JSON.parse(fs.readFileSync(path.join(incomingPath, DEPLOYMENT_METADATA), 'utf8'));
  if (metadata.schemaVersion !== 1
      || metadata.sourceCommit !== commit
      || metadata.requiredSchemaVersion !== EXPECTED_SCHEMA_VERSION
      || metadata.databaseChangePolicy !== 'none') {
    throw new Error('Release-Metadaten verletzen das Schema-32-Gate oder enthalten DB-Änderungen.');
  }
}

function verifyTree(tools, incomingPath, commit) {
  run(tools.node, [
    path.join(incomingPath, 'scripts/verify-release-manifest.mjs'),
    '--artifact', path.join(incomingPath, 'dist'),
    '--manifest', path.join(incomingPath, 'release-manifest.json'),
    '--source-commit', commit,
  ], { cwd: incomingPath, env: runtimeEnv(tools) });
}

function sha256File(tools, filePath) {
  return run(tools.sha256, [filePath]).split(/\s/u)[0];
}

function atomicSwitch(target) {
  const temporary = path.join(APP_ROOT, `.dist-deploy-${process.pid}-${createHash('sha256').update(`${Date.now()}`).digest('hex').slice(0, 8)}`);
  fs.symlinkSync(target, temporary, 'dir');
  fs.renameSync(temporary, ACTIVE_DIST);
}

function createBackupAndRestoreTest(tools, stagePath, commit) {
  const backupDir = path.join(APP_ROOT, 'backups', `deploy-${commit}`);
  if (fs.existsSync(backupDir)) throw new Error('Für diesen Commit existiert bereits ein Deployment-Backup-Verzeichnis.');
  fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
  const backupEnv = runtimeEnv(tools, { DATABASE_PATH: DATABASE, BACKUP_DIR: backupDir });
  run(tools.node, [path.join(stagePath, 'scripts/backup.mjs')], { cwd: stagePath, env: backupEnv });
  const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.sqlite'));
  if (backups.length !== 1) throw new Error('Backup-Skript hat kein eindeutiges SQLite-Backup erzeugt.');
  const backupPath = path.join(backupDir, backups[0]);
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `acy-twitch-restore-${commit.slice(0, 8)}-`));
  try {
    const restored = path.join(testDir, 'restore-test.sqlite');
    run(tools.node, [path.join(stagePath, 'scripts/restore.mjs'), backupPath], {
      cwd: stagePath,
      env: runtimeEnv(tools, { DATABASE_PATH: restored }),
    });
    const result = databaseMetadata(tools, stagePath, restored);
    if (result.integrity !== 'ok' || result.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
      throw new Error('Isolierter SQLite-Restore hat Integrität oder Schema 32 nicht bestanden.');
    }
    return { backup: backupPath, restoreIntegrity: result.integrity, schemaVersion: result.schemaVersion, betterSqlite3: result.betterSqliteVersion };
  } finally { fs.rmSync(testDir, { recursive: true, force: true }); }
}

async function deploy(tools, request) {
  if (os.userInfo().username !== 'ubuntu') throw new Error('Deployment-Gateway läuft nicht als erwarteter ubuntu-Servicebenutzer.');
  const lockPath = path.join(APP_ROOT, '.twitch-deployment.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  let currentTarget = '';
  let incomingPath = '';
  let releasePath = path.join(RELEASES_DIR, request.commit);
  let switched = false;
  try {
    currentTarget = activeReleaseTarget();
    processMetadata(tools);
    await performPreflight(tools);
    if (fs.existsSync(releasePath)) throw new Error('Release-Verzeichnis existiert bereits; Releases bleiben unveränderlich.');
    if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: false, mode: 0o750 });
    incomingPath = fs.mkdtempSync(path.join(RELEASES_DIR, `.incoming-${request.commit}-`));
    const archivePath = path.join(incomingPath, 'release.tar.gz');
    await writeStdinFile(archivePath);
    if (sha256File(tools, archivePath) !== request.archiveSha256) throw new Error('SHA-256 des übertragenen Release-Artefakts stimmt nicht überein.');
    verifyAndExtractArchive(tools, archivePath, incomingPath);
    fs.unlinkSync(archivePath);
    validateDeploymentMetadata(incomingPath, request.commit);
    verifyTree(tools, incomingPath, request.commit);
    const manifest = JSON.parse(fs.readFileSync(path.join(incomingPath, 'release-manifest.json'), 'utf8'));
    if (manifest.source?.workingTreeClean !== true) throw new Error('Build-Quellbaum war beim Manifest-Erstellen nicht sauber.');
    const archive = JSON.parse(fs.readFileSync(path.join(incomingPath, 'package.json'), 'utf8'));
    if (archive.engines?.node?.includes('24') !== true) throw new Error('Release-Paket erklärt Node.js 24 nicht als Runtime.');
    const toolsEnv = runtimeEnv(tools);
    run(tools.npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: incomingPath, env: toolsEnv, maxBuffer: 32 * 1024 * 1024 });
    const postInstallStats = fs.statfsSync(APP_ROOT);
    const freeBytesAfterInstall = postInstallStats.bavail * postInstallStats.bsize;
    if (freeBytesAfterInstall < 1024 * 1024 * 1024) throw new Error('Nach Installation sind weniger als 1 GiB frei; aktives Release bleibt unverändert.');
    const databaseChecks = createBackupAndRestoreTest(tools, incomingPath, request.commit);
    releasePath = path.join(RELEASES_DIR, request.commit);
    if (fs.existsSync(releasePath)) throw new Error('Release-Verzeichnis wurde während der Installation angelegt; Abbruch.');
    fs.renameSync(incomingPath, releasePath);
    incomingPath = '';
    atomicSwitch(path.join(releasePath, 'dist'));
    switched = true;
    try {
      run(tools.pm2, ['restart', PROCESS_NAME]);
      await waitForHealthyProcess(tools);
    } catch (error) {
      atomicSwitch(currentTarget);
      switched = false;
      try {
        run(tools.pm2, ['restart', PROCESS_NAME]);
        await waitForHealthyProcess(tools, 20);
        process.stderr.write('Twitch-Release fehlgeschlagen; vorheriger Twitch-Release wurde zurückgeschaltet und geprüft.\n');
      } catch {
        process.stderr.write('Twitch-Release und automatischer Rollback-Healthcheck fehlgeschlagen; Betreiberprüfung erforderlich.\n');
      }
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      status: 'deployment-ok', process: PROCESS_NAME, sourceCommit: request.commit,
      previousRelease: path.basename(path.dirname(currentTarget)), newRelease: request.commit,
      backup: path.basename(databaseChecks.backup), restoreIntegrity: databaseChecks.restoreIntegrity,
      schemaVersion: databaseChecks.schemaVersion, betterSqlite3: databaseChecks.betterSqlite3,
      health: 'alive',
    })}\n`);
  } catch (error) {
    if (switched) {
      try {
        atomicSwitch(currentTarget);
        run(tools.pm2, ['restart', PROCESS_NAME]);
        await waitForHealthyProcess(tools, 20);
      } catch { process.stderr.write('Automatischer Twitch-Rollback ist fehlgeschlagen; Betreiberprüfung erforderlich.\n'); }
    }
    if (incomingPath && fs.existsSync(incomingPath)) fs.rmSync(incomingPath, { recursive: true, force: true });
    throw error;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

async function main() {
  const command = parseForcedCommand(process.env.SSH_ORIGINAL_COMMAND || '');
  const tools = configuredTools();
  if (command.operation === 'preflight') {
    process.stdout.write(`${JSON.stringify(await performPreflight(tools))}\n`);
    return;
  }
  await deploy(tools, command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Twitch-Deployment-Gateway fehlgeschlagen.'}\n`);
    process.exitCode = 1;
  });
}
