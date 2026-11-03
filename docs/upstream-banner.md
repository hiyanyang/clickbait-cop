# 原仓库 README 顶部导流语

把下面这段贴到 `honest-thumbnails` 仓库 README 的 **H1 标题正下方、正文第一段之前**。

---

## 方案 A · 一行版（推荐，最不打扰原有排版）

```markdown
> **三站版已发布 → [封面避雷针 · Clickbait Cop](https://github.com/hiyanyang/clickbait-cop)**｜同思路扩到 YouTube / 哔哩哔哩 / 抖音（含抖音精选），B 站和抖音取平台自带的进度条预览图，同样不下载视频。
```

## 方案 B · 带分隔线的块版（原仓库正文较长时更醒目）

```markdown
> ### 这个思路已经扩展成三站版
>
> **[封面避雷针 · Clickbait Cop](https://github.com/hiyanyang/clickbait-cop)** 支持 YouTube、哔哩哔哩、抖音（含抖音精选、搜索页、个人主页）。
>
> - YouTube：沿用本仓库的 `maxres{1,2,3}` / `hq{1,2,3}` 取帧规则
> - B 站：走 `x/player/videoshot` 的预览雪碧图
> - 抖音：复用页面已加载的 `video.big_thumbs`
>
> 依旧不下载视频、不转码、无后端。MIT 协议。
```

---

## 建议同时改的两处（各 1 分钟）

1. **仓库 About 的 Website 字段**：填 `https://github.com/hiyanyang/clickbait-cop`
2. **Topics**：给两个仓库都加上 `youtube` `bilibili` `douyin` `thumbnail` `chrome-extension`，互相能搜到
