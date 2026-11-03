/** 两个平台共用的 DOM 工具 */
(() => {
  const HT = (window.HT = window.HT || {});

  const AVATAR_HINTS = /avatar|head|portrait|user-icon|face/i;

  function scoreImg(img) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src) return -1000;
    if (src.startsWith('data:')) return -500;
    if (AVATAR_HINTS.test(src)) return -1000;
    if (AVATAR_HINTS.test(img.className || '')) return -1000;

    let s = 0;
    if (/hdslb\.com/.test(src)) s += 40;
    if (/douyinpic\.com|byteimg\.com|ibyteimg\.com/.test(src)) s += 40;
    if (/aweme/i.test(src)) s += 8;
    if (/\.(jpg|jpeg|png|webp|avif)/i.test(src)) s += 4;

    const r = img.getBoundingClientRect();
    s += Math.min(30, (r.width * r.height) / 6000);
    s += Math.min(10, r.width / 30);
    return s;
  }

  /** 在一张卡片里挑出最像"封面"的元素：img 优先，其次带 background-image 的块 */
  function pickCover(root) {
    if (!root || !root.querySelectorAll) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const img of root.querySelectorAll('img')) {
      const s = scoreImg(img);
      if (s > bestScore) {
        bestScore = s;
        best = img;
      }
    }
    if (best && bestScore > 0) return best;

    for (const el of root.querySelectorAll('[style*="background-image"]')) {
      const bg = el.style.backgroundImage || '';
      if (!bg || bg === 'none' || bg.startsWith('url("data:')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 40) continue;
      return el;
    }
    return null;
  }

  /** 从元素向上找最近的卡片容器 */
  function closestCard(el, selectors) {
    let node = el;
    let depth = 0;
    while (node && depth < 8) {
      for (const sel of selectors) {
        if (node.matches && node.matches(sel)) return node;
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  HT.util = { pickCover, closestCard, scoreImg };
})();
