const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDocumentPreview } = require('../dist-electron/documentPreview.js');

test('prévia de documentos suporta PDF e texto sem interpretar conteúdo ativo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-document-preview-'));
  try {
    const pdfFile = path.join(root, 'documento.pdf');
    const textFile = path.join(root, 'notas.md');
    const officeFile = path.join(root, 'planilha.xlsx');
    fs.writeFileSync(pdfFile, Buffer.from('%PDF-1.4\nLantern'));
    fs.writeFileSync(textFile, '# Título\n<script>alert(1)</script>');
    fs.writeFileSync(officeFile, Buffer.from('arquivo-binario'));

    const pdf = await createDocumentPreview(pdfFile);
    assert.equal(pdf.kind, 'pdf');
    assert.match(pdf.url, /^data:application\/pdf;base64,/);

    const textPreview = await createDocumentPreview(textFile);
    assert.equal(textPreview.kind, 'text');
    assert.equal(textPreview.text, '# Título\n<script>alert(1)</script>');
    assert.equal(textPreview.truncated, false);

    const unsupported = await createDocumentPreview(officeFile);
    assert.equal(unsupported.kind, 'unsupported');
    assert.match(unsupported.reason, /não possui prévia segura/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prévia de texto limita leitura a 512 KB', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-document-preview-limit-'));
  try {
    const file = path.join(root, 'grande.txt');
    fs.writeFileSync(file, 'a'.repeat(600 * 1024));
    const preview = await createDocumentPreview(file);
    assert.equal(preview.kind, 'text');
    assert.equal(Buffer.byteLength(preview.text), 512 * 1024);
    assert.equal(preview.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('políticas de segurança permitem PDF em frame sem liberar objetos ativos', () => {
  const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const relaySource = fs.readFileSync(path.join(__dirname, '..', 'relay', 'main.ts'), 'utf8');
  assert.match(rendererHtml, /frame-src\s+'self'\s+data:\s+blob:/);
  assert.match(rendererHtml, /object-src\s+'none'/);
  assert.match(relaySource, /frame-src 'self' data: blob:/);
  assert.match(relaySource, /object-src 'none'/);
});
