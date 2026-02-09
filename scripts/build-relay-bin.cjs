const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const arg = (process.argv[2] || '').trim().toLowerCase();
const projectRoot = path.resolve(__dirname, '..');

const inferTargetSpec = () => {
  if (process.platform === 'win32') {
    return { targetSuffix: 'win-x64', outputName: 'LanternRelay.exe' };
  }
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return { targetSuffix: 'macos-arm64', outputName: 'LanternRelay-mac-arm64' };
    }
    return { targetSuffix: 'macos-x64', outputName: 'LanternRelay-mac-x64' };
  }
  if (process.platform === 'linux') {
    return { targetSuffix: 'linux-x64', outputName: 'LanternRelay-linux-x64' };
  }
  return null;
};

const explicitTargetSpec = (() => {
  if (!arg) return null;
  if (arg === 'win' || arg === 'windows') {
    return { targetSuffix: 'win-x64', outputName: 'LanternRelay.exe' };
  }
  if (arg === 'mac' || arg === 'macos' || arg === 'darwin') {
    return { targetSuffix: 'macos-arm64', outputName: 'LanternRelay-mac-arm64' };
  }
  if (arg === 'mac-x64') {
    return { targetSuffix: 'macos-x64', outputName: 'LanternRelay-mac-x64' };
  }
  if (arg === 'mac-arm64') {
    return { targetSuffix: 'macos-arm64', outputName: 'LanternRelay-mac-arm64' };
  }
  if (arg === 'linux') {
    return { targetSuffix: 'linux-x64', outputName: 'LanternRelay-linux-x64' };
  }
  return null;
})();

if (arg && !explicitTargetSpec) {
  console.error(
    `[LanternRelay build] alvo inválido "${arg}". Use: win | mac | mac-x64 | mac-arm64 | linux`
  );
  process.exit(1);
}

const targetSpec = explicitTargetSpec || inferTargetSpec();
if (!targetSpec) {
  console.error('[LanternRelay build] plataforma não suportada para target automático.');
  process.exit(1);
}

const parseRuntimeCandidates = () => {
  const envList = (process.env.LANTERN_RELAY_PKG_RUNTIMES || '').trim();
  const defaults = ['node20', 'node18', 'node16'];
  const base = envList.length > 0
    ? envList
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : defaults;

  const valid = base.filter((item) => /^node\d+$/.test(item));
  const deduped = [];
  const seen = new Set();
  for (const item of valid) {
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }

  return deduped.length > 0 ? deduped : defaults;
};

const runtimeCandidates = parseRuntimeCandidates();
const targetCandidates = runtimeCandidates.map(
  (runtime) => `${runtime}-${targetSpec.targetSuffix}`
);

const entryFile = path.resolve(projectRoot, 'dist-relay', 'main.js');
const outputFile = path.resolve(projectRoot, 'dist-relay', targetSpec.outputName);

if (!fs.existsSync(entryFile)) {
  console.error(
    `[LanternRelay build] arquivo de entrada não encontrado: ${entryFile}. Rode "npm run build:relay" antes.`
  );
  process.exit(1);
}

const run = (label, command, args, options = {}) => {
  console.log(`[LanternRelay build] tentando ${label}...`);
  return spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options
  });
};

const resolvePkgBinJs = () => {
  const pkgJsonPath = path.resolve(projectRoot, 'node_modules', 'pkg', 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }

  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const binValue =
      typeof pkgJson.bin === 'string'
        ? pkgJson.bin
        : pkgJson.bin && typeof pkgJson.bin.pkg === 'string'
        ? pkgJson.bin.pkg
        : 'lib-es5/bin.js';

    const pkgJsPath = path.resolve(path.dirname(pkgJsonPath), binValue);
    return fs.existsSync(pkgJsPath) ? pkgJsPath : null;
  } catch {
    return null;
  }
};

const pkgJs = resolvePkgBinJs();
const commandCandidates = [];

if (pkgJs) {
  commandCandidates.push({
    name: 'pkg via node (bin js)',
    command: process.execPath,
    argsForTarget: (target) => [pkgJs, entryFile, '--targets', target, '--output', outputFile]
  });
}

commandCandidates.push({
  name: 'pkg via npx',
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  argsForTarget: (target) => [
    '--yes',
    'pkg',
    entryFile,
    '--targets',
    target,
    '--output',
    outputFile
  ]
});

let lastError = null;
const attempts = [];

for (const target of targetCandidates) {
  for (const candidate of commandCandidates) {
    const label = `${candidate.name} (${target})`;
    const result = run(label, candidate.command, candidate.argsForTarget(target));

    if (result.error) {
      lastError = result.error;
      attempts.push({ label, status: null, error: result.error.message });
      console.warn(`[LanternRelay build] falha em ${label}: ${result.error.message}`);
      continue;
    }

    attempts.push({ label, status: result.status ?? null, error: null });

    if ((result.status ?? 1) === 0) {
      console.log(`[LanternRelay build] ok: ${outputFile}`);
      process.exit(0);
    }

    console.warn(
      `[LanternRelay build] ${label} retornou código ${result.status ?? 'desconhecido'}.`
    );
  }
}

if (!pkgJs) {
  console.warn(
    '[LanternRelay build] pacote "pkg" não encontrado em node_modules; usando apenas npx.'
  );
}

console.error('[LanternRelay build] nenhum target compatível foi gerado.');
console.error(
  `[LanternRelay build] targets tentados: ${targetCandidates.join(', ')}`
);

if (lastError) {
  console.error('[LanternRelay build] erro final ao executar pkg:', lastError.message);
}

if (attempts.length > 0) {
  const lines = attempts.map((attempt) =>
    `  - ${attempt.label}: ${attempt.error ? `erro=${attempt.error}` : `status=${attempt.status}`}`
  );
  console.error('[LanternRelay build] resumo das tentativas:\n' + lines.join('\n'));
}

process.exit(1);
