import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeploymentMetadata } from './create-deployment-metadata.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';

function project(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acy-deployment-metadata-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/feature-store.ts'), source);
  return root;
}

test('allows only the current schema-32 migration set and emits no-database-change metadata', () => {
  const root = project('export const CURRENT_FEATURE_SCHEMA_VERSION = 32;\nINSERT INTO schema_migrations(version,applied_at) VALUES (32, 1);\n');
  try {
    assert.deepEqual(createDeploymentMetadata({ sourceCommit: commit, root }), {
      schemaVersion: 1, sourceCommit: commit, requiredSchemaVersion: 32, databaseChangePolicy: 'none',
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('blocks a raised schema, migration above schema 32, or incomplete version metadata', () => {
  const raised = project('export const CURRENT_FEATURE_SCHEMA_VERSION = 33;\n');
  const added = project('export const CURRENT_FEATURE_SCHEMA_VERSION = 32;\nINSERT INTO schema_migrations(version,applied_at) VALUES (33, 1);\n');
  const missing = project('export const CURRENT_FEATURE_SCHEMA_VERSION = 32;\n');
  try {
    assert.throws(() => createDeploymentMetadata({ sourceCommit: commit, root: raised }), /eingefroren/);
    assert.throws(() => createDeploymentMetadata({ sourceCommit: commit, root: added }), /Migration/);
    assert.throws(() => createDeploymentMetadata({ sourceCommit: commit, root: missing }), /Migration/);
  } finally {
    fs.rmSync(raised, { recursive: true, force: true });
    fs.rmSync(added, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
  }
});
