const DEFAULTS = {
  enabled: true,
  siteBilibili: true,
  siteDouyin: true,
  siteYouTube: true,
  position: 'middle'
};

const els = {
  enabled: document.getElementById('enabled'),
  siteBilibili: document.getElementById('siteBilibili'),
  siteDouyin: document.getElementById('siteDouyin'),
  siteYouTube: document.getElementById('siteYouTube'),
  position: document.getElementById('position'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint')
};

let state = { ...DEFAULTS };

function paint() {
  els.enabled.checked = state.enabled;
  els.siteBilibili.checked = state.siteBilibili;
  els.siteDouyin.checked = state.siteDouyin;
  els.siteYouTube.checked = state.siteYouTube;
  for (const btn of els.position.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === state.position);
  }
  document.body.style.opacity = state.enabled ? '1' : '0.72';
}

function save(patch) {
  state = { ...state, ...patch };
  paint();
  chrome.storage.sync.set(state);
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  state = { ...DEFAULTS, ...stored };
  paint();
  refreshStatus();
});

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
els.siteBilibili.addEventListener('change', () => save({ siteBilibili: els.siteBilibili.checked }));
els.siteDouyin.addEventListener('change', () => save({ siteDouyin: els.siteDouyin.checked }));
els.siteYouTube.addEventListener('change', () => save({ siteYouTube: els.siteYouTube.checked }));

els.position.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (!btn) return;
  save({ position: btn.dataset.value });
});

function refreshStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      els.status.textContent = '未在目标站点';
      return;
    }

    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch {
      /* ignore */
    }

    if (!/(^|\.)(bilibili|douyin|youtube)\.com$/.test(host)) {
      els.status.textContent = '当前页面不是 YouTube / B 站 / 抖音';
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'ht:stats' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        els.status.textContent = '页面尚未就绪，刷新一次再试';
        return;
      }
      const parts = [`已替换 ${res.replaced} 张`];
      if (res.failed) parts.push(`失败 ${res.failed}`);
      if (res.known) parts.push(`已捕获 ${res.known} 条视频数据`);
      els.status.textContent = parts.join(' · ');
    });
  });
}
