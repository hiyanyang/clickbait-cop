/**
 * background service worker
 * 职责：
 *  1. 代理 B 站 videoshot 接口（content script 直接跨域会撞 CORS）
 *  2. 拉取雪碧图、裁剪出目标帧，转成 dataURL 回给页面
 *  3. LRU 缓存裁剪结果（抖音的签名 URL 会过期，缓存成品而不是 URL）
 */

const CACHE_LIMIT = 400;
const MAX_CONCURRENT = 3;

const cache = new Map();      // key -> { dataUrl, meta }
const pending = new Map();    // key -> Promise
let active = 0;
const waiters = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = waiters.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiters.push(run);
  });
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/* ------------------------------------------------------------------ *
 * 磁盘缓存（IndexedDB）
 * 内存缓存随 service worker 休眠丢失，磁盘缓存让回访同一个视频近乎 0 延迟。
 * 存的是裁好的成品图，不是抖音那种带签名会过期的 URL。
 * ------------------------------------------------------------------ */

const IDB_NAME = 'ht-frames';
const IDB_STORE = 'frames';
const IDB_LIMIT = 1500;
let dbPromise = null;
let writesSinceSweep = 0;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const os = db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v && v.dataUrl ? { dataUrl: v.dataUrl, meta: v.meta } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(key, dataUrl, meta) {
  openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ key, dataUrl, meta, ts: Date.now() });
    } catch {
      /* ignore */
    }
    if (++writesSinceSweep >= 40) {
      writesSinceSweep = 0;
      idbSweep();
    }
  });
}

function idbSweep() {
  openDb().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        let over = countReq.result - IDB_LIMIT;
        if (over <= 0) return;
        const cursorReq = store.index('ts').openCursor();
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result;
          if (!cur || over <= 0) return;
          cur.delete();
          over--;
          cur.continue();
        };
      };
    } catch {
      /* ignore */
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ *
 * 雪碧图裁剪
 * ------------------------------------------------------------------ */

async function loadBitmap(url) {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  const res = await fetch(abs, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error('sprite http ' + res.status);
  const blob = await res.blob();
  if (!blob.size) throw new Error('sprite empty');
  return createImageBitmap(blob);
}

/**
 * 从雪碧图里裁出一格。
 * @param {string} url     雪碧图地址
 * @param {number} xLen    列数
 * @param {number} yLen    行数
 * @param {number} xSize   单格宽（0 表示按图宽推算）
 * @param {number} ySize   单格高（0 表示按图高推算）
 * @param {number} cell    该图内部的格序号（从 0 开始，按行优先）
 */
async function cropCell(url, xLen, yLen, xSize, ySize, cell) {
  const bmp = await loadBitmap(url);
  try {
    // 抖音有时只给 img_x_size、不给行列数，按图片实际尺寸反推
    let cw = xSize > 0 ? xSize : 0;
    let ch = ySize > 0 ? ySize : 0;
    let cols = xLen > 0 ? xLen : cw > 0 ? Math.round(bmp.width / cw) : 5;
    let rows = yLen > 0 ? yLen : ch > 0 ? Math.round(bmp.height / ch) : 5;

    if (!cw) cw = Math.floor(bmp.width / cols);
    if (!ch) ch = Math.floor(bmp.height / rows);
    if (!cw || !ch || cols < 1 || rows < 1) throw new Error('bad cell size');

    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const sx = col * cw;
    const sy = row * ch;
    if (sx + 4 > bmp.width || sy + 4 > bmp.height) throw new Error('cell out of range');

    const w = Math.min(cw, bmp.width - sx);
    const h = Math.min(ch, bmp.height - sy);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    return await blobToDataUrl(out);
  } finally {
    if (bmp && typeof bmp.close === 'function') bmp.close();
  }
}

/** 按比例位置从总帧数里挑一帧 */
function pickFrameIndex(total, position) {
  if (total <= 0) return 0;
  if (total === 1) return 0;
  const clamped = Math.min(0.98, Math.max(0.02, position));
  return Math.min(total - 1, Math.max(0, Math.round(clamped * (total - 1))));
}

/* ------------------------------------------------------------------ *
 * B 站
 * ------------------------------------------------------------------ */

async function fetchBiliShot(bvid) {
  const url =
    'https://api.bilibili.com/x/player/videoshot?bvid=' +
    encodeURIComponent(bvid) +
    '&index=1';
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('videoshot http ' + res.status);
  const json = await res.json();
  if (json.code !== 0) throw new Error('videoshot code ' + json.code + ' ' + (json.message || ''));
  const d = json.data;
  if (!d) throw new Error('videoshot empty');

  const images = Array.isArray(d.image) ? d.image : d.image ? [d.image] : [];
  if (!images.length) throw new Error('no sprite');

  const index = Array.isArray(d.index) ? d.index : [];
  const xLen = Number(d.img_x_len) || 10;
  const yLen = Number(d.img_y_len) || 10;
  const per = xLen * yLen;
  // index.length 才是真实帧数，最后一格往往是空的，不能拿 per * images.length 当总帧数
  const total = index.length || per * images.length;

  return {
    urls: images,
    xLen,
    yLen,
    xSize: Number(d.img_x_size) || 0,
    ySize: Number(d.img_y_size) || 0,
    total,
    per,
    times: index
  };
}

async function buildBilibiliFrame(bvid, position) {
  const shot = await fetchBiliShot(bvid);
  const idx = pickFrameIndex(shot.total, position);
  const imgIdx = Math.floor(idx / shot.per);
  const cell = idx % shot.per;
  const url = shot.urls[Math.min(imgIdx, shot.urls.length - 1)];
  const dataUrl = await cropCell(url, shot.xLen, shot.yLen, shot.xSize, shot.ySize, cell);
  const time = shot.times[idx];
  return {
    dataUrl,
    meta: {
      platform: 'bilibili',
      id: bvid,
      frame: idx,
      total: shot.total,
      time: typeof time === 'number' ? time : null
    }
  };
}

/* ------------------------------------------------------------------ *
 * 抖音
 * ------------------------------------------------------------------ */

async function buildDouyinFrame(thumbs, position) {
  const urls = (thumbs.urls || []).filter(Boolean);
  if (!urls.length) throw new Error('no sprite');
  const xLen = Number(thumbs.xLen) || 5;
  const yLen = Number(thumbs.yLen) || 5;
  const per = xLen * yLen;
  const total = Number(thumbs.num) > 0 ? Number(thumbs.num) : per * urls.length;
  const idx = pickFrameIndex(total, position);
  const imgIdx = Math.floor(idx / per);
  const cell = idx % per;
  const url = urls[Math.min(imgIdx, urls.length - 1)];
  const dataUrl = await cropCell(
    url,
    xLen,
    yLen,
    Number(thumbs.xSize) || 0,
    Number(thumbs.ySize) || 0,
    cell
  );
  return {
    dataUrl,
    meta: { platform: 'douyin', frame: idx, total }
  };
}

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

async function handleFrameRequest(msg) {
  const position = Number(msg.position) || 0.5;
  const posTag = position.toFixed(2);
  const platform = msg.platform;

  let key;
  if (platform === 'bilibili') {
    if (!/^BV[0-9A-Za-z]{10}$/.test(msg.id || '')) throw new Error('bad bvid');
    key = `bili:${msg.id}:${posTag}`;
  } else if (platform === 'douyin') {
    if (!msg.thumbs || !msg.thumbs.urls || !msg.thumbs.urls.length) throw new Error('no thumbs');
    // key 只用视频 ID，签名 URL 每次都变，带进去会让缓存全部失效
    key = `dy:${msg.id}:${posTag}`;
  } else {
    throw new Error('unknown platform');
  }

  const hit = cacheGet(key);
  if (hit) return { ok: true, dataUrl: hit.dataUrl, meta: hit.meta, cached: 'mem' };

  const diskHit = await idbGet(key);
  if (diskHit) {
    cacheSet(key, diskHit);
    return { ok: true, dataUrl: diskHit.dataUrl, meta: diskHit.meta, cached: 'disk' };
  }

  if (pending.has(key)) return pending.get(key);

  const task = withSlot(async () => {
    const result =
      platform === 'bilibili'
        ? await buildBilibiliFrame(msg.id, position)
        : await buildDouyinFrame(msg.thumbs, position);
    cacheSet(key, result);
    idbPut(key, result.dataUrl, result.meta);
    return { ok: true, dataUrl: result.dataUrl, meta: result.meta, cached: false };
  }).finally(() => pending.delete(key));

  pending.set(key, task);
  return task;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'ht:frame') return;

  handleFrameRequest(msg)
    .then(sendResponse)
    .catch((err) => {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // 异步
});
