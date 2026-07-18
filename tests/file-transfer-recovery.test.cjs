const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FileTransferService } = require('../dist-electron/fileTransfer.js');

const profile = {
  deviceId: 'receiver',
  username: 'receiver',
  department: '',
  displayName: 'Receiver',
  avatarEmoji: '🙂',
  avatarBg: '#147ad6',
  statusMessage: 'Disponível',
  createdAt: 1,
  updatedAt: 1
};

test('nova tentativa substitui stream de anexo envenenado sem herdar estado inválido', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-file-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bytes = Buffer.from('arquivo recuperado depois de uma falha de escrita');
  const offer = {
    fileId: 'file-retry',
    messageId: 'message-retry',
    filename: 'retry.txt',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  const service = new FileTransferService(root, profile);
  service.startIncoming(offer, 'sender');

  // Simula o erro assíncrono emitido pelo fs.WriteStream antes do primeiro
  // chunk. Esse era o caso que permanecia no Map e contaminava todos os retries.
  const poisoned = service.incoming.get(offer.fileId);
  poisoned.writeStream.emit('error', new Error('stream de teste indisponível'));

  const recoveredPath = service.startIncoming(offer, 'sender');
  assert.notEqual(service.incoming.get(offer.fileId), poisoned);
  assert.equal(service.incoming.get(offer.fileId).streamErrored, false);

  service.onChunk({
    fileId: offer.fileId,
    index: 0,
    total: 1,
    dataBase64: bytes.toString('base64')
  });
  const result = await service.finalize(offer.fileId);
  assert.equal(result.ok, true);
  assert.equal(result.finalPath, recoveredPath);
  assert.deepEqual(fs.readFileSync(recoveredPath), bytes);
});

test('abortAllIncoming remove transferências e arquivos parciais da sessão anterior', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-file-abort-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const service = new FileTransferService(root, profile);
  const bytes = Buffer.from('parcial');
  const offer = {
    fileId: 'file-old-session',
    messageId: 'message-old-session',
    filename: 'old.txt',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  const partialPath = service.startIncoming(offer, 'sender');
  service.abortAllIncoming();

  assert.equal(service.incoming.size, 0);
  assert.equal(fs.existsSync(partialPath), false);

  service.startIncoming(offer, 'sender');
  service.onChunk({
    fileId: offer.fileId,
    index: 0,
    total: 1,
    dataBase64: bytes.toString('base64')
  });
  const result = await service.finalize(offer.fileId);
  assert.equal(result.ok, true);
});

test('arquivo completo em diretório legado somente leitura é adotado sem ser regravado', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-file-adopt-'));
  const writable = path.join(root, 'writable');
  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(writable, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bytes = Buffer.from('cópia canônica já validada no dispositivo');
  const offer = {
    fileId: 'file-adopt',
    messageId: 'message-adopt',
    filename: 'documento.txt',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  const existingPath = path.join(legacy, `${offer.messageId}_${offer.filename}`);
  fs.writeFileSync(existingPath, bytes);
  fs.chmodSync(existingPath, 0o444);

  const service = new FileTransferService(writable, profile, [legacy]);
  const adopted = await service.findExistingCompleteFile(offer);

  assert.equal(adopted, existingPath);
  assert.deepEqual(fs.readFileSync(existingPath), bytes);
  assert.equal(fs.existsSync(path.join(writable, `${offer.messageId}_${offer.filename}`)), false);
});
