import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_SCHEMA_VERSION = 32;

export function createDeploymentMetadata({ sourceCommit, root = process.cwd() }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit || '')) throw new Error('Quell-Commit muss eine vollständige Git-SHA-1-ID sein.');
  const featureStore = fs.readFileSync(path.join(root, 'src/feature-store.ts'), 'utf8');
  const current = /export const CURRENT_FEATURE_SCHEMA_VERSION = (\d+);/u.exec(featureStore);
  if (!current || Number(current[1]) !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Production-Deployment ist auf Schema ${SUPPORTED_SCHEMA_VERSION} eingefroren; Schemaänderung blockiert.`);
  }
  const versions = [...featureStore.matchAll(/schema_migrations\(version,applied_at\)\s*VALUES\s*\(\s*(\d+)/gu)]
    .map((match) => Number(match[1]));
  if (!versions.length || versions.some((version) => version > SUPPORTED_SCHEMA_VERSION)) {
    throw new Error('FeatureStore enthält eine nicht freigegebene oder höher versionierte SQLite-Migration.');
  }
  return {
    schemaVersion: 1,
    sourceCommit,
    requiredSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    databaseChangePolicy: 'none',
  };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--source-commit', '--output'].includes(key) || !value || value.startsWith('--')) {
      throw new Error('Aufruf: node scripts/create-deployment-metadata.mjs --source-commit <40-stelliger-Commit> --output <Datei>');
    }
    values.set(key, value);
    index += 1;
  }
  return values;
}

function main() {
  const args = readArguments(process.argv.slice(2));
  const outputPath = args.get('--output');
  if (!outputPath) throw new Error('Ausgabepfad fehlt.');
  const metadata = createDeploymentMetadata({ sourceCommit: args.get('--source-commit'), root: process.cwd() });
  fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Deployment-Metadaten erstellt (Schema ${metadata.requiredSchemaVersion}; DB-Änderungen: keine).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Deployment-Metadaten konnten nicht erstellt werden.'}\n`);
    process.exitCode = 1;
  }
}
