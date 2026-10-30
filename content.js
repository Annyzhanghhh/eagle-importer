// Eagle 素材导入助手 - Content Script
// 1) 扫描页面图片供 popup 批量操作
// 2) 鼠标悬停图片时，注入工具条，可直接选择 Eagle 文件夹导入
(function () {
  // 防止重复注入（manifest 自动注入 + popup 按需注入 + 扩展更新后自动重注入）
  // 用版本号做守卫：扩展更新后旧脚本已失效，必须允许新版本重新接管
  const CS_VERSION = '1.4.3';
  if (window.__eagleImporterVersion === CS_VERSION) return;
  window.__eagleImporterVersion = CS_VERSION;
  window.__eagleImporterInjected = true;

let enabled = true;
let foldersCache = null;

let toolbar = null; // { host, shadow, bar, save, caret }
let currentAsset = null;
let currentFolderId = null;
let currentFolderName = '';

// 记录鼠标位置：画布类工具「一键复制 PNG」需要它来确定右键点
let lastPointer = null;
// 画布上最后一次「按下」的位置 —— 选中画板必然是一次点击，比移动位置可靠得多
let lastCanvasClick = null;

// 即时设计这类工具的画布在 iframe 里，iframe 内拿到的是「自己的」局部坐标，
// 而 CDP 派发鼠标事件用的是整页坐标。子框架把局部坐标 postMessage 给父框架，
// 由父框架加上 iframe 的位置，逐层累加，最终得到可用的整页坐标（跨域也成立）。
const IS_TOP = (() => {
  try {
    return window.top === window;
  } catch (e) {
    return false;
  }
})();

function iframeOf(source) {
  try {
    const list = document.querySelectorAll('iframe');
    for (const f of list) {
      if (f.contentWindow === source) return f;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

if (!IS_TOP) {
  const post = (kind, x, y) => {
    try {
      window.parent.postMessage({ __eaglePointer: 1, kind, x, y, t: Date.now() }, '*');
    } catch (e) {
      /* ignore */
    }
  };
  document.addEventListener(
    'mousemove',
    (e) => post('move', Math.round(e.clientX), Math.round(e.clientY)),
    { passive: true, capture: true }
  );
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      const inCanvas = t && (t.tagName === 'CANVAS' || (t.closest && t.closest('canvas')));
      if (inCanvas) post('click', Math.round(e.clientX), Math.round(e.clientY));
      else post('move', Math.round(e.clientX), Math.round(e.clientY));
    },
    { passive: true, capture: true }
  );
}

window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || d.__eaglePointer !== 1) return;
  if (typeof d.x !== 'number' || typeof d.y !== 'number') return;
  const frame = iframeOf(e.source);
  let ox = 0;
  let oy = 0;
  if (frame) {
    try {
      const r = frame.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
    } catch (err) {
      /* ignore */
    }
  }
  const x = Math.round(d.x + ox);
  const y = Math.round(d.y + oy);
  const t = d.t || Date.now();
  lastPointer = { x, y, t, inFrame: true };
  if (d.kind === 'click') lastCanvasClick = { x, y, t, inFrame: true };
  if (!IS_TOP) {
    try {
      window.parent.postMessage({ __eaglePointer: 1, kind: d.kind, x, y, t }, '*');
    } catch (err) {
      /* ignore */
    }
  }
});

if (IS_TOP) {
  document.addEventListener(
    'mousemove',
    (e) => {
      lastPointer = { x: Math.round(e.clientX), y: Math.round(e.clientY), t: Date.now() };
    },
    { passive: true, capture: true }
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return; // 只记左键，右键（含扩展自己模拟的）不算选择动作
      const t = e.target;
      const inCanvas = t && (t.tagName === 'CANVAS' || (t.closest && t.closest('canvas')));
      if (inCanvas) {
        lastCanvasClick = { x: Math.round(e.clientX), y: Math.round(e.clientY), t: Date.now() };
      }
    },
    { passive: true, capture: true }
  );
}

// 子框架只负责上报鼠标位置，不注入工具条、不扫描图片（避免在设计工具画布里画蛇添足）
if (!IS_TOP) return;

// 页面顶部浮动提示：快捷键触发时没有任何面板，用它回报结果
let pageToastEl = null;
let pageToastTimer = null;

function showPageToast(text, isError, duration) {
  if (!document.documentElement) return;
  if (!pageToastEl || !pageToastEl.parentNode) {
    pageToastEl = document.createElement('div');
    pageToastEl.id = 'eagle-importer-toast';
    pageToastEl.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'padding:8px 14px;border-radius:8px;font:500 13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;' +
      'color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.28);pointer-events:none;max-width:72vw;' +
      'transition:opacity .2s;opacity:1;';
    document.documentElement.appendChild(pageToastEl);
  }
  pageToastEl.style.background = isError ? '#d23b3b' : '#2e5bff';
  pageToastEl.textContent = text;
  pageToastEl.style.opacity = '1';
  if (pageToastTimer) clearTimeout(pageToastTimer);
  pageToastTimer = setTimeout(
    () => {
      if (pageToastEl) pageToastEl.style.opacity = '0';
    },
    duration || 3200
  );
}

function overCanvas(p) {
  try {
    const el = document.elementFromPoint(p.x, p.y);
    return !!(el && (el.tagName === 'CANVAS' || (el.closest && el.closest('canvas'))));
  } catch (e) {
    return false;
  }
}

chrome.storage.local.get(['hoverEnabled'], ({ hoverEnabled }) => {
  enabled = hoverEnabled !== false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_IMAGES') {
    sendResponse({ images: collectImages(), page: pageContext() });
    return false; // 同步返回
  }
  if (msg.type === 'SET_HOVER') {
    enabled = msg.enabled;
    if (!enabled) hideToolbar();
    return false;
  }
  if (msg.type === 'SHOW_TOAST') {
    showPageToast(msg.text, msg.isError, msg.duration);
    return false;
  }
  if (msg.type === 'GET_POINTER') {
    // 鼠标停在哪张图上，就导出哪张（用户直觉）；鼠标不在画布上时才退回最后的点选位置
    // inFrame 表示坐标来自子框架转发，elementFromPoint 只会拿到 iframe 元素，不能用来判断
    const onCanvas = (p) => !!(p && (p.inFrame || overCanvas(p)));
    const pOnCanvas = onCanvas(lastPointer);
    const primary = pOnCanvas ? lastPointer : lastCanvasClick || lastPointer;
    let alt = primary === lastPointer ? lastCanvasClick : lastPointer;
    if (alt && (primary && alt.x === primary.x && alt.y === primary.y)) alt = null;
    // selected：用户最后一次在画布上点选的位置，通常就是他选中的那个画板
    const selected = onCanvas(lastCanvasClick) ? lastCanvasClick : null;
    sendResponse({ pointer: primary, alt, selected });
    return false;
  }
  if (msg.type === 'THUMB_BLOB') {
    blobThumb(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'BLOB_DATA') {
    blobDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // 页面上下文抓图：自动携带正确的 Referer，且 CDN 允许 CORS 时可直接读取
  if (msg.type === 'THUMB_PAGE') {
    pageFetchDataUrl(msg.url, 240)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'DATA_PAGE') {
    pageFetchDataUrl(msg.url, 0)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// 在页面上下文抓图（Referer 正确）；maxSize>0 时缩成缩略图
async function pageFetchDataUrl(url, maxSize) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let blob;
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    blob = await res.blob();
  } finally {
    clearTimeout(timer);
  }

  if (maxSize) {
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      /* 回退为原始 dataURL */
    }
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// blob 全分辨率 dataURL（用于导入，Eagle 无法访问页面私有 blob）
async function blobDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read blob failed'));
    reader.readAsDataURL(blob);
  });
}

// blob: 地址只在页面上下文有效，交给 content script 转成缩略图 dataURL
async function blobThumb(url, maxSize) {
  maxSize = maxSize || 240;
  const res = await fetch(url);
  const blob = await res.blob();
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (e) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('read blob failed'));
      reader.readAsDataURL(blob);
    });
  }
}

// ---------- 收集页面素材 ----------
function normalizeUrl(u) {
  if (!u) return null;
  try {
    if (u.startsWith('data:') || u.startsWith('blob:')) return u;
    return new URL(u, location.href).href;
  } catch {
    return null;
  }
}

function fileName(url) {
  try {
    const seg = new URL(url).pathname.split('/').pop();
    return seg && seg.includes('.') ? seg : 'image';
  } catch {
    return 'image';
  }
}

// ---------- Eagle 名称 / 页面标题 取值 ----------
function cleanText(s, max) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-|｜·\s]+/, '')
    .trim()
    .slice(0, max || 60);
}

// 页面主标题：og:title → h1 → document.title
function pageTitleText() {
  const og = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
  const ogText = cleanText(og && og.getAttribute('content'), 60);
  if (ogText) return ogText;
  const h1 = document.querySelector('h1');
  const h1Text = cleanText(h1 && h1.textContent, 60);
  if (h1Text && h1Text.length > 1) return h1Text;
  return cleanText(document.title, 60);
}

// 供 popup 使用的页面上下文
function pageContext() {
  return {
    title: pageTitleText(),
    url: location.href.split('#')[0],
  };
}

// 名称优先级：alt（有意义时）→ 页面标题 → 原始文件名
function pickName(candidate, url) {
  const c = cleanText(candidate, 80);
  if (c && !/^(image|img|photo|picture|图片|untitled)(\.\w+)?$/i.test(c)) return c;
  const base = fileName(url);
  if (base !== 'image') return base;
  const title = pageTitleText();
  return title || 'image';
}

function collectImages() {
  const seen = new Set();
  const list = [];

  document.querySelectorAll('img').forEach((img) => {
    const url = normalizeUrl(img.currentSrc || img.src);
    if (!url) return;
    if (img.naturalWidth && img.naturalWidth < 24) return; // 跳过小图标
    if (seen.has(url)) return;
    seen.add(url);
    list.push({
      url,
      name: pickName(img.getAttribute('alt'), url),
      w: img.naturalWidth || img.width || 0,
      h: img.naturalHeight || img.height || 0,
    });
  });

  // CSS 背景图
  try {
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1] && m[1].startsWith('http')) {
        const url = normalizeUrl(m[1]);
        if (url && !seen.has(url) && el.offsetWidth > 40 && el.offsetHeight > 40) {
          seen.add(url);
          list.push({ url, name: pickName(null, url), w: el.offsetWidth, h: el.offsetHeight });
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
  return list;
}

// ---------- 悬停工具条 ----------
let hideTimer = null;
let saving = false;

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide(delay) {
  cancelHide();
  if (saving) return; // 保存过程中不隐藏，保证结果可见
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideToolbar();
  }, delay || 450);
}

document.addEventListener('mouseover', (e) => {
  if (!enabled) return;
  // 鼠标在工具条内（含阴影 DOM 重定向到 host）保持显示
  if (toolbar && toolbar.host.contains(e.target)) {
    cancelHide();
    return;
  }
  const asset = getAsset(e.target);
  if (asset) {
    cancelHide();
    showToolbar(asset, e.target);
  } else {
    scheduleHide(450);
  }
});

window.addEventListener(
  'scroll',
  () => hideToolbar(),
  true
);

// 点击页面其它位置关闭菜单
document.addEventListener('click', (e) => {
  if (toolbar && !toolbar.host.contains(e.target)) {
    const menu = toolbar.shadow.querySelector('.menu');
    if (menu) menu.remove();
  }
});

function getAsset(el) {
  if (el && el.tagName === 'IMG') {
    const url = normalizeUrl(el.currentSrc || el.src);
    if (url) return { url, name: pickName(el.getAttribute('alt'), url) };
  }
  try {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1]) {
      const url = normalizeUrl(m[1]);
      if (url) return { url, name: pickName(null, url) };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function ensureToolbar() {
  if (toolbar) return toolbar;
  // 清理扩展重载后残留的旧工具条
  const orphan = document.getElementById('eagle-importer-host');
  if (orphan) orphan.remove();
  const host = document.createElement('div');
  host.id = 'eagle-importer-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;display:none;width:max-content;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .bar{ position:relative; display:inline-flex; align-items:center; gap:1px; height:24px;
            background:rgba(24,28,38,.92); color:#fff; border-radius:6px; padding:0 2px;
            font:500 12px/1 system-ui,-apple-system,"PingFang SC",sans-serif;
            box-shadow:0 2px 8px rgba(0,0,0,.2); cursor:pointer; user-select:none; white-space:nowrap; }
      .bar button{ all:unset; color:#fff; cursor:pointer; padding:0 7px; height:24px; line-height:24px;
                   border-radius:5px; }
      .bar button:hover{ background:rgba(255,255,255,.22); }
      .caret{ opacity:.85; padding:0 5px !important; }
      .menu{ position:absolute; top:28px; left:0; min-width:180px; max-height:280px; overflow:auto; z-index:1;
            background:#fff; color:#222; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.25);
            padding:4px; font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif; white-space:normal; }
      .menu .item{ padding:6px 8px; border-radius:6px; cursor:pointer; white-space:nowrap; }
      .menu .item:hover{ background:#eef2ff; }
      .menu .sep{ height:1px; background:#eef0f4; margin:3px 4px; }
      .menu .empty{ padding:8px; color:#888; }
      .toast{ position:absolute; top:28px; left:0; background:#222; color:#fff; padding:5px 9px;
              border-radius:6px; font:12px/1.4 system-ui,sans-serif; white-space:nowrap;
              box-shadow:0 4px 14px rgba(0,0,0,.25); }
    </style>
    <div class="bar">
      <button class="save" title="保存到 Eagle">导入 Eagle</button>
      <button class="caret" title="选择文件夹">▾</button>
    </div>
  `;
  toolbar = {
    host,
    shadow,
    bar: shadow.querySelector('.bar'),
    save: shadow.querySelector('.save'),
    caret: shadow.querySelector('.caret'),
  };
  toolbar.save.addEventListener('click', (ev) => {
    ev.stopPropagation();
    doSave(currentAsset, currentFolderId);
  });
  toolbar.caret.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openMenu();
  });
  return toolbar;
}

function showToolbar(asset, el) {
  ensureToolbar();
  currentAsset = asset;

  // 先显示但不可见，量出实际尺寸再定位，避免闪烁
  toolbar.host.style.visibility = 'hidden';
  toolbar.host.style.display = 'block';
  const rect = el.getBoundingClientRect();
  const barRect = toolbar.bar.getBoundingClientRect();
  const barW = barRect.width || 84;
  const barH = barRect.height || 24;
  const gap = 6;

  let top;
  let left = rect.left;
  // 优先浮在元素上方，其次下方，空间都不够才压在元素内
  if (rect.top - barH - gap >= 4) {
    top = rect.top - barH - gap;
  } else if (rect.bottom + gap + barH <= window.innerHeight - 4) {
    top = rect.bottom + gap;
  } else {
    top = rect.top + gap;
    left = rect.left + gap;
  }
  left = Math.max(4, Math.min(left, window.innerWidth - barW - 4));
  top = Math.max(4, Math.min(top, window.innerHeight - barH - 4));

  toolbar.host.style.top = top + 'px';
  toolbar.host.style.left = left + 'px';
  toolbar.host.style.visibility = 'visible';

  chrome.storage.local.get(['lastFolderId', 'lastFolderName'], (s) => {
    currentFolderId = s.lastFolderId || null;
    currentFolderName = s.lastFolderName || '';
    toolbar.save.title = currentFolderName ? '保存到 ' + currentFolderName : '保存到 Eagle';
  });
}

function hideToolbar() {
  if (!toolbar) return;
  toolbar.host.style.display = 'none';
  const menu = toolbar.shadow.querySelector('.menu');
  if (menu) menu.remove();
}

function flattenFolders(folders, depth, out) {
  out = out || [];
  folders.forEach((f) => {
    out.push({ id: f.id, name: f.name, depth });
    if (f.children && f.children.length) flattenFolders(f.children, depth + 1, out);
  });
  return out;
}

function openMenu() {
  const shadow = toolbar.shadow;
  let menu = shadow.querySelector('.menu');
  if (menu) {
    menu.remove();
    return;
  }
  // 锁定打开菜单时的目标元素，避免移动过程中被切换
  const assetAtOpen = currentAsset;
  getFolders().then((folders) => {
    menu = document.createElement('div');
    menu.className = 'menu';
    const flat = flattenFolders(folders, 0);

    // 库根目录：点击直接保存到根目录
    const rootItem = document.createElement('div');
    rootItem.className = 'item';
    rootItem.textContent = '（库根目录）';
    rootItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      currentFolderId = null;
      currentFolderName = '';
      chrome.storage.local.set({ lastFolderId: null, lastFolderName: '' });
      toolbar.save.title = '保存到 Eagle';
      menu.remove();
      doSave(assetAtOpen, undefined);
    });
    menu.appendChild(rootItem);

    if (flat.length) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
    }

    // 点击任意文件夹 = 立即保存到该文件夹
    flat.forEach((f) => {
      const it = document.createElement('div');
      it.className = 'item';
      it.textContent = '　'.repeat(f.depth) + (f.depth ? '└ ' : '') + f.name;
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        currentFolderId = f.id;
        currentFolderName = f.name;
        chrome.storage.local.set({ lastFolderId: f.id, lastFolderName: f.name });
        toolbar.save.title = '保存到 ' + f.name;
        menu.remove();
        doSave(assetAtOpen, f.id);
      });
      menu.appendChild(it);
    });
    toolbar.bar.appendChild(menu);

    // 空间不够时把菜单翻到上方 / 右对齐，避免超出视口
    const br = toolbar.bar.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    if (br.bottom + mr.height > window.innerHeight - 4) {
      menu.style.top = 'auto';
      menu.style.bottom = '28px';
    }
    if (br.left + mr.width > window.innerWidth - 4) {
      menu.style.left = 'auto';
      menu.style.right = '0';
    }
  });
}

function doSave(asset, folderId) {
  if (!asset) return;
  const targetName = currentFolderName || '';
  saving = true;
  cancelHide();
  showToast('保存中…', 60000);

  const finish = (text, duration) => {
    saving = false;
    showToast(text, duration);
    cancelHide();
    scheduleHide(duration || 2600);
  };

  const deliver = (url) => {
    const items = [{ url, name: pickName(asset.name, asset.url) }];
    // 用完整页面地址做 Referer：防盗链站点只认完整路径
    const referer = location.href.split('#')[0];
    const pageTitle = pageTitleText();
    send(
      'IMPORT_IMAGES',
      { items, folderId: folderId || undefined, referer, pageTitle },
      180000
    ).then(
      (res) => {
        if (res && res.ok) {
          const data = res.data || {};
          if (!data.imported) {
            finish('失败：Eagle 没有真正入库', 4000);
            return;
          }
          chrome.storage.local.set({
            lastFolderId: folderId,
            lastFolderName: currentFolderName,
          });
          const note = data.notes && data.notes.length ? '（' + data.notes[0] + '）' : '';
          finish(
            (targetName ? '已保存到 ' + targetName : '已保存到 Eagle') + note,
            2600
          );
        } else {
          finish('失败：' + ((res && res.error) || '未知错误'), 4000);
        }
      }
    );
  };

  // 优先在页面上下文取字节（Referer/Cookie 正确）；失败则交给后台兜底
  const prepare = async () => {
    const url = asset.url;
    if (/^data:/i.test(url)) return url;
    if (/^blob:/i.test(url)) return await blobDataUrl(url);
    try {
      return await pageFetchDataUrl(url, 0);
    } catch (e) {
      return url;
    }
  };

  prepare()
    .then(deliver)
    .catch((e) => finish('失败：' + e.message, 4000));
}

let toastTimer = null;

function showToast(text, duration) {
  if (!toolbar) return;
  const shadow = toolbar.shadow;
  let t = shadow.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    toolbar.bar.appendChild(t);
  }
  t.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }, duration || 2200);
}

// ---------- 与后台通信 ----------
const DEAD_CONTEXT_MSG = '扩展已更新，请刷新本页面后重试';

// 扩展被重载/更新后，页面里的老 content script 会彻底失联
function isContextAlive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function markDeadContext() {
  try {
    const btn = toolbar && toolbar.save;
    if (btn) {
      btn.textContent = '请刷新页面';
      btn.title = DEAD_CONTEXT_MSG;
    }
  } catch (e) {
    /* ignore */
  }
}

function send(type, extra, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: '超时，请重试' });
      }
    }, timeoutMs || 30000);
    if (!isContextAlive()) {
      clearTimeout(timer);
      markDeadContext();
      resolve({ ok: false, error: DEAD_CONTEXT_MSG });
      return;
    }
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let err = null;
        try {
          err = chrome.runtime.lastError;
        } catch (e) {
          err = e;
        }
        if (!res && err && /context invalidated/i.test(err.message || '')) {
          markDeadContext();
          resolve({ ok: false, error: DEAD_CONTEXT_MSG });
          return;
        }
        resolve(res || { ok: false, error: (err && err.message) || '无响应' });
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        markDeadContext();
        resolve({ ok: false, error: DEAD_CONTEXT_MSG });
      }
    }
  });
}

function getFolders() {
  if (foldersCache) return Promise.resolve(foldersCache);
  return send('GET_FOLDERS').then((res) => {
    foldersCache = res.ok ? res.folders : [];
    return foldersCache;
  });
}

})();
