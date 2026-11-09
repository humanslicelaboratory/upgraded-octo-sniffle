const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'space-analyzer-scan-'));
  await fs.mkdir(path.join(root, 'alpha', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'beta'), { recursive: true });
  await fs.writeFile(path.join(root, 'alpha', 'a.txt'), '12345');
  await fs.writeFile(path.join(root, 'alpha', 'nested', 'b.bin'), Buffer.alloc(4096));
  await fs.writeFile(path.join(root, 'beta', 'c.dat'), Buffer.alloc(1024));

  const handlers = new Map();
  const events = [];
  const sender = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel, payload) => events.push({ channel, payload })
  };
  const electronMock = {
    app: { whenReady: () => Promise.resolve(), on: () => {} },
    BrowserWindow: class { constructor() { this.webContents = {}; } once() {} show() {} loadURL() {} loadFile() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    require('../desktop/main.cjs');
    await handlers.get('scan:start')({ sender }, { taskId: 'scanner-smoke', root, concurrency: 3, batchSize: 100 });
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (events.some(event => event.channel === 'scan:done' || event.channel === 'scan:error')) {
          clearInterval(timer); resolve();
        } else if (Date.now() - started > 10000) {
          clearInterval(timer); reject(new Error('scanner smoke test timed out'));
        }
      }, 20);
    });
    const records = events.filter(event => event.channel === 'scan:batch').flatMap(event => event.payload.records);
    const done = events.find(event => event.channel === 'scan:done')?.payload;
    assert.ok(done, events.find(event => event.channel === 'scan:error')?.payload?.message || 'scan did not finish');
    assert.equal(records.length, 6);
    assert.equal(done.files, 3);
    assert.equal(done.folders, 3);
    assert.equal(done.bytes, 5125);
    assert.equal(done.errors, 0);
    console.log('Windows scanner IPC smoke test passed: streamed batches, nested folders, metadata and byte totals.');
  } finally {
    Module._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
