# Playwright 交易机器人

本目录包含将现有 Tampermonkey 逻辑迁移到 Playwright 的最小实现。机器人仍旧通过 DOM 与 EdgeX 网页交互，但可以作为独立 Node 进程运行，便于部署和扩展。

## 目录结构

- `bot.js`：主循环，负责拉取行情、调用 AI 决策接口并驱动下单/平仓。
- `config.js`：环境变量和默认配置。
- `selectors.js`：页面元素选择器，源自现有用户脚本。
- `pageActions.js`：读写页面数据、下单、切换 Tab 等操作封装。
- `session.js`：浏览器上下文初始化，支持复用已有 Chrome 配置或存储登录状态。
- `saveStorageState.js`：辅助脚本，用于保存一次登录后的会话信息。
- `aiClient.js`、`indicators.js`：AI 调用和基础指标计算。

## 环境准备

1. 安装依赖：
   ```bash
   npm install
   ```

2. 登录会话准备（选择其一）：
   - **复用现有 Chrome 配置**：设置环境变量 `PLAYWRIGHT_USER_DATA_DIR` 指向你的浏览器用户目录（建议复制一份，以免污染日常使用），例如：
     ```bash
     export PLAYWRIGHT_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome/EdgeXBot"
     ```
     首次运行时手动打开该目录里的 Chrome，装好钱包插件并完成登录 / 授权。
   - **存储状态文件**：若无需插件登录，可执行：
     ```bash
     npm run bot:record-state
     ```
     在弹出的窗口中完成 EdgeX 登录后返回终端回车，脚本会把会话保存到 `automation/state.json`。

3. 根据需要覆盖配置（可放在 `.env`）：
   ```env
   EDGEX_URL=https://pro.edgex.exchange/trade/ETHUSD
   AI_ENDPOINT=http://154.17.228.72:12345/ai-decision
   BOT_QUANTITY=0.02
   BOT_PRICE_OFFSET=0.001
   PLAYWRIGHT_HEADLESS=false
   ```
   更多项（例如随机轮询、风险控制、信号确认次数）已在 `.env` 中列出并附带中文说明，可按需调整。

## 运行机器人

```bash
npm run bot
```

脚本会打开 EdgeX 交易页面，自动切换到当前委托 Tab，按以下逻辑循环：

1. 采集最新价格并维护历史序列。
2. 计算基础指标，调用本地 AI 服务获取 buy/sell/hold 信号。
3. 当没有持仓且无挂单时，根据信号和价差配置下限价单（支持信号确认次数、风险暂停）。
4. 当有持仓且信号反向或命中风险条件（止损、止盈、超时）时，自动限价平仓。
5. 定期检查未成交委托，超过配置时限会自动撤单。

尚未迁移的模块包括外部行情同步、页面健康检查与 UI 面板展示，后续可继续按原脚本逐步补齐。

## 退出

`Ctrl+C` 会触发清理逻辑并关闭 Playwright 上下文。若使用了 `PLAYWRIGHT_USER_DATA_DIR`，退出后配置目录仍会保留，可用于下次登录。
