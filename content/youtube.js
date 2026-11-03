/**
 * YouTube 适配器
 *
 * YouTube 会为每个视频自动生成三张截图，正好是 25% / 50% / 75%：
 *   i.ytimg.com/vi/<id>/maxres{1,2,3}.jpg   1280×720，高清视频才有
 *   i.ytimg.com/vi/<id>/hq{1,2,3}.jpg       480×360，基本都有（带黑边）
 * 与 B 站、抖音不同，这里不需要请求接口、不需要裁剪，直接换地址即可。
 *
 * 注意：不存在的帧 YouTube 返回的是 120×90 的灰色占位图，而且 HTTP 是 200，
 * 所以必须用 naturalWidth 判断，否则封面会变成一片灰。
 */
(() => {
  const HT = (window.HT = window.HT || {});
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const ORIGIN = 'https://i.ytimg.com';
  const PLACEHOLDER_WIDTH = 120;

  // 缩略图地址形如 https://i.ytimg.com/vi/<11 位 id>/hq720.jpg
  const THUMB_RE = /\/vi(?:_webp)?\/([\w-]{11})\//;
  // 竖版短片（Shorts）的封面是 9:16，换成横版帧会被拉扁，跳过
  const SHORTS_SRC_RE = /\/(oar|frame)/;

  const CARD_ANCHOR =
    'a[href*="/watch?v="], ytd-rich-item-renderer, ytd-video-renderer, ' +
    'ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ' +
    'ytd-playlist-panel-video-renderer, yt-lockup-view-model, ytd-watch-card-compact-video-renderer';

  const cache = new Map(); // "<id>:<n>" -> Promise<url | null>
  const CACHE_LIMIT = 800;

  function probe(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > PLACEHOLDER_WIDTH);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  function frameNo(position) {
    if (position <= 0.34) return 1;
    if (position <= 0.67) return 2;
    return 3;
  }

  /** 优先 1280×720 的 maxres，没有就退回 480×360 的 hq */
  function resolve(id, position) {
    const n = frameNo(position);
    const key = `${id}:${n}`;
    let task = cache.get(key);
    if (task) return task;

    task = (async () => {
      for (const name of [`maxres${n}`, `hq${n}`]) {
        const url = `${ORIGIN}/vi/${id}/${name}.jpg`;
        if (await probe(url)) return url;
      }
      return null;
    })();

    if (cache.size >= CACHE_LIMIT) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(key, task);
    return task;
  }

  function srcOf(img) {
    return img.getAttribute('src') || img.currentSrc || '';
  }

  function idFrom(img) {
    if (!img || img.tagName !== 'IMG') return null;
    const src = srcOf(img);
    if (SHORTS_SRC_RE.test(src)) return null;
    const m = THUMB_RE.exec(src);
    if (m) return m[1];

    // 极端情况：YouTube 换了 CDN 域名，退回从卡片链接里取
    let node = img;
    let depth = 0;
    while (node && depth < 10) {
      const href = node.getAttribute && node.getAttribute('href');
      if (href) {
        const v = /[?&]v=([\w-]{11})/.exec(href);
        if (v) return v[1];
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function collect() {
    const out = [];
    const used = new Set();

    for (const img of document.querySelectorAll('img[src*="ytimg.com/vi/"]')) {
      if (used.has(img)) continue;
      // 只处理卡片里的缩略图，播放器海报和头像不算
      if (!img.closest(CARD_ANCHOR)) continue;
      if (img.closest('a[href*="/shorts/"]')) continue;

      const id = idFrom(img);
      if (!id) continue;

      const r = img.getBoundingClientRect();
      if (r.width && r.width < 60) continue;

      used.add(img);
      out.push({ platform: 'youtube', id, cover: img });
    }
    return out;
  }

  HT.youtube = { collect, idFrom, resolve };
})();
