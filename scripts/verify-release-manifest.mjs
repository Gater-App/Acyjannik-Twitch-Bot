import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Symlink im Release-Artefakt: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const contents = fs.readFileSync(absolute);
        files.push({ path: relative, size: contents.byteLength, sha256: sha256(contents) });
      } else throw new Error(`Nicht unterstützter Artefakteintrag: ${relative}`);
    }
  };
  if (!fs.statSync(root).isDirectory()) throw new Error('dist muss ein Verzeichnis sein.');
  visit(root);
  if (!files.length) throw new Error('dist enthält keine Dateien.');
  return files;
}

export function verifyReleaseManifest({ artifactPath, manifestPath, sourceCommit }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit || '')) throw new Error('Erwartete Commit-ID ist ungültig.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1
      || manifest.source?.commit !== sourceCommit
      || manifest.artifact?.name !== 'dist'
      || manifest.artifact?.algorithm !== 'sha256-tree-v1'
      || manifest.deployment?.state !== 'not_verified') {
    throw new Error('Release-Manifest passt nicht zum erwarteten, noch nicht deployten Commit.');
  }
  const actualFiles = collectFiles(path.resolve(artifactPath));
  const expectedFiles = manifest.artifact.files;
  if (!Array.isArray(expectedFiles) || JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Dateiliste oder Datei-Hashes im Release-Manifest stimmen nicht überein.');
  }
  const treeContents = actualFiles.map((file) => `${file.path}\0${file.sha256}\n`).join('');
  if (sha256(treeContents) !== manifest.artifact.sha256
      || manifest.artifact.fileCount !== actualFiles.length) {
    throw new Error('Tree-Hash im Release-Manifest stimmt nicht überein.');
  }
  return { commit: sourceCommit, fileCount: actualFiles.length, treeSha256: manifest.artifact.sha256 };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--artifact', '--manifest', '--source-commit'].includes(key) || !value || value.startsWith('--')) {
      throw new Error('Aufruf: node scripts/verify-release-manifest.mjs --artifact dist --manifest release-manifest.json --source-commit <40-stelliger-Commit>');
    }
    values.set(key, value);
    index += 1;
  }
  return values;
}

function main() {
  const args = readArguments(process.argv.slice(2));
  const result = verifyReleaseManifest({
    artifactPath: args.get('--artifact'),
    manifestPath: args.get('--manifest'),
    sourceCommit: args.get('--source-commit'),
  });
  process.stdout.write(`Release-Artefakt verifiziert: ${result.fileCount} Dateien, ${result.treeSha256}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release-Artefakt konnte nicht verifiziert werden.'}\n`);
    process.exitCode = 1;
  }
}
