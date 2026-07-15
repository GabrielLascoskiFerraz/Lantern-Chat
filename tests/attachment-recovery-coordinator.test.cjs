const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AttachmentRecoveryCoordinator
} = require('../dist-electron/attachmentRecoveryCoordinator.js');

test('recuperações concorrentes aguardam a mesma transferência e liberam retry após falha', async () => {
  const coordinator = new AttachmentRecoveryCoordinator();
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = coordinator.run('message-1', async () => {
    executions += 1;
    await gate;
  });
  const second = coordinator.run('message-1', async () => {
    executions += 1;
  });
  assert.equal(first, second);
  assert.equal(coordinator.has('message-1'), true);
  release();
  await Promise.all([first, second]);
  assert.equal(executions, 1);
  assert.equal(coordinator.has('message-1'), false);

  await assert.rejects(
    coordinator.run('message-1', async () => { throw new Error('falha transitória'); }),
    /falha transitória/
  );
  await coordinator.run('message-1', async () => { executions += 1; });
  assert.equal(executions, 2);
});
