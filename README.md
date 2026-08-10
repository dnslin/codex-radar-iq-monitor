# Codex Radar IQ Monitor

一个无需持续打开 Codex Radar 页面、可以在 Chrome 后台定时汇总模型 IQ 的 Manifest V3 扩展。

## 功能

- 汇总以下 5 个模型：
  - GPT-5.6 Sol
  - GPT-5.6 Terra
  - GPT-5.6 Luna
  - GPT-5.5
  - DeepSeek V4 Flash
- 展示 `low`、`medium`、`high`、`xhigh`、`max`、`ultra` 各思考等级的 IQ。
- 展示每个模型跨思考等级的总体 IQ。
- 默认每 15 分钟在后台更新，也可改为 5、30 或 60 分钟。
- 支持手动刷新。
- 支持 `自动`、`浅色`、`深色` 三种主题：默认自动模式在本地时间 07:00–18:59 使用浅色，其余时间使用深色；手动选择会保存在本机。
- 当 IQ 变化达到设定阈值时发送 Chrome 通知，并在扩展徽章显示未读变化模型数。
- 页面未打开时仍会通过 Chrome Alarm 定期更新。

## 数据口径

扩展直接读取 Codex Radar 的公开表格接口，不抓取页面 DOM。IQ 计算与站点当前前端实现保持一致：

```text
weighted_score   = Σ(score_sum × iq_weight)
weighted_samples = Σ(n × iq_weight)
IQ               = round(weighted_score / weighted_samples × 150)
```

当 `iq_weight` 缺失或无效时按 `1` 处理；当 `score_sum` 缺失时回退到 `p`。

## 安装

该项目不需要安装依赖，也不需要构建。

1. 在 Chrome 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：

```text
/Volumes/data/chatgpt-web/dev/codex-radar-monitor
```

5. 固定工具栏中的 **Codex Radar IQ Monitor** 图标。

首次安装后扩展会立即获取一次数据。打开弹窗即可查看五个模型的总体分数和思考等级矩阵。

## 权限说明

| 权限 | 用途 |
|---|---|
| `alarms` | 定时刷新数据 |
| `storage` | 保存最近快照、未读变化、监听设置和主题偏好 |
| `notifications` | IQ 变化达到阈值时发送通知 |
| `https://api.codexradar.com/*` | 读取 Codex Radar 的公开数据接口 |

扩展没有内容脚本，不读取当前网页，也不访问浏览历史。

## 开发与验证

```bash
cd /Volumes/data/chatgpt-web/dev/codex-radar-monitor
npm run check
npm run smoke
```

- `npm run check`：Manifest、JavaScript 语法和单元测试检查。
- `npm run smoke`：请求实时接口并在终端打印五个模型的 IQ 矩阵。

## 打包与发布

本地可以按 Chrome 扩展版本号生成发布包：

```bash
npm run package -- v0.2.0
```

输出文件：

```text
dist/codex-radar-iq-monitor-v0.2.0.zip
dist/codex-radar-iq-monitor-v0.2.0.zip.sha256
```

推送形如 `v0.3.0` 的 tag 后，`.github/workflows/release.yml` 会自动：

1. 运行全部检查和测试；
2. 将 tag 版本写入发布包内的 `manifest.json`；
3. 生成 ZIP 和 SHA-256 文件；
4. 创建 GitHub Release，并自动生成 Release Notes；
5. 上传 ZIP 与校验文件。

发布示例：

```bash
git tag v0.3.0
git push origin v0.3.0
```

发布 tag 必须使用三段纯数字版本，例如 `v1.2.3`。打包过程不会修改仓库根目录的 `manifest.json`。

## 目录

```text
codex-radar-monitor/
├── .github/workflows/release.yml
├── manifest.json
├── package.json
├── icons/
├── scripts/
│   ├── package.mjs
│   ├── smoke.mjs
│   └── validate.mjs
├── src/
│   ├── background.js
│   ├── popup.css
│   ├── popup.html
│   ├── popup.js
│   ├── radar.js
│   └── theme.js
└── test/
    └── radar.test.mjs
```

## 当前边界

- 依赖 Codex Radar 当前公开 API 及字段结构；站点若调整接口，需要同步更新 `src/radar.js`。
- Chrome 的后台 Alarm 不是精确定时器，浏览器可能根据休眠和资源策略延后执行。
- 本版本只保留“当前快照、上一次快照和最近变化”，暂不绘制长期历史曲线。
