const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distInstallersDir = path.join(projectRoot, 'dist-installers');
const distRelayDir = path.join(projectRoot, 'dist-relay');
const distReleaseDir = path.join(projectRoot, 'dist-release');
const distReleaseAssetsDir = path.join(distReleaseDir, 'assets');
const distReleaseTmpDir = path.join(distReleaseDir, 'tmp');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
);

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {
    tag: 'release',
    title: 'Client e Server',
    notesFile: '',
    repo: '',
    skipBuild: false,
    dryRun: false,
    draft: false,
    prerelease: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--tag') {
      result.tag = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--title') {
      result.title = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--notes-file') {
      result.notesFile = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--repo') {
      result.repo = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--skip-build') {
      result.skipBuild = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--draft') {
      result.draft = true;
      continue;
    }
    if (arg === '--prerelease') {
      result.prerelease = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(`
Uso:
  node ./scripts/build-and-release-from-mac.cjs [opcoes]

Opcoes:
  --tag <tag>            Tag da release (default: release)
  --title <titulo>       Titulo da release (default: Client e Server)
  --notes-file <arquivo> Arquivo markdown para notas (se omitido, gera template padrao)
  --repo <owner/repo>    Repositorio alvo do GitHub (opcional)
  --skip-build           Pula etapa de build e usa artefatos existentes
  --draft                Cria/edita release como draft
  --prerelease           Cria/edita release como prerelease
  --dry-run              Mostra comandos sem executar

Prerequisitos:
  - macOS
  - gh CLI autenticado (gh auth login)
  - Script de build completo funcionando (npm run build:mac-win:from-mac)
`);
      process.exit(0);
    }
  }

  if (!result.tag) {
    throw new Error('Informe uma tag valida com --tag (ex: v1.0.0).');
  }
  if (!result.title) {
    result.title = `Lantern ${result.tag}`;
  }
  return result;
};

const run = (label, command, args, options = {}, dryRun = false) => {
  console.log(`[release] ${label}`);
  console.log(`[release] $ ${command} ${args.join(' ')}`);
  if (dryRun) return { status: 0 };
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} falhou (exit=${result.status ?? 'desconhecido'})`);
  }
  return result;
};

const resolveGhBinary = () => {
  const candidates = [
    process.env.GH_BIN && process.env.GH_BIN.trim(),
    'gh',
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'gh') {
      const probe = spawnSync('which', ['gh'], {
        cwd: projectRoot,
        stdio: 'ignore',
        shell: false
      });
      if ((probe.status ?? 1) === 0) {
        return 'gh';
      }
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
};

const ensureDirClean = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
};

const findFile = (dir, matcher) => {
  if (!fs.existsSync(dir)) return '';
  const names = fs.readdirSync(dir);
  for (const name of names) {
    if (matcher(name)) return path.join(dir, name);
  }
  return '';
};

const copyFile = (source, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
};

const makeZipSingleFile = (sourceFile, zipFile, dryRun) => {
  const tempDir = path.join(
    distReleaseTmpDir,
    `${path.basename(sourceFile)}-${Date.now().toString(36)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });
  const stagedFile = path.join(tempDir, path.basename(sourceFile));
  fs.copyFileSync(sourceFile, stagedFile);

  if (fs.existsSync(zipFile)) {
    fs.rmSync(zipFile, { force: true });
  }

  run(
    `Compactando ${path.basename(zipFile)}`,
    'zip',
    ['-j', '-X', zipFile, stagedFile],
    {},
    dryRun
  );
};

const writeDefaultReleaseNotes = (tag) => {
  const version = tag.replace(/^v/i, '') || packageJson.version;
  const notesPath = path.join(distReleaseDir, `RELEASE_NOTES_${tag}.md`);
  const notes = `# Lantern v${version}

Primeira release pública do Lantern (cliente) + LanternRelay (servidor de ponte), focada em chat local com presença online confiável via relay central.

## ✨ Destaques

- Chat 1:1 em tempo real.
- Anúncios globais com expiração automática (24h).
- Presença online/offline sincronizada pelo Relay.
- Envio de arquivos/anexos com progresso.
- Reações em mensagens e anúncios.
- Notificações nativas + execução em tray.
- Temas claro/escuro e ajustes visuais da interface.

## 📦 Arquivos desta release

- \`client-lantern-windows-setup.exe\` — Cliente Lantern para Windows.
- \`server-relay-windows.zip\` — Relay (Server) para Windows.
- \`client-lantern-mac-universal.dmg\` — Cliente Lantern para macOS (Apple Silicon e Intel).
- \`server-relay-mac.zip\` — Relay (Server) para macOS.

## 🚀 Como usar (resumo)

1. Inicie o LanternRelay em uma única máquina da rede.
2. Abra o Lantern nos clientes.
3. Os clientes conectam ao relay e sincronizam presença/mensagens automaticamente.

## ⚠️ Observações

- Todo o tráfego passa pelo Relay.
- Mensagens/arquivos ficam salvos localmente no cliente.
- Se o relay estiver offline, envio de mensagens/anúncios fica indisponível até reconectar.

## ✅ Recomendação

Manter apenas um Relay ativo por rede para evitar conflitos de presença.
`;
  fs.mkdirSync(distReleaseDir, { recursive: true });
  fs.writeFileSync(notesPath, notes, 'utf8');
  return notesPath;
};

const buildReleaseAssets = (dryRun) => {
  ensureDirClean(distReleaseAssetsDir);
  ensureDirClean(distReleaseTmpDir);

  const windowsInstaller =
    findFile(distInstallersDir, (name) => /^Lantern-Setup-.*\.exe$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern.*\.exe$/i.test(name));
  const macDmg =
    findFile(distInstallersDir, (name) => /^Lantern-.*universal.*\.dmg$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern-.*arm64.*\.dmg$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern-.*\.dmg$/i.test(name));
  const relayWin = path.join(distRelayDir, 'LanternRelay.exe');
  const relayMac =
    findFile(distRelayDir, (name) => /^LanternRelay-mac-arm64$/i.test(name)) ||
    findFile(distRelayDir, (name) => /^LanternRelay-mac-x64$/i.test(name)) ||
    findFile(distRelayDir, (name) => /^LanternRelay-mac-/i.test(name));

  if (!windowsInstaller) {
    throw new Error('Instalador Windows não encontrado em dist-installers.');
  }
  if (!macDmg) {
    throw new Error('DMG macOS não encontrado em dist-installers.');
  }
  if (!fs.existsSync(relayWin)) {
    throw new Error('Relay Windows não encontrado em dist-relay/LanternRelay.exe.');
  }
  if (!relayMac) {
    throw new Error('Relay macOS não encontrado em dist-relay.');
  }

  const targetWindowsInstaller = path.join(
    distReleaseAssetsDir,
    'client-lantern-windows-setup.exe'
  );
  const targetMacDmg = path.join(distReleaseAssetsDir, 'client-lantern-mac-universal.dmg');
  const targetRelayWinZip = path.join(distReleaseAssetsDir, 'server-relay-windows.zip');
  const targetRelayMacZip = path.join(distReleaseAssetsDir, 'server-relay-mac.zip');

  copyFile(windowsInstaller, targetWindowsInstaller);
  copyFile(macDmg, targetMacDmg);
  makeZipSingleFile(relayWin, targetRelayWinZip, dryRun);
  makeZipSingleFile(relayMac, targetRelayMacZip, dryRun);

  return [targetWindowsInstaller, targetRelayWinZip, targetMacDmg, targetRelayMacZip];
};

const ghArgsWithRepo = (args, repo) => (repo ? [...args, '--repo', repo] : args);

const releaseExists = (tag, repo, dryRun) => {
  if (dryRun) return false;
  const cmd = resolveGhBinary();
  if (!cmd) {
    throw new Error(
      'GitHub CLI (gh) não encontrado. Instale com "brew install gh" e execute "gh auth login".'
    );
  }
  const args = ghArgsWithRepo(['release', 'view', tag], repo);
  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    stdio: 'ignore',
    shell: false
  });
  return (result.status ?? 1) === 0;
};

const ensureRelease = (options, notesFile) => {
  const gh = resolveGhBinary();
  if (!gh) {
    throw new Error(
      'GitHub CLI (gh) não encontrado. Instale com "brew install gh" e execute "gh auth login".'
    );
  }
  const exists = releaseExists(options.tag, options.repo, options.dryRun);
  const baseFlags = [];
  if (options.draft) baseFlags.push('--draft');
  if (options.prerelease) baseFlags.push('--prerelease');

  if (!exists) {
    run(
      `Criando release ${options.tag}`,
      gh,
      ghArgsWithRepo(
        [
          'release',
          'create',
          options.tag,
          '--title',
          options.title,
          '--notes-file',
          notesFile,
          ...baseFlags
        ],
        options.repo
      ),
      {},
      options.dryRun
    );
    return;
  }

  run(
    `Atualizando release ${options.tag}`,
    gh,
    ghArgsWithRepo(
      [
        'release',
        'edit',
        options.tag,
        '--title',
        options.title,
        '--notes-file',
        notesFile,
        ...baseFlags
      ],
      options.repo
    ),
    {},
    options.dryRun
  );
};

const uploadAssets = (options, assetPaths) => {
  const gh = resolveGhBinary();
  if (!gh) {
    throw new Error(
      'GitHub CLI (gh) não encontrado. Instale com "brew install gh" e execute "gh auth login".'
    );
  }
  run(
    `Upload de artefatos para ${options.tag}`,
    gh,
    ghArgsWithRepo(
      ['release', 'upload', options.tag, ...assetPaths, '--clobber'],
      options.repo
    ),
    {},
    options.dryRun
  );
};

const main = () => {
  if (process.platform !== 'darwin') {
    throw new Error('Este script deve ser executado no macOS.');
  }

  const options = parseArgs();
  if (!options.skipBuild) {
    run(
      'Build completo macOS + Windows + relay',
      process.execPath,
      ['./scripts/build-mac-win-from-mac.cjs'],
      {},
      options.dryRun
    );
  }

  const assets = buildReleaseAssets(options.dryRun);
  const notesFile = options.notesFile
    ? path.resolve(projectRoot, options.notesFile)
    : writeDefaultReleaseNotes(options.tag);

  if (!fs.existsSync(notesFile) && !options.dryRun) {
    throw new Error(`Arquivo de notas não encontrado: ${notesFile}`);
  }

  ensureRelease(options, notesFile);
  uploadAssets(options, assets);

  console.log('[release] Concluído com sucesso.');
  console.log('[release] Artefatos publicados:');
  for (const asset of assets) {
    console.log(`[release] - ${asset}`);
  }
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[release] ERRO: ${message}`);
  process.exit(1);
}
