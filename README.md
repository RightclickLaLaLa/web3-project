# Web3 吹牛遊戲

這是一個區塊鏈期末專案用的 Web3 吹牛遊戲 DApp。系統結合 Solidity 押金池合約、瀏覽器遊戲介面、後端 relayer，以及可選的 AI 電腦玩家。

遊戲採用 54 張牌的吹牛 / Bullshit / Cheat 規則，包含 2 張鬼牌。玩家進房前先把測試 ETH 存入智慧合約作為押金；出牌、Pass、抓吹牛與 AI 決策等高頻操作主要在鏈下處理；押金、房間生命週期、遊戲開始、再開投票、認輸與最終結算則由合約記錄與執行。

## 專案重點

- **智慧合約流程**：押金、提款、建立房間、加入房間、移除玩家、開始遊戲、再開投票、認輸、抓吹牛結算、最終結算。
- **押金池結算**：玩家只需要先存入押金，遊戲結束後由合約調整押金餘額，最後再提款，減少每回合交易與 gas 成本。
- **防重複結算**：每個房間使用 `roomEpoch` 區分不同局，並用 `settledEpochs[roomId][epoch]` 防止同一局被重複結算。
- **事件驅動介面**：前端監聽合約 events，更新房間、押金、結算與交易紀錄。
- **準備狀態不上鏈**：ready / unready 只透過 relayer 同步，不需要玩家為準備動作支付手續費。
- **AI 電腦玩家**：電腦玩家有自己的錢包與押金，可加入房間並參與遊戲。AI 可使用 LM Studio 本地模型、Google AI Studio，或本地 fallback 規則。
- **洗牌承諾**：前端使用 WebCrypto 隨機洗牌，開局時提交 deck commitment hash 到合約。

## 技術棧

- Solidity `^0.8.28`
- Hardhat 3 + `@nomicfoundation/hardhat-toolbox-viem`
- HTML / CSS / JavaScript
- ethers.js + MetaMask
- Node.js relayer
- Node.js AI server
- LM Studio OpenAI-compatible API
- Google AI Studio / Gemma API

## 專案結構

```text
contracts/Web3BullshitGame.sol   智慧合約
frontend/index.html              前端頁面
frontend/app.js                  遊戲流程與鏈上互動
frontend/styles.css              介面樣式
server/relayer.js                電腦玩家錢包、off-chain ready、自動結算
server/ai-player.js              AI 決策伺服器
scripts/deploy.ts                本地部署腳本
test/Web3BullshitGame.ts         合約測試
```

## 安裝

安裝套件：

```powershell
npm install
```

建立環境設定檔：

```powershell
Copy-Item .env.example .env
```

在 `.env` 填入 RPC、合約地址、relayer 私鑰與電腦玩家私鑰：

```text
AI_PORT=8787
RELAYER_PORT=8790
RELAYER_RPC_URL=http://127.0.0.1:8545
RELAYER_PRIVATE_KEY=...
CONTRACT_ADDRESS=...
BOT_PRIVATE_KEYS=...
AI_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=qwen3.5-4b
```

若要使用 Google AI Studio：

```text
AI_PROVIDER=google
GOOGLE_API_KEY=...
GEMMA_MODEL=gemma-3-27b-it
```

## 本地啟動流程

啟動 Hardhat 私鏈：

```powershell
npm run node
```

部署合約：

```powershell
npm run deploy:localhost
```

啟動 relayer：

```powershell
npm run relayer
```

啟動 AI server：

```powershell
npm run ai
```

最後用本地網頁伺服器或 Cloudflare Tunnel 開啟 `frontend/index.html`。

## 公開 Demo 路由

若使用 Cloudflare Tunnel，前端預期可連到以下路徑：

- `/rpc`：Hardhat JSON-RPC，通常對應本機 `8545`
- `/relayer`：relayer server，通常對應本機 `8790`
- `/ai`：AI server，通常對應本機 `8787`

外部玩家需要能開啟前端，並在 MetaMask 中使用公開 RPC。AI 請求通常由前端或後端服務送出，AI 模型本身不一定要單獨公開。

## Demo 流程

1. 連接 MetaMask 到本地或 tunneled 私鏈。
2. 玩家存入測試 ETH 作為押金。
3. 建立房間或加入房間。
4. 加入真人玩家或 AI 電腦玩家，直到房間滿 4 人。
5. 所有玩家準備，電腦玩家預設準備。
6. 房主開始遊戲，前端洗牌並提交 deck commitment。
7. 玩家依序出牌、Pass 或抓吹牛。
8. 有玩家打完手牌後，其他玩家仍可抓最後一手。
9. 最終結果由 relayer 提交合約結算。
10. 玩家從合約提領剩餘押金。

## 智慧合約對照

合約符合課程要求的 Solidity 設計：

- **State variables**：`owner`、`deposits`、`rooms`、`isPlayerInRoom`、`rematchVotes`、`roomEpoch`、`settledEpochs`、`roomIds`
- **Struct**：`Room`
- **Mapping / Array**：押金、房間、玩家狀態、再開投票、防重複結算、房間列表、房間玩家列表
- **Events**：`Deposit`、`Withdrawal`、`RoomCreated`、`PlayerJoined`、`PlayerRemoved`、`RematchVoted`、`RematchExpired`、`GameStarted`、`GameFinished`、`ChallengeSettled`、`FinalWinnerSettled`、`FinalPenaltiesSettled`、`AutoFinalSettlementTriggered`、`PlayerForfeited`
- **Modifiers**：`onlyOwner`、`roomExists`、`onlyHost`、`inStatus`
- **錯誤處理**：使用 custom errors 處理未授權、狀態錯誤、房間不存在、重複加入、押金不足、玩家數錯誤、重複結算等情況
- **權限設計**：房主才能開始遊戲；owner / 房主可管理大廳玩家；房間玩家才能參與再開與結算流程
- **Workflow**：`Lobby -> Active -> Finished -> Closed`
- **Replay protection**：同一房間同一局只能結算一次

## AI 整合

AI server 會接收結構化遊戲狀態：

- 電腦玩家身份
- 目前輪到誰
- 電腦玩家手牌
- 本輪喊牌點數
- 出牌堆張數
- 棄牌堆張數
- 已 Pass 玩家
- 上一手宣稱
- 座位與手牌數摘要

AI 回傳簡短決策，例如：

```json
{ "action": "play", "rank": "A", "cards": ["A"] }
```

或：

```json
{ "action": "challenge" }
```

Provider 優先順序：

1. LM Studio 本地模型
2. Google AI Studio / Gemma
3. 本地 fallback 規則

AI request / response 會寫入：

```text
logs/ai-monitor.log
```

## 驗證

執行合約測試：

```powershell
npm run test
```

編譯合約：

```powershell
npm run build
```

檢查 JavaScript 語法：

```powershell
node --check frontend/app.js
node --check server/relayer.js
node --check server/ai-player.js
```

## 目前範圍與限制

目前系統展示 WebCrypto 隨機洗牌與 deck commitment，但尚未完整實作 SRA mental poker。完整 SRA 需要多方加密、洗牌、局部解密與證明，可作為未來延伸。本版本主要聚焦課程要求：智慧合約 workflow、前端整合、事件顯示、錯誤處理與 AI server integration。
