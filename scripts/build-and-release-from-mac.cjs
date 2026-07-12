const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distInstallersDir = path.join(projectRoot, 'dist-installers');
const distRelayDir = path.join(projectRoot, 'dist-relay');
const distRelayUiInstallersDir = path.join(projectRoot, 'dist-relay-ui-installers');
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
    prerelease: false,
    includeLinux: true
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
    if (arg === '--no-linux') {
      result.includeLinux = false;
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
  --no-linux             Não gera/publica os artefatos Linux
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

const makeRelayZip = (sourceFile, zipFile, dryRun) => {
  const tempDir = path.join(
    distReleaseTmpDir,
    `${path.basename(sourceFile)}-${Date.now().toString(36)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });
  fs.copyFileSync(sourceFile, path.join(tempDir, path.basename(sourceFile)));

  const stickersSource = path.join(projectRoot, 'assets', 'stickers', 'cats');
  if (fs.existsSync(stickersSource)) {
    const stickersTarget = path.join(tempDir, 'stickers', 'cats');
    fs.mkdirSync(stickersTarget, { recursive: true });
    for (const name of fs.readdirSync(stickersSource)) {
      if (/^lantern-cat-sticker-[a-z0-9-]+\.gif$/i.test(name)) {
        fs.copyFileSync(path.join(stickersSource, name), path.join(stickersTarget, name));
      }
    }
  }

  if (fs.existsSync(zipFile)) {
    fs.rmSync(zipFile, { force: true });
  }

  run(
    `Compactando ${path.basename(zipFile)}`,
    'zip',
    ['-X', '-r', zipFile, '.'],
    { cwd: tempDir },
    dryRun
  );
};

const writeDefaultReleaseNotes = (tag) => {
  const version = tag.replace(/^v/i, '') || packageJson.version;
  const notesPath = path.join(distReleaseDir, `RELEASE_NOTES_${tag}.md`);
  const notes = `# Lantern v${version}

Lantern 1.2.1 adds four interface languages and introduces Lantern Relay UI, a small desktop control panel for the Relay.

## Highlights

- Complete interface localization with automatic operating-system language detection and manual selection for Brazilian Portuguese, English, Spanish, and French.
- Lantern Relay UI: start, stop, and restart the Relay from a compact desktop window, now localized using the system language.
- Local network addresses and Relay port are displayed for easy manual client configuration.
- Live Relay overview with connected users, active announcements, attachment retention, and uptime.
- Configurable announcement expiration from 1 hour to 7 days.
- Continued support for local Relay discovery, chat, groups, announcements, attachments, reactions, and notifications.

## Release assets

- \`client-lantern-windows-setup.exe\` — Lantern client for Windows x64.
- \`client-lantern-mac-universal.dmg\` — Lantern client for macOS (Apple Silicon and Intel).
- \`client-lantern-linux.AppImage\` — Lantern client for Linux x64.
- \`relay-lantern-windows-setup.exe\` — Lantern Relay UI for Windows x64.
- \`relay-lantern-mac-universal.dmg\` — Lantern Relay UI for macOS (Apple Silicon and Intel).
- \`relay-lantern-linux.AppImage\` — Lantern Relay UI for Linux x64.

## Quick start

1. Run Lantern Relay UI on one machine in the network.
2. Start the Relay and copy a displayed local address if clients need manual configuration.
3. Open Lantern on client machines. Clients discover the Relay automatically or connect with the configured IP and port.

## Notes

- All live traffic passes through the Relay.
- Messages and attachments remain stored locally on client devices.
- When the Relay is offline, new messages and announcements wait until the connection is restored.

## Recommendation

Keep only one active Relay per network to avoid discovery and presence conflicts.
`;
  fs.mkdirSync(distReleaseDir, { recursive: true });
  fs.writeFileSync(notesPath, notes, 'utf8');
  return notesPath;
};

const buildReleaseAssets = (dryRun, includeLinux) => {
  ensureDirClean(distReleaseAssetsDir);
  ensureDirClean(distReleaseTmpDir);

  const windowsInstaller =
    findFile(distInstallersDir, (name) => /^Lantern-Setup-.*\.exe$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern.*\.exe$/i.test(name));
  const macDmg =
    findFile(distInstallersDir, (name) => /^Lantern-.*universal.*\.dmg$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern-.*arm64.*\.dmg$/i.test(name)) ||
    findFile(distInstallersDir, (name) => /^Lantern-.*\.dmg$/i.test(name));
  const linuxClient = findFile(distInstallersDir, (name) => /^Lantern-.*\.AppImage$/i.test(name));
  const relayUiWindows = findFile(distRelayUiInstallersDir, (name) => /^LanternRelay-Setup-.*\.exe$/i.test(name));
  const relayUiMac = findFile(distRelayUiInstallersDir, (name) => /^LanternRelay-.*universal.*\.dmg$/i.test(name));
  const relayUiLinux = findFile(distRelayUiInstallersDir, (name) => /^LanternRelay-.*\.AppImage$/i.test(name));
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
  if (!relayUiWindows || !relayUiMac) {
    throw new Error('Artefatos do Relay UI não encontrados em dist-relay-ui-installers.');
  }
  if (includeLinux && (!linuxClient || !relayUiLinux)) {
    throw new Error('Artefatos Linux não encontrados. Rode o build completo com Linux.');
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
  const targetLinuxClient = path.join(distReleaseAssetsDir, 'client-lantern-linux.AppImage');
  const targetRelayUiWindows = path.join(distReleaseAssetsDir, 'relay-lantern-windows-setup.exe');
  const targetRelayUiMac = path.join(distReleaseAssetsDir, 'relay-lantern-mac-universal.dmg');
  const targetRelayUiLinux = path.join(distReleaseAssetsDir, 'relay-lantern-linux.AppImage');

  copyFile(windowsInstaller, targetWindowsInstaller);
  copyFile(macDmg, targetMacDmg);
  makeRelayZip(relayWin, targetRelayWinZip, dryRun);
  makeRelayZip(relayMac, targetRelayMacZip, dryRun);
  copyFile(relayUiWindows, targetRelayUiWindows);
  copyFile(relayUiMac, targetRelayUiMac);
  if (includeLinux) {
    copyFile(linuxClient, targetLinuxClient);
    copyFile(relayUiLinux, targetRelayUiLinux);
  }

  return [
    targetWindowsInstaller,
    targetMacDmg,
    ...(includeLinux ? [targetLinuxClient] : []),
    targetRelayUiWindows,
    targetRelayUiMac,
    ...(includeLinux ? [targetRelayUiLinux] : []),
    targetRelayWinZip,
    targetRelayMacZip
  ];
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
      `Build completo macOS + Windows${options.includeLinux ? ' + Linux' : ''} + Relay`,
      process.execPath,
      [options.includeLinux ? './scripts/build-all-platforms-from-mac.cjs' : './scripts/build-mac-win-from-mac.cjs'],
      {},
      options.dryRun
    );
  }

  const assets = buildReleaseAssets(options.dryRun, options.includeLinux);
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
