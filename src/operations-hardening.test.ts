import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FeatureStore, CURRENT_FEATURE_SCHEMA_VERSION } from './feature-store.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Runtime-Datenpfade bleiben einschließlich OAuth-Varianten und temporärer Secret-Dateien von Git ausgeschlossen', () => {
  const secretPaths = [
    'data/oauth-tokens.json',
    'data/oauth-tokens.json.broadcaster',
    'data/oauth-tokens.json.vip',
    'data/oauth-tokens.json.broadcaster.oauth-state',
    'data/oauth-tokens.json.vip.oauth-state.tmp-123',
    'data/spotify-tokens.json',
    'data/custom-session.json',
    'data/custom-provider-credentials.json',
    'data/custom-oauth-state.json',
  ];
  for (const secretPath of secretPaths) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', secretPath], { cwd: projectRoot });
    assert.equal(result.status, 0, `${secretPath} muss ignoriert werden`);
  }
  const trackedData = execFileSync('git', ['ls-files', '--cached', '--', 'data'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(trackedData.trim(), '', 'Runtime-Dateien unter data/ dürfen nicht versioniert sein');
  const sourceFile = spawnSync('git', ['check-ignore', '--no-index', '--quiet', 'src/config.ts'], { cwd: projectRoot });
  assert.notEqual(sourceFile.status, 0, 'Quellcode bleibt vom Runtime-Ignore unberührt');
});

test('Geschützter Runtime-Status unterscheidet SQLite, erwartetes Schema und abgeschaltete Datenbank', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-runtime-health-'));
  const store = new FeatureStore(path.join(directory, 'bot.sqlite'));
  try {
    assert.deepEqual(store.runtimeHealth(), {
      sqlite: 'available', schema: 'ready', schemaVersion: CURRENT_FEATURE_SCHEMA_VERSION,
      expectedSchemaVersion: CURRENT_FEATURE_SCHEMA_VERSION,
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(store.runtimeHealth(), {
    sqlite: 'unavailable', schema: 'unavailable', schemaVersion: null,
    expectedSchemaVersion: CURRENT_FEATURE_SCHEMA_VERSION,
  });
});

test('Beide Caddy-Konfigurationen routen öffentliche, geschützte und OAuth-Pfade an die richtigen Listener', () => {
  const configs = [
    { file: 'Caddyfile', upstream: 'halloween-bot:3001', oauthUpstream: 'halloween-bot:3000' },
    { file: 'ops/Caddyfile.oracle', upstream: '127.0.0.1:3001', oauthUpstream: '127.0.0.1:3000' },
  ];
  const routes = [
    ['health', '/health'], ['dashboard', '/dashboard*'], ['community', '/community /community/*'],
    ['help', '/hilfe'], ['streamer', '/streamer'], ['widgets', '/widgets/*'], ['games', '/games/*'],
  ];
  for (const config of configs) {
    const source = fs.readFileSync(path.join(projectRoot, config.file), 'utf8');
    for (const [name, paths] of routes) {
      const block = `@${name} path ${paths}\n\thandle @${name} {\n\t\treverse_proxy ${config.upstream}\n\t}`;
      assert.ok(source.includes(block), `${config.file} muss ${paths} zu ${config.upstream} leiten`);
    }
    assert.ok(source.includes(`@oauth path /oauth/*\n\thandle @oauth {\n\t\treverse_proxy ${config.oauthUpstream}\n\t}`),
      `${config.file} muss OAuth-Callbackpfade an Port 3000 leiten`);
    assert.match(source, /respond "Not found" 404/u, `${config.file} erhält den ausdrücklich nicht konfigurierten Root-Pfad`);
  }
});
