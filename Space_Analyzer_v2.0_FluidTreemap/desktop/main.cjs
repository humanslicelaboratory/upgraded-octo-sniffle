const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const tasks = new Map();
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#252D29',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.once('ready-to-show', () => win.show());
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    win.loadURL('http://127.0.0.1:5173');
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { for (const task of tasks.values()) task.cancelled = true; });

function send(task, channel, payload) {
  if (!task.sender.isDestroyed() && !task.sender.isCrashed()) {
    task.sender.send(channel, { taskId: task.id, ...payload });
  }
}

async function waitWhilePaused(task) {
  while (task.paused && !task.cancelled) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function runScan(task) {
  const queue = [task.root];
  const batch = [];
  let lastProgressAt = 0;
  const flush = () => {
    if (!batch.length) return;
    const records = batch.splice(0, batch.length);
    send(task, 'scan:batch', { records });
  };
  const progress = (currentPath, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 350) return;
    lastProgressAt = now;
    send(task, 'scan:progress', {
      files: task.files,
      folders: task.folders,
      bytes: task.bytes,
      errors: task.errors,
      currentPath
    });
  };
  const add = record => {
    batch.push(record);
    if (record.type === 'file') { task.files += 1; task.bytes += record.size || 0; }
    else if (record.type === 'dir') task.folders += 1;
    if (batch.length >= task.batchSize) flush();
  };

  try {
    while (queue.length && !task.cancelled) {
      await waitWhilePaused(task);
      if (task.cancelled) break;
      const group = queue.splice(0, task.concurrency);
      const nextDirectories = [];
      await Promise.all(group.map(async directory => {
        if (task.cancelled) return;
        let handle;
        try {
          handle = await fs.opendir(directory);
        } catch (error) {
          task.errors += 1;
          return;
        }
        let entries = [];
        const processEntries = async () => {
          if (!entries.length) return;
          await waitWhilePaused(task);
          if (task.cancelled) { entries = []; return; }
          const current = entries;
          entries = [];
          const regularFiles = current.filter(entry => entry.isFile());
          const directories = current.filter(entry => entry.isDirectory());
          for (const entry of directories) {
            const fullPath = path.join(directory, entry.name);
            add({ path: fullPath, parentPath: directory, name: entry.name, type: 'dir', size: 0, mtime: 0 });
            nextDirectories.push(fullPath);
          }
          const stats = await Promise.all(regularFiles.map(async entry => {
            const fullPath = path.join(directory, entry.name);
            try {
              const stat = await fs.stat(fullPath, { bigint: false });
              return { path: fullPath, parentPath: directory, name: entry.name, type: 'file', size: stat.size, mtime: stat.mtimeMs };
            } catch {
              task.errors += 1;
              return null;
            }
          }));
          for (const record of stats) if (record) add(record);
          // Symlinks, junctions and special files are intentionally skipped to avoid loops.
          progress(directory);
        };
        try {
          for await (const entry of handle) {
            if (task.cancelled) break;
            entries.push(entry);
            if (entries.length >= 128) await processEntries();
          }
          await processEntries();
        } catch {
          task.errors += 1;
        } finally {
          try { await handle.close(); } catch { /* already closed by iterator */ }
        }
      }));
      queue.push(...nextDirectories);
      progress(queue.at(-1) || task.root, true);
    }
    flush();
    send(task, 'scan:done', {
      cancelled: task.cancelled,
      files: task.files,
      folders: task.folders,
      bytes: task.bytes,
      errors: task.errors,
      elapsedMs: Date.now() - task.startedAt
    });
  } catch (error) {
    flush();
    send(task, 'scan:error', { message: error.message || '扫描失败' });
  } finally {
    tasks.delete(task.id);
  }
}

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择需要分析的磁盘或文件夹',
    properties: ['openDirectory', 'showHiddenFiles']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan:start', async (event, options) => {
  const inputRoot = String(options?.root || '').trim();
  if (!inputRoot) throw new Error('无效的扫描路径');
  const root = path.resolve(inputRoot);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('所选路径不是文件夹');
  const id = String(options?.taskId || '');
  if (!id || id.length > 100) throw new Error('无效的扫描任务编号');
  if (tasks.has(id)) throw new Error('扫描任务已存在');
  const task = {
    id, root, sender: event.sender, cancelled: false, paused: false,
    concurrency: Math.max(1, Math.min(8, Number(options?.concurrency) || 4)),
    batchSize: Math.max(100, Math.min(1200, Number(options?.batchSize) || 500)),
    files: 0, folders: 0, bytes: 0, errors: 0, startedAt: Date.now()
  };
  tasks.set(id, task);
  setImmediate(() => runScan(task));
  return { started: true, taskId: id, root };
});

ipcMain.handle('scan:control', async (_event, { taskId, action }) => {
  const task = tasks.get(String(taskId));
  if (!task) return { ok: false };
  if (action === 'pause') task.paused = true;
  else if (action === 'resume') task.paused = false;
  else if (action === 'cancel') { task.cancelled = true; task.paused = false; }
  else return { ok: false };
  return { ok: true };
});
