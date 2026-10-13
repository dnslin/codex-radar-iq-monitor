# Codex Radar IQ Monitor

一个无需持续打开 Codex Radar 页面、可以在 Chrome 后台定时读取雷达Bench成绩的 Manifest V3 扩展。

当前版本：0.9.0。更新内容见 [更新记录](CHANGELOG.md)。

## 功能

- 跟随新版雷达Bench公开成绩接口，直接显示服务端给出的 0–150 分成绩，不在扩展里重算。
- 从公开目录动态发现模型与思考等级。截至 2026-10-13，目录包含 6 个 Codex 模型、34 个档位：GPT-6 Astra、GPT-6.1 Sol、GPT-6 Sol、GPT-5.6 Sol 各有 low / medium / high / xhigh / max / ultra，GPT-6 Luna 与 GPT-5.6 Luna 各有 low / medium / high / xhigh / max。新增配置随目录刷新同步。
- 主行显示已测档位中的最高分，并标出对应思考等级、该档位的覆盖与计分样本量。各档位分别保留成绩；不生成跨档位的“总体 IQ”。点击模型行可展开全部档位的成绩、计分样本量和变化。
- 雷达Bench包含 64 道题：DeepSWE 15 题、庞贝 16 题、TB 14 题、Science 19 题。每个档位独立显示覆盖题数；未覆盖全部 64 题时标为“阶段分”，没有有效判分时显示“待采样”。合法 0 分正常显示。
- 按模型厂商分组，保留厂商与运行工具筛选、搜索和排序。当前新接口只提供 OpenAI 模型与 Codex；不会借用旧版多厂商成绩填充缺失项。无法识别厂商的新模型仍显示在“其他”组。
- 分类导航和分组标题配有本地品牌图标，使用石墨灰深色主题、雾白浅色主题和蓝色选中状态。图标来源与许可见 [图标说明](icons/providers/README.md)。
- 显示本机完成读取的时间。公开摘要未提供精确判分时刻，不把历史日期或目录发布时间当成实时更新时间。
- 默认每 15 分钟在后台更新，也可改为 5、30 或 60 分钟。
- 支持手动刷新。
- 支持 `自动`、`浅色`、`深色` 三种主题：默认自动模式在本地时间 07:00–18:59 使用浅色，其余时间使用深色；手动选择会保存在本机。
- 当雷达分变化达到设定阈值时发送 Chrome 通知，并在扩展徽章显示未读变化模型数。
- 刷新途中标记已读不会恢复旧的未读数。关闭通知或修改阈值后，进行中的刷新使用最新设置。
- 页面未打开时仍会通过 Chrome Alarm 定期更新。

## 数据口径

扩展从 [雷达Bench公开目录](https://codexradar.com/data/radar-bench-binding.json) 读取 `model_efforts`，再逐个读取公开成绩摘要：

```text
https://codexradar.com/api/radar-bench-score?model=<模型>&effort=<档位>&view=summary
X-Radar-Bench-Selection: user-selected-v1
```

成绩取摘要的 `score`，满分取 `score_max`，已测题数取 `coverage`，题库题数取 `required_tasks`，计分样本量取 `graded_runs_count`。成绩保留一位小数。`score_status` 区分完整覆盖、阶段分和暂无有效判分。`score: 0` 是有效成绩，`score: null` 才表示待采样。

源站算法先对每题最近最多 3 次有效判分求平均，再对已覆盖题等权汇总，换算为 150 分。未覆盖题不按 0 分处理。扩展直接使用服务端成绩，不重新执行此计算，也不合并不同模型或档位。

`graded_runs_count` 是当前计分窗口内的样本数，每道题最多贡献 3 次。`statistics.sample_count` 是全部合格历史运行的统计样本数，两者口径不同。公开摘要无法对多个档位的题目覆盖去重，因此不显示跨档位的覆盖率或总分。

目录的 `public_api_observed_at` 是目录观测时间。历史记录的 `updated_bucket` 是 UTC 日桶，只有日期精度。它们都不是最近一次判分的精确时刻；弹窗使用本机读取时间说明数据新鲜程度。

0.9.0 的雷达Bench成绩与旧版 112 题 DeepSWE 软件工程 IQ 不是同一口径。升级后的第一份新版快照作为新的比较起点，不将跨题库、跨计分版本的差异发送为涨跌通知。

## 安装

该项目不需要安装依赖，也不需要构建。

1. 在 Chrome 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择下载并解压后的扩展目录（包含 `manifest.json`）。

5. 固定工具栏中的 **Codex Radar IQ Monitor** 图标。

首次安装后扩展会立即获取一次数据。打开弹窗后，从左侧选择厂商，或在全部厂商中搜索模型，再展开查看思考等级。分类导航和模型列表可分别滚动，顶部搜索和底部监听设置始终可用。没有样本的档位显示“待采样”，不显示为零分。

### 更新已解压安装的扩展

GitHub 下载的 ZIP 不会自动更新已加载的扩展。下载新版本后，将解压出的文件覆盖到 Chrome 当前加载的原目录，再到 `chrome://extensions/` 点击这款扩展的“重新加载”。确认管理页显示的新版本号，然后重新打开工具栏弹窗。沿用原目录可以保留监听设置和主题偏好。

## 权限说明

| 权限 | 用途 |
|---|---|
| `alarms` | 定时刷新数据 |
| `storage` | 保存最近快照、未读变化、监听设置和主题偏好 |
| `notifications` | 雷达分变化达到阈值时发送通知 |
| `https://codexradar.com/*` | 读取 Codex Radar 的公开数据接口 |

扩展没有内容脚本，不读取当前网页，也不访问浏览历史。

## 开发与验证

```bash
cd codex-radar-iq-monitor
npm run check
npm run smoke
```

- `npm run check`：Manifest、发布脚本、JavaScript 语法和单元测试检查。后台回归测试覆盖刷新中的已读操作、通知开关、阈值更新和并发存储。
- `npm run smoke`：读取实时目录和各档位公开摘要，打印全部模型、实际思考等级与服务端雷达分。
- `node scripts/verify-popup.mjs`：在独立 Chrome 窗口验证真实工具栏弹窗的自然尺寸、模型数量、搜索和展开交互；前置条件及发布包验收方法见 [弹窗验证说明](docs/popup-verification.md)。

## 打包与发布

本地可以按 Chrome 扩展版本号生成发布包：

```bash
npm run package -- v0.9.0
```

输出文件：

```text
dist/codex-radar-iq-monitor-v0.9.0.zip
dist/codex-radar-iq-monitor-v0.9.0.zip.sha256
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
│   ├── verify-popup.mjs
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
    ├── background.test.mjs
    ├── radar.test.mjs
    └── view.test.mjs
```

## 当前边界

- 依赖 Codex Radar 当前公开目录与雷达Bench成绩摘要；站点若调整接口，需要同步更新 `src/radar.js`。
- 当前读取雷达Bench 64 题成绩，不继续读取旧版 DeepSWE 表格。公开目录之外的模型或档位不借用旧成绩。
- 公开摘要不提供精确判分时间或逐题样本；界面使用本地读取时间，并保留服务端的独立档位成绩。
- Chrome 的后台 Alarm 不是精确定时器，浏览器可能根据休眠和资源策略延后执行。
- 本版本只保留“当前快照、上一次快照和最近变化”，暂不绘制长期历史曲线。
