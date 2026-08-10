const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('pacote do Relay headless inclui dashboard administrativa e cliente Web', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'relay-node.pkg.json'), 'utf8')
  );
  const assets = Array.isArray(config.assets) ? config.assets : [];

  assert.ok(
    assets.includes('relay-ui/renderer/**/*'),
    'A dashboard do Relay UI precisa ser incorporada ao executável Node.'
  );
  assert.ok(
    assets.includes('dist-renderer/**/*'),
    'O cliente Lantern Web precisa ser incorporado ao executável Node.'
  );
  for (const relativePath of [
    'relay-ui/renderer/index.html',
    'relay-ui/renderer/styles.css',
    'relay-ui/renderer/app.js',
    'relay-ui/renderer/web-adapter.js'
  ]) {
    assert.ok(fs.statSync(path.join(projectRoot, relativePath)).isFile(), `${relativePath} ausente`);
  }
});

test('Relay UI Electron e Relay headless calculam a mesma pasta compartilhada', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'relay', 'dataPaths.ts'), 'utf8');
  assert.match(source, /path\.join\(appData, 'lantern', 'relay-data'\)/);
  assert.match(source, /platform === 'darwin'/);
  assert.match(source, /platform === 'win32'/);
  assert.match(source, /XDG_CONFIG_HOME/);
  assert.match(
    fs.readFileSync(path.join(projectRoot, 'relay-ui', 'main.ts'), 'utf8'),
    /resolveSharedRelayDataDir/
  );
  assert.match(
    fs.readFileSync(path.join(projectRoot, 'relay', 'main.ts'), 'utf8'),
    /resolveSharedRelayDataDir/
  );
});
