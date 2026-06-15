# Web3 Bullshit Game

這是一個區塊鏈期末專案用的 Web3 吹牛遊戲 DApp。第一版聚焦課程評分主軸：Solidity 合約工作流、MetaMask 前端整合、事件顯示、錯誤處理與可 demo 的交易流程。

## 專案範圍

- Smart Contract：玩家押金、4 人房間、牌組承諾上鏈、鏈上抓吹牛裁決、EIP-712 債券簽名備用結算、提款。
- Frontend：HTML/CSS/JavaScript + ethers.js + MetaMask，支援讀寫合約與事件顯示。
- Mock AI Server：課程 bonus 項目，先保留在規劃文件，之後可補 Node.js/Express mock。
- Mental Poker/SRA：第一版先用 deck commitment 展示「洗牌結果存證」，完整 SRA 加解密流程列為進階功能。

## 快速啟動

```bash
npm install
npm run build
npm run node
```

開另一個終端部署：

```bash
npm run deploy:localhost
```

啟動 AI 出牌建議伺服器：

```bash
$env:GOOGLE_API_KEY="你的 Google AI Studio API Key"
$env:GEMMA_MODEL="gemma-3-27b-it"
npm run ai
```

如果你在 Google AI Studio 看到 Gemma 4 的實際模型 ID，可以把 `GEMMA_MODEL` 改成該 ID。沒有 API key 時，AI server 會自動使用本地規則建議，方便 demo。

把部署輸出的合約地址貼到 `frontend/index.html` 的合約欄位。前端可直接用瀏覽器開啟：

```text
C:\Users\Administrator\Documents\web3\frontend\index.html
```

## Demo 建議流程

1. 連接 MetaMask 到 Hardhat localhost。
2. 四個測試帳號各自 deposit `0.5 ETH`。
3. host 建立 room，其他 3 位玩家加入。
4. host start game，提交 deck commitment。
5. 玩家抓吹牛後呼叫鏈上裁決，合約依實際翻牌直接扣押金。
6. 展示 deposits 變化、事件 log、玩家數不足或未授權操作 revert。

## 課程要求對照

- State variables：`owner`, `deposits`, `rooms`, `roomIds`, `usedNonces`。
- Struct：`Room`, `DebtNote`。
- Mapping / Array：玩家押金、房間、玩家註冊、nonce、防重放、room id 清單。
- Events：`Deposit`, `RoomCreated`, `PlayerJoined`, `GameStarted`, `DebtSettled` 等。
- Modifier：`onlyOwner`, `roomExists`, `onlyHost`, `inStatus`。
- Require / Revert：押金不足、重複加入、錯誤狀態、簽名無效、nonce 重複。
- Role-based permission：host 才能 start/finish room，winner 才能 settle 自己的 debt note。
- Workflow design：Lobby -> Active -> Finished -> Closed，Active 中支援 `settleChallenge()` 鏈上裁決。
