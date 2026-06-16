# Web3 Bullshit Game

Web3 Bullshit Game is a blockchain final-project DApp that combines a Solidity deposit-pool contract, a browser game UI, a backend relayer, and optional AI computer players.

The game uses the classic Bullshit / Cheat card-game flow with 54 cards, including jokers. Players deposit test ETH into the smart contract before entering a room. Gameplay actions such as playing cards, passing, challenging, and AI decisions are handled off-chain for speed, while deposits, room lifecycle, game start, rematch votes, forfeits, and final settlement are recorded on-chain.

## Project Highlights

- **Smart contract workflow**: deposit, withdraw, room creation, joining/leaving, player removal, game start, rematch voting, forfeit, challenge settlement, and final settlement.
- **Deposit-pool settlement**: players only need to deposit before playing and withdraw after the game. Per-game penalties are settled from contract balances.
- **Replay protection**: each room has a `roomEpoch`, and final settlement is guarded by `settledEpochs[roomId][epoch]`.
- **Event-driven UI**: frontend listens to contract events and refreshes room, balance, and settlement state.
- **Off-chain ready state**: ready/unready does not cost gas. It is synchronized through the relayer.
- **AI computer players**: bots can join rooms with their own private keys and deposits. AI decisions can use Google Gemini/Gemma or an OpenAI-compatible LM Studio server, with local fallback rules.
- **Deck commitment**: the frontend shuffles with WebCrypto randomness and submits a deck commitment hash when the host starts a game.

## Tech Stack

- Solidity `^0.8.28`
- Hardhat 3 + `@nomicfoundation/hardhat-toolbox-viem`
- HTML / CSS / JavaScript frontend
- ethers.js + MetaMask
- Node.js relayer
- Node.js AI server
- Google AI Studio or LM Studio compatible AI endpoint

## Repository Layout

```text
contracts/Web3BullshitGame.sol   Smart contract
frontend/index.html              Browser UI
frontend/app.js                  Frontend game and chain integration
frontend/styles.css              UI styling
server/relayer.js                Bot wallet actions, off-chain ready state, auto settlement
server/ai-player.js              AI decision server
scripts/deploy.ts                Local deployment script
test/Web3BullshitGame.ts         Contract tests
```

## Setup

Install dependencies:

```powershell
npm install
```

Copy environment settings:

```powershell
Copy-Item .env.example .env
```

Fill `.env` with your local RPC, deployed contract address, relayer private key, and bot private keys:

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

Google AI Studio can also be used:

```text
AI_PROVIDER=google
GOOGLE_API_KEY=...
GEMMA_MODEL=gemma-3-27b-it
```

## Local Development

Start a local Hardhat chain:

```powershell
npm run node
```

Deploy the contract:

```powershell
npm run deploy:localhost
```

Start the relayer:

```powershell
npm run relayer
```

Start the AI server:

```powershell
npm run ai
```

Serve the frontend from the `frontend` folder, then open `index.html` in a browser through your local web server or Cloudflare tunnel.

## Public Demo Notes

When exposing the app through Cloudflare Tunnel, the frontend expects these service paths:

- `/rpc` -> Hardhat JSON-RPC server, usually local port `8545`
- `/relayer` -> relayer server, usually local port `8790`
- `/ai` -> AI server, usually local port `8787`

External players only need access to the web frontend and the public RPC route used by MetaMask. AI requests are normally sent by the frontend/backend services; the AI model itself does not need to be exposed as a standalone public service unless your deployment architecture requires it.

## Demo Flow

1. Connect MetaMask to the local or tunneled private chain.
2. Deposit test ETH into the contract.
3. Create a room or join an existing room.
4. Add real players or AI computer players until there are 4 players.
5. All players mark ready. Bots are ready by default.
6. Host starts the game. The frontend shuffles the deck and submits a commitment hash.
7. Players take turns playing, passing, or challenging.
8. When a player finishes, final challenge/settlement flow runs.
9. Relayer submits final settlement to the contract.
10. Players withdraw remaining contract balances.

## Smart Contract Checklist

The contract is designed to match the project grading requirements:

- **State variables**: `owner`, `deposits`, `rooms`, `isPlayerInRoom`, `rematchVotes`, `roomEpoch`, `settledEpochs`, `roomIds`.
- **Struct**: `Room`.
- **Mapping and array usage**: deposits, room lookup, player membership, rematch votes, settlement replay guard, room list, room player list.
- **Events**: `Deposit`, `Withdrawal`, `RoomCreated`, `PlayerJoined`, `PlayerRemoved`, `RematchVoted`, `RematchExpired`, `GameStarted`, `GameFinished`, `ChallengeSettled`, `FinalWinnerSettled`, `FinalPenaltiesSettled`, `AutoFinalSettlementTriggered`, `PlayerForfeited`.
- **Modifiers**: `onlyOwner`, `roomExists`, `onlyHost`, `inStatus`.
- **Require/revert handling**: custom errors for unauthorized calls, invalid room status, duplicate rooms, duplicate joins, insufficient deposits, invalid player counts, invalid settlement claims, and duplicate settlement execution.
- **Role-based permission**: host-only game start, owner/host lobby removal, player-only settlement and rematch actions.
- **Workflow design**: `Lobby -> Active -> Finished -> Closed`, with rematch support from `Finished`.
- **Replay protection**: final settlement can only execute once per room epoch.

## AI Integration

The AI server receives structured game state:

- bot identity
- current turn
- bot hand
- current claim rank
- play pile count
- discard pile count
- passed players
- last claim
- seat summaries

It returns a compact decision such as:

```json
{ "action": "play", "rank": "A", "cards": ["A"] }
```

or:

```json
{ "action": "challenge" }
```

If the AI provider fails, the frontend falls back to local card-rule heuristics so the demo can continue.

AI request and response logs are written to:

```text
logs/ai-monitor.log
```

## Validation

Run contract tests:

```powershell
npm run test
```

Compile contracts:

```powershell
npm run build
```

Basic syntax checks:

```powershell
node --check frontend/app.js
node --check server/relayer.js
node --check server/ai-player.js
```

## Current Scope Notes

This project demonstrates deck commitment and browser-side secure randomness, but it does not implement a full SRA mental-poker protocol. The original SRA design can be described as an advanced extension. The implemented version focuses on the course requirements: smart contract workflow, frontend integration, events, error handling, and AI/server integration.
