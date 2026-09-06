# Codex Radar IQ Monitor

一个无需持续打开 Codex Radar 页面、可以在 Chrome 后台定时汇总模型 IQ 的 Manifest V3 扩展。

## 功能

- 自动读取 DeepSWE 接口中的所有模型与思考等级，源站新增模型后随刷新同步，无需修改固定名单。
- 截至 2026-09-06，支持 18 条运行工具与模型记录、64 个思考档位：

  | 运行工具 | 模型 |
  |---|---|
  | Codex | GPT-6 Astra、GPT-5.6 Sol / Terra / Luna、GPT-5.5、DeepSeek V4 Pro / Flash |
  | DSH | DeepSeek V4 Pro / Flash / Flash Vision Exp |
  | ZCode | GLM-5.3、GLM-5.3 Flash |
  | Grok | Grok 4.6 |
  | Kimi Code | Kimi K3 |
  | Antigravity | Gemini 3.7 Flash |
  | CodeBuddy | HY4 Preview |
  | Claude Code | Claude Sonnet 5、Claude Opus 5（内测中）|

- 用紧凑列表展示总体 IQ，点击模型行展开各思考等级的 IQ、样本量和相对上次快照的变化。
- 支持搜索模型或运行工具、按运行工具筛选，以及按 IQ、站点顺序或名称排序。筛选只影响查看范围，后台仍监听全部模型。
- 显示已测题数和样本量，已测题目不足题库的 60% 时提示“样本覆盖不足”，与源站标准一致。
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

当前 DeepSWE 为每格最近三次有效结果的等权汇总。总体 IQ 由全部档位的样本一起计算，不是各档 IQ 的算术平均。已测题数是至少存在一条有效样本的任务数，跨档位按任务去重。

同一基础模型通过不同运行工具测试时分别展示。例如 Codex 的 `deepseek-v4-pro` 与 DSH 的 `dsh-deepseek-v4-pro` 保留独立分数和通知。模型身份直接使用接口的 `combo.model`，运行工具取 `combo.agent`（缺省为 Codex）。展示名表只用于易读名称，不限制模型范围；尚未收录名称的新模型或工具会显示接口原名。

## 安装

该项目不需要安装依赖，也不需要构建。

1. 在 Chrome 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择下载并解压后的扩展目录（包含 `manifest.json`）。

5. 固定工具栏中的 **Codex Radar IQ Monitor** 图标。

首次安装后扩展会立即获取一次数据。打开弹窗即可搜索、筛选模型，并展开查看思考等级。列表可独立滚动，顶部搜索和底部监听设置始终可用。没有样本的档位显示“待采样”，不显示为零分。

### 更新已解压安装的扩展

GitHub 下载的 ZIP 不会自动更新已加载的扩展。下载新版本后，将解压出的文件覆盖到 Chrome 当前加载的原目录，再到 `chrome://extensions/` 点击这款扩展的“重新加载”。确认管理页显示的新版本号，然后重新打开工具栏弹窗。沿用原目录可以保留监听设置和主题偏好。

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
cd codex-radar-iq-monitor
npm run check
npm run smoke
```

- `npm run check`：Manifest、发布脚本、JavaScript 语法和单元测试检查。
- `npm run smoke`：请求实时接口，打印全部模型、运行工具及实际思考等级的 IQ 矩阵。
- `node scripts/verify-popup.mjs`：在独立 Chrome 窗口验证真实工具栏弹窗的自然尺寸、模型数量、搜索和展开交互；前置条件及发布包验收方法见 [弹窗验证说明](docs/popup-verification.md)。

## 打包与发布

本地可以按 Chrome 扩展版本号生成发布包：

```bash
npm run package -- v0.6.1
```

输出文件：

```text
dist/codex-radar-iq-monitor-v0.6.1.zip
dist/codex-radar-iq-monitor-v0.6.1.zip.sha256
```

推送形如 `v0.3.0` 的 tag 后，`.github/workflows/release.yml` 会自动：

1. 运行全部检查和测试；
2. 将 tag 版本写入发布包内的 `manifest.json`；
3. 生成 ZIP 和 SHA-256 文件；
4. 创建或更新 GitHub Release；
5. 使用服务账号获取 Chrome Web Store API 访问令牌；
6. 上传 ZIP，并在异步处理时轮询上传状态；
7. 以 `DEFAULT_PUBLISH` 提交审核，通过审核后自动发布。

发布示例：

```bash
git tag v0.3.0
git push origin v0.3.0
```

发布 tag 必须使用三段纯数字版本，例如 `v1.2.3`，而且版本必须高于 Chrome Web Store 当前版本。打包过程不会修改仓库根目录的 `manifest.json`。

### Chrome Web Store 自动发布配置

Chrome Web Store API V2 只能更新已经存在的商店项目。第一次发布仍需在 Chrome Web Store Developer Dashboard 中手动创建项目、上传 ZIP，并完成商店资料、隐私和分发设置。

完成首次项目创建后：

1. 在 Google Cloud 项目中启用 **Chrome Web Store API**。
2. 创建一个服务账号，并为它生成 JSON 密钥。
3. 在 Chrome Web Store Developer Dashboard 的账号设置中添加该服务账号邮箱。
4. 打开本仓库的 **Settings → Secrets and variables → Actions**，添加：

| 类型 | 名称 | 内容 |
|---|---|---|
| Repository secret | `CWS_SERVICE_ACCOUNT_JSON` | 服务账号 JSON 密钥的完整内容 |
| Repository variable | `CWS_PUBLISHER_ID` | Chrome Web Store Publisher ID |
| Repository variable | `CWS_ITEM_ID` | 已创建扩展的 32 位 Item ID |

服务账号 JSON 是长期凭据，不要提交到仓库。如果密钥泄露，应立即在 Google Cloud 中撤销并重新生成。

工作流提交成功只表示新版本已经进入 Chrome Web Store 的审核或发布流程，不代表可以绕过商店审核。

## 目录

```text
codex-radar-monitor/
├── .github/workflows/release.yml
├── manifest.json
├── package.json
├── icons/
├── scripts/
│   ├── package.mjs
│   ├── publish-chrome-web-store.mjs
│   ├── smoke.mjs
│   └── validate.mjs
├── src/
│   ├── background.js
│   ├── popup.css
│   ├── popup.html
│   ├── popup.js
│   ├── radar.js
│   ├── view.js
│   └── theme.js
└── test/
    ├── radar.test.mjs
    └── view.test.mjs
```

## 当前边界

- 依赖 Codex Radar 当前公开 API 及字段结构；站点若调整接口，需要同步更新 `src/radar.js`。
- 当前汇总 DeepSWE 软件工程题库，不混合庞贝壁画等其他 benchmark 的结果。
- Chrome 的后台 Alarm 不是精确定时器，浏览器可能根据休眠和资源策略延后执行。
- 本版本只保留“当前快照、上一次快照和最近变化”，暂不绘制长期历史曲线。
