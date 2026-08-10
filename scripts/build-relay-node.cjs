const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'dist-relay-installers');
const stagingDir = path.join(root, 'dist-relay-node');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '0.0.0');
const requested = String(process.argv[2] || 'current').toLowerCase();
const pkgBin = path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
const esbuildBin = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');

const run = (label, command, args, options = {}) => {
  console.log(`[LanternRelay Node] ${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} falhou (exit=${result.status ?? 'desconhecido'})`);
  }
};

const removeIfExists = (target) => fs.rmSync(target, { recursive: true, force: true });

const prepareBundle = () => {
  removeIfExists(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  run('Consolidando o servidor para Node 24', esbuildBin, [
    'dist-relay/main.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node24',
    '--external:better-sqlite3',
    `--outfile=${path.join(stagingDir, 'main.cjs')}`
  ]);
  fs.writeFileSync(
    path.join(stagingDir, 'package.json'),
    JSON.stringify({
      name: 'lantern-relay-server',
      version,
      private: true,
      bin: 'main.cjs',
      dependencies: { 'better-sqlite3': packageJson.dependencies['better-sqlite3'] }
    }, null, 2)
  );
};

const packageNode = (target, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run(`Empacotando ${target}`, process.execPath, [
    pkgBin,
    '--config',
    path.join(root, 'relay-node.pkg.json'),
    '--targets',
    target,
    '--no-bytecode',
    '--public',
    '--fallback-to-source',
    '--public-packages',
    'better-sqlite3',
    '--output',
    destination,
    path.join(stagingDir, 'main.cjs')
  ]);
};

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Lantern Relay Server</string>
  <key>CFBundleExecutable</key><string>Lantern Relay Server</string>
  <key>CFBundleIdentifier</key><string>com.lantern.relay.headless</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Lantern Relay Server</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
</dict></plist>\n`;

const buildMac = () => {
  if (process.platform !== 'darwin') {
    throw new Error('O pacote universal do macOS deve ser gerado no macOS.');
  }
  const appDir = path.join(outputDir, 'mac-universal', 'Lantern Relay Server.app');
  const contentsDir = path.join(appDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const runtimeDir = path.join(resourcesDir, 'runtime');
  removeIfExists(path.join(outputDir, 'mac-universal'));
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  packageNode('node24-macos-arm64', path.join(runtimeDir, 'LanternRelay-arm64'));
  packageNode('node24-macos-x64', path.join(runtimeDir, 'LanternRelay-x64'));
  run('Compilando launcher universal macOS', 'clang', [
    '-arch', 'arm64',
    '-arch', 'x86_64',
    '-O2',
    path.join(root, 'scripts', 'relay-node-launcher.c'),
    '-o', path.join(macosDir, 'Lantern Relay Server')
  ]);

  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plist);
  fs.copyFileSync(path.join(root, 'assets', 'icon.icns'), path.join(resourcesDir, 'icon.icns'));
  run('Assinando localmente o aplicativo Node', 'codesign', [
    '--force', '--deep', '--sign', '-', appDir
  ]);

  const dmgRoot = path.join(stagingDir, 'dmg');
  removeIfExists(dmgRoot);
  fs.mkdirSync(dmgRoot, { recursive: true });
  fs.cpSync(appDir, path.join(dmgRoot, path.basename(appDir)), { recursive: true });
  fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications'));
  const dmgPath = path.join(outputDir, `LanternRelayServer-${version}-universal.dmg`);
  removeIfExists(dmgPath);
  run('Gerando DMG universal', 'hdiutil', [
    'create', '-volname', 'Lantern Relay Server', '-srcfolder', dmgRoot,
    '-ov', '-format', 'UDZO', dmgPath
  ]);
};

const findFileRecursive = (directory, fileName) => {
  if (!fs.existsSync(directory)) return '';
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(candidate, fileName);
      if (nested) return nested;
    }
  }
  return '';
};

const resolveMakensis = () => {
  const probe = spawnSync('sh', ['-lc', 'command -v makensis'], { encoding: 'utf8' });
  if ((probe.status ?? 1) === 0 && probe.stdout.trim()) return probe.stdout.trim();
  const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  if (process.platform === 'darwin') {
    const macCandidates = [];
    const collectMacCandidates = (directory) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) collectMacCandidates(candidate);
        else if (entry.isFile() && entry.name === 'makensis' && candidate.includes(`${path.sep}mac${path.sep}`)) {
          macCandidates.push(candidate);
        }
      }
    };
    collectMacCandidates(cacheRoot);
    return macCandidates[0] || '';
  }
  return findFileRecursive(cacheRoot, process.platform === 'win32' ? 'makensis.exe' : 'makensis');
};

const buildWindows = () => {
  const unpackedDir = path.join(outputDir, 'win-unpacked');
  removeIfExists(unpackedDir);
  fs.mkdirSync(unpackedDir, { recursive: true });
  const serverExe = path.join(unpackedDir, 'Lantern Relay Server.exe');
  packageNode('node24-win-x64', serverExe);

  const makensis = resolveMakensis();
  if (!makensis) {
    throw new Error('makensis não encontrado; instale o NSIS para gerar o instalador Windows.');
  }
  const setupExe = path.join(outputDir, `LanternRelayServer-Setup-${version}.exe`);
  removeIfExists(setupExe);
  const nsisDir = makensis.includes(`${path.sep}electron-builder${path.sep}`)
    ? path.dirname(path.dirname(makensis))
    : String(process.env.NSISDIR || '').trim();
  run('Gerando instalador NSIS do Relay Node', makensis, [
    `-DSOURCE_EXE=${serverExe}`,
    `-DOUTPUT_EXE=${setupExe}`,
    `-DAPP_VERSION=${version}`,
    path.join(root, 'scripts', 'relay-node-installer.nsi')
  ], {
    env: nsisDir ? { ...process.env, NSISDIR: nsisDir } : process.env
  });
};

const buildLinux = () => {
  const linuxDir = path.join(outputDir, 'linux-x64');
  removeIfExists(linuxDir);
  fs.mkdirSync(linuxDir, { recursive: true });
  packageNode('node24-linux-x64', path.join(linuxDir, 'LanternRelay'));
};

try {
  prepareBundle();
  if (requested === 'mac' || requested === 'mac-universal') buildMac();
  else if (requested === 'win' || requested === 'windows') buildWindows();
  else if (requested === 'linux') buildLinux();
  else if (requested === 'all') {
    buildMac();
    buildWindows();
    buildLinux();
  } else if (requested === 'current') {
    if (process.platform === 'darwin') buildMac();
    else if (process.platform === 'win32') buildWindows();
    else buildLinux();
  } else {
    throw new Error(`Plataforma desconhecida: ${requested}`);
  }
  console.log('[LanternRelay Node] Build concluído sem Electron.');
} catch (error) {
  console.error(`[LanternRelay Node] ERRO: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
