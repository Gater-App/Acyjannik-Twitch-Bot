import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function walkFiles(root, excludedRelativePaths = new Set()) {
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (excludedRelativePaths.has(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink im Release-Artefakt wird nicht unterstützt: ${relativePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const content = fs.readFileSync(absolutePath);
        files.push({ path: relativePath, size: content.byteLength, sha256: sha256(content) });
      } else throw new Error(`Nicht unterstützter Artefakteintrag: ${relativePath}`);
    }
  };
  if (!fs.statSync(root).isDirectory()) throw new Error('Das Build-Artefakt muss ein Verzeichnis sein.');
  visit(root);
  if (!files.length) throw new Error('Das Build-Artefakt enthält keine Dateien.');
  return files;
}

function resolveCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(value)) throw new Error(`${label} muss eine Git-Commit-ID enthalten.`);
  return value.toLowerCase();
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('deployedAt muss ein gültiger ISO-Zeitpunkt sein.');
  return new Date(milliseconds).toISOString();
}

export function createReleaseManifest({
  artifactPath,
  sourceCommit,
  runtimeCommit = null,
  deployedAt = null,
  proxyConfigPaths = ['Caddyfile', 'ops/Caddyfile.oracle'],
  manifestCreatedAt = new Date().toISOString(),
  sourceWorktreeClean = null,
  root = projectRoot,
  outputPath,
}) {
  const absoluteRoot = path.resolve(root);
  const absoluteArtifact = path.resolve(absoluteRoot, artifactPath || 'dist');
  const excluded = new Set();
  if (outputPath) {
    const relativeOutput = path.relative(absoluteArtifact, path.resolve(absoluteRoot, outputPath));
    if (relativeOutput && !relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)) {
      excluded.add(relativeOutput.split(path.sep).join('/'));
    }
  }
  const files = walkFiles(absoluteArtifact, excluded);
  const treeContents = files.map((file) => `${file.path}\0${file.sha256}\n`).join('');
  const proxyConfigs = proxyConfigPaths.map((relativePath) => {
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    const insideRoot = path.relative(absoluteRoot, absolutePath);
    if (!insideRoot || insideRoot.startsWith(`..${path.sep}`) || insideRoot === '..' || path.isAbsolute(insideRoot)) {
      throw new Error(`Proxy-Konfiguration muss innerhalb des Projektverzeichnisses liegen: ${relativePath}`);
    }
    const content = fs.readFileSync(absolutePath);
    return { path: insideRoot.split(path.sep).join('/'), sha256: sha256(content) };
  });
  return {
    schemaVersion: 1,
    createdAt: new Date(manifestCreatedAt).toISOString(),
    source: { commit: resolveCommit(sourceCommit, 'sourceCommit'), workingTreeClean: sourceWorktreeClean },
    runtime: { commit: runtimeCommit === null ? null : resolveCommit(runtimeCommit, 'runtimeCommit') },
    artifact: {
      name: path.basename(absoluteArtifact),
      algorithm: 'sha256-tree-v1',
      sha256: sha256(treeContents),
      fileCount: files.length,
      files,
    },
    proxyConfigs,
    deployment: {
      state: deployedAt ? 'reported' : 'not_verified',
      deployedAt: normalizeTimestamp(deployedAt),
    },
  };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`Unerwartetes Argument: ${key || ''}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Wert fehlt für ${key}.`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function main() {
  const args = readArguments(process.argv.slice(2));
  const sourceCommit = args.get('source-commit') || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const sourceWorktreeClean = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim().length === 0;
  const manifest = createReleaseManifest({
    artifactPath: args.get('artifact') || 'dist',
    sourceCommit,
    runtimeCommit: args.get('runtime-commit') || null,
    deployedAt: args.get('deployed-at') || null,
    sourceWorktreeClean,
    outputPath: args.get('output'),
  });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  const outputPath = args.get('output');
  if (!outputPath) { process.stdout.write(output); return; }
  const absoluteOutput = path.resolve(projectRoot, outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, output, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`Release-Manifest geschrieben: ${path.relative(projectRoot, absoluteOutput)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release-Manifest konnte nicht erstellt werden.'}\n`);
    process.exitCode = 1;
  }
}
