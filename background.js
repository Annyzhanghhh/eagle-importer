// Eagle 素材导入助手 - 后台 Service Worker
// 负责与 Eagle 本地 API (http://localhost:41595) 通信
const EAGLE_BASE = 'http://localhost:41595';

async function eagleRequest(path, method = 'GET', body = null, timeout = 120000) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  init.signal = ctrl.signal;
  try {
    const res = await fetch(EAGLE_BASE + path, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error('Eagle 接口返回 ' + res.status + (text ? '：' + text.slice(0, 120) : ''));
    }
    if (!text) return { status: 'success' };
    try {
      return JSON.parse(text);
    } catch (e) {
      return { status: 'success' };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Eagle 请求超时（' + timeout / 1000 + 's）');
    if (e instanceof TypeError) throw new Error('无法连接 Eagle 客户端（请确认 Eagle 已启动，端口 41595）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').pop();
    return seg && seg.includes('.') ? seg : 'image';
  } catch {
    return 'image';
  }
}

// ---------- 缩略图 / 原图抓取（绕开 CORS、混合内容、Referer 防盗链）----------
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// 通过 DNR 给「图片请求」补上 Referer，破解 img.js.design 这类防盗链
const refererRuleMap = new Map(); // hostname -> { ruleId, referer }

// 同一域名固定用同一个规则 id，避免扩展重载后残留冲突规则
function hostRuleId(hostname) {
  let h = 0;
  for (let i = 0; i < hostname.length; i++) h = (h * 31 + hostname.charCodeAt(i)) % 900000;
  return 1000 + h;
}

const refererRuleQueue = new Map(); // hostname -> Promise（按域名串行化规则更新）

// 清理我们临时加的所有会话规则：
// 残留规则会给设计工具自己的图片请求也套上错误 Referer，导致导出时资源一直加载不出来
async function clearRefererRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getSessionRules) return;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules
      .map((r) => r.id)
      .filter((id) => typeof id === 'number' && id >= 1000 && id <= 901000);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
    refererRuleMap.clear();
  } catch (e) {
    /* ignore */
  }
}

async function ensureRefererRule(imageUrl, referer, scoped) {
  if (!referer) return;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  let hostname;
  try {
    hostname = new URL(imageUrl).hostname;
  } catch (e) {
    return;
  }
  if (!hostname) return;

  const prev = refererRuleQueue.get(hostname) || Promise.resolve();
  const task = prev
    .then(async () => {
      const ruleId = hostRuleId(hostname);
      const existing = refererRuleMap.get(hostname);
      if (existing && existing.referer === referer && existing.ruleId === ruleId) {
        if (existing.scoped === scoped) return;
        // 已经放宽过的规则不再收窄，避免同一域名反复切换
        if (existing.scoped === false) return;
      }

      refererRuleMap.set(hostname, { ruleId, referer, scoped });
      const condition = {
        requestDomains: [hostname],
        resourceTypes: ['xmlhttprequest', 'other'],
      };
      // tabIds 只在 session 规则里支持；-1 表示后台 / Service Worker 发起的请求
      if (scoped) condition.tabIds = [-1];

      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
            },
            condition,
          },
        ],
      });
    })
    .catch(() => {
      // DNR 失败不阻塞抓图（可能本来就无需 Referer）
    });

  refererRuleQueue.set(hostname, task);
  await task;
}

async function fetchImageBlob(url, referer) {
  // 先精确限定「后台请求」；若仍被防盗链拦（部分版本 SW 请求带 tabId），放宽后重试一次
  await ensureRefererRule(url, referer, true);
  let res = await fetch(url, { credentials: 'include' });
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    await ensureRefererRule(url, referer, false);
    res = await fetch(url, { credentials: 'include' });
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.blob();
}

async function makeThumbnail(url, referer, maxSize = 240) {
  const blob = await fetchImageBlob(url, referer);
  // 用 OffscreenCanvas 缩放，减小传输体积；失败则回退原图 dataURL
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return await blobToDataUrl(outBlob);
  } catch (e) {
    return await blobToDataUrl(blob);
  }
}

async function fetchOriginalDataUrl(url, referer) {
  const blob = await fetchImageBlob(url, referer);
  if (blob.size > 30 * 1024 * 1024) throw new Error('image too large');
  return await blobToDataUrl(blob);
}

// ---------- 落地成临时文件再导入 ----------
// Eagle 4.0.0（20240821）的本地 API 在接收 base64 图片时会在原生层段错误退出，
// 与图片体积无关（实测 6.1MB 成功、1.0MB 崩溃）。所以一律先写成真实文件，
// 走 Eagle 自己的 addFromPath 导入链路（和它在界面里导入文件完全一致）。
const TEMP_DIR = 'eagle-import-tmp';

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
};

function extFromDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([a-z0-9.+/-]+)[;,]/i);
  const mime = m ? m[1].toLowerCase() : '';
  return MIME_EXT[mime] || 'png';
}

// 临时文件只是给 Eagle 读的，别在下载气泡里打扰用户。
// setUiOptions 是 profile 级的全局开关，用计数避免并发下载互相抢着还原。
let uiHiddenCount = 0;

function setDownloadUi(enabled) {
  try {
    if (chrome.downloads && chrome.downloads.setUiOptions) {
      const p = chrome.downloads.setUiOptions({ enabled });
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) {
    /* 没有 downloads.ui 权限就忽略，功能不受影响 */
  }
}

function hideDownloadUi() {
  uiHiddenCount += 1;
  if (uiHiddenCount === 1) setDownloadUi(false);
}

function showDownloadUi() {
  uiHiddenCount = Math.max(0, uiHiddenCount - 1);
  if (uiHiddenCount === 0) setDownloadUi(true);
}

// 用 downloads API 把 data URL 写成 ~/Downloads/eagle-import-tmp/xxx.png，返回 downloadId
function saveTempFile(dataUrl, ext, seed) {
  const filename =
    TEMP_DIR + '/' + Date.now() + '-' + (seed || Math.random().toString(36).slice(2, 8)) + '.' + ext;
  return new Promise((resolve, reject) => {
    if (!chrome.downloads || !chrome.downloads.download) {
      reject(new Error('缺少 downloads 权限'));
      return;
    }
    hideDownloadUi();
    chrome.downloads.download(
      { url: dataUrl, filename, conflictAction: 'overwrite', saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) {
          showDownloadUi();
          reject(new Error('写入临时文件失败：' + (err ? err.message : '未知原因')));
          return;
        }
        let settled = false;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          try {
            chrome.downloads.onChanged.removeListener(onChanged);
          } catch (e) {
            /* ignore */
          }
          clearTimeout(timer);
          showDownloadUi();
          fn(arg);
        };
        const onChanged = (delta) => {
          if (delta.id !== id || !delta.state) return;
          if (delta.state.current === 'complete') finish(resolve, id);
          else if (delta.state.current === 'interrupted') {
            finish(reject, new Error('临时文件写入被中断'));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
        const timer = setTimeout(() => finish(reject, new Error('临时文件写入超时')), 60000);
        // 小文件可能在监听器挂上之前就已经下载完，主动查一次当前状态
        chrome.downloads.search({ id }, (list) => {
          const f = list && list[0];
          if (!f) return;
          if (f.state === 'complete') finish(resolve, id);
          else if (f.state === 'interrupted') finish(reject, new Error('临时文件写入被中断'));
        });
      }
    );
  });
}

// 确认临时文件还真的落在磁盘上（exists 由浏览器给出，比我们自己猜可靠）
async function downloadFileReady(id, tries) {
  for (let i = 0; i < (tries || 15); i++) {
    try {
      const list = await chrome.downloads.search({ id });
      const f = list && list[0];
      if (f && f.exists === true) return f.filename || '';
    } catch (e) {
      /* ignore */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
}

// 下载完成后再盯 450ms：文件要是一直在，才交给 Eagle；中途消失说明被回收了，重新下载
async function ensureTempFile(id) {
  const path = await downloadFileReady(id, 20);
  if (!path) return '';
  for (let i = 0; i < 3; i++) {
    await new Promise((res) => setTimeout(res, 150));
    if (!(await downloadFileReady(id, 1))) return '';
  }
  return path;
}

function strToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function fileNameOf(id) {
  try {
    const list = await chrome.downloads.search({ id });
    return list && list[0] ? String(list[0].filename || '') : '';
  } catch (e) {
    return '';
  }
}

// 自动导出失败时把现场存下来：一张页面截图 + 一份 JSON（指针坐标、候选点、菜单文本）。
// 截图里能看到右键到底点在哪儿、菜单长什么样，比猜 UI 靠谱。
async function dumpFailure(tabId, info) {
  try {
    const stamp = Date.now();
    const shot = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
    if (!shot || !shot.data) return '';
    const pngId = await saveTempFile('data:image/png;base64,' + shot.data, 'png', 'fail-' + stamp);
    const pngPath = await fileNameOf(pngId);
    const jsonId = await saveTempFile(
      'data:application/json;base64,' + strToBase64(JSON.stringify(info, null, 2)),
      'json',
      'fail-' + stamp
    );
    void jsonId;
    return pngPath.split('/').pop() || '';
  } catch (e) {
    return '';
  }
}

// 时间优先从文件名里取（我们自己写的 Date.now() 前缀），
// 因为 Chrome 的 startTime 偶尔取到 NaN，靠它判断会误删刚下载的文件。
// Eagle 的 addFromPath 是先返回再异步上传（实测 15ms 内就去读了），2 分钟足够安全。
const TEMP_FILE_TTL = 2 * 60 * 1000;

function tempFileAge(f) {
  const base = String(f.filename || '').split('/').pop() || '';
  const m = base.match(/^(\d{12,14})/);
  if (m) {
    const t = Number(m[1]);
    if (t > 1600000000000) return Date.now() - t;
  }
  const t = Date.parse(f.startTime || f.endTime || '');
  return isNaN(t) ? null : Date.now() - t;
}

function dropTempFile(id) {
  if (!id || !chrome.downloads || !chrome.downloads.removeFile) return;
  try {
    chrome.downloads.removeFile(id, () => {
      void chrome.runtime.lastError;
      if (chrome.downloads.erase) chrome.downloads.erase({ id });
    });
  } catch (e) {
    /* ignore */
  }
}

function cleanupStaleTempFiles() {
  if (!chrome.downloads || !chrome.downloads.search) return;
  try {
    chrome.downloads.search({ filenameRegex: TEMP_DIR, limit: 300 }, (list) => {
      if (chrome.runtime.lastError || !Array.isArray(list)) return;
      list.forEach((f) => {
        if (/fail-/.test(f.filename || '')) return; // 诊断产物留着，方便排查
        const age = tempFileAge(f);
        if (age === null) return; // 完全算不出年龄的不动，宁可留垃圾也不能误删
        if (age < TEMP_FILE_TTL) return;
        dropTempFile(f.id);
      });
    });
  } catch (e) {
    /* ignore */
  }
}

// Eagle 老版本要求 name 带扩展名才能正确识别格式
function ensureNameExt(name, url) {
  let base = String(name || 'image')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  if (!base) base = 'image';
  let ext = '';
  if (/^data:/i.test(url || '')) {
    const m = url.match(/^data:image\/([a-z0-9.+-]+);base64,/i);
    if (m) ext = m[1].toLowerCase();
  }
  if (!ext) {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-z0-9]+)$/i);
      if (m) ext = m[1].toLowerCase();
    } catch (e) {
      /* ignore */
    }
  }
  if (!ext) ext = 'png';
  if (ext === 'jpeg') ext = 'jpg';
  if (ext === 'svg+xml') ext = 'svg';
  return base + '.' + ext;
}

// 校验 folderId 是否还存在：失效的文件夹会让 Eagle 返回 success 却静默丢弃素材
async function resolveFolderId(folderId, notes) {
  if (!folderId) return undefined;
  try {
    const res = await eagleRequest('/api/folder/list');
    const ids = new Set();
    (function walk(list) {
      (list || []).forEach((f) => {
        ids.add(f.id);
        if (f.children) walk(f.children);
      });
    })(res && res.data);
    if (!ids.size) return folderId; // 拿不到列表就不做判断
    if (ids.has(folderId)) return folderId;
    notes.push('目标文件夹已不存在，已导入到库根目录');
    return undefined;
  } catch (e) {
    return folderId;
  }
}

// ---------- 自动标签 ----------
const SITE_NAMES = [
  [/xiaohongshu\.com$/i, '小红书'],
  [/xhslink\.com$/i, '小红书'],
  [/js\.design$/i, '即时设计'],
  [/ui\.cn$/i, 'UI中国'],
  [/dribbble\.com$/i, 'Dribbble'],
  [/behance\.net$/i, 'Behance'],
  [/figma\.com$/i, 'Figma'],
  [/pinterest\./i, 'Pinterest'],
  [/huaban\.com$/i, '花瓣'],
  [/zcool\.com\.cn$/i, '站酷'],
  [/instagram\.com$/i, 'Instagram'],
  [/artstation\.com$/i, 'ArtStation'],
  [/uiiiuiii\.com$/i, '优设'],
];

function siteNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const [re, name] of SITE_NAMES) if (re.test(host)) return name;
    return host;
  } catch (e) {
    return '';
  }
}

// 自动标签 = 来源站点 + 页面标题
function buildAutoTags(pageUrl, pageTitle) {
  const out = [];
  [siteNameFromUrl(pageUrl), pageTitle].forEach((s) => {
    const t = String(s || '')
      .replace(/[#／/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (t && out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

// Eagle 标签：去空、去重、限长
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return undefined;
  const out = [];
  tags.forEach((t) => {
    const v = String(t || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (v && out.indexOf(v) === -1) out.push(v);
  });
  return out.length ? out.slice(0, 8) : undefined;
}

// 同一批里名称重复时补序号，避免 Eagle 里一堆同名素材
function dedupeName(name, counter) {
  const m = String(name || '').match(/^(.*?)(\.[a-z0-9]+)$/i);
  const stem = m ? m[1] : String(name || 'image');
  const ext = m ? m[2] : '';
  const key = stem.toLowerCase();
  const n = (counter.get(key) || 0) + 1;
  counter.set(key, n);
  return n > 1 ? stem + ' ' + n + ext : stem + ext;
}

// 统一导入：http(s) 图片先带 Referer 抓成 base64，避免 Eagle 服务端被防盗链拦截
async function importItems(items, folderId, referer, pageTitle) {
  const prepared = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const pos = idx++;
      const it = items[pos];
      let url = it.url;
      if (/^https?:/i.test(url || '')) {
        try {
          url = await fetchOriginalDataUrl(url, referer);
        } catch (e) {
          // 抓取失败则保留原始 URL，交给 Eagle 尝试
        }
      }
      const entry = { name: ensureNameExt(it.name, url) };
      if (/^data:/i.test(url || '')) {
        // data URL 绝不直接发给 Eagle：先落盘再 addFromPath
        const ext = extFromDataUrl(url);
        for (let attempt = 0; attempt < 2 && !entry.path; attempt++) {
          try {
            entry.tempId = await saveTempFile(url, ext, String(pos) + '-' + attempt);
            entry.path = await ensureTempFile(entry.tempId);
            if (!entry.path) {
              dropTempFile(entry.tempId);
              entry.tempId = 0;
            }
          } catch (e) {
            entry.tempId = 0;
          }
        }
        if (!entry.path) {
          // 没有 downloads 权限 / 写盘失败，退回 base64（有崩溃风险，仅作兜底）
          entry.url = url;
          entry.base64 = true;
        }
      } else {
        entry.url = url;
      }
      // 调用方没给标签时，用「来源站点 + 页面标题」自动补上
      const tags = normalizeTags(it.tags) || buildAutoTags(referer, pageTitle || it.pageTitle);
      if (tags && tags.length) entry.tags = tags;
      if (it.annotation) entry.annotation = String(it.annotation).slice(0, 200);
      // 仍是远程 URL 时，把来源页告诉 Eagle（官方支持 headers，可绕过部分防盗链）
      if (/^https?:/i.test(url) && referer) entry.headers = { referer };
      prepared[pos] = entry;
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));

  // 逐条提交，且严格串行：
  // Eagle 的下载队列是单线程的，并发提交会出现「返回 success 但素材被静默丢弃」
  const notes = [];
  const targetFolderId = await resolveFolderId(folderId, notes);
  if (prepared.some((e) => e && e.base64)) {
    notes.push('缺少 downloads 权限，已退回 base64 导入（可能导致 Eagle 崩溃）');
  }
  let imported = 0;
  const failed = [];
  const nameCounter = new Map();
  const tempIds = [];
  for (const entry of prepared) {
    if (!entry) continue;
    const name = dedupeName(entry.name, nameCounter);
    const isPath = !!entry.path;
    const payload = isPath ? { path: entry.path, name } : { url: entry.url, name };
    if (entry.tags) payload.tags = entry.tags;
    if (entry.annotation) payload.annotation = entry.annotation;
    if (entry.headers) payload.headers = entry.headers;
    if (referer) payload.website = referer;
    if (targetFolderId) payload.folderId = targetFolderId;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await eagleRequest(
          isPath ? '/api/item/addFromPath' : '/api/item/addFromURL',
          'POST',
          payload,
          180000
        );
        if (r && r.status && r.status !== 'success') {
          throw new Error(r.message || 'Eagle 拒绝：' + r.status);
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 600));
      }
    }
    if (lastErr) failed.push({ name, error: lastErr.message || String(lastErr) });
    else imported++;
    if (entry.tempId) tempIds.push(entry.tempId);
    // 给 Eagle 的缩略图/缓存处理留出时间
    await new Promise((res) => setTimeout(res, 200));
  }

  // 30 秒后再删临时文件：Eagle 的 addFromPath 是先返回再异步上传，
  // 留足余量（实测 15ms 内就读完），既不让 Downloads 留垃圾，也不会打断导入。
  if (tempIds.length) setTimeout(() => tempIds.forEach(dropTempFile), 30000);

  // 用完立刻清掉临时 Referer 规则，别影响页面/设计工具自己的请求
  clearRefererRules();

  if (!imported && failed.length) throw new Error(failed[0].error);
  return { status: 'success', imported, failed, notes };
}

// ---------- 画布类设计工具：用 CDP 自动执行「更多 → 复制/粘贴 → 复制 PNG 图片」----------
// 这些工具的画板内容在 canvas 里，DOM 抓不到；只能借它自己的菜单导出。
// 合成 DOM 事件没有可信手势，剪贴板写入会失败，所以走 chrome.debugger 发真实鼠标事件。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function withDebugger(tabId, fn) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/already attached/i.test(msg)) {
      throw new Error('页面已被其它调试器占用，请先关闭该页的开发者工具再试');
    }
    throw new Error('无法附加调试器：' + msg);
  }
  try {
    return await fn();
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      /* ignore */
    }
  }
}

async function evalInPage(tabId, expression, awaitPromise) {
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise: !!awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行失败');
  }
  return r && r.result ? r.result.value : null;
}

// 定位右键菜单的浮层容器并记到 window 上；后续查找只在这个容器里进行，
// 避免把画布上/面板里的同名文字（比如按钮"更多"）当成菜单项
const MENU_ROOT_EXPR = `(() => {
  if (!Array.isArray(window.__eagleMenuRoots)) window.__eagleMenuRoots = [];
  let best = null;
  let bestZ = -1;
  document.querySelectorAll('body *').forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const z = parseInt(cs.zIndex, 10);
    if (isNaN(z) || z < 50) return;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 40) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    let items = 0;
    el.querySelectorAll('div,span,li,a,button,p').forEach((c) => {
      const t = (c.textContent || '').trim();
      if (t && t.length <= 24 && c.children.length <= 1) items++;
    });
    if (items < 3) return;
    if (z >= bestZ) {
      bestZ = z;
      best = el;
    }
  });
  if (!best) return null;
  if (window.__eagleMenuRoots.indexOf(best) === -1) window.__eagleMenuRoots.push(best);
  const out = [];
  window.__eagleMenuRoots.forEach((rt) => {
    if (!rt || !document.contains(rt)) return;
    rt.querySelectorAll('div,span,li,a,button,p').forEach((c) => {
      const t = (c.textContent || '').replace(/\\s+/g, '');
      if (!t || t.length > 24) return;
      if (c.children.length > 1) return;
      out.push(t);
    });
  });
  return Array.from(new Set(out)).slice(0, 40);
})()`;

// 按文本匹配右键菜单项，返回面积最小（最贴近文字）那一块的中心坐标 + 是否禁用
function findMenuItemExpr(texts) {
  return `(() => {
  const wanted = ${JSON.stringify(texts)}.map((s) => String(s).replace(/\\s+/g, ''));
  const norm = (s) => String(s || '').replace(/\\s+/g, '');
  const roots = (window.__eagleMenuRoots || []).filter((r) => r && document.contains(r));
  let els = [];
  if (roots.length) {
    roots.forEach((r) => {
      els = els.concat(Array.from(r.querySelectorAll('div,span,li,a,button,p')));
    });
  } else {
    els = Array.from(document.querySelectorAll('div,span,li,a,button,p'));
  }
  for (const want of wanted) {
    const hits = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const t = norm(el.textContent);
      if (!t) continue;
      if (t !== want && t.indexOf(want) !== 0) continue;
      if (t.length > want.length + 6) continue;
      hits.push({ el, r });
    }
    if (hits.length) {
      hits.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
      const { el, r } = hits[0];
      let disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      if (!disabled) {
        const cs = getComputedStyle(el);
        if (cs.pointerEvents === 'none') disabled = true;
        const op = parseFloat(cs.opacity);
        if (!isNaN(op) && op > 0 && op < 0.55) disabled = true;
      }
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        disabled,
      };
    }
  }
  return null;
})()`;
}

async function mouseMove(tabId, x, y) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

async function mouseClick(tabId, x, y, button) {
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons: button === 'right' ? 2 : 1,
    clickCount: 1,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

async function hoverAt(tabId, x, y) {
  await mouseMove(tabId, Math.max(0, x - 1), y);
  await sleep(70);
  await mouseMove(tabId, x, y);
}

async function pressEsc(tabId) {
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

// modifiers: 1=Alt 2=Ctrl 4=Meta(⌘) 8=Shift
async function pressKeyCombo(tabId, key, code, vk, modifiers) {
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

// 等剪贴板内容变化并取出图片；内容没变说明快捷键没生效，返回 null 交给后续方案
async function waitClipboardImage(tabId, beforeFp, timeout) {
  const deadline = Date.now() + (timeout || 8000);
  while (Date.now() < deadline) {
    await sleep(400);
    let fp = '';
    try {
      fp = (await evalInPage(tabId, CLIP_FP_EXPR, true)) || '';
    } catch (e) {
      fp = '';
    }
    if (!fp || fp === beforeFp) continue;
    try {
      return await evalInPage(tabId, READ_CLIPBOARD_EXPR, true);
    } catch (e) {
      return null;
    }
  }
  return null;
}

const READ_CLIPBOARD_EXPR = `navigator.clipboard.read().then(async (items) => {
  for (const item of items) {
    const type = (item.types || []).find((t) => String(t).indexOf('image/') === 0);
    if (!type) continue;
    const blob = await item.getType(type);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return 'data:' + type + ';base64,' + btoa(bin);
  }
  return null;
})`;

async function autoCopyPng(tabId, pointerInfo) {
  return await withDebugger(tabId, async () => {
    try {
      await cdp(tabId, 'Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    } catch (e) {
      /* 授权失败也继续，最后读剪贴板时再报错 */
    }

    // 先记下剪贴板现状，用于确认「这次真的复制到东西了」
    let beforeFp = '';
    try {
      beforeFp = (await evalInPage(tabId, CLIP_FP_EXPR, true)) || '';
    } catch (e) {
      beforeFp = '';
    }

    // ⌘⇧L（显式「导入剪贴板」）时不做任何右键，直接取剪贴板里的图。
    // ⌘⇧K 仍按鼠标停着的画板导出，两者互不干扰。
    const preferClipboard = !!(pointerInfo && pointerInfo.preferClipboard === true);
    if (preferClipboard) {
      let clipData = null;
      try {
        clipData = await evalInPage(tabId, READ_CLIPBOARD_EXPR, true);
      } catch (e) {
        clipData = null;
      }
      if (!clipData) {
        return {
          ok: false,
          code: 'CLIPBOARD_EMPTY',
          error: '剪贴板里没有图片，请先在设计工具里「复制 PNG 图片」',
        };
      }
      return { ok: true, dataUrl: clipData, fromClipboard: true };
    }

    // 首选：⌘⇧C（Figma 同款「复制为 PNG」）。
    // 不移动鼠标、不弹菜单、不破坏选区，画布在 iframe 里也无所谓（键盘事件跟着焦点走）。
    // 只有剪贴板确实变了才采用，避免把上一次的旧图当成本次结果。
    try {
      await cdp(tabId, 'Page.bringToFront');
    } catch (e) {
      /* ignore */
    }
    try {
      await pressKeyCombo(tabId, 'c', 'KeyC', 67, 12); // 12 = Meta(4) + Shift(8)
      const quick = await waitClipboardImage(tabId, beforeFp, 10000);
      if (quick) return { ok: true, dataUrl: quick, fromClipboard: true, viaShortcut: true };
    } catch (e) {
      /* 快捷键路径失败就继续走右键菜单 */
    }

    // 候选右键点只允许是「用户自己指定过的位置」：
    // 鼠标当前停留处（悬停即意图），以及最后一次在画布上点选的位置（选中的那个画板）。
    // 绝不能去别处乱点——右键会改变画布里的选中对象，点歪了就会导出毫不相干的画板。
    const candidates = [];
    const pushCand = (p) => {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
      if (candidates.some((c) => Math.abs(c.x - p.x) < 4 && Math.abs(c.y - p.y) < 4)) return;
      candidates.push({ x: Math.round(p.x), y: Math.round(p.y) });
    };
    // 用户点选过的画板优先：选中态才是他心里「我要导的那个」
    if (pointerInfo && pointerInfo.selected) pushCand(pointerInfo.selected);
    pushCand(pointerInfo && pointerInfo.pointer);
    pushCand(pointerInfo && pointerInfo.alt);
    if (!candidates.length) {
      return {
        ok: false,
        code: 'NO_POINTER',
        error: '拿不到鼠标位置。请把鼠标停在要导出的画板上，再按 ⌘⇧K',
      };
    }

    // 清空上一次的菜单容器记录
    try {
      await evalInPage(tabId, '(() => { window.__eagleMenuRoots = []; return true; })()');
    } catch (e) {
      /* ignore */
    }

    // 右键之前先记录每个候选点下方到底是什么元素，失败时一起存盘，便于判断坐标是否错位
    let hits = [];
    try {
      hits = await evalInPage(
        tabId,
        `(() => ${JSON.stringify(candidates)}.map((p) => {
  const el = document.elementFromPoint(p.x, p.y);
  if (!el) return { p, el: null };
  const cls = typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 3).join('.') : '';
  return {
    p,
    el: el.tagName + (el.id ? '#' + el.id : '') + cls,
    text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
  };
}))()`
      );
    } catch (e) {
      hits = [];
    }

    // 逐个位置试右键：菜单里只要出现任一已知项，就认为这个位置有效。
    // 单选时「复制 PNG 图片」在「更多 → 复制/粘贴」里，多选时层级可能不同，所以不强制先找「更多」。
    const COPY_MENU = ['复制/粘贴', '复制 / 粘贴', '复制粘贴', 'Copy/Paste'];
    const PNG_TEXTS = ['复制 PNG 图片', '复制PNG图片', '复制 PNG'];
    const MORE_TEXTS = ['更多', 'More'];

    let menuOk = false;
    let lastSeen = [];
    for (const c of candidates) {
      await mouseMove(tabId, c.x, c.y);
      await mouseClick(tabId, c.x, c.y, 'right');
      await sleep(360);
      // 先定位真正的菜单浮层；定位不到说明这个位置没弹出菜单（空白处/未命中对象）
      const rootTexts = await evalInPage(tabId, MENU_ROOT_EXPR);
      lastSeen = rootTexts || [];
      if (!rootTexts) {
        await pressEsc(tabId);
        await sleep(120);
        continue;
      }
      const found =
        (await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS))) ||
        (await evalInPage(tabId, findMenuItemExpr(COPY_MENU))) ||
        (await evalInPage(tabId, findMenuItemExpr(MORE_TEXTS)));
      if (found) {
        menuOk = true;
        break;
      }
      await pressEsc(tabId);
      await sleep(120);
    }
    if (!menuOk) {
      let vp = null;
      try {
        vp = await evalInPage(
          tabId,
          '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, frames: document.querySelectorAll("iframe").length })'
        );
      } catch (e) {
        vp = null;
      }
      const diag = await dumpFailure(tabId, {
        pointer: pointerInfo && pointerInfo.pointer,
        alt: pointerInfo && pointerInfo.alt,
        selected: pointerInfo && pointerInfo.selected,
        candidates,
        hits,
        menu: lastSeen,
        viewport: vp,
      });
      const blankMenu =
        lastSeen.some((t) => /选择全部|粘贴到当前位置|放大|缩小|操作面板/.test(t)) &&
        !lastSeen.some((t) => /更多|复制/.test(t));
      return {
        ok: false,
        code: 'MENU_NOT_FOUND',
        error: blankMenu
          ? '右键落在了空白画布上（菜单里只有「选择全部/粘贴/放大缩小」）。请把鼠标移到画板上再按 ⌘⇧K；或先手动右键画板 →「复制 PNG 图片」，再按 ⌘⇧L 导入'
          : '右键菜单里没有导出相关项（尝试了 ' +
            candidates.length +
            ' 个位置；菜单里看到：' +
            (lastSeen.length ? lastSeen.join(' | ') : '（空）') +
            '）' +
            (diag ? '。已保存现场截图 ' + diag : ''),
      };
    }

    // 展开到「复制 PNG 图片」：可能直接在菜单里，也可能在「更多 → 复制/粘贴」里
    let png = await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS));
    if (!png) {
      let sub = null;
      const more = await evalInPage(tabId, findMenuItemExpr(MORE_TEXTS));
      if (more) {
        await hoverAt(tabId, more.x, more.y);
        await sleep(450);
        await evalInPage(tabId, MENU_ROOT_EXPR); // 子菜单可能是新的浮层，先登记
        sub = await evalInPage(tabId, findMenuItemExpr(COPY_MENU));
        if (!sub) {
          await mouseClick(tabId, more.x, more.y, 'left');
          await sleep(420);
          await evalInPage(tabId, MENU_ROOT_EXPR);
          sub = await evalInPage(tabId, findMenuItemExpr(COPY_MENU));
        }
      }
      if (!sub) sub = await evalInPage(tabId, findMenuItemExpr(COPY_MENU));
      if (sub) {
        await hoverAt(tabId, sub.x, sub.y);
        await sleep(450);
        await evalInPage(tabId, MENU_ROOT_EXPR);
        png = await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS));
        if (!png) {
          await mouseClick(tabId, sub.x, sub.y, 'left');
          await sleep(420);
          await evalInPage(tabId, MENU_ROOT_EXPR);
          png = await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS));
        }
      }
      if (!png) {
        const seen = (await evalInPage(tabId, MENU_ROOT_EXPR)) || lastSeen || [];
        const diag2 = await dumpFailure(tabId, {
          stage: 'MENU_ITEM_MISSING',
          pointer: pointerInfo && pointerInfo.pointer,
          selected: pointerInfo && pointerInfo.selected,
          candidates,
          hits,
          menu: seen,
        });
        return {
          ok: false,
          code: 'MENU_ITEM_MISSING',
          error:
            '菜单里没找到「复制 PNG 图片」（当前菜单：' +
            (seen.length ? seen.join(' | ') : '空') +
            '）' +
            (diag2 ? '。已保存现场截图 ' + diag2 : ''),
        };
      }
    }
    if (png.disabled) {
      return {
        ok: false,
        code: 'MENU_DISABLED',
        error: '「复制 PNG 图片」在菜单里是禁用状态（多选时 js.design 可能不允许这样导出）',
      };
    }

    // 点击「复制 PNG 图片」，并用「菜单是否关闭」确认点击真的生效
    // （不能只看剪贴板是否变化：重复导出同一个画板时内容本来就不变）
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      const item = attempt === 0 ? png : await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS));
      if (!item) break;
      await hoverAt(tabId, item.x, item.y);
      await sleep(140);
      await mouseClick(tabId, item.x, item.y, 'left');
      await sleep(500);
      const stillOpen = await evalInPage(tabId, findMenuItemExpr(PNG_TEXTS));
      clicked = !stillOpen; // 菜单关闭 = 点击生效
      if (!clicked) await sleep(300);
    }
    if (!clicked) {
      return {
        ok: false,
        code: 'CLICK_MISSED',
        error: '点击「复制 PNG 图片」没有生效（菜单仍未关闭），请重试一次',
      };
    }

    // 等 js.design 真正生成完：它在生成期间会显示「正在复制图片，请稍候…」
    // 大画板 / 多选时要好几秒，固定等待会导致读到旧剪贴板内容
    const started = Date.now();
    let sawCopying = false;
    let changed = false;
    let lastNote = 0;
    const deadline = started + 60000;
    while (Date.now() < deadline) {
      await sleep(350);
      let copying = false;
      try {
        copying = !!(await evalInPage(tabId, COPYING_EXPR));
      } catch (e) {
        copying = false;
      }
      if (copying) sawCopying = true;
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (copying && elapsed - lastNote >= 4) {
        lastNote = elapsed;
        pageToast(tabId, '正在生成图片…已等待 ' + elapsed + ' 秒', false, 6000);
      }

      let fp = '';
      try {
        fp = (await evalInPage(tabId, CLIP_FP_EXPR, true)) || '';
      } catch (e) {
        fp = '';
      }
      if (fp && fp !== beforeFp) {
        changed = true;
        break;
      }
      if (sawCopying && !copying) break; // 提示消失 = 生成结束
      if (!sawCopying && Date.now() - started > 25000) break; // 没有任何信号，最多等 25 秒
    }

    const waited = Math.round((Date.now() - started) / 1000);
    if (!changed && !sawCopying) {
      return {
        ok: false,
        code: 'COPY_NOT_TRIGGERED',
        error:
          '点了「复制 PNG 图片」但剪贴板没变化、也没出现复制进度（已等 ' +
          waited +
          ' 秒）。多选时 js.design 可能不支持这样导出，建议逐个选中画板分别导入',
      };
    }
    if (!changed && Date.now() >= deadline) {
      return {
        ok: false,
        code: 'COPY_TIMEOUT',
        error:
          '等待 60 秒仍未复制完成（画板过大或页面资源未加载完）。' +
          '可刷新页面后重试；或手动复制 PNG 后按 ⌘⇧L 导入',
      };
    }

    let dataUrl = null;
    try {
      dataUrl = await evalInPage(tabId, READ_CLIPBOARD_EXPR, true);
    } catch (e) {
      return {
        ok: false,
        code: 'CLIPBOARD_READ_FAILED',
        error: '已触发复制，但读取剪贴板失败：' + e.message,
      };
    }
    if (!dataUrl) {
      return {
        ok: false,
        code: 'CLIPBOARD_READ_FAILED',
        error: '已触发复制，但剪贴板里没有图片',
      };
    }

    // 内容与操作前相同只作为提示：可能是重复导出同一个画板，也可能是没复制成功
    const sameAsBefore = !!(beforeFp && fpOfDataUrl(dataUrl) === beforeFp);
    return { ok: true, dataUrl, sameAsBefore };
  });
}

// 抓取右键点附近的可见文本，便于在失败时回显「菜单里到底有什么」
function nearbyMenuTextExpr(x, y) {
  return `(() => {
  const out = [];
  const cx = ${x};
  const cy = ${y};
  document.querySelectorAll('div,span,li,a,button,p').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 12) return;
    if (r.right < cx - 60 || r.left > cx + 460) return;
    if (r.bottom < cy - 60 || r.top > cy + 700) return;
    const t = (el.textContent || '').replace(/\\s+/g, '');
    if (!t || t.length > 24) return;
    if (el.children.length > 1) return;
    out.push(t);
  });
  return Array.from(new Set(out)).slice(0, 30);
})()`;
}

// js.design 生成图片时的提示条
const COPYING_EXPR = `(() => {
  const els = document.querySelectorAll('div,span,p');
  for (const el of els) {
    const t = el.textContent || '';
    if (t.indexOf('正在复制') === -1 && t.indexOf('正在导出') === -1) continue;
    if (t.length > 60) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
})()`;

// 剪贴板指纹：MIME + base64 长度，用来判断复制前后是否发生变化
function fpOfDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  const mime = s.slice(5, s.indexOf(';'));
  const len = i >= 0 ? s.length - i - 7 : s.length;
  return mime + ':' + len;
}

const CLIP_FP_EXPR = `navigator.clipboard.read().then(async (items) => {
  for (const item of items) {
    const type = (item.types || []).find((t) => String(t).indexOf('image/') === 0);
    if (!type) continue;
    const blob = await item.getType(type);
    return type + ':' + (4 * Math.ceil(blob.size / 3));
  }
  return '';
})`;

async function getPointer(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_POINTER' });
    if (r && r.pointer && typeof r.pointer.x === 'number') {
      return {
        pointer: r.pointer,
        alt: r.alt || null,
        selected: r.selected || null,
      };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

async function runAutoImport(tabId, opts) {
  const options = opts || {};
  const pointer = options.pointer || (await getPointer(tabId));
  const info = Object.assign({}, pointer || {}, {
    preferClipboard: options.preferClipboard === true,
  });
  const copied = await autoCopyPng(tabId, info);
  if (!copied.ok) {
    const err = new Error(copied.error);
    err.code = copied.code || '';
    throw err;
  }
  const result = await importItems(
    [{ url: copied.dataUrl, name: options.name || options.pageTitle || '' }],
    options.folderId,
    options.referer,
    options.pageTitle
  );
  result.sameAsBefore = !!copied.sameAsBefore;
  result.fromClipboard = !!copied.fromClipboard;
  result.viaShortcut = !!copied.viaShortcut;
  if (result.imported) {
    // 记住这张，避免下次同一张剪贴板内容被重复导入
    chrome.storage.local.set({ lastImportedClipFp: fpOfDataUrl(copied.dataUrl) });
  }
  return result;
}

function flashBadge(text) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: text === '✓' ? '#2e5bff' : '#d23b3b' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch (e) {
    /* ignore */
  }
}

function pageToast(tabId, text, isError, duration) {
  try {
    chrome.tabs
      .sendMessage(tabId, { type: 'SHOW_TOAST', text, isError, duration })
      .catch(() => {});
  } catch (e) {
    /* ignore */
  }
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'auto_import' && command !== 'clipboard_import') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const isClip = command === 'clipboard_import';
    flashBadge('…');
    pageToast(
      tab.id,
      isClip ? '正在导入剪贴板里的图片…' : '正在复制画板，请稍候…',
      false,
      120000
    );
    try {
      const s = await chrome.storage.local.get(['lastFolderId', 'lastFolderName']);
      const res = await runAutoImport(tab.id, {
        folderId: s.lastFolderId || undefined,
        referer: (tab.url || '').split('#')[0],
        pageTitle: tab.title || '',
        preferClipboard: isClip,
      });
      if (res && res.imported) {
        flashBadge('✓');
        pageToast(
          tab.id,
          res.viaShortcut
            ? '已复制选中画板并导入 Eagle'
            : res.fromClipboard
              ? '已导入剪贴板中的图片'
              : '已导入 Eagle' + (res.sameAsBefore ? '（内容与上次相同）' : ''),
          false,
          2600
        );
      } else {
        flashBadge('!');
        pageToast(tab.id, '导入失败：Eagle 没有真正入库', true, 6000);
      }
    } catch (e) {
      console.warn('[Eagle] 自动复制导入失败：', e.message);
      flashBadge('!');
      pageToast(tab.id, '导入失败：' + e.message, true, 8000);
      try {
        chrome.action.setTitle({ tabId: tab.id, title: '自动导入失败：' + e.message });
      } catch (err) {
        /* ignore */
      }
    }
  });
}

// 与 popup / content script 通信
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CHECK') {
    eagleRequest('/api/application/info')
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_FOLDERS') {
    eagleRequest('/api/folder/list')
      .then((d) => sendResponse({ ok: true, folders: d.data || [] }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'ADD_IMAGES') {
    importItems(msg.items || [], msg.folderId, msg.referer, msg.pageTitle)
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'AUTO_COPY') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: '拿不到标签页 id' });
      return false;
    }
    runAutoImport(tabId, msg)
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code || '' }));
    return true;
  }

  if (msg.type === 'IMPORT_IMAGES') {
    importItems(msg.items || [], msg.folderId, msg.referer, msg.pageTitle)
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'THUMB') {
    if (/^https?:/i.test(msg.url || '')) {
      makeThumbnail(msg.url, msg.referer)
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    sendResponse({ ok: false, error: 'unsupported-url' });
    return false;
  }

  if (msg.type === 'FETCH_DATA') {
    if (/^https?:/i.test(msg.url || '')) {
      fetchOriginalDataUrl(msg.url, msg.referer)
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    sendResponse({ ok: false, error: 'unsupported-url' });
    return false;
  }
});

// ---------- 右键菜单：导入到 Eagle（含文件夹子菜单）----------
const MENU_PARENT = 'eagle-import';

function flattenFolders(folders, depth, out) {
  out = out || [];
  folders.forEach((f) => {
    out.push({ id: f.id, name: f.name, depth });
    if (f.children && f.children.length) flattenFolders(f.children, depth + 1, out);
  });
  return out;
}

function findFolderName(folders, id) {
  let found = '';
  (function walk(list) {
    list.forEach((f) => {
      if (f.id === id) found = f.name;
      if (f.children) walk(f.children);
    });
  })(folders || []);
  return found;
}

// 根据文件夹列表（或上一次缓存）重建右键菜单
function buildMenu(folders) {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PARENT,
      title: '导入到 Eagle',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'eagle-root',
      parentId: MENU_PARENT,
      title: '（库根目录）',
      contexts: ['image'],
    });
    flattenFolders(folders, 0).forEach((f) => {
      chrome.contextMenus.create({
        id: 'eagle-folder:' + f.id,
        parentId: MENU_PARENT,
        title: '　'.repeat(f.depth) + (f.depth ? '└ ' : '') + f.name,
        contexts: ['image'],
      });
    });
  });
}

// 从 Eagle 拉取最新文件夹并刷新菜单；Eagle 未运行时回退到上次缓存
async function refreshContextMenu() {
  let folders = [];
  try {
    const res = await eagleRequest('/api/folder/list');
    folders = (res && res.data) || [];
    await chrome.storage.local.set({ eagleFolders: folders });
  } catch (e) {
    const s = await chrome.storage.local.get(['eagleFolders']);
    folders = s.eagleFolders || [];
  }
  buildMenu(folders);
}

// 扩展更新/重载后，老页面里的 content script 会失效（点击就报「扩展上下文已失效」）。
// 这里主动给所有已打开的普通网页重新注入，用户无需手动刷新。
async function reinjectContentScripts() {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !/^https?:/i.test(tab.url || '')) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js'],
        });
      } catch (e) {
        /* 受保护页面 / 无权限，忽略 */
      }
    })
  );
}

chrome.runtime.onInstalled.addListener(() => {
  refreshContextMenu();
  reinjectContentScripts();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    reinjectContentScripts();
  });
}

// 定时刷新文件夹菜单（Eagle 文件夹可能变化）
chrome.alarms.create('refreshEagleMenu', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refreshEagleMenu') {
    refreshContextMenu();
    cleanupStaleTempFiles();
  }
});

// Service Worker 每次唤醒时也尝试刷新一次
refreshContextMenu().catch(() => {});
// 顺便清掉上次运行残留的 Referer 改写规则
clearRefererRules();
// 上次异常退出可能留下临时文件，超过 30 分钟的一律清掉
cleanupStaleTempFiles();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.srcUrl) return;
  let referer;
  try {
    referer = tab && tab.url ? tab.url.split('#')[0] : undefined;
  } catch (e) {
    referer = undefined;
  }
  let folderId;
  if (info.menuItemId === 'eagle-root') {
    folderId = undefined;
  } else if (String(info.menuItemId).startsWith('eagle-folder:')) {
    folderId = String(info.menuItemId).slice('eagle-folder:'.length);
    chrome.storage.local.get(['eagleFolders'], ({ eagleFolders }) => {
      const name = findFolderName(eagleFolders, folderId);
      chrome.storage.local.set({ lastFolderId: folderId, lastFolderName: name });
    });
  } else {
    return;
  }

  const items = [{ url: info.srcUrl, name: fileNameFromUrl(info.srcUrl) }];
  importItems(items, folderId, referer, tab && tab.title).catch(() => {});
});
