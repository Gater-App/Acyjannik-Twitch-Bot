import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReleaseManifest } from './create-release-manifest.mjs';
import { verifyReleaseManifest } from './verify-release-manifest.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-deploy-manifest-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'main.js'), 'export {};\n');
  fs.mkdirSync(path.join(dist, 'nested'));
  fs.writeFileSync(path.join(dist, 'nested', 'index.html'), '<main>ok</main>\n');
  const manifest = createReleaseManifest({
    root,
    artifactPath: 'dist',
    sourceCommit: commit,
    sourceWorktreeClean: true,
    proxyConfigPaths: [],
    manifestCreatedAt: '2026-10-15T00:00:00.000Z',
  });
  const manifestPath = path.join(root, 'release-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, dist, manifestPath };
}

test('verifies exact file list, hashes, and source commit', () => {
  const sample = fixture();
  try {
    const result = verifyReleaseManifest({ artifactPath: sample.dist, manifestPath: sample.manifestPath, sourceCommit: commit });
    assert.deepEqual(result, { commit, fileCount: 2, treeSha256: JSON.parse(fs.readFileSync(sample.manifestPath, 'utf8')).artifact.sha256 });
  } finally { fs.rmSync(sample.root, { recursive: true, force: true }); }
});

test('rejects changed files and a different expected commit', () => {
  const sample = fixture();
  try {
    fs.writeFileSync(path.join(sample.dist, 'main.js'), 'changed\n');
    assert.throws(() => verifyReleaseManifest({ artifactPath: sample.dist, manifestPath: sample.manifestPath, sourceCommit: commit }), /stimmen nicht überein/);
    assert.throws(() => verifyReleaseManifest({ artifactPath: sample.dist, manifestPath: sample.manifestPath, sourceCommit: 'f'.repeat(40) }), /passt nicht/);
  } finally { fs.rmSync(sample.root, { recursive: true, force: true }); }
});

test('rejects symbolic links in the runtime artifact', () => {
  const sample = fixture();
  try {
    fs.symlinkSync(path.join(sample.dist, 'main.js'), path.join(sample.dist, 'linked.js'));
    assert.throws(() => verifyReleaseManifest({ artifactPath: sample.dist, manifestPath: sample.manifestPath, sourceCommit: commit }), /Symlink/);
  } finally { fs.rmSync(sample.root, { recursive: true, force: true }); }
});
