import assert from 'node:assert/strict';
import test from 'node:test';
import { parseForcedCommand, validateArchiveEntries } from './twitch-deploy-gateway.mjs';

test('accepts only a preflight and a commit plus archive digest', () => {
  assert.deepEqual(parseForcedCommand('preflight'), { operation: 'preflight' });
  assert.deepEqual(parseForcedCommand(`deploy ${'a'.repeat(40)} ${'b'.repeat(64)}`), {
    operation: 'deploy', commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64),
  });
  for (const command of ['', 'bash', 'deploy latest', 'preflight; id', `deploy ${'A'.repeat(40)} ${'b'.repeat(64)}`]) {
    assert.throws(() => parseForcedCommand(command), /Nicht erlaubter/);
  }
});

test('accepts only regular files and directories within the release allowlist', () => {
  validateArchiveEntries([
    'dist/', 'dist/main.js', 'scripts/', 'scripts/backup.mjs', 'scripts/restore.mjs',
    'scripts/verify-release-manifest.mjs', 'release-manifest.json', 'deployment-metadata.json',
    'package.json', 'package-lock.json',
  ], ['drwx------ 0/0 0 2026-01-01 00:00 dist/', '-rw-r--r-- 0/0 12 2026-01-01 00:00 dist/main.js', 'drwx------ 0/0 0 2026-01-01 00:00 scripts/', '-rw-r--r-- 0/0 12 2026-01-01 00:00 scripts/backup.mjs', '-rw-r--r-- 0/0 12 2026-01-01 00:00 scripts/restore.mjs', '-rw-r--r-- 0/0 12 2026-01-01 00:00 scripts/verify-release-manifest.mjs', '-rw-r--r-- 0/0 12 2026-01-01 00:00 release-manifest.json', '-rw-r--r-- 0/0 12 2026-01-01 00:00 deployment-metadata.json', '-rw-r--r-- 0/0 12 2026-01-01 00:00 package.json', '-rw-r--r-- 0/0 12 2026-01-01 00:00 package-lock.json']);
  assert.throws(() => validateArchiveEntries(['dist/', '../escape'], ['drwx------ 0/0 0 2026-01-01 00:00 dist/', '-rw-r--r-- 0/0 12 2026-01-01 00:00 ../escape']), /unsicheren Pfad/);
  assert.throws(() => validateArchiveEntries(['dist/', 'dist/link'], ['drwx------ 0/0 0 2026-01-01 00:00 dist/', 'lrwxrwxrwx 0/0 0 2026-01-01 00:00 dist/link']), /Links/);
  assert.throws(() => validateArchiveEntries(['dist/', 'package.json', 'unexpected.txt'], ['drwx------ 0/0 0 2026-01-01 00:00 dist/', '-rw-r--r-- 0/0 12 2026-01-01 00:00 package.json', '-rw-r--r-- 0/0 12 2026-01-01 00:00 unexpected.txt']), /nicht freigegebene/);
  assert.throws(() => validateArchiveEntries(['dist/', 'dist/large.js'], ['drwx------ 0/0 0 2026-01-01 00:00 dist/', '-rw-r--r-- 0/0 600000000 2026-01-01 00:00 dist/large.js']), /Größenlimit/);
});
