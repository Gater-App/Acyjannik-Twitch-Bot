import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createReleaseManifest } from './create-release-manifest.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Release-Manifest trennt Quelle, Runtime, Artefakt, Proxy-Prüfsummen und Deploymentzeit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-release-manifest-'));
  const artifact = path.join(root, 'dist');
  fs.mkdirSync(path.join(artifact, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(artifact, 'main.js'), 'console.log("safe");\n');
  fs.writeFileSync(path.join(artifact, 'nested', 'module.js'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'Caddyfile'), 'example.test { respond "ok" }\n');
  try {
    const manifest = createReleaseManifest({
      artifactPath: 'dist', sourceCommit: 'a'.repeat(40), runtimeCommit: 'b'.repeat(40),
      deployedAt: '2026-10-15T10:00:00+02:00', manifestCreatedAt: '2026-10-15T08:01:00Z',
      proxyConfigPaths: ['Caddyfile'], root,
    });
    assert.deepEqual(manifest.source, { commit: 'a'.repeat(40), workingTreeClean: null });
    assert.deepEqual(manifest.runtime, { commit: 'b'.repeat(40) });
    assert.equal(manifest.artifact.algorithm, 'sha256-tree-v1');
    assert.equal(manifest.artifact.fileCount, 2);
    assert.deepEqual(manifest.artifact.files.map((file) => file.path), ['main.js', 'nested/module.js']);
    assert.equal(manifest.proxyConfigs[0].path, 'Caddyfile');
    assert.equal(manifest.deployment.state, 'reported');
    assert.equal(manifest.deployment.deployedAt, '2026-10-15T08:00:00.000Z');
    assert.equal(manifest.createdAt, '2026-10-15T08:01:00.000Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Release-Manifest markiert unbekannten Runtime-Commit und Deploymentzeit nicht als verifiziert', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-release-manifest-unverified-'));
  const artifact = path.join(root, 'dist');
  fs.mkdirSync(artifact);
  fs.writeFileSync(path.join(artifact, 'main.js'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'Caddyfile'), 'example.test { respond "ok" }\n');
  try {
    const manifest = createReleaseManifest({ artifactPath: 'dist', sourceCommit: 'c'.repeat(40), proxyConfigPaths: ['Caddyfile'], root });
    assert.deepEqual(manifest.runtime, { commit: null });
    assert.deepEqual(manifest.deployment, { state: 'not_verified', deployedAt: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Release-Manifest-CLI schreibt die Prüfsumme getrennt neben das Build-Artefakt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-release-manifest-cli-'));
  const artifact = path.join(root, 'dist');
  const output = path.join(root, 'metadata', 'release-manifest.json');
  fs.mkdirSync(artifact);
  fs.writeFileSync(path.join(artifact, 'main.js'), 'export {};\n');
  try {
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts/create-release-manifest.mjs'), '--artifact', artifact,
      '--output', output, '--source-commit', 'd'.repeat(40), '--runtime-commit', 'e'.repeat(40),
      '--deployed-at', '2026-10-15T08:00:00Z',
    ], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(manifest.source.commit, 'd'.repeat(40));
    assert.equal(typeof manifest.source.workingTreeClean, 'boolean');
    assert.equal(manifest.runtime.commit, 'e'.repeat(40));
    assert.equal(manifest.artifact.fileCount, 1);
    assert.equal(manifest.deployment.deployedAt, '2026-10-15T08:00:00.000Z');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
