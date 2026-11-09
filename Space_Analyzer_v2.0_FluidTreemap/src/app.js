import { hashString, polygonArea, polygonCentroid, pointInPolygon, layoutPowerCells } from './fluid-layout.mjs';

const $ = id => document.getElementById(id);
const DARK_PALETTE = ['#35443C', '#435449', '#526456', '#69786B', '#374149', '#46535A', '#5B514B', '#6A5C52', '#85877A'];
const FILE_PALETTE = ['#6B625A', '#746B62', '#655F55', '#7A7065'];
const state = {
  root: null, rootName: '', nodes: [], files: [], dirs: [], nodeByPath: new Map(),
  current: null, selected: null, scanning: false, paused: false, cancelled: false,
  taskId: null, started: 0, scanMs: 0, scanErrors: 0, mapDepth: 2, lastPaint: 0,
  theme: 'dark', sourceKind: null
};

const fmt = n => {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const extOf = name => { const i = String(name).lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : '无扩展名'; };
const pathJoin = (a, b, native = false) => native ? `${a.replace(/[\\/]+$/, '')}${a.includes('\\') ? '\\' : '/'}${b}` : `${a}/${b}`;
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => element.classList.remove('show'), 2500);
}
function showView(view) {
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('welcome').classList.toggle('hidden', !!state.root);
  $('dashboard').classList.toggle('hidden', view !== 'overview' || !state.root);
  ['treemap', 'files', 'types'].forEach(name => $(`${name}-view`).classList.toggle('hidden', view !== name));
  $('page-title').textContent = ({ overview: '磁盘总览', treemap: '流体空间地图', files: '文件列表', types: '类型分析' })[view];
  if (view === 'treemap') requestAnimationFrame(renderMap);
  if (view === 'files') renderFiles();
  if (view === 'types') renderTypes();
}
document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => showView(button.dataset.goto)));
$('theme-toggle').onclick = () => {
  document.body.classList.toggle('dark');
  state.theme = document.body.classList.contains('dark') ? 'dark' : 'light';
};
$('choose-btn').onclick = $('welcome-choose').onclick = chooseFolder;

async function chooseFolder() {
  try {
    if (window.spaceAPI?.chooseFolder) {
      const selectedPath = await window.spaceAPI.chooseFolder();
      if (selectedPath) startScan({ kind: 'native', path: selectedPath, name: selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || selectedPath });
      return;
    }
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await startScan({ kind: 'handle', handle, name: handle.name });
      return;
    }
    $('folder-input').click();
  } catch (error) {
    if (error?.name !== 'AbortError') toast(`无法打开所选目录：${error.message || error}`);
  }
}
$('folder-input').addEventListener('change', async event => {
  const fileList = [...event.target.files];
  if (!fileList.length) return;
  const name = fileList[0].webkitRelativePath.split('/')[0] || '所选文件夹';
  event.target.value = '';
  await startScan({ kind: 'filelist', fileList, name });
});

function initRoot(id, name) {
  const root = { id, path: id, name, parent: null, type: 'dir', size: 0, count: 0, mtime: 0, children: [], depth: 0 };
  state.root = root;
  state.nodeByPath.set(id, root);
  state.nodes.push(root);
  state.dirs.push(root);
  return root;
}
function addRecord(record) {
  let parent = state.nodeByPath.get(record.parentPath);
  if (!parent) {
    // WebKit directory input may omit empty folders; reconstruct the missing chain safely.
    const pieces = record.parentPath.split(/[\\/]/).filter(Boolean);
    let currentPath = state.root.id;
    parent = state.root;
    for (const name of pieces.slice(state.rootName ? 1 : 0)) {
      currentPath = pathJoin(currentPath, name, state.sourceKind === 'native');
      if (!state.nodeByPath.has(currentPath)) {
        const created = { id: currentPath, path: currentPath, name, parent, type: 'dir', size: 0, count: 0, mtime: 0, children: [], depth: parent.depth + 1 };
        parent.children.push(created); state.nodeByPath.set(currentPath, created); state.nodes.push(created); state.dirs.push(created);
      }
      parent = state.nodeByPath.get(currentPath);
    }
  }
  if (state.nodeByPath.has(record.path)) return state.nodeByPath.get(record.path);
  const node = {
    id: record.path, path: record.path, name: record.name, parent,
    type: record.type, size: Number(record.size) || 0, count: record.type === 'file' ? 1 : 0,
    mtime: Number(record.mtime) || 0, children: [], depth: parent.depth + 1
  };
  parent.children.push(node);
  state.nodeByPath.set(node.path, node);
  state.nodes.push(node);
  if (node.type === 'file') {
    state.files.push(node);
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      ancestor.size += node.size;
      ancestor.count += 1;
    }
  } else {
    state.dirs.push(node);
  }
  return node;
}
function updateLiveStats(progress = null) {
  if (!state.root) return;
  $('total-size').textContent = fmt(state.root.size);
  $('total-files').textContent = `${state.files.length.toLocaleString()} 个文件`;
  $('total-dirs').textContent = `${Math.max(0, state.dirs.length - 1).toLocaleString()} 个文件夹`;
  $('progress-errors').textContent = `${state.scanErrors.toLocaleString()} 个跳过`;
  if (progress) {
    $('progress-files').textContent = `${progress.files.toLocaleString()} 个文件`;
    $('progress-folders').textContent = `${progress.folders.toLocaleString()} 个文件夹`;
    $('progress-bytes').textContent = fmt(progress.bytes);
    $('progress-detail').textContent = progress.currentPath || state.rootName;
    state.scanErrors = progress.errors || state.scanErrors;
  }
}
function setProgress(title, detail = '') {
  $('progress').classList.remove('hidden');
  $('progress-title').textContent = title;
  $('progress-detail').textContent = detail;
  $('progress-fill').style.width = '38%';
}

const nativeUnsubscribers = [];
if (window.spaceAPI) {
  nativeUnsubscribers.push(window.spaceAPI.onBatch(payload => {
    if (payload.taskId !== state.taskId || !state.scanning) return;
    for (const record of payload.records || []) addRecord(record);
    updateLiveStats();
    scheduleLivePaint();
  }));
  nativeUnsubscribers.push(window.spaceAPI.onProgress(payload => {
    if (payload.taskId !== state.taskId || !state.scanning) return;
    updateLiveStats(payload);
  }));
  nativeUnsubscribers.push(window.spaceAPI.onDone(payload => {
    if (payload.taskId !== state.taskId) return;
    state.scanMs = payload.elapsedMs || performance.now() - state.started;
    state.scanErrors = payload.errors || 0;
    state.scanning = false; state.paused = false;
    $('progress').classList.add('hidden');
    if (payload.cancelled) {
      $('scan-state').textContent = '扫描已取消';
      toast('扫描已取消，已读取的数据仍可查看');
    } else {
      $('scan-state').textContent = '扫描完成';
      toast(`扫描完成：${state.files.length.toLocaleString()} 个文件${state.scanErrors ? `，跳过 ${state.scanErrors} 项` : ''}`);
    }
    $('scan-path').textContent = state.rootName;
    finalizeScan();
  }));
  nativeUnsubscribers.push(window.spaceAPI.onError(payload => {
    if (payload.taskId !== state.taskId) return;
    state.scanning = false; state.paused = false;
    $('progress').classList.add('hidden');
    $('scan-state').textContent = '扫描失败';
    toast(payload.message || '扫描失败');
    finalizeScan();
  }));
}

async function startScan(source) {
  if (state.scanning) {
    toast('请先取消当前扫描');
    return;
  }
  state.root = null; state.rootName = source.name; state.nodes = []; state.files = []; state.dirs = [];
  state.nodeByPath = new Map(); state.current = null; state.selected = null;
  state.scanning = true; state.paused = false; state.cancelled = false;
  state.started = performance.now(); state.scanErrors = 0; state.sourceKind = source.kind;
  state.taskId = (globalThis.crypto?.randomUUID?.() || `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const rootId = source.kind === 'native' ? source.path : source.name;
  initRoot(rootId, source.name);
  $('scan-state').textContent = '正在扫描'; $('scan-path').textContent = source.name;
  showView('overview');
  setProgress('正在扫描磁盘…', source.name);
  $('progress-files').textContent = '0 个文件'; $('progress-folders').textContent = '0 个文件夹'; $('progress-bytes').textContent = '0 B'; $('progress-errors').textContent = '0 个跳过';
  $('pause-btn').textContent = '暂停';
  try {
    if (source.kind === 'native') {
      await window.spaceAPI.startScan({ taskId: state.taskId, root: source.path, concurrency: 4, batchSize: 450 });
    } else if (source.kind === 'handle') {
      await scanDirectoryHandle(source.handle);
      if (state.scanning) completeBrowserScan();
    } else if (source.kind === 'filelist') {
      await scanInputFileList(source.fileList);
      if (state.scanning) completeBrowserScan();
    }
  } catch (error) {
    state.scanning = false;
    $('progress').classList.add('hidden');
    $('scan-state').textContent = '扫描失败';
    toast(error.message || '扫描失败');
    finalizeScan();
  }
}
async function browserPauseWait() {
  while (state.paused && state.scanning && !state.cancelled) await new Promise(resolve => setTimeout(resolve, 100));
}
async function scanDirectoryHandle(rootHandle) {
  const queue = [{ handle: rootHandle, path: rootHandle.name, node: state.root }];
  let visited = 0;
  while (queue.length && state.scanning && !state.cancelled) {
    const current = queue.shift();
    await browserPauseWait();
    for await (const [name, handle] of current.handle.entries()) {
      await browserPauseWait();
      if (!state.scanning || state.cancelled) break;
      const path = `${current.path}/${name}`;
      if (handle.kind === 'directory') {
        const node = addRecord({ path, parentPath: current.path, name, type: 'dir', size: 0, mtime: 0 });
        queue.push({ handle, path, node });
      } else {
        try {
          const file = await handle.getFile();
          addRecord({ path, parentPath: current.path, name, type: 'file', size: file.size, mtime: file.lastModified });
        } catch { state.scanErrors += 1; }
      }
      visited += 1;
      if (visited % 150 === 0) {
        $('progress-detail').textContent = path;
        updateLiveStats({ files: state.files.length, folders: Math.max(0, state.dirs.length - 1), bytes: state.root.size, errors: state.scanErrors, currentPath: path });
        scheduleLivePaint();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
}
async function scanInputFileList(fileList) {
  const files = [...fileList].sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
  let visited = 0;
  for (const file of files) {
    await browserPauseWait();
    if (state.cancelled || !state.scanning) break;
    const parts = file.webkitRelativePath.split('/').slice(1);
    let parent = state.root;
    let path = state.root.id;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const isFile = index === parts.length - 1;
      path = `${path}/${name}`;
      if (isFile) {
        addRecord({ path, parentPath: parent.path, name, type: 'file', size: file.size, mtime: file.lastModified });
      } else {
        let node = state.nodeByPath.get(path);
        if (!node) node = addRecord({ path, parentPath: parent.path, name, type: 'dir', size: 0, mtime: 0 });
        parent = node;
      }
    }
    visited += 1;
    if (visited % 500 === 0) {
      updateLiveStats({ files: state.files.length, folders: Math.max(0, state.dirs.length - 1), bytes: state.root.size, errors: 0, currentPath: file.webkitRelativePath });
      scheduleLivePaint();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
function completeBrowserScan() {
  state.scanMs = performance.now() - state.started;
  state.scanning = false; state.paused = false;
  $('progress').classList.add('hidden');
  $('scan-state').textContent = state.cancelled ? '扫描已取消' : '扫描完成';
  $('scan-path').textContent = state.rootName;
  toast(state.cancelled ? '扫描已取消' : `扫描完成：${state.files.length.toLocaleString()} 个文件`);
  finalizeScan();
}
$('cancel-btn').onclick = async () => {
  if (!state.scanning) return;
  state.cancelled = true;
  if (window.spaceAPI && state.sourceKind === 'native') {
    await window.spaceAPI.controlScan(state.taskId, 'cancel');
    $('progress-title').textContent = '正在停止扫描…';
  } else {
    state.scanning = false;
    completeBrowserScan();
  }
};
$('pause-btn').onclick = async () => {
  if (!state.scanning) return;
  state.paused = !state.paused;
  $('pause-btn').textContent = state.paused ? '继续' : '暂停';
  $('progress-title').textContent = state.paused ? '扫描已暂停' : '正在扫描磁盘…';
  if (state.sourceKind === 'native') await window.spaceAPI.controlScan(state.taskId, state.paused ? 'pause' : 'resume');
};

function finalizeScan() {
  if (!state.root) return;
  state.current = null;
  updateLiveStats();
  renderDashboard();
  if (!$('treemap-view').classList.contains('hidden')) renderMap(false);
  if (!$('files-view').classList.contains('hidden')) renderFiles();
}
let paintScheduled = false;
function scheduleLivePaint() {
  const now = performance.now();
  if (now - state.lastPaint < 900 || paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false; state.lastPaint = performance.now();
    if (!$('dashboard').classList.contains('hidden')) drawFluidMap($('mini-map'), state.root, 1, true);
    if (!$('treemap-view').classList.contains('hidden')) renderMap(false);
  });
}

function typeStats() {
  const result = Object.create(null);
  for (const file of state.files) {
    const extension = `.${extOf(file.name)}`;
    if (!result[extension]) result[extension] = { size: 0, count: 0 };
    result[extension].size += file.size; result[extension].count += 1;
  }
  return result;
}
function renderDashboard() {
  $('welcome').classList.add('hidden'); $('dashboard').classList.remove('hidden');
  $('total-size').textContent = fmt(state.root.size); $('root-label').textContent = state.rootName;
  $('total-files').textContent = `${state.files.length.toLocaleString()} 个文件`;
  $('total-dirs').textContent = `${Math.max(0, state.dirs.length - 1).toLocaleString()} 个文件夹`;
  const largest = state.files.reduce((best, file) => !best || file.size > best.size ? file : best, null);
  $('largest-file').textContent = largest ? fmt(largest.size) : '—'; $('largest-name').textContent = largest ? largest.name : '没有文件';
  const types = typeStats(); $('type-count').textContent = Object.keys(types).length;
  $('scan-time').textContent = `${(state.scanMs / 1000).toFixed(1)}s`;
  $('map-root-name').textContent = state.rootName;
  $('folder-ranking').innerHTML = [...state.dirs].filter(node => node !== state.root).sort((a, b) => b.size - a.size).slice(0, 5).map((node, index) =>
    `<div class="ranking-row"><span class="rank-num">0${index + 1}</span><div class="rank-info"><b>${esc(node.name)}</b><div class="rank-track"><i style="width:${state.root.size ? 100 * node.size / state.root.size : 0}%"></i></div></div><span class="rank-size">${fmt(node.size)}</span></div>`
  ).join('') || '<div class="empty">暂无文件夹数据</div>';
  $('type-ranking').innerHTML = Object.entries(types).sort((a, b) => b[1].size - a[1].size).slice(0, 6).map(([extension, value]) =>
    `<div class="type-row"><span>${esc(extension)}</span><span>${fmt(value.size)}</span></div>`
  ).join('') || '<div class="empty">暂无文件类型数据</div>';
  drawFluidMap($('mini-map'), state.root, 1, true);
}

// Fluid Treemap: recursively clipped power-diagram cells. Each generation partitions
// its parent polygon, so hierarchy is retained and cells share continuous boundaries.
function displayChildren(parent) {
  const children = parent.children.slice().sort((a, b) => b.size - a.size);
  if (children.length <= 18) return children;
  const visible = children.slice(0, 17);
  const rest = children.slice(17);
  visible.push({
    id: `${parent.id}::other`, path: parent.path, name: `其他 ${rest.length} 项`, type: 'aggregate',
    size: rest.reduce((sum, node) => sum + node.size, 0), count: rest.reduce((sum, node) => sum + (node.type === 'file' ? 1 : node.count), 0),
    children: rest, parent, depth: parent.depth + 1
  });
  return visible;
}
function roundedPolygonPath(context, polygon, radius = 9) {
  if (polygon.length < 3) return;
  const corners = polygon.map((point, index) => {
    const prev = polygon[(index + polygon.length - 1) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    const prevLength = Math.hypot(prev.x - point.x, prev.y - point.y);
    const nextLength = Math.hypot(next.x - point.x, next.y - point.y);
    const r = Math.min(radius, prevLength * .22, nextLength * .22);
    const before = { x: point.x + (prev.x - point.x) / (prevLength || 1) * r, y: point.y + (prev.y - point.y) / (prevLength || 1) * r };
    const after = { x: point.x + (next.x - point.x) / (nextLength || 1) * r, y: point.y + (next.y - point.y) / (nextLength || 1) * r };
    return { before, after, point };
  });
  context.beginPath();
  context.moveTo(corners[0].before.x, corners[0].before.y);
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index];
    context.quadraticCurveTo(corner.point.x, corner.point.y, corner.after.x, corner.after.y);
    const next = corners[(index + 1) % corners.length];
    const edgeA = corner.point, edgeB = next.point;
    const forward = edgeA.x < edgeB.x || (Math.abs(edgeA.x - edgeB.x) < 0.001 && edgeA.y <= edgeB.y);
    const first = forward ? edgeA : edgeB;
    const second = forward ? edgeB : edgeA;
    const dx = second.x - first.x, dy = second.y - first.y;
    const edgeLength = Math.hypot(dx, dy) || 1;
    const edgeKey = [first.x, first.y, second.x, second.y].map(value => value.toFixed(2)).join(':');
    const wave = ((hashString(edgeKey) % 1001) / 1000 - .5) * .07 * edgeLength;
    const control = { x: (first.x + second.x) / 2 - dy / edgeLength * wave, y: (first.y + second.y) / 2 + dx / edgeLength * wave };
    context.quadraticCurveTo(control.x, control.y, next.before.x, next.before.y);
  }
  context.closePath();
}
function cellColor(node, depth) {
  if (node.type === 'file' || node.type === 'aggregate') return FILE_PALETTE[hashString(node.id) % FILE_PALETTE.length];
  const palette = DARK_PALETTE;
  return palette[(hashString(node.id) + depth * 2) % palette.length];
}
function drawCell(context, node, polygon, depth, selected) {
  const area = polygonArea(polygon);
  if (area < 5) return;
  const fill = cellColor(node, depth);
  roundedPolygonPath(context, polygon, Math.max(4, Math.min(13, Math.sqrt(area) * .075)));
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = selected ? 2.6 : 1.5;
  context.strokeStyle = selected ? '#D8E0D4' : '#202923';
  context.stroke();
  if (selected) {
    roundedPolygonPath(context, polygon, 10);
    context.strokeStyle = 'rgba(225,235,220,.3)'; context.lineWidth = 5; context.stroke();
  }
}
function drawCenteredLabel(context, node, polygon, isMini) {
  const area = polygonArea(polygon);
  if (area < (isMini ? 3200 : 4200)) return;
  const center = polygonCentroid(polygon);
  const box = polygon.reduce((result, point) => ({ minX: Math.min(result.minX, point.x), maxX: Math.max(result.maxX, point.x), minY: Math.min(result.minY, point.y), maxY: Math.max(result.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (width < 52 || height < 34) return;
  const fontSize = Math.max(9, Math.min(isMini ? 11 : 15, width / Math.max(5, node.name.length * .72)));
  context.save();
  roundedPolygonPath(context, polygon, 7);
  context.clip();
  context.beginPath();
  context.rect(box.minX + 4, box.minY + 3, Math.max(0, width - 8), Math.max(0, height - 6));
  context.clip();
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0,0,0,.2)'; context.shadowBlur = 7;
  context.fillStyle = '#F0F0E9'; context.font = `600 ${fontSize}px "Microsoft YaHei", "微软雅黑", sans-serif`;
  context.fillText(node.name, center.x, center.y - (height > 52 ? 7 : 0), Math.max(20, width - 18));
  if (!isMini && height > 52 && width > 70) {
    context.shadowBlur = 0; context.fillStyle = 'rgba(241,242,233,.72)'; context.font = `10px "DM Mono", monospace`;
    context.fillText(fmt(node.size), center.x, center.y + 11, width - 18);
  }
  context.restore();
}
function drawFluidMap(canvas, parent, maxDepth = 2, isMini = false, animate = false) {
  if (!canvas || !parent) return;
  let previousFrame = null;
  if (animate && canvas.__renderedOnce && canvas.width > 0 && canvas.height > 0) {
    previousFrame = document.createElement('canvas');
    previousFrame.width = canvas.width; previousFrame.height = canvas.height;
    previousFrame.getContext('2d').drawImage(canvas, 0, 0);
  }
  const width = Math.max(1, canvas.clientWidth || (isMini ? 800 : 1000));
  const height = Math.max(1, canvas.clientHeight || (isMini ? 170 : 500));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#252D29'; context.fillRect(0, 0, width, height);
  const padding = isMini ? 5 : 9;
  const boundary = [
    { x: padding, y: padding }, { x: width - padding, y: padding },
    { x: width - padding, y: height - padding }, { x: padding, y: height - padding }
  ];
  const hitRegions = [];
  const render = (node, polygon, depth) => {
    const items = displayChildren(node);
    if (!items.length) {
      drawCell(context, node, polygon, depth, state.selected?.id === node.id);
      drawCenteredLabel(context, node, polygon, isMini);
      hitRegions.push({ node, polygon, depth });
      return;
    }
    const cells = layoutPowerCells(polygon, items, node.id);
    items.forEach((child, index) => {
      const cell = cells[index];
      if (!cell || cell.length < 3 || polygonArea(cell) < 6) return;
      const area = polygonArea(cell);
      const canNest = child.type === 'dir' && child.children.length > 0 && depth < maxDepth && area > polygonArea(polygon) * .055;
      if (canNest) {
        drawCell(context, child, cell, depth, state.selected?.id === child.id);
        hitRegions.push({ node: child, polygon: cell, depth });
        render(child, cell, depth + 1);
      } else {
        drawCell(context, child, cell, depth, state.selected?.id === child.id);
        drawCenteredLabel(context, child, cell, isMini);
        hitRegions.push({ node: child, polygon: cell, depth });
      }
    });
  };
  render(parent, boundary, 0);
  canvas.__hitRegions = hitRegions;
  canvas.__mapParent = parent;
  canvas.__mapSize = { width, height };
  if (previousFrame) {
    const nextFrame = document.createElement('canvas');
    nextFrame.width = canvas.width; nextFrame.height = canvas.height;
    nextFrame.getContext('2d').drawImage(canvas, 0, 0);
    if (canvas.__transitionRAF) cancelAnimationFrame(canvas.__transitionRAF);
    const startedAt = performance.now();
    const animateFrame = now => {
      const raw = Math.min(1, (now - startedAt) / 240);
      const eased = 1 - Math.pow(1 - raw, 3);
      const frameContext = canvas.getContext('2d');
      frameContext.setTransform(1, 0, 0, 1, 0, 0);
      frameContext.clearRect(0, 0, canvas.width, canvas.height);
      frameContext.globalAlpha = 1 - eased;
      frameContext.drawImage(previousFrame, 0, 0, canvas.width, canvas.height);
      frameContext.save();
      frameContext.globalAlpha = eased;
      const scale = .985 + .015 * eased;
      frameContext.translate(canvas.width * (1 - scale) / 2, canvas.height * (1 - scale) / 2);
      frameContext.scale(scale, scale);
      frameContext.drawImage(nextFrame, 0, 0, canvas.width, canvas.height);
      frameContext.restore();
      frameContext.globalAlpha = 1;
      if (raw < 1) canvas.__transitionRAF = requestAnimationFrame(animateFrame);
      else canvas.__transitionRAF = null;
    };
    canvas.__transitionRAF = requestAnimationFrame(animateFrame);
  }
  canvas.__renderedOnce = true;
}

function selectMapNode(node) {
  state.selected = node;
  $('selected-name').textContent = node.name;
  $('selected-path').textContent = node.path;
  $('selected-size').textContent = fmt(node.size);
  $('map-inspector').classList.add('has-selection');
  if (!$('treemap-view').classList.contains('hidden')) renderMap(false);
  else if (state.root) drawFluidMap($('mini-map'), state.root, 1, true);
}
function mapPoint(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}
function installCanvasEvents(canvas, allowNavigation = true, isMini = false) {
  canvas.addEventListener('mousemove', event => {
    const point = mapPoint(canvas, event);
    const hits = (canvas.__hitRegions || []).filter(hit => pointInPolygon(point, hit.polygon)).sort((a, b) => b.depth - a.depth);
    const hit = hits[0];
    canvas.style.cursor = hit ? ((hit.node.type === 'dir' || hit.node.type === 'aggregate') && hit.node.children?.length ? 'zoom-in' : 'pointer') : 'default';
    canvas.title = hit ? `${hit.node.name}\n${fmt(hit.node.size)}\n${hit.node.path}` : '';
  });
  canvas.addEventListener('click', event => {
    const point = mapPoint(canvas, event);
    const hits = (canvas.__hitRegions || []).filter(hit => pointInPolygon(point, hit.polygon)).sort((a, b) => b.depth - a.depth);
    if (hits[0]) selectMapNode(hits[0].node);
  });
  if (allowNavigation) canvas.addEventListener('dblclick', event => {
    const point = mapPoint(canvas, event);
    const hits = (canvas.__hitRegions || []).filter(hit => pointInPolygon(point, hit.polygon)).sort((a, b) => b.depth - a.depth);
    const node = hits[0]?.node;
    if (node && (node.type === 'dir' || node.type === 'aggregate') && node.children?.length) { state.current = node; state.selected = node; if (isMini) showView('treemap'); else renderMap(); }
  });
  if (allowNavigation) canvas.addEventListener('wheel', event => {
    event.preventDefault();
    state.mapDepth = Math.max(1, Math.min(4, state.mapDepth + (event.deltaY < 0 ? 1 : -1)));
    $('zoom-label').textContent = `层级 ${state.mapDepth}`;
    renderMap();
  }, { passive: false });
}
installCanvasEvents($('main-map'));
installCanvasEvents($('mini-map'), true, true);

function renderMap(animate = true) {
  if (!state.root) return;
  const parent = state.current || state.root;
  $('map-size').textContent = fmt(parent.size);
  $('breadcrumbs').innerHTML = '';
  const chain = [];
  for (let node = parent; node; node = node.parent) chain.unshift(node);
  chain.forEach((node, index) => {
    const button = document.createElement('button'); button.textContent = node.name;
    button.onclick = () => { state.current = node === state.root ? null : node; renderMap(); };
    $('breadcrumbs').appendChild(button);
    if (index < chain.length - 1) $('breadcrumbs').append(' / ');
  });
  $('up-btn').disabled = parent === state.root;
  $('zoom-label').textContent = `层级 ${state.mapDepth}`;
  drawFluidMap($('main-map'), parent, state.mapDepth, false, animate);
}
$('up-btn').onclick = () => {
  if (!state.current) return;
  state.current = state.current.parent === state.root ? null : state.current.parent;
  renderMap();
};
$('map-reset').onclick = () => { state.current = null; state.selected = null; renderMap(); };
$('zoom-in').onclick = () => { state.mapDepth = Math.min(4, state.mapDepth + 1); renderMap(); };
$('zoom-out').onclick = () => { state.mapDepth = Math.max(1, state.mapDepth - 1); renderMap(); };

function renderFiles() {
  if (!state.root) return;
  const query = $('file-search').value.toLowerCase();
  const kind = $('file-kind').value; const sort = $('file-sort').value;
  const rows = state.nodes.filter(node => node !== state.root && (kind === 'all' || node.type === kind) && (!query || node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)));
  rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'date' ? b.mtime - a.mtime : sort === 'type' ? extOf(a.name).localeCompare(extOf(b.name)) : b.size - a.size);
  $('file-rows').innerHTML = rows.slice(0, 1000).map(node =>
    `<div class="file-row"><span class="file-name"><span class="kind-icon">${node.type === 'dir' ? '▰' : '▤'}</span><b title="${esc(node.path)}">${esc(node.name)}</b></span><span class="file-type">${node.type === 'dir' ? '文件夹' : '.' + extOf(node.name)}</span><span class="file-date">${node.mtime ? new Date(node.mtime).toLocaleDateString() : '—'}</span><span class="file-size">${fmt(node.size)}</span></div>`
  ).join('') || '<div class="empty">没有匹配的项目</div>';
  $('file-count').textContent = `显示 ${Math.min(rows.length, 1000).toLocaleString()} / ${rows.length.toLocaleString()} 个项目`;
}
['file-search', 'file-sort', 'file-kind'].forEach(id => $(id).addEventListener(id === 'file-search' ? 'input' : 'change', renderFiles));
function renderTypes() {
  const rows = Object.entries(typeStats()).sort((a, b) => b[1].size - a[1].size);
  const max = rows[0]?.[1].size || 1;
  $('type-bars').innerHTML = rows.slice(0, 80).map(([extension, value], index) =>
    `<div class="type-bar-row"><span>${esc(extension)}</span><div class="type-track"><i style="width:${value.size / max * 100}%;background:${DARK_PALETTE[index % DARK_PALETTE.length]}"></i></div><span class="type-size">${fmt(value.size)} · ${value.count}</span></div>`
  ).join('') || '<div class="empty">暂无类型数据</div>';
}
$('export-btn').onclick = () => {
  if (!state.root) return toast('请先完成一次扫描');
  const rows = [['类型', '名称', '路径', '大小（字节）', '修改时间'], ...state.nodes.map(node => [node.type, node.name, node.path, node.size, node.mtime ? new Date(node.mtime).toISOString() : ''])];
  const csv = '\ufeff' + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'space-analyzer-report.csv'; link.click(); URL.revokeObjectURL(link.href); toast('CSV 报告已导出');
};
const resizeObserver = new ResizeObserver(() => {
  if (!state.root) return;
  if (!$('dashboard').classList.contains('hidden')) drawFluidMap($('mini-map'), state.root, 1, true);
  if (!$('treemap-view').classList.contains('hidden')) renderMap(false);
});
resizeObserver.observe($('mini-map')); resizeObserver.observe($('main-map'));
$('map-root-name').textContent = '流体式空间地图';
