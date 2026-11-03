# 封面避雷针 · Clickbait Cop

把 **YouTube**、**哔哩哔哩**、**抖音**的视频封面替换成视频里真实的中段画面，不再被夸张封面骗进去。

不下载视频、不转码、没有后端。三个平台取的都是它们自己已经生成好的预览帧。

> 想上架 Chrome 应用商店？见 **[docs/PUBLISH.md](docs/PUBLISH.md)**：材料清单、申请入口、可直接复制的商品文案与权限说明，以及针对本插件的拒审风险。
> 隐私政策全文：**[docs/privacy.html](docs/privacy.html)**

## 安装

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选本目录
4. 打开 youtube.com / bilibili.com / douyin.com，刷新一次

Edge 用 `edge://extensions`，步骤相同。

如果要打包成商店可上传的 zip：

```bash
bash scripts/package.sh     # 产出 dist/cover-lightning-rod-<版本>.zip
```

## 用法

点扩展图标：

- **总开关**：一键全站恢复原封面
- **生效站点**：YouTube / B 站 / 抖音 分别开关
- **取哪一帧**：前段 25% / 中段 50% / 后段 75%
- **底部状态**：当前页已替换张数、失败数；抖音还会显示「已捕获 N 条视频数据」

## 工作原理

```
封面元素 → 视频 ID → 取一帧预览图 → 替换 <img> / background-image
```

三个平台的取帧来源完全不同：

| 平台 | 取帧来源 | 是否要请求接口 | 是否要裁剪 |
|---|---|---|---|
| YouTube | `i.ytimg.com/vi/<id>/maxres{1,2,3}.jpg` | 否 | 否 |
| B 站 | `x/player/videoshot` 返回的雪碧图 | 是（后台代理） | 是 |
| 抖音 | 页面数据里的 `video.big_thumbs` 雪碧图 | 否（复用页面已请求的数据） | 是 |

**YouTube**

YouTube 为每个视频自动生成三张截图，正好对应 25% / 50% / 75%：

```
i.ytimg.com/vi/<id>/maxres{1,2,3}.jpg   1280×720，高清视频才有
i.ytimg.com/vi/<id>/hq{1,2,3}.jpg       480×360，基本都有（4:3 带黑边）
```

两个坑：

1. **不存在的帧返回的是 120×90 灰色占位图，HTTP 仍是 200**。必须用 `naturalWidth > 120` 判断，否则封面会变成一片灰。
2. **Shorts 是竖版 9:16**（`oar2.jpg`），用横版帧替换会被压扁，直接跳过。

因为地址是固定的，YouTube 这条链路不需要后台、不需要裁剪，探测完直接换 `src`，比另外两个站快得多。

**B 站**

```
GET https://api.bilibili.com/x/player/videoshot?bvid=<BV号>&index=1
→ image[]（雪碧图，可能多张）+ index[]（逐帧时间）+ img_x_len/img_y_len/img_x_size/img_y_size
```

关键点：**总帧数是 `index.length`，不是 `格子数`**。实测某视频 2 张 10×10 图共 200 格，但只有 183 帧，末尾是空的。按格子数算会取到空白帧。

**抖音**

不调接口、不签名。在 `MAIN world` hook 页面自身的 `fetch`/`XHR`，从返回体里捞出 `aweme.video.big_thumbs`，用 `postMessage` 递给隔离环境，再按 `aweme_id` 匹配到卡片。

抖音有两种卡片结构，都要处理：

| 场景 | 卡片锚点 | 封面 |
|---|---|---|
| 抖音精选 / 双列信息流 | `[data-aweme-id="..."]`，**页面里没有 `<a>` 链接** | `img.discover-video-card-img` |
| 首页单列 / 搜索 / 个人主页 | `a[href="/video/<id>"]` | 通用打分挑图 |

精选页的数据来自 `aweme/v2/web/module/feed/`，`big_thumbs` 是**数组**（不是对象），且可能只给 `img_x_size` 不给行列数 —— 这两种情况都在代码里做了兼容，否则整条链路会静默失效。

## 关于延迟

首次看到某个视频，B 站和抖音必须先把雪碧图下载下来再裁，这段延迟消不掉；YouTube 没有这个问题。

已经做的优化：

| 手段 | 效果 |
|---|---|
| IndexedDB 持久化缓存（1500 条成品帧） | **回访同一视频几乎 0 延迟**，内存缓存随 SW 休眠丢失，磁盘缓存不会 |
| 预取视口上下各两屏 | 滚到的卡片通常已经换好了，不会先看到假封面 |
| 扫描防抖 350ms → 120ms | 省 ~230ms |
| 并发 4 → 6 | B 站要连着发两次请求，并发高才跟得上 |

实测（无缓存冷启动，chromium 加载真扩展跑）：

- B 站首页：约 4 秒内视口内 14/14 全部替换
- 抖音精选：页面自身加载较慢，数据到位后视口内 7/7 全部替换
- YouTube：本地拦截模拟页面，5 条用例全部符合预期（见下表）

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| B 站 `videoshot` 接口可用、无需签名 | ✅ 实测 200 |
| 雪碧图实际尺寸 = `img_x_len × img_x_size`（1600×900） | ✅ 实测 |
| 25% / 50% / 75% 三帧裁出来是有效画面、互不相同 | ✅ 实测裁剪并查看 |
| 抖音页面 HTML 是否自带数据 | ✅ 实测**不含**，必须 hook |
| 抖音精选卡片结构 / `data-aweme-id` / `big_thumbs` 为数组 | ✅ 实测（chromium 加载扩展跑通） |
| 抖音精选视口内替换率 | ✅ 7/7 |
| B 站首页视口内替换率 | ✅ 14/14 |
| YouTube：正常卡片换 `maxres2` | ✅ 模拟验证 |
| YouTube：无 maxres 时退回 `hq2` | ✅ 模拟验证 |
| YouTube：Shorts / 头像 / 播放器海报不被误改 | ✅ 模拟验证 |
| 抖音普通首页单列 / 搜索页 | ⚠️ 未单独实测，按 `a[href="/video/"]` 路径处理 |
| YouTube 真实站点 | ⚠️ 开发机直连不了 Google，只做了本地拦截模拟，需你实机确认 |

## 已知限制

1. **大卡片会有点糊**：抖音精选顶部大图约 1033px 宽，平台预览图单帧只有 240×136，放大约 4 倍；B 站是 160×90 放大 2 倍；YouTube 的 maxres 是 1280×720，基本不糊。
2. **YouTube 没有 maxres 的老视频会退回 hq（480×360，带黑边）**，画质一般。
3. **YouTube Shorts 不处理**：竖版封面换横版帧会变形，直接跳过。
4. **多 P 视频**只取 P1 的快照（`videoshot` 不带 `cid`）。分 P 的第 2 集以后会显示 P1 的画面。
5. **新投稿、极短视频、图文、直播、广告**通常没有预览帧，保留原封面。
6. B 站单视频最多 200 帧（2 张图），超长视频的帧间隔会拉大，但仍按时间比例取。
7. 抖音图片 URL 带签名会过期，所以缓存的是**裁剪后的成品图**，不是 URL；缓存 key 只用视频 ID，不含签名参数。
8. 只处理视口上下各两屏内的卡片，滚远了不请求 —— 抖音精选一屏约 10 个卡片，预取两屏约 3MB 流量。
9. 磁盘缓存上限 1500 条（约 45MB），超了按时间淘汰最旧的。
10. 页面自己重新渲染封面时（虚拟滚动复用 DOM），会检测到并重新替换，极少数情况下可能闪一下原图。

## 排查

页面控制台执行：

```js
HT.engine.stats()       // { replaced, failed, waiting, known }
HT.youtube.collect()    // 当前扫到的 YouTube 卡片
HT.bilibili.collect()   // 当前扫到的 B 站卡片
HT.douyin.collect()     // 当前扫到的抖音卡片
```

也可以在控制台看 `<html data-ht-stat="...">`，不用打开扩展面板。

background 的日志在 `chrome://extensions` → 本扩展 → 「Service Worker」。

## 目录

```
manifest.json        MV3 配置
background.js        B 站接口代理 + 雪碧图裁剪 + LRU / IndexedDB 缓存
content/hook.js      MAIN world，hook fetch/XHR 捞抖音 big_thumbs
content/util.js      封面元素识别（排除头像、按面积打分）
content/bilibili.js  B 站卡片 → BV 号
content/douyin.js    抖音卡片 → aweme_id，接 hook 数据
content/youtube.js   YouTube 卡片 → 视频 ID → 自动截帧地址
content/engine.js    扫描 / 队列 / 替换 / 恢复
content.css          替换后的 object-fit 兜底
popup.*              开关与档位
icons/               16 / 32 / 48 / 128 图标
docs/PUBLISH.md      Chrome 应用商店上架手册（含可复制的文案）
docs/privacy.html    隐私政策，可直接挂 GitHub Pages
docs/upstream-banner.md  原仓库 README 用的导流语
docs/screenshots/    商店用 1280×800 实拍截图
scripts/package.sh   打 zip
```

## 上架

完整步骤见 [docs/PUBLISH.md](docs/PUBLISH.md)。一句话版：付 5 美元 → 实名验证 → 上传 `dist/*.zip` → 填商品详情与隐私表单 → 提交审核。

## 来源与致谢

YouTube 的取帧规则（`maxres{1,2,3}` / `hq{1,2,3}` 三帧、把 120×90 占位图判定为「没有这一帧」而不是相信 HTTP 200、跳过竖版 Shorts）来自 [honest-thumbnails](https://github.com/hiyanyang/honest-thumbnails)（MIT）。

B 站适配器、抖音适配器、公共引擎（扫描 / 预取 / 队列 / IndexedDB 缓存 / 还原）、弹窗与图标均为本项目新增。

上游的完整版权与许可声明保留在 [LICENSE](LICENSE) 末尾的 Third-party notices 一节。

## 许可

MIT，见 [LICENSE](LICENSE)。
