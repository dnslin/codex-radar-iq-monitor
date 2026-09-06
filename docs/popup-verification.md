# 验证真实工具栏弹窗

普通浏览器标签页不能验证扩展弹窗的自然尺寸。v0.6.0 的 `max-width: 100vw` 会让 Chrome 将工具栏弹窗压到约 182px；在标签页手动设置 720px 视口会掩盖这个问题。

准备 Node.js 22 或更新版本，以及可在命令行运行的 `agent-browser` 和它使用的 Chrome。检查需要桌面窗口和可访问的 Codex Radar 实时接口，不需要安装项目运行依赖。

在仓库根目录运行：

```bash
node scripts/verify-popup.mjs
```

发布前应解压实际 ZIP，再把解压目录传给同一个检查脚本。可选的第二个参数保存真实弹窗截图：

```bash
unzip dist/codex-radar-iq-monitor-v0.6.1.zip -d /tmp/radar-release-check
node scripts/verify-popup.mjs /tmp/radar-release-check /tmp/radar-popup.png
```

脚本使用独立浏览器会话加载指定目录，通过 `chrome.action.openPopup()` 打开真实工具栏弹窗，检查结束后关闭会话。它不设置弹窗视口，而是断言 Chrome 自然生成的尺寸为 720 × 600px，列表高度至少为 250px，页面和列表无横向溢出。随后对照后台实时快照核对全部模型数量，并检查搜索、清空和展开详情。

模型数量来自接口，不固定为 18。接口不可用或模型数据在 30 秒内未加载会使检查失败，并显示页面中的错误。尺寸回归时仍会保存截图；尺寸正常时，截图等待模型加载后再保存。
