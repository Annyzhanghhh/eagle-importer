// Eagle 素材导入助手 - Popup 逻辑
let currentTab = null;
let images = [];
// 页面信息（标题用于生成 Eagle 名称 / 标签）
let pageMeta = { title: '', url: '' };

const $ = (id) => document.getElementById(id);

// 当前页面的来源，用作抓图时的 Referer（破解防盗链）
function pageReferer() {
  try {
    return currentTab && currentTab.url ? currentTab.url.split('#')[0] : undefined;
  } catch (e) {
    return undefined;
  }
}

function send(type, extra, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: 'timeout' });
      }
    }, timeoutMs || 20000);
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        resolve(res || { ok: false, error: (err && err.message) || 'no-response' });
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: e.message });
      }
    }
  });
}

// 带超时的 content script 消息（避免个别图片卡住队列）
function sendTabWithTimeout(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: 'timeout' });
      }
    }, timeoutMs || 20000);
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        resolve(res || { ok: false, error: (err && err.message) || 'no-response' });
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: e.message });
      }
    }
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function fileName(url) {
  try {
    const seg = new URL(url).pathname.split('/').pop();
    return seg && seg.includes('.') ? seg : 'image';
  } catch {
    return 'image';
  }
}

function showMsg(text, isErr) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg show' + (isErr ? ' err' : '');
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  await checkConnection();
  await loadFolders();
  await loadImages();
  restoreHoverToggle();
  bindEvents();
  bindClipboardEvents();
  tryAutoClipboard();
}

function checkConnection() {
  return send('CHECK').then((res) => {
    const s = $('status');
    if (res && res.ok) {
      s.textContent = '已连接 Eagle';
      s.className = 'status ok';
    } else {
      s.textContent = '未连接 Eagle';
      s.className = 'status err';
    }
  });
}

function loadFolders() {
  return send('GET_FOLDERS').then((res) => {
    const sel = $('folderSelect');
    sel.innerHTML = '<option value="">（库根目录）</option>';
    if (res && res.ok) {
      flattenFolders(res.folders, 0).forEach((f) => {
        const o = document.createElement('option');
        o.value = f.id;
        o.textContent = '　'.repeat(f.depth) + (f.depth ? '└ ' : '') + f.name;
        sel.appendChild(o);
      });
      chrome.storage.local.get(['lastFolderId'], ({ lastFolderId }) => {
        if (lastFolderId) sel.value = lastFolderId;
      });
    } else {
      showMsg('获取文件夹失败：' + (res && res.error), true);
    }
  });
}

function flattenFolders(folders, depth, out) {
  out = out || [];
  folders.forEach((f) => {
    out.push({ id: f.id, name: f.name, depth });
    if (f.children && f.children.length) flattenFolders(f.children, depth + 1, out);
  });
  return out;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  if (/^(chrome|edge|about|chrome-extension|moz-extension|devtools|view-source):/i.test(url)) {
    return true;
  }
  if (/^https?:\/\/chromewebstore\.google\.com/i.test(url)) return true;
  if (/^https?:\/\/chrome\.google\.com\/webstore/i.test(url)) return true;
  return false;
}

// 独立扫描函数：会被序列化注入页面执行，不能依赖外部变量
function scanPageImages() {
  const normalize = (u) => {
    if (!u) return null;
    try {
      if (u.startsWith('data:') || u.startsWith('blob:')) return u;
      return new URL(u, location.href).href;
    } catch (e) {
      return null;
    }
  };
  const fname = (url) => {
    try {
      const seg = new URL(url).pathname.split('/').pop();
      return seg && seg.includes('.') ? seg : 'image';
    } catch (e) {
      return 'image';
    }
  };
  const seen = new Set();
  const list = [];
  document.querySelectorAll('img').forEach((img) => {
    const url = normalize(img.currentSrc || img.src);
    if (!url) return;
    if (img.naturalWidth && img.naturalWidth < 24) return;
    if (seen.has(url)) return;
    seen.add(url);
    list.push({
      url,
      name: fname(url),
      w: img.naturalWidth || img.width || 0,
      h: img.naturalHeight || img.height || 0,
    });
  });
  try {
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && m[1].startsWith('http')) {
        const url = normalize(m[1]);
        if (url && !seen.has(url) && el.offsetWidth > 40 && el.offsetHeight > 40) {
          seen.add(url);
          list.push({ url, name: fname(url), w: el.offsetWidth, h: el.offsetHeight });
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
  return list;
}

function loadImages() {
  if (!currentTab || !currentTab.id) return;
  return chrome.tabs
    .sendMessage(currentTab.id, { type: 'GET_IMAGES' })
    .then((res) => {
      images = (res && res.images) || [];
      if (res && res.page) pageMeta = res.page;
      renderGrid();
    })
    .catch(async () => {
      // content script 不可用（页面早于扩展打开 / 重载后失效）：直接注入扫描函数
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          func: scanPageImages,
        });
        const result = out && out[0] && out[0].result;
        images = Array.isArray(result) ? result : [];
        pageMeta = { title: currentTab.title || '', url: currentTab.url || '' };
        // 尽量补注入 content.js，恢复页面抓图与悬停工具条（已存在时会被守卫跳过）
        try {
          await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            files: ['content.js'],
          });
        } catch (e) {
          /* 忽略 */
        }
        renderGrid();
      } catch (e) {
        if (isRestrictedUrl(currentTab.url)) {
          showMsg(
            '当前页面不支持读取（浏览器新标签页、扩展页、应用商店等），请在普通网页上使用。',
            true
          );
        } else {
          showMsg('无法读取页面图片，请刷新页面后重试：' + e.message, true);
        }
        images = [];
        renderGrid();
      }
    });
}

// 缩略图并发队列（避免一次请求过多）
let thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 6;

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  thumbQueue = [];
  thumbActive = 0;
  if (!images.length) {
    grid.innerHTML =
      '<div class="empty">未检测到图片素材<br/><span style="font-size:11px">' +
      '画布类设计工具（即时设计 / Figma）请先在画布上复制 PNG，' +
      '再用上方按钮或下方粘贴区导入</span></div>';
    updateCounter();
    return;
  }
  images.forEach((img, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const name = img.name || fileName(img.url);
    const size = img.w ? `${img.w}×${img.h}` : '';
    card.innerHTML = `
      <label class="check"><input type="checkbox" data-i="${i}"></label>
      <div class="thumb-wrap"><img class="thumb" alt="" /></div>
      <div class="meta">${escapeHtml(name)} ${size}</div>`;
    grid.appendChild(card);
    enqueueThumb(card.querySelector('.thumb'), img.url);
  });
  grid.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', updateCounter);
  });
  updateCounter();
}

function enqueueThumb(imgEl, url) {
  thumbQueue.push({ imgEl, url });
  pumpThumb();
}

function pumpThumb() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    loadThumb(job.imgEl, job.url).finally(() => {
      thumbActive--;
      pumpThumb();
    });
  }
}

async function loadThumb(imgEl, url) {
  let src = null;
  try {
    if (/^data:/i.test(url)) {
      src = url;
    } else if (/^blob:/i.test(url)) {
      const r = await chrome.tabs.sendMessage(currentTab.id, {
        type: 'THUMB_BLOB',
        url,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'blob thumb failed');
      src = r.dataUrl;
    } else {
      // 先在页面上下文抓（自动带正确 Referer）；失败再走后台 DNR 兜底
      try {
        const pr = await sendTabWithTimeout(currentTab.id, { type: 'THUMB_PAGE', url }, 20000);
        if (!pr || !pr.ok) throw new Error((pr && pr.error) || 'page thumb failed');
        src = pr.dataUrl;
      } catch (e) {
        const r = await send('THUMB', { url, referer: pageReferer() });
        if (!r || !r.ok) throw new Error((r && r.error) || 'thumb failed');
        src = r.dataUrl;
      }
    }
  } catch (e) {
    // 后台抓取失败时回退为直接加载原图（未加载完成前保持透明，不会出现裂图）
    src = url;
  }
  setThumb(imgEl, src);
}

function setThumb(imgEl, src) {
  if (!src) {
    imgEl.classList.add('failed');
    return;
  }
  imgEl.addEventListener('load', () => imgEl.classList.add('loaded'), { once: true });
  imgEl.addEventListener('error', () => imgEl.classList.add('failed'), { once: true });
  imgEl.src = src;
}

// 把图片解析成可交给 Eagle 的地址：blob/http 先在页面上下文转 base64，其余交给后台
async function resolveImportUrl(img) {
  const url = img.url;
  if (/^blob:/i.test(url)) {
    const r = await sendTabWithTimeout(currentTab.id, { type: 'BLOB_DATA', url }, 30000);
    if (!r || !r.ok) throw new Error('blob 图片转换失败：' + ((r && r.error) || ''));
    return r.dataUrl;
  }
  if (/^https?:/i.test(url)) {
    const r = await sendTabWithTimeout(currentTab.id, { type: 'DATA_PAGE', url }, 45000);
    if (r && r.ok && r.dataUrl) return r.dataUrl;
  }
  return url;
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const pos = idx++;
      out[pos] = await fn(list[pos], pos);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function updateCounter() {
  const n = $('grid').querySelectorAll('input:checked').length;
  $('counter').textContent = n + ' 张';
}

function restoreHoverToggle() {
  chrome.storage.local.get(['hoverEnabled'], ({ hoverEnabled }) => {
    $('hoverToggle').checked = hoverEnabled !== false;
  });
}

// ---------- 剪贴板图片导入（画布类设计工具无法从 DOM 抽图，只能走它自己的「复制 PNG」）----------
let clipImage = null;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取图片数据失败'));
    r.readAsDataURL(blob);
  });
}

function imageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}

// 读取剪贴板里的第一张图片；没有图片返回 null
async function readClipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error('当前浏览器不支持读取剪贴板');
  }
  const entries = await navigator.clipboard.read();
  for (const entry of entries) {
    const type = (entry.types || []).find((t) => /^image\//i.test(t));
    if (!type) continue;
    const blob = await entry.getType(type);
    const dataUrl = await blobToDataUrl(blob);
    const dim = await imageSize(dataUrl);
    return { dataUrl, type, w: dim.w, h: dim.h, size: blob.size };
  }
  return null;
}

function clipKey(item) {
  const u = item.dataUrl || '';
  return u.length + ':' + u.slice(-64);
}

function clipName() {
  const raw =
    (pageMeta && pageMeta.title) || (currentTab && currentTab.title) || '';
  const t = String(raw).replace(/\s+/g, ' ').trim();
  if (!t || /^(即时设计|Figma|js\.design|设计协作)/i.test(t)) return '剪贴板图片';
  return t.slice(0, 60);
}

function showClipBar(item) {
  clipImage = item;
  const bar = $('clipBar');
  if (!item) {
    bar.hidden = true;
    return;
  }
  $('clipThumb').src = item.dataUrl;
  $('clipTitle').textContent = clipName();
  const kb = item.size ? (item.size / 1024).toFixed(0) + ' KB · ' : '';
  const dim = item.w ? item.w + '×' + item.h + ' · ' : '';
  $('clipMeta').textContent = kb + dim + String(item.type).replace('image/', '').toUpperCase();
  bar.hidden = false;
}

function selectedFolder() {
  const sel = $('folderSelect');
  return {
    id: sel.value || undefined,
    name: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text.trim() : '',
  };
}

async function importClipboard() {
  if (!clipImage) {
    showMsg('剪贴板里没有图片，请先在设计工具里复制', true);
    return false;
  }
  const folder = selectedFolder();
  showMsg('正在导入剪贴板图片…');
  const res = await send(
    'IMPORT_IMAGES',
    {
      items: [{ url: clipImage.dataUrl, name: clipName() }],
      folderId: folder.id,
      referer: pageReferer(),
      pageTitle: (pageMeta && pageMeta.title) || (currentTab && currentTab.title) || '',
    },
    180000
  );
  if (res && res.ok) {
    const d = res.data || {};
    if (!d.imported) {
      showMsg('导入失败：Eagle 没有真正入库', true);
      return false;
    }
    showMsg('已导入 Eagle' + (folder.name && folder.id ? '（' + folder.name + '）' : ''));
    chrome.storage.local.set({ lastFolderId: folder.id });
    return true;
  }
  showMsg('剪贴板导入失败：' + ((res && res.error) || '未知错误'), true);
  return false;
}

// 兜底 1：扩展页面用 execCommand('paste') 读剪贴板（有 clipboardRead 权限时可用，不需要手势）
async function execPasteImage() {
  const sink = $('pasteSink');
  if (!sink) return null;
  sink.innerHTML = '';
  try {
    sink.focus();
  } catch (e) {
    /* ignore */
  }
  let ok = false;
  try {
    ok = document.execCommand('paste');
  } catch (e) {
    ok = false;
  }
  if (!ok) return null;
  const img = sink.querySelector('img');
  if (!img || !img.src) return null;
  const src = img.src;
  sink.innerHTML = '';
  return await srcToClipItem(src);
}

async function srcToClipItem(src) {
  let dataUrl = src;
  let size = 0;
  let type = '';
  if (/^data:/i.test(src)) {
    type = src.slice(5, src.indexOf(';'));
    size = Math.round((src.length * 3) / 4);
  } else {
    const blob = await (await fetch(src)).blob();
    dataUrl = await blobToDataUrl(blob);
    size = blob.size;
    type = blob.type;
  }
  const dim = await imageSize(dataUrl);
  return { dataUrl, type: type || 'image/png', w: dim.w, h: dim.h, size };
}

// 兜底 2：用户手动 ⌘V 到粘贴区（任何情况下都可用）
async function handlePastedBlob(blob) {
  const dataUrl = await blobToDataUrl(blob);
  const dim = await imageSize(dataUrl);
  const item = {
    dataUrl,
    type: blob.type || 'image/png',
    w: dim.w,
    h: dim.h,
    size: blob.size,
  };
  showClipBar(item);
  $('pasteZone').hidden = true;
  await chrome.storage.local.set({ lastClipKey: clipKey(item) });
  await importClipboard();
}

// 画布类设计工具的「复制成图片」藏在右键子菜单里，普通 ⌘C 复制的不是图片
function copyHint() {
  let host = '';
  try {
    host = new URL((currentTab && currentTab.url) || '').hostname;
  } catch (e) {
    host = '';
  }
  if (/js\.design$|figma\.com$|mastergo\.com$|pixso\.cn$/i.test(host)) {
    return '先在画布上右键 → 更多 → 复制/粘贴 → 复制 PNG 图片，再回到这里按 ⌘V';
  }
  return '请在下方区域按 ⌘V 粘贴，粘贴后会自动导入 Eagle';
}

function showPasteFallback(reason) {
  $('pasteZone').hidden = false;
  showMsg((reason ? reason + '；' : '') + copyHint(), false);
  try {
    $('pasteSink').focus();
  } catch (e) {
    /* ignore */
  }
}

// 打开面板时尝试一次：有图就直接导入（可通过开关关闭）
async function tryAutoClipboard() {
  const { clipAuto } = await chrome.storage.local.get(['clipAuto']);
  if (clipAuto !== true) return; // 默认关闭：只有用户显式开启后才在打开面板时自动导入

  let item = null;
  let readOk = false;
  let reason = '';
  try {
    item = await readClipboardImage();
    readOk = true;
  } catch (e) {
    reason = '浏览器拒绝直接读取剪贴板';
  }
  if (!item && !readOk) {
    try {
      item = await execPasteImage();
    } catch (e) {
      /* ignore */
    }
  }
  if (!item) {
    // 读不到，或当前页面本来就抓不到图（画布类工具）→ 引导手动粘贴
    if (!readOk || !images.length) showPasteFallback(reason);
    return;
  }

  showClipBar(item);
  const key = clipKey(item);
  const { lastClipKey } = await chrome.storage.local.get(['lastClipKey']);
  if (key === lastClipKey) {
    showMsg('剪贴板里还是上次导入的那张（' + clipName() + '）');
    return;
  }
  await chrome.storage.local.set({ lastClipKey: key });
  await importClipboard();
}

function bindClipboardEvents() {
  chrome.storage.local.get(['clipAuto'], ({ clipAuto }) => {
    $('clipAutoToggle').checked = clipAuto === true;
  });

  $('clipAutoToggle').addEventListener('change', () => {
    chrome.storage.local.set({ clipAuto: $('clipAutoToggle').checked });
  });

  $('clipBtn').addEventListener('click', async () => {
    showMsg('读取剪贴板…');
    let item = null;
    try {
      item = await readClipboardImage();
    } catch (e) {
      /* 继续走 execCommand */
    }
    if (!item) {
      try {
        item = await execPasteImage();
      } catch (e) {
        /* ignore */
      }
    }
    if (!item) {
      showPasteFallback('无法自动读取剪贴板');
      return;
    }
    showClipBar(item);
    $('pasteZone').hidden = true;
    if ($('clipAutoToggle').checked) {
      const key = clipKey(item);
      const { lastClipKey } = await chrome.storage.local.get(['lastClipKey']);
      if (key === lastClipKey) {
        showMsg('这张图刚导入过，可点「导入」再导一次');
        return;
      }
      await chrome.storage.local.set({ lastClipKey: key });
      await importClipboard();
    } else {
      showMsg('已读取剪贴板图片，点「导入」发送到 Eagle');
    }
  });

  $('clipImport').addEventListener('click', () => {
    importClipboard();
  });

  $('autoCopyBtn').addEventListener('click', async () => {
    if (!currentTab || !currentTab.id) return;
    const folder = selectedFolder();
    const title = (pageMeta && pageMeta.title) || currentTab.title || '';
    chrome.storage.local.set({ lastFolderId: folder.id || '', lastFolderName: folder.name || '' });
    showMsg('正在画布上执行「复制 PNG 图片」…（页面顶部会出现调试提示，完成后消失）');
    const res = await send(
      'AUTO_COPY',
      {
        tabId: currentTab.id,
        folderId: folder.id,
        referer: pageReferer(),
        pageTitle: title,
        name: title,
      },
      60000
    );
    if (res && res.ok && res.data && res.data.imported) {
      const where = folder.name && folder.id ? '（' + folder.name + '）' : '';
      if (res.data.fromClipboard) {
        showMsg('已导入剪贴板中的图片' + where);
      } else {
        const hint = res.data.sameAsBefore ? '；内容与剪贴板里原有的一致' : '';
        showMsg('已导入 Eagle' + where + hint);
      }
      return;
    }
    // 只有「后台读不到剪贴板」时才用弹窗权限再试一次；
    // COPY_UNCHANGED 说明复制没成功，绝不能拿剪贴板里的旧图凑数
    const code = (res && res.code) || (res && res.data && res.data.code);
    if (code === 'CLIPBOARD_READ_FAILED' || (!code && !(res && res.ok))) {
      try {
        const item = await readClipboardImage();
        if (item) {
          showClipBar(item);
          await chrome.storage.local.set({ lastClipKey: clipKey(item) });
          if (await importClipboard()) return;
        }
      } catch (e) {
        /* ignore */
      }
    }
    showMsg(
      '自动导入失败：' + ((res && res.error) || '未知错误') + '（也可手动复制后点「读取剪贴板」）',
      true
    );
  });

  const sink = $('pasteSink');
  sink.addEventListener('paste', async (e) => {
    e.preventDefault();
    const dt = e.clipboardData;
    const files = dt ? Array.from(dt.files || []) : [];
    let blob = files.find((f) => /^image\//i.test(f.type)) || null;
    if (!blob && dt) {
      const it = Array.from(dt.items || []).find(
        (i) => i.kind === 'file' && /^image\//i.test(i.type)
      );
      if (it) blob = it.getAsFile();
    }
    if (!blob) {
      showMsg('剪贴板里没有图片，请用「复制 PNG 图片」再粘贴', true);
      return;
    }
    await handlePastedBlob(blob);
  });

  // 拖入图片也能导入
  sink.addEventListener('dragover', (e) => e.preventDefault());
  sink.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = Array.from(e.dataTransfer.files || []).find((x) => /^image\//i.test(x.type));
    if (f) await handlePastedBlob(f);
  });
}

function bindEvents() {
  $('hoverToggle').addEventListener('change', () => {
    const v = $('hoverToggle').checked;
    chrome.storage.local.set({ hoverEnabled: v });
    if (currentTab) {
      sendTabWithTimeout(currentTab.id, { type: 'SET_HOVER', enabled: v }, 8000);
    }
  });

  $('refreshFolders').addEventListener('click', () => loadFolders());

  // 选完文件夹立刻记住：否则重开弹窗 / 用快捷键导入时
  // 会退回上一次存下来的文件夹（表现为「选了别的又变回 PC风格页面」）
  $('folderSelect').addEventListener('change', () => {
    const sel = $('folderSelect');
    const name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text.trim() : '';
    chrome.storage.local.set({ lastFolderId: sel.value || '', lastFolderName: name });
  });

  $('selectAll').addEventListener('click', () => {
    $('grid')
      .querySelectorAll('input[type=checkbox]')
      .forEach((cb) => (cb.checked = true));
    updateCounter();
  });

  $('selectNone').addEventListener('click', () => {
    $('grid')
      .querySelectorAll('input[type=checkbox]')
      .forEach((cb) => (cb.checked = false));
    updateCounter();
  });

  $('importBtn').addEventListener('click', async () => {
    const checked = [...$('grid').querySelectorAll('input:checked')].map(
      (cb) => +cb.dataset.i
    );
    if (!checked.length) {
      showMsg('请先选择要导入的图片', true);
      return;
    }
    const sel = $('folderSelect');
    const folderId = sel.value || undefined;
    const folderName = sel.options[sel.selectedIndex]
      ? sel.options[sel.selectedIndex].text
      : '';
    showMsg('正在导入 ' + checked.length + ' 张…');

    try {
      // 按批「解析 → 发送」，避免一次性把大量原图堆在内存
      const BATCH = 3;
      let sent = 0;
      let importedCount = 0;
      let failedCount = 0;
      let firstError = '';
      let note = '';
      for (let i = 0; i < checked.length; i += BATCH) {
        const slice = checked.slice(i, i + BATCH);
        const items = await mapLimit(
          slice.map((idx) => images[idx]),
          3,
          async (img) => {
            let url;
            try {
              url = await resolveImportUrl(img);
            } catch (e) {
              url = img.url;
            }
            return { url, name: img.name || fileName(img.url) };
          }
        );
        const res = await send(
          'IMPORT_IMAGES',
          {
            items,
            folderId,
            referer: pageReferer(),
            pageTitle: pageMeta.title || (currentTab && currentTab.title) || '',
          },
          90000
        );
        if (!res || !res.ok) throw new Error(res && res.error);
        const data = res.data || {};
        importedCount += data.imported || 0;
        const failedList = data.failed || [];
        if (failedList.length) {
          failedCount += failedList.length;
          if (!firstError) firstError = failedList[0].error || '';
        }
        if (!note && data.notes && data.notes.length) note = data.notes[0];
        sent += slice.length;
        showMsg('正在导入 ' + sent + '/' + checked.length + ' 张…');
      }
      showMsg(
        '成功导入 ' + importedCount + ' 张到 Eagle' +
          (folderName ? '（' + folderName + '）' : '') +
          (note ? '，' + note : '') +
          (failedCount ? '，' + failedCount + ' 张失败：' + firstError : ''),
        failedCount > 0
      );
      chrome.storage.local.set({ lastFolderId: folderId });
    } catch (e) {
      showMsg('导入失败：' + e.message, true);
    }
  });
}

init();
