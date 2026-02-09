const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

const normalizeTargetArg = (value) => {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;

  if (raw === 'win' || raw === 'windows' || raw === '--win') return '--win';
  if (raw === 'mac' || raw === 'darwin' || raw === '--mac') return '--mac';
  if (raw === 'linux' || raw === '--linux') return '--linux';
  return null;
};

const inferDefaultTarget = () => {
  if (process.platform === 'win32') return '--win';
  if (process.platform === 'darwin') return '--mac';
  if (process.platform === 'linux') return '--linux';
  return null;
};

const rawArg = process.argv[2];
const explicitTarget = normalizeTargetArg(rawArg);
if (rawArg && !explicitTarget) {
  console.error(`[Lantern build] Alvo inválido: "${rawArg}". Use: win | mac | linux`);
  process.exit(1);
}

const target = explicitTarget || inferDefaultTarget();
if (!target) {
  console.error('[Lantern build] Plataforma não suportada para build automático.');
  process.exit(1);
}

const builderArgs = [target];
if (target === '--win') {
  builderArgs.push('--x64');
}
builderArgs.push('--publish', 'never');

const run = (label, command, args, options = {}) => {
  console.log(`[Lantern build] tentando ${label}...`);
  return spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options
  });
};

const resolveElectronBuilderBinJs = () => {
  const pkgJsonPath = path.resolve(projectRoot, 'node_modules', 'electron-builder', 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }

  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const binValue =
      typeof pkgJson.bin === 'string'
        ? pkgJson.bin
        : pkgJson.bin && typeof pkgJson.bin['electron-builder'] === 'string'
        ? pkgJson.bin['electron-builder']
        : 'cli.js';

    const binPath = path.resolve(path.dirname(pkgJsonPath), binValue);
    return fs.existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
};

const candidates = [];
const builderJs = resolveElectronBuilderBinJs();
if (builderJs) {
  candidates.push({
    label: 'electron-builder via node (bin js)',
    command: process.execPath,
    args: [builderJs, ...builderArgs]
  });
}

candidates.push({
  label: 'electron-builder via npx',
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['--yes', 'electron-builder', ...builderArgs]
});

let lastError = null;
for (const candidate of candidates) {
  const result = run(candidate.label, candidate.command, candidate.args);
  if (result.error) {
    lastError = result.error;
    console.warn(`[Lantern build] falha em ${candidate.label}: ${result.error.message}`);
    continue;
  }

  if ((result.status ?? 1) === 0) {
    process.exit(0);
  }

  console.warn(
    `[Lantern build] ${candidate.label} retornou código ${result.status ?? 'desconhecido'}.`
  );
}

if (!builderJs) {
  console.warn('[Lantern build] pacote electron-builder não encontrado em node_modules; usando apenas npx.');
}

if (lastError) {
  console.error('[Lantern build] Falha ao executar electron-builder:', lastError.message);
}

process.exit(1);
