/** 抖音适配器：消费 hook 抓到的 big_thumbs，按 aweme_id 匹配到卡片封面 */
(() => {
  const HT = (window.HT = window.HT || {});
  if (!/(^|\.)douyin\.com$/.test(location.hostname)) return;

  const SOURCE = 'ht-hook-v1';
  const ID_RE = /\/video\/(\d{6,})/;
  const thumbsMap = new Map(); // awemeId -> thumbs
  let onData = null;

  const CARD_SELECTORS = [
    '.discover-video-card-item',
    '.waterfall-videoCardContainer',
    'li[data-e2e="scroll-list-item"]',
    '[data-e2e="search-result-item"]',
    '[data-e2e="feed-item"]',
    'li'
  ];

  function normalize(raw) {
    if (!raw || !Array.isArray(raw.urls) || !raw.urls.length) return null;
    const urls = raw.urls.filter((u) => typeof u === 'string' && u.length > 10);
    if (!urls.length) return null;
    const xLen = Number(raw.xLen) || 0;
    const yLen = Number(raw.yLen) || 0;
    const xSize = Number(raw.xSize) || 0;
    // 精选页只给 img_x_size、不给行列数，交给 background 按图片尺寸推算
    if (!xLen && !xSize) return null;
    const num = Number(raw.num) || 0;
    if (num && num < 4) return null;
    return {
      urls,
      xLen,
      yLen,
      xSize,
      ySize: Number(raw.ySize) || 0,
      num,
      interval: Number(raw.interval) || 0,
      duration: Number(raw.duration) || 0
    };
  }

  function remember(items) {
    let added = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const t = normalize(it.thumbs);
      if (!t) continue;
      thumbsMap.set(String(it.id), t);
      added++;
    }
    if (added && typeof onData === 'function') onData();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== SOURCE || d.type !== 'aweme-thumbs') return;
    remember(d.items || []);
  });

  /** 兜底：老版 SSR 页面的 RENDER_DATA */
  function readRenderData() {
    const el = document.getElementById('RENDER_DATA');
    if (!el || !el.textContent) return;
    if (el.dataset.htRead === '1') return;
    el.dataset.htRead = '1';
    try {
      const json = JSON.parse(decodeURIComponent(el.textContent));
      const found = [];
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12) return;
        const id = node.aweme_id || node.awemeId;
        if (id && node.video) found.push(node);
        for (const k in node) {
          const v = node[k];
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(json, 0);
      const items = found.map((a) => {
        let bt = (a.video && a.video.big_thumbs) || {};
        if (Array.isArray(bt)) bt = bt[0] || {};
        const urls = Array.isArray(bt.img_urls)
          ? bt.img_urls
          : bt.img_url
            ? [bt.img_url]
            : [];
        return {
          id: String(a.aweme_id || a.awemeId),
          thumbs: {
            urls,
            xLen: bt.img_x_len,
            yLen: bt.img_y_len,
            xSize: bt.img_x_size,
            ySize: bt.img_y_size,
            num: bt.img_num
          }
        };
      });
      remember(items);
    } catch {
      /* ignore */
    }
  }

  /** 从元素向上找 aweme_id：优先 data-aweme-id，其次 /video/<id> 链接 */
  function idFrom(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 10) {
      const aid = node.getAttribute && node.getAttribute('data-aweme-id');
      if (aid && /^\d{10,}$/.test(aid)) return aid;
      node = node.parentElement;
      depth++;
    }

    node = el;
    depth = 0;
    while (node && depth < 10) {
      const href = node.getAttribute && node.getAttribute('href');
      if (href) {
        const m = href.match(ID_RE);
        if (m) return m[1];
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function pickCardCover(card) {
    const direct =
      card.querySelector('img.discover-video-card-img') ||
      card.querySelector('.discover-video-card-img');
    if (direct) return direct;
    return HT.util.pickCover(card);
  }

  function pushIfOk(out, used, id, card) {
    const thumbs = thumbsMap.get(id);
    if (!thumbs) return;

    const cover = pickCardCover(card);
    if (!cover || used.has(cover) || !cover.isConnected) return;

    const r = cover.getBoundingClientRect();
    if (r.width && r.width < 60) return;

    used.add(cover);
    out.push({ platform: 'douyin', id, cover, thumbs });
  }

  function collect() {
    readRenderData();
    if (!thumbsMap.size) return [];

    const out = [];
    const used = new Set();

    // 路径 A：抖音精选 / 双列信息流 —— 卡片自带 data-aweme-id，页面里没有 <a> 链接
    for (const card of document.querySelectorAll('[data-aweme-id]')) {
      const id = card.getAttribute('data-aweme-id');
      if (!id || !/^\d{10,}$/.test(id)) continue;
      pushIfOk(out, used, id, card);
    }

    // 路径 B：首页单列、搜索、个人主页 —— 用 <a href="/video/<id>">
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const m = (a.getAttribute('href') || '').match(ID_RE);
      if (!m) continue;
      const id = m[1];
      const card = HT.util.closestCard(a, CARD_SELECTORS) || a.parentElement || a;
      pushIfOk(out, used, id, card);
    }

    return out;
  }

  HT.douyin = {
    collect,
    idFrom,
    setOnData(fn) {
      onData = fn;
    },
    /** 让 MAIN world 把启动早期抓到的数据回放一遍 */
    requestBuffer() {
      try {
        window.postMessage({ source: 'ht-content', type: 'ht-request-buffer' }, '*');
      } catch {
        /* ignore */
      }
    },
    stats() {
      return { known: thumbsMap.size };
    }
  };
})();
