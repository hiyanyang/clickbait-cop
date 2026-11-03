/**
 * 以 MAIN world 在 document_start 注入，hook 页面自身的 fetch / XHR，
 * 捞出抖音返回体里的 aweme.video.big_thumbs（进度条预览雪碧图），
 * 再通过 postMessage 递给隔离环境的 content script。
 *
 * 这里不主动请求接口，只复用页面已经拿到的数据 —— 不需要签名、不带额外风控。
 */
(() => {
  if (window.__HT_HOOK_V1__) return;
  window.__HT_HOOK_V1__ = true;

  const SOURCE = 'ht-hook-v1';
  const URL_HINT = /aweme|feed|search|post|video|recommend|related|tab/i;
  const MAX_NODES = 40000;

  /** 深度遍历，收集同时带 aweme_id 与 video 的节点 */
  function collectAwemes(node, out, depth, budget) {
    if (!node || typeof node !== 'object') return;
    if (budget.n++ > MAX_NODES) return;
    if (depth > 14) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        collectAwemes(node[i], out, depth + 1, budget);
        if (out.length >= 80) return;
      }
      return;
    }

    const id = node.aweme_id || node.awemeId;
    if (id && node.video) out.push(node);

    for (const key in node) {
      if (key === 'video' || key === 'author' || key === 'music') continue;
      const v = node[key];
      if (v && typeof v === 'object') {
        collectAwemes(v, out, depth + 1, budget);
        if (out.length >= 80) return;
      }
    }
  }

  function normalizeThumbs(video) {
    if (!video) return null;
    // 实测：抖音的 big_thumbs 有时是对象，有时是数组（精选页 / module/feed 返回数组）
    let bt = video.big_thumbs || video.bigThumbs || video.big_thumb || null;
    if (Array.isArray(bt)) bt = bt[0];
    if (!bt || typeof bt !== 'object') return null;

    let urls = bt.img_urls || bt.imgUrls || null;
    if (!Array.isArray(urls)) {
      urls = bt.img_url ? [bt.img_url] : bt.imgUrl ? [bt.imgUrl] : [];
    }
    urls = urls.filter((u) => typeof u === 'string' && u.length > 10);
    if (!urls.length) return null;

    const num = Number(bt.img_num || bt.imgNum || 0) || 0;
    // 实测精选页可能只给 img_x_size，不给行列数 —— 留给 background 按图片实际尺寸推算
    const xLen = Number(bt.img_x_len || bt.imgXLen || 0) || 0;
    const yLen = Number(bt.img_y_len || bt.imgYLen || 0) || 0;
    const xSize = Number(bt.img_x_size || bt.imgXSize || 0) || 0;
    if (!xLen && !xSize) return null;
    if (num && num < 4) return null; // 帧太少，换过去也没意义

    return {
      urls,
      xLen,
      yLen,
      xSize,
      ySize: Number(bt.img_y_size || bt.imgYSize || 0) || 0,
      num,
      interval: Number(bt.interval || 0) || 0,
      duration: Number(bt.duration || video.duration || 0) || 0
    };
  }

  const buffer = new Map(); // 首屏数据常在 content script 就位前就返回了，先存下来

  function post(items) {
    if (!items.length) return;
    for (const it of items) {
      if (it && it.id) buffer.set(it.id, it.thumbs);
    }
    while (buffer.size > 500) {
      buffer.delete(buffer.keys().next().value);
    }
    window.postMessage({ source: SOURCE, type: 'aweme-thumbs', items }, '*');
  }

  // content script 就位后回放
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'ht-content' || d.type !== 'ht-request-buffer') return;
    if (!buffer.size) return;
    const items = [];
    for (const [id, thumbs] of buffer) items.push({ id, thumbs });
    window.postMessage({ source: SOURCE, type: 'aweme-thumbs', items }, '*');
  });

  function parseText(text) {
    if (typeof text !== 'string' || text.length < 200) return;
    if (text.length > 6_000_000) return; // 大响应不解析，避免拖慢页面
    if (text.indexOf('aweme_id') === -1 && text.indexOf('awemeId') === -1) return;

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const found = [];
    collectAwemes(json, found, 0, { n: 0 });
    if (!found.length) return;

    const items = [];
    for (const a of found) {
      const id = String(a.aweme_id || a.awemeId || '');
      if (!id) continue;
      const thumbs = normalizeThumbs(a.video);
      if (!thumbs) continue;
      items.push({ id, thumbs });
    }
    post(items);
  }

  /* ---- fetch ---- */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input && input.url;
        if (url && URL_HINT.test(String(url))) {
          p.then((res) => {
            try {
              res
                .clone()
                .text()
                .then(parseText)
                .catch(() => {});
            } catch {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return p;
    };
  }

  /* ---- XHR ---- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__htUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener('load', function () {
        try {
          if (!this.__htUrl || !URL_HINT.test(String(this.__htUrl))) return;
          parseText(this.responseText);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    return origSend.apply(this, args);
  };
})();
