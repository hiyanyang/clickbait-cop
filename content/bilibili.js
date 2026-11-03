/** B 站适配器：从卡片链接取 BV 号，交给 background 换快照帧 */
(() => {
  const HT = (window.HT = window.HT || {});
  if (!/(^|\.)bilibili\.com$/.test(location.hostname)) return;

  const CARD_SELECTORS = [
    '.bili-video-card',
    '.bili-video-card__wrap',
    '.video-list-item',
    '.rank-item',
    '.video-page-card-small',
    '.card-box',
    '.small-item',
    '.video-card',
    '.bili-dyn-card-video',
    'li'
  ];

  const BV_RE = /\/video\/(BV[0-9A-Za-z]{10})/;

  function bvidFrom(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 8) {
      const href = node.getAttribute && node.getAttribute('href');
      if (href) {
        const m = href.match(BV_RE);
        if (m) return m[1];
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  function collect() {
    const out = [];
    const used = new Set();

    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const m = (a.getAttribute('href') || '').match(BV_RE);
      if (!m) continue;
      const bvid = m[1];

      const card =
        HT.util.closestCard(a, CARD_SELECTORS) || a.parentElement || a;

      let cover = HT.util.pickCover(card);
      if (!cover) cover = HT.util.pickCover(a);
      if (!cover || used.has(cover)) continue;

      // 头像、图标尺寸太小的一律跳过
      const r = cover.getBoundingClientRect();
      if (r.width && r.width < 60) continue;

      used.add(cover);
      out.push({ platform: 'bilibili', id: bvid, cover });
    }
    return out;
  }

  HT.bilibili = { collect, bvidFrom };
})();
