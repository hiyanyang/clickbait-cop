/**
 * 公共引擎：扫描卡片 → 取帧 → 替换封面 → 可恢复。
 * 平台差异全部收敛在 bilibili.js / douyin.js 里。
 */
(() => {
  if (window.__HT_ENGINE__) return;
  window.__HT_ENGINE__ = true;

  const HT = (window.HT = window.HT || {});

  const POSITIONS = { early: 0.25, middle: 0.5, late: 0.75 };
  const DEFAULTS = {
    enabled: true,
    siteBilibili: true,
    siteDouyin: true,
    siteYouTube: true,
    position: 'middle'
  };

  const isBili = /(^|\.)bilibili\.com$/.test(location.hostname);
  const isDouyin = /(^|\.)douyin\.com$/.test(location.hostname);
  const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);

  const MAX_CONCURRENT = 6;
  const SCAN_DEBOUNCE = 120;
  const MAX_PER_ROUND = 40;

  const settings = { ...DEFAULTS };
  const elState = new WeakMap(); // el -> { kind, src, srcset, sizes, picture, bg, written, key }
  const pending = new Map();     // el -> { item, key }
  const activeEls = new Set();

  let active = 0;
  let replacedCount = 0;
  let failCount = 0;

  /* ---------------- 元素状态 ---------------- */

  function readValue(el) {
    return el.tagName === 'IMG'
      ? el.getAttribute('src') || ''
      : el.style.backgroundImage || '';
  }

  function snapshot(el) {
    if (el.tagName === 'IMG') {
      const pic = el.closest('picture');
      const sources = pic ? Array.from(pic.querySelectorAll('source')) : [];
      return {
        kind: 'img',
        src: el.getAttribute('src'),
        srcset: el.getAttribute('srcset'),
        sizes: el.getAttribute('sizes'),
        picture: sources.map((s) => ({
          el: s,
          srcset: s.getAttribute('srcset'),
          type: s.getAttribute('type')
        }))
      };
    }
    return {
      kind: 'bg',
      bg: el.style.backgroundImage,
      bgColor: el.style.backgroundColor
    };
  }

  function applyFrame(el, dataUrl, key) {
    let st = elState.get(el);
    if (st && readValue(el) !== st.written) {
      // 页面自己改写了图片，原快照已失效
      elState.delete(el);
      el.classList.remove('ht-replaced');
      el.removeAttribute('data-ht');
      st = null;
    }
    if (!st) {
      st = snapshot(el);
      elState.set(el, st);
    }
    st.key = key;

    if (st.kind === 'img') {
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      for (const s of st.picture) {
        s.el.removeAttribute('srcset');
        s.el.removeAttribute('type');
      }
      el.setAttribute('src', dataUrl);
    } else {
      el.style.backgroundImage = `url("${dataUrl}")`;
    }

    st.written = readValue(el);
    el.classList.add('ht-replaced');
    el.setAttribute('data-ht', '1');
    el.removeAttribute('data-ht-fail');
  }

  function restore(el) {
    const st = elState.get(el);
    el.classList.remove('ht-replaced');
    el.removeAttribute('data-ht');
    if (!st) return;
    elState.delete(el);

    if (st.kind === 'img') {
      if (st.src === null) el.removeAttribute('src');
      else el.setAttribute('src', st.src);
      if (st.srcset === null) el.removeAttribute('srcset');
      else el.setAttribute('srcset', st.srcset);
      if (st.sizes === null) el.removeAttribute('sizes');
      else el.setAttribute('sizes', st.sizes);
      for (const s of st.picture) {
        if (s.srcset === null) s.el.removeAttribute('srcset');
        else s.el.setAttribute('srcset', s.srcset);
        if (s.type === null) s.el.removeAttribute('type');
        else s.el.setAttribute('type', s.type);
      }
    } else if (st.bg !== undefined) {
      el.style.backgroundImage = st.bg;
    }
  }

  function restoreAll() {
    for (const el of document.querySelectorAll('.ht-replaced')) restore(el);
    replacedCount = 0;
    failCount = 0;
  }

  /* ---------------- 请求队列 ---------------- */

  function adapterFor(platform) {
    if (platform === 'bilibili') return HT.bilibili;
    if (platform === 'douyin') return HT.douyin;
    if (platform === 'youtube') return HT.youtube;
    return null;
  }

  function idFor(item) {
    const adapter = adapterFor(item.platform);
    if (!adapter) return null;
    return item.platform === 'bilibili'
      ? adapter.bvidFrom(item.cover)
      : adapter.idFrom(item.cover);
  }

  function markFail(el, key) {
    el.setAttribute('data-ht-fail', `${key}@${Date.now()}`);
    failCount++;
  }

  function failedRecently(el, key) {
    const raw = el.getAttribute('data-ht-fail');
    if (!raw) return false;
    const at = raw.lastIndexOf('@');
    if (at < 0) return false;
    if (raw.slice(0, at) !== key) return false;
    return Date.now() - Number(raw.slice(at + 1)) < 10 * 60 * 1000;
  }

  async function fetchFrame(item, position) {
    // YouTube 的自动截帧是固定地址，直接换 src 即可，不用走后台、不用裁剪
    if (item.platform === 'youtube') {
      const yt = HT.youtube;
      if (!yt) return null;
      return yt.resolve(item.id, position);
    }

    const res = await chrome.runtime.sendMessage({
      type: 'ht:frame',
      platform: item.platform,
      id: item.id,
      position,
      thumbs: item.thumbs || null
    });
    if (!res || !res.ok) return null;
    return res.dataUrl;
  }

  async function run(job) {
    const { item, key } = job;
    const cover = item.cover;
    if (!cover.isConnected) return;

    const position = POSITIONS[settings.position] || 0.5;

    let frameUrl;
    try {
      frameUrl = await fetchFrame(item, position);
    } catch (err) {
      markFail(cover, key);
      return;
    }

    if (!frameUrl) {
      markFail(cover, key);
      return;
    }

    // 请求期间状态可能已变（切档、站点关闭、虚拟滚动复用卡片）
    if (!settings.enabled) return;
    if (!cover.isConnected) return;
    if (POSITIONS[settings.position] !== position) return;

    const nowId = idFor(item);
    if (!nowId || nowId !== item.id) return;

    const liveKey = `${item.platform}:${item.id}:${settings.position}`;
    if (liveKey !== key) return;

    applyFrame(cover, frameUrl, key);
    replacedCount++;
    updateStat();
  }

  function pump() {
    while (active < MAX_CONCURRENT && pending.size) {
      let picked = null;
      for (const entry of pending) {
        if (!activeEls.has(entry[0])) {
          picked = entry;
          break;
        }
      }
      if (!picked) break; // 剩下的都在请求中，等它们收尾时再续

      const [el, job] = picked;
      pending.delete(el);
      active++;
      activeEls.add(el);

      run(job)
        .catch(() => {})
        .finally(() => {
          active--;
          activeEls.delete(el);
          pump();
        });
    }
  }

  function enqueue(item, key) {
    pending.set(item.cover, { item, key });
    pump();
  }

  /* ---------------- 扫描 ---------------- */

  /**
   * 2 = 视口内，立刻做；1 = 预取区（上下各一屏），提前做好，滚到时已经换完；
   * 0 = 太远，不碰，省流量
   */
  function zoneOf(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    const vh = window.innerHeight || 800;
    if (r.bottom > 0 && r.top < vh) return 2;
    // 提前两屏准备，滚得快也不会先看到假封面
    if (r.bottom > -vh * 2 && r.top < vh * 3) return 1;
    return 0;
  }

  function scan() {
    if (!settings.enabled) return;

    const items = [];
    if (isBili && settings.siteBilibili && HT.bilibili) {
      items.push(...HT.bilibili.collect());
    }
    if (isDouyin && settings.siteDouyin && HT.douyin) {
      items.push(...HT.douyin.collect());
    }
    if (isYouTube && settings.siteYouTube && HT.youtube) {
      items.push(...HT.youtube.collect());
    }

    const seen = new Set();
    let roundBudget = MAX_PER_ROUND;

    for (const item of items) {
      const el = item.cover;
      if (!el || !el.isConnected || seen.has(el)) continue;
      seen.add(el);

      const key = `${item.platform}:${item.id}:${settings.position}`;
      const st = elState.get(el);

      if (st) {
        if (readValue(el) !== st.written) {
          elState.delete(el);
          el.classList.remove('ht-replaced');
          el.removeAttribute('data-ht');
        } else if (st.key === key) {
          continue; // 已是目标帧
        } else {
          restore(el); // 视频或档位变了
        }
      }

      if (failedRecently(el, key)) continue;

      if (!zoneOf(el)) continue;
      if (roundBudget <= 0) continue;
      roundBudget--;

      // 正在请求中：把新任务压在 pending 里，覆盖旧档位，等它收尾
      if (activeEls.has(el)) {
        const cur = pending.get(el);
        if (!cur || cur.key !== key) pending.set(el, { item, key });
        continue;
      }

      enqueue(item, key);
    }
  }

  /* ---------------- 调度 ---------------- */

  let scanTimer = null;

  /** 调试用：把内部计数写在 <html> 上，方便不打开控制台也能看 */
  function updateStat() {
    const known = HT.douyin && HT.douyin.stats ? HT.douyin.stats().known : 0;
    document.documentElement.setAttribute(
      'data-ht-stat',
      JSON.stringify({ replaced: replacedCount, failed: failCount, pending: pending.size, known })
    );
  }

  function scheduleScan(delay = SCAN_DEBOUNCE) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
        updateStat();
      } catch (err) {
        console.warn('[封面避雷针] scan failed', err);
      }
    }, delay);
  }

  function startObservers() {
    const mo = new MutationObserver(() => scheduleScan());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    let scrollTimer = null;
    window.addEventListener(
      'scroll',
      () => {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          scheduleScan(50);
        }, 150);
      },
      { passive: true, capture: true }
    );

    window.addEventListener('resize', () => scheduleScan(300), { passive: true });

    // B 站有 history 路由，抖音详情页也是 SPA
    for (const method of ['pushState', 'replaceState']) {
      const orig = history[method];
      if (typeof orig !== 'function') continue;
      history[method] = function (...args) {
        const r = orig.apply(this, args);
        scheduleScan(500);
        return r;
      };
    }
    window.addEventListener('popstate', () => scheduleScan(500));
  }

  /* ---------------- 设置 ---------------- */

  function applySettings(next) {
    const wasEnabled = settings.enabled;
    Object.assign(settings, next);

    if (!settings.enabled) {
      restoreAll();
      return;
    }
    if (!wasEnabled && settings.enabled) {
      scheduleScan(0);
      return;
    }
    scheduleScan(0);
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        applySettings(stored);
      });
    } catch {
      applySettings(DEFAULTS);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const next = {};
      let touched = false;
      for (const k in changes) {
        next[k] = changes[k].newValue;
        touched = true;
      }
      if (touched) applySettings(next);
    });
  } catch {
    /* ignore */
  }

  /* ---------------- 对外 ---------------- */

  HT.engine = {
    rescan: () => scheduleScan(120),
    stats: () => ({
      replaced: replacedCount,
      failed: failCount,
      waiting: pending.size,
      known: HT.douyin && HT.douyin.stats ? HT.douyin.stats().known : 0
    })
  };

  if (HT.douyin && HT.douyin.setOnData) {
    HT.douyin.setOnData(() => scheduleScan(150));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ht:stats') return;
    sendResponse({ ...HT.engine.stats(), position: settings.position, enabled: settings.enabled });
  });

  loadSettings();
  startObservers();

  // hook 在 document_start 就开始抓了，这里把早期数据取回来
  if (HT.douyin && HT.douyin.requestBuffer) {
    HT.douyin.requestBuffer();
    setTimeout(() => HT.douyin.requestBuffer(), 1500);
  }

  scheduleScan(400);
})();
