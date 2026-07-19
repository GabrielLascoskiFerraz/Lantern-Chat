const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourceFile = path.resolve(__dirname, '../renderer/src/ui/loginErrorFeedback.ts');
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourceFile
}).outputText;
const loadedModule = { exports: {} };
new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)(
  require,
  loadedModule,
  loadedModule.exports,
  sourceFile,
  path.dirname(sourceFile)
);

const { describeLoginError, readableLoginError } = loadedModule.exports;

test('remove o invólucro técnico do Electron sem remover a mensagem útil', () => {
  assert.equal(
    readableLoginError(
      new Error("Error invoking remote method 'lantern:login': Error: Usuário ou senha inválidos."),
      'Falha'
    ),
    'Usuário ou senha inválidos.'
  );
});

test('diferencia credenciais inválidas de indisponibilidade do Relay', () => {
  const credentials = describeLoginError(new Error('Usuário ou senha inválidos.'), 'local-auto', false);
  assert.equal(credentials.title, 'Dados de acesso incorretos');
  assert.equal(credentials.action, null);

  const offline = describeLoginError(new Error('Não foi possível conectar ao Relay.'), 'local-auto', false);
  assert.equal(offline.title, 'Relay indisponível');
  assert.equal(offline.action, 'discover');
});

test('orienta revisão manual para DNS e certificado WSS', () => {
  const dns = describeLoginError(
    new Error('O endereço do Relay não foi encontrado. Confira o nome ou IP informado.'),
    'local-manual',
    false
  );
  assert.equal(dns.action, 'review-connection');

  const tls = describeLoginError(
    new Error('Não foi possível validar a conexão segura com o Relay. Verifique o certificado.'),
    'external-manual',
    false
  );
  assert.equal(tls.title, 'Conexão segura não validada');
  assert.equal(tls.action, 'review-connection');
});

test('distingue um serviço HTTP que não é o Relay Lantern', () => {
  const wrongService = describeLoginError(
    new Error('O endereço respondeu, mas não parece ser um Relay Lantern. Confira o endereço e a porta.'),
    'local-manual',
    false
  );
  assert.equal(wrongService.title, 'Endereço incompatível');
  assert.equal(wrongService.action, 'review-connection');
});
