const CONTRACT_ADDRESS = "0x1291be112d480055dafd8a610b7d1e203891c274";
const APP_VERSION = "20260617-wallet-funds-compact";
const LOCAL_RPC_URL = "http://127.0.0.1:8545";
const PUBLIC_RPC_HOST = "rightclickhohoho.dpdns.org";
const MAX_CLAIM_COUNT = 6;
const ROOM_STATUS = ["不存在", "大廳等待中", "遊戲進行中", "遊戲已結束", "房間已關閉"];

const abi = [
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function createRoom(bytes32 roomId,uint256 stakeRequired)",
  "function joinRoom(bytes32 roomId)",
  "function removeLobbyPlayer(bytes32 roomId,address player)",
  "function leaveLobbyRoom(bytes32 roomId)",
  "function voteRematch(bytes32 roomId,bool approve)",
  "function rematchVoteCount(bytes32 roomId) view returns (uint256)",
  "function rematchVoteStartedAt(bytes32 roomId) view returns (uint256)",
  "function rematchVotes(bytes32 roomId,address player) view returns (bool)",
  "function startGame(bytes32 roomId,bytes32 deckCommitment)",
  "function finishGame(bytes32 roomId)",
  "function cancelLobbyRoom(bytes32 roomId)",
  "function closeFinishedRoom(bytes32 roomId)",
  "function closeExpiredRematch(bytes32 roomId)",
  "function settleChallenge(bytes32 roomId,address actor,uint8 claimRank,uint8[] actualRanks,uint256 amount)",
  "function settleFinalWinner(bytes32 roomId,address winner,uint256 amountPerLoser)",
  "function settleFinalPenalties(bytes32 roomId,address winner,address[] losers,uint256[] amounts)",
  "function forfeitGame(bytes32 roomId,uint256 amountPerOpponent)",
  "function deposits(address player) view returns (uint256)",
  "function getRoom(bytes32 roomId) view returns (address host,uint256 stakeRequired,bytes32 deckCommitment,uint8 status,address[] players)",
  "event Deposit(address indexed player,uint256 amount,uint256 newBalance)",
  "event Withdrawal(address indexed player,uint256 amount,uint256 remainingBalance)",
  "event RoomCreated(bytes32 indexed roomId,address indexed host,uint256 stakeRequired)",
  "event PlayerJoined(bytes32 indexed roomId,address indexed player,uint256 playerCount)",
  "event PlayerRemoved(bytes32 indexed roomId,address indexed player,uint256 playerCount)",
  "event RematchVoted(bytes32 indexed roomId,address indexed player,bool approve,uint256 yesVotes)",
  "event RematchExpired(bytes32 indexed roomId,uint256 yesVotes)",
  "event GameStarted(bytes32 indexed roomId,bytes32 indexed deckCommitment)",
  "event GameFinished(bytes32 indexed roomId)",
  "event ChallengeSettled(bytes32 indexed roomId,address indexed loser,address indexed winner,address challenger,address actor,bool claimWasHonest,uint256 amount)",
  "event FinalWinnerSettled(bytes32 indexed roomId,address indexed winner,uint256 amountPerLoser,uint256 totalWon)",
  "event FinalPenaltiesSettled(bytes32 indexed roomId,address indexed winner,uint256 totalWon)",
  "event AutoFinalSettlementTriggered(bytes32 indexed roomId,address indexed winner,address indexed submitter,address[] losers,uint256[] amounts,uint256 totalWon)",
  "event PlayerForfeited(bytes32 indexed roomId,address indexed quitter,uint256 amountPerOpponent,uint256 totalPenalty)"
];

let provider;
let signer;
let contract;
let readProvider;
let eventContract;
let account;
let connecting = false;
let walletEventsReady = false;
let tablePlayers = [];
let roomViewCache = { roomId: null, players: [], status: null };
let latestRoomSnapshot = null;
let roomReadyStatus = new Map();
let rematchYesVotes = 0;
let rematchVoteStartedAt = 0;
let rematchCountdownTimer = null;
let rematchCountdownDeadlineMs = 0;
let rematchAutoClosing = false;
let currentTurnIndex = 0;
let lastActor = null;
let lastClaim = null;
let roundStamp = 0;
let actionStamp = 0;
let playPile = [];
let roundPlays = [];
let discardPileCount = 0;
const discardedRanks = new Set();
let roundRank = null;
let lastPlayedBy = null;
let winnerAddress = null;
let pendingWinner = null;
let finalSettlementInProgress = false;
let finalSettlementDone = false;
let startGamePending = false;
let botMode = false;
let botJoinInProgress = false;
let rematchVoteInProgress = false;
let gameLocked = false;
let botTurnTimer = null;
let botTurnInFlight = null;
let botChallengeTimers = [];
let challengeWindowTimer = null;
let roomSyncTimer = null;
let challengeWindowOpen = false;
let challengeHardLock = false;
let challengeHardLockUntil = 0;
let challengeWindowToken = 0;
let challengeWindowExpiresAt = 0;
let challengeAccepted = false;
let claimSequence = 0;
let resolvingChallenge = false;
const passedPlayers = new Set();
const finalReviewActions = new Set();
const seenContractEvents = new Set();
const recentLogMessages = new Map();
const pendingRoomEventWaiters = new Set();
const CHALLENGE_HARD_LOCK_MS = 10000;
const FINAL_CHALLENGE_WINDOW_MS = 30000;
const REMATCH_WINDOW_MS = 30000;
const playerHands = new Map();
const botPlayers = [
  "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
  "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
  "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199"
];

const demoHand = ["A", "A", "3", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "鬼牌", "鬼牌"];
const defaultHands = [
  ["A", "A", "3", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "鬼牌", "鬼牌"],
  ["2", "2", "4", "4", "6", "7", "8", "9", "10", "J", "Q", "K", "鬼牌", "A"],
  ["3", "3", "5", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"],
  ["2", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "3"]
];
const $ = (id) => document.getElementById(id);
const short = (addr) => addr && addr !== "-" ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "-";
const sameAddress = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const handKey = (addr) => (addr || "guest").toLowerCase();
const isBot = (addr) => botPlayers.some((bot) => sameAddress(bot, addr));
const nicknameKey = (addr = account) => `nickname:${handKey(addr)}`;
const hostedRoomKey = (addr = account) => `hosted-room:${handKey(addr)}`;

function getRpcUrl() {
  if (window.location.hostname === PUBLIC_RPC_HOST) return `${window.location.origin}/rpc`;
  return LOCAL_RPC_URL;
}

function getRelayerUrl() {
  if (window.location.hostname === PUBLIC_RPC_HOST) return `${window.location.origin}/relayer`;
  return "http://127.0.0.1:8790";
}

function getAiServerUrl() {
  if (window.location.hostname === PUBLIC_RPC_HOST) return `${window.location.origin}/ai`;
  return "http://127.0.0.1:8787";
}

async function ensureHardhatNetwork() {
  if (!window.ethereum) return;
  const rpcUrl = getRpcUrl();
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x7a69" }]
    });
  } catch (err) {
    if (err?.code !== 4902) return;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x7a69",
        chainName: "Hardhat Private Chain",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: [rpcUrl]
      }]
    });
  }
}

function sortHand(hand) {
  return [...hand].sort((a, b) => rankNumber(a) - rankNumber(b));
}

function sanitizeNickname(value) {
  return String(value || "").trim().slice(0, 16);
}

function getNickname(player) {
  if (!player) return "";
  return sanitizeNickname(localStorage.getItem(nicknameKey(player)));
}

function updateNicknameInput() {
  if ($("nicknameInput")) $("nicknameInput").value = getNickname(account);
}

function playerLabel(player) {
  if (!player) return "尚未開始";
  const botIndex = botPlayers.findIndex((bot) => sameAddress(bot, player));
  if (botIndex >= 0) return `電腦玩家 ${botIndex + 1}`;
  const nickname = getNickname(player);
  if (nickname) return nickname;
  if (sameAddress(player, account)) return "你";
  return short(player);
}

function log(message) {
  const now = Date.now();
  const normalized = String(message);
  const lastAt = recentLogMessages.get(normalized) || 0;
  if (now - lastAt < 2000) return;
  recentLogMessages.set(normalized, now);
  for (const [entry, timestamp] of recentLogMessages) {
    if (now - timestamp > 10000) recentLogMessages.delete(entry);
  }
  const item = document.createElement("div");
  item.className = "log-item";
  item.textContent = `[${new Date().toLocaleTimeString()}] ${normalized}`;
  $("eventLog").prepend(item);
}

function closeChallengeableTableLogs() {
  document.querySelectorAll("#tableEventFeed .log-item.is-challengeable").forEach((item) => {
    item.classList.remove("is-challengeable");
    item.classList.add("is-closed");
  });
}

function tableLog(message, state = "closed") {
  const tableEventFeed = $("tableEventFeed");
  if (tableEventFeed) {
    const tableItem = document.createElement("div");
    tableItem.className = "log-item";
    if (state === "challengeable") tableItem.classList.add("is-challengeable");
    if (state === "closed") tableItem.classList.add("is-closed");
    tableItem.textContent = message;
    tableEventFeed.prepend(tableItem);
  }
}

function eventKey(name, event) {
  const txHash = event?.log?.transactionHash || event?.transactionHash || event?.hash;
  const logIndex = event?.log?.index ?? event?.log?.logIndex ?? event?.index ?? event?.logIndex;
  if (txHash || logIndex !== undefined) return `${name}:${txHash || "no-tx"}:${logIndex ?? "no-index"}`;
  const argsKey = JSON.stringify(Array.from(event?.args || []), (_, value) => typeof value === "bigint" ? value.toString() : value);
  return `${name}:${argsKey}`;
}

function notifyRoomEventWaiters(name, args) {
  for (const waiter of Array.from(pendingRoomEventWaiters)) {
    try {
      if (!waiter.names.includes(name)) continue;
      if (!waiter.predicate(args)) continue;
      clearTimeout(waiter.timer);
      pendingRoomEventWaiters.delete(waiter);
      waiter.resolve({ name, args });
    } catch (_err) {
      // Ignore malformed event payloads and keep waiting for the next event.
    }
  }
}

function waitForRoomEvent(names, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const waiter = {
      names,
      predicate,
      resolve,
      timer: setTimeout(() => {
        pendingRoomEventWaiters.delete(waiter);
        reject(new Error("event timeout"));
      }, timeoutMs)
    };
    pendingRoomEventWaiters.add(waiter);
  });
}

function formatEtherText(value) {
  try {
    return `${ethers.formatEther(value)} ETH`;
  } catch (_) {
    return String(value);
  }
}

function formatContractEvent(name, args) {
  const values = Array.from(args || []);
  switch (name) {
    case "Deposit":
      return `押金存入：${short(values[0])} 存入 ${formatEtherText(values[1])}，餘額 ${formatEtherText(values[2])}`;
    case "Withdrawal":
      return `押金提出：${short(values[0])} 提出 ${formatEtherText(values[1])}，餘額 ${formatEtherText(values[2])}`;
    case "RoomCreated":
      return `房間建立：房主 ${short(values[1])}，最低押金 ${formatEtherText(values[2])}`;
    case "PlayerJoined":
      return `玩家加入：${short(values[1])}，目前 ${values[2].toString()} 位`;
    case "PlayerRemoved":
      return `玩家移除：${short(values[1])}，目前 ${values[2].toString()} 位`;
    case "RematchVoted":
      return `${short(values[1])} ${values[2] ? "同意" : "取消同意"}再開一局，目前 ${values[3].toString()} 票`;
    case "RematchExpired":
      return `再開一局投票逾時，最後 ${values[1].toString()} 票，房間已結束`;
    case "GameStarted":
      return `遊戲開始：牌組承諾 ${short(values[1])}`;
    case "GameFinished":
      return `遊戲結束事件：房間 ${short(values[0])}`;
    case "ChallengeSettled":
      return `抓吹牛結算：輸家 ${short(values[1])}，贏家 ${short(values[2])}，金額 ${formatEtherText(values[6])}`;
    case "FinalPenaltiesSettled":
      return `最終押金結算：贏家 ${short(values[1])}，總額 ${formatEtherText(values[2])}`;
    case "FinalWinnerSettled":
      return `最終押金結算：贏家 ${short(values[1])}，每位輸家 ${formatEtherText(values[2])}`;
    case "AutoFinalSettlementTriggered":
      return `自動結算事件：relayer 已提交，贏家 ${short(values[1])}`;
    case "PlayerForfeited":
      return `認輸退出事件：${short(values[1])} 認輸，總罰金 ${formatEtherText(values[3])}`;
    default:
      return name;
  }
}

function explainError(err) {
  const code = err?.code ?? err?.error?.code;
  const parts = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (typeof value === "string") {
      parts.push(value);
      try {
        const parsed = JSON.parse(value);
        visit(parsed, depth + 1);
      } catch (_) {}
      return;
    }
    if (typeof value !== "object") return;
    for (const key of ["shortMessage", "reason", "message", "data", "body"]) visit(value[key], depth + 1);
    visit(value.error, depth + 1);
    visit(value.info, depth + 1);
    visit(value.payload, depth + 1);
  };
  visit(err);
  const message = parts.find(Boolean) || String(err);
  const allMessages = parts.join(" \n ");
  if (code === -32002 || message.includes("-32002")) return "MetaMask 已有待處理請求，請先確認或取消。";
  if (code === 4001 || message.includes("user rejected")) return "你已取消 MetaMask 請求。";
  if (/invalid block tag/i.test(allMessages)) return "MetaMask 還記著舊私鏈區塊高度。已改由前端直接向 Hardhat RPC 讀取 nonce；請 Ctrl+F5 後重送交易。";
  if (/nonce/i.test(allMessages)) return "交易 nonce 與私鏈不同步。請重整頁面再試；若仍失敗，請在 MetaMask 的 Hardhat 帳號執行 Reset account 後重送交易。";
  if (/insufficient funds|exceeds balance/i.test(allMessages)) return "錢包 ETH 不足，請確認 MetaMask 連到 Hardhat Private Chain，且使用 Hardhat 測試帳號。";
  if (/could not coalesce error/i.test(message)) return `MetaMask/私鏈回傳錯誤：${allMessages || message}`;
  if (message.includes("RoomAlreadyExists")) return "房間已存在，請加入房間或換新房號。";
  if (message.includes("AlreadyJoined")) return "你已經加入這個房間。";
  if (message.includes("InvalidPlayerCount")) return "玩家人數不符合要求：開始遊戲需要剛好 4 位玩家。";
  if (message.includes("RematchNotApproved")) return "不能開始：再開一局投票尚未過半。";
  if (message.includes("InsufficientDeposit")) return "押金不足，請先存入足夠 ETH。";
  if (message.includes("Unauthorized")) return "沒有權限：只有房主可以開始或結束遊戲。";
  if (message.includes("RoomNotFound")) return "找不到房間，請先建立房間。";
  if (message.includes("InvalidStatus")) return "房間狀態不允許這個操作。";
  if (message.includes("execution reverted")) return `合約拒絕交易：${message}`;
  return message;
}

function syncContractAddress() {
  $("contractAddress").value = CONTRACT_ADDRESS;
  const visibleLabel = document.getElementById("contractAddressLabel");
  if (visibleLabel) visibleLabel.textContent = CONTRACT_ADDRESS;
}

function roomId() {
  return ethers.id($("roomText").value || "room-001");
}

function roomIdFromText(value) {
  return ethers.id(value || "room-001");
}

function makeRoomName() {
  const random = crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36) : Math.random().toString(36).slice(2, 8);
  return `room-${Date.now().toString(36)}-${random}`;
}

function showView(viewId) {
  for (const section of document.querySelectorAll(".app-view")) {
    section.classList.toggle("is-hidden", section.id !== viewId);
  }
  const buttonMap = { lobbySection: "showLobbyButton", gameSection: "showGameButton" };
  for (const button of document.querySelectorAll(".tab-button")) button.classList.remove("active");
  if (buttonMap[viewId]) $(buttonMap[viewId]).classList.add("active");
}

function renderHand() {
  const cards = $("handCards");
  cards.innerHTML = "";
  if (account) setPlayerHand(account, getPlayerHand(account));
  const hand = getPlayerHand(account);
  hand.forEach((rank, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = rank === "鬼牌" ? "card joker" : "card";
    card.dataset.index = String(index);
    card.textContent = rank;
    cards.append(card);
  });
  if ($("handCount")) $("handCount").textContent = String(hand.length);
  updateControls();
}

function getPlayerHand(player = account, index = tablePlayers.findIndex((p) => sameAddress(p, player))) {
  const key = handKey(player);
  if (!playerHands.has(key)) {
    const fallback = defaultHands[index >= 0 ? index % defaultHands.length : 0] || demoHand;
    playerHands.set(key, sortHand(fallback));
  }
  playerHands.set(key, sortHand(playerHands.get(key)));
  return playerHands.get(key);
}

function setPlayerHand(player, hand) {
  playerHands.set(handKey(player), sortHand(hand));
}

function buildDeck() {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (const rank of ranks) {
    for (let i = 0; i < 4; i += 1) deck.push(rank);
  }
  deck.push("鬼牌", "鬼牌");
  return deck;
}

function secureRandomInt(maxExclusive) {
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % maxExclusive;
}

function shuffleDeck(deck) {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function startingIndexFromCommitment(commitment, playerCount = tablePlayers.length) {
  if (!playerCount) return 0;
  const hex = String(commitment || "").replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 8) return secureRandomInt(playerCount);
  return Number.parseInt(hex.slice(-8), 16) % playerCount;
}

async function dealRandomEncryptedHands() {
  if (tablePlayers.length !== 4) {
    log(`發牌失敗：需要 4 位玩家，目前只有 ${tablePlayers.length} 位。`);
    return false;
  }

  const deck = shuffleDeck(buildDeck());
  const counts = [14, 14, 13, 13];
  let offset = 0;
  playerHands.clear();
  tablePlayers.forEach((player, index) => {
    const hand = sortHand(deck.slice(offset, offset + counts[index]));
    setPlayerHand(player, hand);
    offset += counts[index];
  });

  const salt = crypto.getRandomValues(new Uint32Array(4)).join("-");
  const commitment = await sha256Hex(JSON.stringify({ room: $("roomText").value, salt, deck }));
  const startingPlayerIndex = startingIndexFromCommitment(commitment, tablePlayers.length);
  $("deckCommitment").value = commitment;
  $("tableDeckCommitment").textContent = `${commitment.slice(0, 10)}...${commitment.slice(-8)}`;
  $("dealStatus").textContent = "已用 WebCrypto 產生隨機洗牌，並依玩家順序發牌。";
  localStorage.setItem(
    `deal:${roomId()}`,
    JSON.stringify({ commitment, salt, startingPlayerIndex, players: tablePlayers, hands: Object.fromEntries(playerHands) })
  );
  currentTurnIndex = startingPlayerIndex;

  checkAllPlayersFourOfAKind();
  renderHand();
  renderSeats();
  renderTurn();
  log(`已隨機洗牌並發牌，起始玩家：${playerLabel(tablePlayers[startingPlayerIndex])}，牌組承諾：${commitment}`);
  return true;
}

function restoreDealForRoom() {
  try {
    const payload = JSON.parse(localStorage.getItem(`deal:${roomId()}`) || "{}");
    if (!payload?.hands) return false;
    playerHands.clear();
    for (const [player, hand] of Object.entries(payload.hands)) {
      if (Array.isArray(hand)) setPlayerHand(player, hand);
    }
    if (payload.commitment) {
      $("deckCommitment").value = payload.commitment;
      $("tableDeckCommitment").textContent = `${payload.commitment.slice(0, 10)}...${payload.commitment.slice(-8)}`;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

function ensureTablePlayers(players = tablePlayers, useAccountFallback = true) {
  tablePlayers = Array.from(players || []).slice(0, 4);
  if (!tablePlayers.length && account && useAccountFallback) tablePlayers = [account];
  tablePlayers.forEach((player, index) => getPlayerHand(player, index));
  if (currentTurnIndex >= tablePlayers.length) currentTurnIndex = 0;
  renderSeats();
  renderTurn();
}

function resetTurnState(players = tablePlayers, clearHands = false, startingIndex = 0) {
  clearBotTimer();
  clearBotTurnInFlight();
  clearBotChallengeTimers();
  clearChallengeWindowTimer();
  challengeWindowOpen = false;
  challengeHardLock = false;
  challengeHardLockUntil = 0;
  challengeAccepted = false;
  challengeWindowToken += 1;
  challengeWindowExpiresAt = 0;
  claimSequence += 1;
  roundStamp += 1;
  actionStamp += 1;
  if (clearHands) playerHands.clear();
  tablePlayers = Array.from(players || []).slice(0, 4);
  currentTurnIndex = tablePlayers.length ? Math.max(0, Math.min(Number(startingIndex) || 0, tablePlayers.length - 1)) : 0;
  lastActor = null;
  lastClaim = null;
  playPile = [];
  roundPlays = [];
  discardPileCount = 0;
  discardedRanks.clear();
  roundRank = null;
  lastPlayedBy = null;
  winnerAddress = null;
  pendingWinner = null;
  finalReviewActions.clear();
  finalSettlementInProgress = false;
  finalSettlementDone = false;
  rematchVoteInProgress = false;
  resolvingChallenge = false;
  passedPlayers.clear();
  $("currentClaim").textContent = "尚未喊牌";
  $("lastMove").textContent = "等待玩家行動";
  $("winnerText").textContent = "尚未分出勝負";
  if ($("tableEventFeed")) $("tableEventFeed").replaceChildren();
  hidePostGameActions();
  updateClaimBoard();
  updatePileDisplay();
  ensureTablePlayers(tablePlayers, false);
}

function hidePostGameActions() {
  if ($("postGameActions")) $("postGameActions").classList.add("is-hidden");
  if ($("settleFinalButton")) {
    $("settleFinalButton").classList.add("is-hidden");
    $("settleFinalButton").disabled = true;
    $("settleFinalButton").textContent = "自動結算中";
  }
}

function showPostGameActions() {
  if ($("settleFinalButton")) {
    $("settleFinalButton").classList.add("is-hidden");
    $("settleFinalButton").disabled = true;
  }
  if ($("postGameActions")) $("postGameActions").classList.remove("is-hidden");
  updateControls();
}

function showSettlementRetryButton() {
  if (!$("settleFinalButton")) return;
  $("settleFinalButton").classList.remove("is-hidden");
  $("settleFinalButton").disabled = false;
  $("settleFinalButton").textContent = "重送結算";
}

function cardRank(card) {
  if (card === "鬼牌") return "鬼牌";
  return card;
}

function rankNumber(rank) {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  if (rank === "鬼牌") return 13;
  return ranks.indexOf(rank);
}

function isClaimHonest(claim) {
  if (!claim) return false;
  return claim.actualCards.length === claim.count && claim.actualCards.every((card) => {
    const rank = cardRank(card);
    return rank === claim.rank || rank === "鬼牌";
  });
}

function updateClaimBoard(resultText = "尚未判定") {
  $("lastClaimActor").textContent = lastClaim ? short(lastClaim.actor) : "尚無";
  $("lastClaimText").textContent = lastClaim ? `${lastClaim.count} 張 ${lastClaim.rank}` : "尚無";
  $("revealedCards").textContent = lastClaim?.revealed ? lastClaim.actualCards.join("、") : "尚未抓牌";
  $("roundReveal").textContent = roundPlays.some((play) => play.revealed)
    ? roundPlays.map((play) => `${playerLabel(play.actor)} 宣稱 ${play.count} 張 ${play.rank}，實出 ${play.actualCards.join("、")}`).join("｜")
    : "尚未抓牌";
  $("challengeResult").textContent = resultText;
  updateControls();
}

function updatePileDisplay() {
  $("playPileCount").textContent = `${playPile.length} 張`;
  $("discardPileCount").textContent = `棄牌堆 ${discardPileCount} 張`;
}

function playerIndex(player) {
  return tablePlayers.findIndex((p) => sameAddress(p, player));
}

function setTurnTo(player) {
  const index = playerIndex(player);
  if (index >= 0) currentTurnIndex = index;
  renderSeats();
  renderTurn();
}

function givePileTo(player) {
  const hand = [...getPlayerHand(player)];
  hand.push(...playPile);
  setPlayerHand(player, hand);
  discardFourOfAKind(player);
  playPile = [];
  roundPlays = [];
  roundRank = null;
  lastPlayedBy = null;
  passedPlayers.clear();
  updatePileDisplay();
}

function discardFourOfAKind(player) {
  const hand = [...getPlayerHand(player)];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  let changed = false;

  for (const rank of ranks) {
    const matchingIndexes = hand
      .map((card, index) => ({ card, index }))
      .filter((entry) => entry.card === rank)
      .map((entry) => entry.index);
    if (matchingIndexes.length < 4) continue;
    for (const index of matchingIndexes.slice(0, 4).sort((a, b) => b - a)) hand.splice(index, 1);
    discardPileCount += 4;
    discardedRanks.add(rank);
    changed = true;
    log(`${playerLabel(player)} 湊滿 4 張 ${rank}，放入棄牌堆。`);
  }

  if (!changed) return false;
  setPlayerHand(player, hand);
  updatePileDisplay();
  return true;
}

function checkAllPlayersFourOfAKind() {
  for (const player of tablePlayers) discardFourOfAKind(player);
  renderHand();
  renderSeats();
}

function finishPassCycle() {
  if (challengeWindowOpen) {
    challengeWindowOpen = false;
    challengeHardLock = false;
    challengeHardLockUntil = 0;
    challengeWindowToken += 1;
    challengeWindowExpiresAt = 0;
    clearChallengeWindowTimer();
  }
  closeChallengeableTableLogs();
  if (pendingWinner) {
    $("lastMove").textContent = `所有其他玩家都 Pass，${playerLabel(pendingWinner)} 的最後一手通過。`;
    setWinner(pendingWinner);
    void autoSettleFinalPenalties();
    renderHand();
    renderSeats();
    updateControls();
    return;
  }
  roundRank = null;
  lastActor = null;
  lastClaim = null;
  passedPlayers.clear();
  updateClaimBoard();
  $("currentClaim").textContent = "新回合，可自由喊點數";
  $("lastMove").textContent = "所有其他玩家都 pass，由最後出牌者開始新回合，可喊新的點數。出牌堆保留。";
  updatePileDisplay();
  if (lastPlayedBy) setTurnTo(lastPlayedBy);
}

function setWinner(player) {
  pendingWinner = null;
  winnerAddress = player;
  gameLocked = false;
  $("winnerText").textContent = playerLabel(player);
  $("lastMove").textContent = `${playerLabel(player)} 已打完所有手牌，遊戲結束。`;
  $("settlementSuggestion").textContent = `贏家 ${playerLabel(player)} 已出完牌。最後三家輸家各支付結算金額給贏家。`;
  log(`遊戲結束：${playerLabel(player)} 打完所有手牌。`);
}

function confirmPendingWinner(reason = "最後一手通過") {
  if (!pendingWinner || winnerAddress) return false;
  const winner = pendingWinner;
  challengeWindowOpen = false;
  challengeHardLock = false;
  challengeHardLockUntil = 0;
  challengeAccepted = false;
  challengeWindowToken += 1;
  challengeWindowExpiresAt = 0;
  finalReviewActions.clear();
  clearChallengeWindowTimer();
  clearBotChallengeTimers();
  closeChallengeableTableLogs();
  $("lastMove").textContent = `${reason}，${playerLabel(winner)} 獲勝。`;
  setWinner(winner);
  void autoSettleFinalPenalties();
  renderHand();
  renderSeats();
  updateControls();
  return true;
}

function checkWinner(player) {
  if (!player) return false;
  if (getPlayerHand(player).length !== 0) return false;
  pendingWinner = player;
  finalReviewActions.clear();
  $("winnerText").textContent = `待確認：${playerLabel(player)}`;
  $("lastMove").textContent = `${playerLabel(player)} 已出完手牌，其他玩家仍可抓最後一手。`;
  $("settlementSuggestion").textContent = `最後一手進入 30 秒審查，其他玩家可同時抓吹牛；無人成功抓則 ${playerLabel(player)} 獲勝。`;
  log(`${playerLabel(player)} 已出完手牌，最後 30 秒可被其他玩家抓吹牛。`);
  return true;
}

function markFinalReviewAction(player, label = "放棄抓吹牛") {
  if (!pendingWinner || winnerAddress || resolvingChallenge) return false;
  if (!player || sameAddress(player, pendingWinner)) return false;

  const key = handKey(player);
  if (!finalReviewActions.has(key)) {
    finalReviewActions.add(key);
    log(`${playerLabel(player)} ${label}。`);
    tableLog(`${playerLabel(player)} ${label}`);
  }

  const reviewers = tablePlayers.filter((candidate) => !sameAddress(candidate, pendingWinner));
  const allReviewed = reviewers.length > 0 && reviewers.every((candidate) => finalReviewActions.has(handKey(candidate)));
  if (allReviewed) confirmPendingWinner("所有其他玩家都已放棄抓吹牛");
  updateControls();
  return true;
}

async function autoSettleFinalPenalties() {
  if (!winnerAddress || finalSettlementInProgress || finalSettlementDone) return;
  finalSettlementInProgress = true;

  const losers = tablePlayers.filter((player) => !sameAddress(player, winnerAddress));
  const payableLosers = losers.filter((loser) => getPlayerHand(loser).length > 0);
  const summary = losers
    .map((loser) => `${playerLabel(loser)} ${getPlayerHand(loser).length} ETH`)
    .join("、");

  try {
    if (!payableLosers.length) {
      completePostSettlement("沒有剩餘手牌需要扣款，遊戲已結束。");
      await refreshBalance();
      await refreshRoomStatus().catch(() => {});
      return;
    }

    const amounts = payableLosers.map((loser) => ethers.parseEther(String(getPlayerHand(loser).length)));
    const payload = {
      type: "final-penalties",
      roomId: roomId(),
      winner: winnerAddress,
      losers: payableLosers,
      amounts: amounts.map((amount) => amount.toString()),
      summary,
      simulated: false,
      issuedAt: Date.now()
    };

    const key = `final-settlement:${payload.roomId}:${winnerAddress.toLowerCase()}`;
    localStorage.setItem(key, JSON.stringify(payload));
    if ($("settleNoteInput")) $("settleNoteInput").value = JSON.stringify(payload, null, 2);
    fillLatestFinalSettlementPayload(true);
    $("settlementSuggestion").textContent = `本局結算已自動代入：${summary}，正在由 relayer 提交鏈上結算。`;
    log(`本局結算已自動代入：${summary}。`);
    renderHand();
    renderSeats();
    updateControls();
    await settleFinalSettlementBundle(payload);
  } catch (err) {
    const message = explainError(err);
    $("settlementSuggestion").textContent = `自動鏈上結算失敗：${message}。系統已保留本局結算資料。`;
    showSettlementRetryButton();
    log(`自動鏈上結算失敗：${message}`);
  } finally {
    finalSettlementInProgress = false;
  }
}

function completePostSettlement(message = "本局已完成鏈上結算。") {
  gameLocked = false;
  finalSettlementDone = true;
  finalSettlementInProgress = false;
  challengeWindowOpen = false;
  challengeHardLock = false;
  challengeAccepted = false;
  clearBotTimer();
  clearBotTurnInFlight();
  clearBotChallengeTimers();
  clearChallengeWindowTimer();
  closeChallengeableTableLogs();
  if ($("tableStatus")) $("tableStatus").textContent = "本局已結束";
  if ($("lastMove")) $("lastMove").textContent = message;
  if ($("settlementSuggestion")) $("settlementSuggestion").textContent = `${message} 可結束遊戲，或準備再開一局。`;
  if (tablePlayers.some(isBot)) {
    void relayerReadyBots()
      .then(() => refreshRoomStatus())
      .catch((err) => log(`電腦玩家自動準備失敗：${explainError(err)}`));
  }
  showPostGameActions();
  updateControls();
}

function getLatestFinalSettlementPayload() {
  const currentRoomId = roomId();
  const payloads = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith("final-settlement:")) continue;
    try {
      const payload = JSON.parse(localStorage.getItem(key) || "{}");
      if (payload?.type !== "final-penalties") continue;
      const sameRoom = payload.roomId === currentRoomId;
      const ownWinner = account && payload.winner && sameAddress(payload.winner, account);
      payloads.push({ payload, sameRoom, ownWinner, issuedAt: Number(payload.issuedAt || 0) });
    } catch (_err) {
      // Ignore stale or manually edited localStorage entries.
    }
  }

  payloads.sort((a, b) => {
    if (a.sameRoom !== b.sameRoom) return a.sameRoom ? -1 : 1;
    if (a.ownWinner !== b.ownWinner) return a.ownWinner ? -1 : 1;
    return b.issuedAt - a.issuedAt;
  });
  return payloads[0]?.payload || null;
}

function buildFinalSettlementPayload() {
  const winner = winnerAddress || getLatestFinalSettlementPayload()?.winner;
  if (!winner) return null;
  const losers = tablePlayers.filter((player) => player && !sameAddress(player, winner));
  const payableLosers = losers.filter((loser) => getPlayerHand(loser).length > 0);
  const amounts = payableLosers.map((loser) => ethers.parseEther(String(getPlayerHand(loser).length)).toString());
  const summary = losers
    .map((loser) => `${playerLabel(loser)}：${getPlayerHand(loser).length} ETH`)
    .join("\n");
  return {
    type: "final-penalties",
    roomId: roomId(),
    winner,
    losers: payableLosers,
    amounts,
    summary,
    simulated: false,
    issuedAt: Date.now()
  };
}

function fillLatestFinalSettlementPayload(force = false) {
  const input = $("settleNoteInput");
  const winnerInput = $("settlementWinner");
  const preview = $("settlementPreview");
  if (!input && !winnerInput && !preview) return null;
  if (!force && input.value.trim()) {
    try {
      const existing = JSON.parse(input.value);
      if (winnerInput) winnerInput.value = existing.winner || "";
      if (preview) preview.value = existing.summary || "";
      return existing;
    } catch (_err) {
      return null;
    }
  }
  const payload = buildFinalSettlementPayload() || getLatestFinalSettlementPayload();
  if (!payload) return null;
  if (input) input.value = JSON.stringify(payload, null, 2);
  if (winnerInput) winnerInput.value = payload.winner || "";
  if (preview) preview.value = payload.summary || "";
  if ($("settlementSuggestion")) {
    $("settlementSuggestion").textContent = `已自動載入本局結算：${payload.summary || "等待鏈上結算"}`;
  }
  return payload;
}

function chooseBotPlay(bot) {
  const hand = getPlayerHand(bot);
  const targetRank = roundRank;
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].filter((rank) => !discardedRanks.has(rank));
  if (!targetRank && !ranks.length) return { action: "pass" };
  const countRank = (rank) => hand.filter((card) => card === rank).length;
  const playableForRank = (rank) => hand.filter((card) => card === rank || card === "鬼牌");
  const bluffCards = () => [...hand]
    .sort((a, b) => rankNumber(a) - rankNumber(b))
    .slice(0, Math.min(hand.length, playPile.length >= 10 ? 1 : 2));

  if (targetRank) {
    const cards = playableForRank(targetRank).slice(0, 3);
    if (cards.length) return { action: "play", rank: targetRank, cards };
    const dangerousPile = playPile.length >= 12;
    const manyPlayersStillActive = tablePlayers
      .filter((player) => !sameAddress(player, lastPlayedBy))
      .some((player) => !passedPlayers.has(handKey(player)));
    if (dangerousPile && manyPlayersStillActive) return { action: "pass" };
    return { action: "play", rank: targetRank, cards: bluffCards() };
  }

  let bestRank = ranks[0];
  let bestCount = 0;
  for (const rank of ranks) {
    const count = playableForRank(rank).length;
    if (count > bestCount) {
      bestRank = rank;
      bestCount = count;
    }
  }
  if (bestCount > 0) {
    return { action: "play", rank: bestRank, cards: playableForRank(bestRank).slice(0, Math.min(3, bestCount)) };
  }
  return { action: "play", rank: "A", cards: hand.slice(0, 1) };
}

function botShouldChallenge(bot) {
  if (!lastClaim || sameAddress(lastClaim.actor, bot)) return false;
  const botHand = getPlayerHand(bot);
  const knownRankCount = botHand.filter((card) => card === lastClaim.rank).length;
  const knownJokers = botHand.filter((card) => card === "鬼牌").length;
  const impossiblePressure = lastClaim.count + knownRankCount + knownJokers > 6;
  const botHasNoClaimRank = knownRankCount + knownJokers === 0;
  const botBlocksMostTruth = lastClaim.count + knownRankCount + knownJokers >= 5;
  const actorHandCount = getPlayerHand(lastClaim.actor).length;
  const highClaim = lastClaim.count >= 2;
  const desperate = actorHandCount <= 2;
  const pileIsLarge = playPile.length >= 6;
  const latePileBluff = botHasNoClaimRank && lastClaim.count >= 2 && playPile.length >= 4;
  const suspiciousSingle = botHasNoClaimRank
    && lastClaim.count === 1
    && playPile.length >= (actorHandCount <= 3 ? 4 : 6)
    && secureRandomInt(actorHandCount <= 3 ? 100 : 140) < (actorHandCount <= 3 ? 46 : 32);
  return impossiblePressure || botBlocksMostTruth || (highClaim && pileIsLarge) || desperate || latePileBluff || suspiciousSingle;
}

function buildBotAiState(bot) {
  return {
    bot: playerLabel(bot),
    hand: getPlayerHand(bot),
    roundRank,
    playPileCount: playPile.length,
    discardPileCount,
    passedPlayers: tablePlayers.filter((player) => passedPlayers.has(handKey(player))).map(playerLabel),
    currentTurn: playerLabel(currentTurnPlayer()),
    lastClaim: lastClaim ? {
      actor: playerLabel(lastClaim.actor),
      count: lastClaim.count,
      rank: lastClaim.rank
    } : null,
    seats: tablePlayers.map((player) => ({
      player: playerLabel(player),
      handCount: getPlayerHand(player).length,
      isBot: isBot(player)
    }))
  };
}

async function requestAiBotChoice(bot) {
  const response = await fetch(`${getAiServerUrl()}/bot-action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildBotAiState(bot))
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "AI server error");
  return payload;
}

function aiLabel(payload) {
  if (!payload?.provider) return "AI";
  if (payload.provider === "lmstudio") return `LM Studio ${payload.model || ""}`.trim();
  if (payload.provider === "google") return `Google ${payload.model || ""}`.trim();
  if (payload.provider === "local-rule") return "本地規則";
  return payload.provider;
}

function normalizeAiChoice(bot, decision) {
  const hand = getPlayerHand(bot);
  const action = String(decision?.action || "").toLowerCase();
  if (action === "challenge" && lastClaim && !sameAddress(lastClaim.actor, bot)) return { action: "challenge" };
  if (action === "pass" && roundRank && lastPlayedBy && !sameAddress(lastPlayedBy, bot)) return { action: "pass" };
  const actor = String(decision?.actor || "");
  const claimActorLabel = lastClaim ? playerLabel(lastClaim.actor) : "";
  const describesLastClaim = Boolean(
    lastClaim
    && actor
    && actor === claimActorLabel
    && (!decision?.rank || String(decision.rank).toUpperCase() === String(lastClaim.rank).toUpperCase())
    && (!decision?.count || Number(decision.count) === Number(lastClaim.count))
    && !sameAddress(lastClaim.actor, bot)
  );
  if (!action && describesLastClaim) return { action: "challenge" };
  if (action !== "play") return null;

  const rank = roundRank || String(decision?.rank || "").toUpperCase();
  const validRanks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].filter((rank) => roundRank === rank || !discardedRanks.has(rank));
  if (!validRanks.includes(rank)) return null;

  const wantedCards = Array.isArray(decision?.cards) ? decision.cards.map(String) : [];
  const selected = [];
  const used = new Set();
  for (const card of wantedCards.slice(0, 3)) {
    const index = hand.findIndex((candidate, candidateIndex) => candidate === card && !used.has(candidateIndex));
    if (index >= 0) {
      selected.push(hand[index]);
      used.add(index);
    }
  }
  if (!selected.length || selected.length > 3) return null;
  return { action: "play", rank, cards: selected };
}

function renderSeats() {
  const seats = $("tableSeats");
  if (!seats) return;

  const names = ["玩家 A", "玩家 B", "玩家 C", "玩家 D"];
  seats.innerHTML = "";

  for (let index = 0; index < 4; index += 1) {
    const player = tablePlayers[index];
    const seat = document.createElement("div");
    seat.className = "seat";
    if (player && sameAddress(player, account)) seat.classList.add("active");
    if (player && index === currentTurnIndex) seat.classList.add("turn");

    const title = document.createElement("strong");
    const isYou = player && sameAddress(player, account);
    title.textContent = player ? playerLabel(player) : names[index];
    const address = document.createElement("span");
    if (isYou) address.id = "seatYou";
    address.textContent = player ? short(player) : "等待玩家";
    const hand = document.createElement("small");
    const handCount = player ? getPlayerHand(player, index).length : 0;
    hand.innerHTML = player && isYou ? `手牌 <b id="handCount">${handCount}</b>` : player ? `手牌 ${handCount}` : "空位";

    seat.append(title, address, hand);
    seats.append(seat);
  }
}

function renderTurn() {
  const current = tablePlayers[currentTurnIndex];
  $("currentTurn").textContent = playerLabel(current);
  if (!current) {
    $("turnHint").textContent = "等待房間玩家同步。";
  } else if (sameAddress(current, account)) {
    $("turnHint").textContent = "輪到你出牌。";
  } else if (isBot(current)) {
    $("turnHint").textContent = `${playerLabel(current)} 的回合，會自動行動。`;
  } else {
    $("turnHint").textContent = `等待 ${short(current)} 出牌。`;
  }
  updateControls();
  scheduleBotTurn();
}

function updateControls() {
  const current = currentTurnPlayer();
  const ownTurn = Boolean(account && current && sameAddress(current, account));
  const botTurn = Boolean(current && isBot(current));
  const gameOver = Boolean(winnerAddress);
  const finalPending = Boolean(pendingWinner);
  const room = latestRoomSnapshot;
  const roomStatus = room ? Number(room.status) : 0;
  const roomPlayers = room ? Array.from(room.players) : [];
  const isHost = Boolean(account && room && sameAddress(room.host, account));
  const isInRoom = Boolean(account && roomPlayers.some((player) => sameAddress(player, account)));
  const isReadyable = roomStatus === 1 || roomStatus === 3;
  const canEditPlayers = roomStatus === 1 || roomStatus === 3;
  const selfReady = Boolean(account && roomReadyStatus.get(handKey(account)));
  const canFinalPass = Boolean(finalPending && account && challengeWindowOpen && !gameOver && !resolvingChallenge && !sameAddress(pendingWinner, account) && !finalReviewActions.has(handKey(account)));
  const canPass = canFinalPass || (ownTurn && !gameOver && !finalPending && !resolvingChallenge && !challengeHardLock && Boolean(roundRank && lastPlayedBy && !sameAddress(lastPlayedBy, account)));
  const canChallenge = Boolean(account && challengeWindowOpen && lastClaim && lastActor && !sameAddress(lastActor, account) && !gameOver && !resolvingChallenge);

  if ($("playClaimButton")) $("playClaimButton").disabled = !ownTurn || gameOver || finalPending || resolvingChallenge || challengeHardLock || botTurn;
  if ($("passButton")) $("passButton").disabled = !canPass;
  if ($("challengeButton")) $("challengeButton").disabled = !canChallenge;
  if ($("createRoomButton")) $("createRoomButton").disabled = !account || gameLocked || (roomStatus === 1 && isInRoom);
  if ($("joinRoomButton")) $("joinRoomButton").disabled = !account || gameLocked || roomStatus !== 1 || isInRoom || roomPlayers.length >= 4;
  if ($("readyButton")) {
    $("readyButton").disabled = !account || !isInRoom || !isReadyable;
    $("readyButton").textContent = selfReady ? "取消準備" : "準備";
  }
  if ($("leaveRoomButton")) $("leaveRoomButton").disabled = !account || gameLocked || roomStatus !== 1 || !isInRoom || isHost;
  if ($("disbandRoomButton")) $("disbandRoomButton").disabled = !account || gameLocked || ![1, 3].includes(roomStatus) || !isHost;
  if ($("addBotsButton")) $("addBotsButton").disabled = !account || !isHost || gameLocked || botJoinInProgress || roomStatus !== 1 || roomPlayers.length >= 4;
  if ($("removePlayerSelect")) $("removePlayerSelect").disabled = !account || !isHost || gameLocked || botJoinInProgress || !canEditPlayers || roomPlayers.length <= 1;
  if ($("removeBotButton")) {
    $("removeBotButton").disabled = !account || !isHost || gameLocked || botJoinInProgress || !canEditPlayers || roomPlayers.length <= 1;
    $("removeBotButton").textContent = "移除玩家";
  }
  if ($("startGameButton")) $("startGameButton").disabled = !account || !isHost || botJoinInProgress || ![1, 3].includes(roomStatus) || roomPlayers.length !== 4 || roomPlayers.some((player) => !roomReadyStatus.get(handKey(player)));
  if ($("forfeitButton")) $("forfeitButton").disabled = !(gameLocked || roomStatus === 2) || gameOver || !isInRoom;
  if ($("rematchButton")) $("rematchButton").disabled = !finalSettlementDone || rematchVoteInProgress;
  if ($("endGameButton")) $("endGameButton").disabled = rematchVoteInProgress;

  if ($("claimRank")) {
    $("claimRank").disabled = !ownTurn || gameOver || finalPending || resolvingChallenge || challengeHardLock || Boolean(roundRank);
    if (roundRank) $("claimRank").value = roundRank;
    [...$("claimRank").options].forEach((option) => {
      option.disabled = discardedRanks.has(option.value) && option.value !== roundRank;
    });
    if (!roundRank && discardedRanks.has($("claimRank").value)) {
      const nextOption = [...$("claimRank").options].find((option) => !option.disabled);
      if (nextOption) $("claimRank").value = nextOption.value;
    }
  }
  if ($("selectedCountLabel")) {
    const selectedCount = document.querySelectorAll(".card.selected").length;
    $("selectedCountLabel").textContent = `已選 ${selectedCount} 張`;
  }
}

function currentTurnPlayer() {
  return tablePlayers[currentTurnIndex];
}

function clearBotTimer() {
  if (!botTurnTimer) return;
  clearTimeout(botTurnTimer);
  botTurnTimer = null;
}

function clearBotTurnInFlight() {
  botTurnInFlight = null;
}

function clearBotChallengeTimers() {
  botChallengeTimers.forEach((timer) => clearTimeout(timer));
  botChallengeTimers = [];
}

function clearChallengeWindowTimer() {
  if (!challengeWindowTimer) return;
  clearTimeout(challengeWindowTimer);
  challengeWindowTimer = null;
}

function closeChallengeWindow() {
  if (!challengeWindowOpen) return;
  challengeWindowOpen = false;
  challengeHardLock = false;
  challengeHardLockUntil = 0;
  challengeAccepted = false;
  challengeWindowToken += 1;
  challengeWindowExpiresAt = 0;
  clearChallengeWindowTimer();
  clearBotChallengeTimers();
  closeChallengeableTableLogs();
  updateControls();
  scheduleBotTurn();
}

function openChallengeWindow() {
  clearBotTimer();
  clearBotTurnInFlight();
  clearBotChallengeTimers();
  const finalWindow = Boolean(pendingWinner);
  challengeWindowOpen = true;
  challengeHardLock = true;
  challengeHardLockUntil = Date.now() + CHALLENGE_HARD_LOCK_MS;
  challengeAccepted = false;
  challengeWindowExpiresAt = finalWindow ? Date.now() + FINAL_CHALLENGE_WINDOW_MS : Number.POSITIVE_INFINITY;
  const token = challengeWindowToken + 1;
  challengeWindowToken = token;
  clearChallengeWindowTimer();
  updateControls();
  scheduleBotChallengeRequests(token, roundStamp, actionStamp, claimSequence);
  if (finalWindow) {
    challengeWindowTimer = setTimeout(() => {
      if (challengeWindowToken !== token || !pendingWinner || resolvingChallenge) return;
      confirmPendingWinner("最後 30 秒無人成功抓吹牛");
    }, FINAL_CHALLENGE_WINDOW_MS);
  }
  setTimeout(() => {
    if (!challengeWindowOpen || challengeWindowToken !== token) return;
    challengeHardLock = false;
    challengeHardLockUntil = 0;
    updateControls();
    if (!pendingWinner) scheduleBotTurn();
  }, CHALLENGE_HARD_LOCK_MS);
}

function canAcceptChallengeRequest(challenger, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence) {
  return Boolean(
    challengeWindowOpen
    && !challengeAccepted
    && !resolvingChallenge
    && challengeWindowToken === token
    && roundStamp === expectedRoundStamp
    && actionStamp === expectedActionStamp
    && claimSequence === expectedClaimSequence
    && lastClaim
    && !sameAddress(lastClaim.actor, challenger)
    && Date.now() <= challengeWindowExpiresAt
  );
}

async function runBotChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence) {
  if (!canAcceptChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence)) return false;

  let wantsChallenge = false;
  try {
    const aiPayload = await requestAiBotChoice(bot);
    const choice = normalizeAiChoice(bot, aiPayload.decision);
    if (!canAcceptChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence)) return false;
    wantsChallenge = choice?.action === "challenge";
    log(`${playerLabel(bot)} 使用 ${aiLabel(aiPayload)} 判斷是否抓：${wantsChallenge ? "抓" : "不抓"}`);
  } catch (err) {
    if (!canAcceptChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence)) return false;
    wantsChallenge = botShouldChallenge(bot);
    log(`${playerLabel(bot)} AI 判斷失敗，改用本地抓牌規則：${err.message || err}`);
  }

  if (!wantsChallenge) {
    if (pendingWinner) markFinalReviewAction(bot, "放棄抓吹牛");
    return false;
  }
  if (!canAcceptChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence)) {
    log(`${playerLabel(bot)} 抓吹牛請求被拒絕：已超時或不是當前回合。`);
    return false;
  }

  clearBotChallengeTimers();
  const result = resolveChallenge(bot, { expectedActionStamp });
  if (!result.ok) {
    challengeAccepted = false;
    log(`${playerLabel(bot)} 抓吹牛請求被拒絕：${result.reason || "狀態已改變"}。`);
    return false;
  }
  return true;
}

function scheduleBotChallengeRequests(token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence) {
  if (!botMode || !gameLocked || winnerAddress || !lastClaim) return;
  const challengers = tablePlayers.filter((player) => isBot(player) && !sameAddress(player, lastClaim.actor));
  challengers.forEach((bot, index) => {
    const delay = 900 + index * 450 + secureRandomInt(900);
    const timer = setTimeout(() => {
      botChallengeTimers = botChallengeTimers.filter((activeTimer) => activeTimer !== timer);
      void runBotChallengeRequest(bot, token, expectedRoundStamp, expectedActionStamp, expectedClaimSequence);
    }, delay);
    botChallengeTimers.push(timer);
  });
}

function scheduleBotTurn() {
  clearBotTimer();
  const current = currentTurnPlayer();
  if (!botMode || !gameLocked || winnerAddress || pendingWinner || resolvingChallenge || !current || !isBot(current)) return;
  if (challengeHardLock) return;
  const delay = 800;
  const scheduledPlayer = current;
  const scheduledToken = challengeWindowToken;
  const scheduledRoundStamp = roundStamp;
  const scheduledActionStamp = actionStamp;
  const scheduledKey = `${handKey(scheduledPlayer)}:${scheduledToken}:${scheduledRoundStamp}:${scheduledActionStamp}`;
  if (botTurnInFlight === scheduledKey) return;
  botTurnTimer = setTimeout(async () => {
    botTurnTimer = null;
    if (!sameAddress(currentTurnPlayer(), scheduledPlayer)) return;
    if (challengeWindowToken !== scheduledToken) return;
    if (roundStamp !== scheduledRoundStamp) return;
    if (actionStamp !== scheduledActionStamp) return;
    if (botTurnInFlight === scheduledKey) return;
    botTurnInFlight = scheduledKey;
    try {
      await runBotAction(scheduledRoundStamp, scheduledActionStamp, scheduledKey);
    } finally {
      if (botTurnInFlight === scheduledKey) botTurnInFlight = null;
    }
  }, delay);
}

function advanceTurn() {
  if (!tablePlayers.length) return;
  advanceTurnFrom(currentTurnPlayer());
}

function advanceTurnFrom(player) {
  if (!tablePlayers.length) return;
  const index = playerIndex(player);
  currentTurnIndex = index >= 0 ? (index + 1) % tablePlayers.length : (currentTurnIndex + 1) % tablePlayers.length;
  renderSeats();
  renderTurn();
}

function readyTextFor(player, status) {
  if (status === 2) return "遊戲中";
  const ready = roomReadyStatus.get(handKey(player));
  return ready ? "已準備" : "未準備";
}

function renderRoomPlayers(players, status) {
  $("roomPlayers").innerHTML = Array.from(players || [])
    .map((player, index) => `<span>${index + 1}. ${playerLabel(player)} ${short(player)} · ${readyTextFor(player, status)}</span>`)
    .join("");
  if ($("removePlayerSelect")) {
    const removable = Array.from(players || []).filter((player) => !sameAddress(player, latestRoomSnapshot?.host));
    $("removePlayerSelect").innerHTML = removable.length
      ? removable.map((player) => `<option value="${player}">${playerLabel(player)} ${short(player)}</option>`).join("")
      : `<option value="">沒有可移除玩家</option>`;
  }
}

function updateRoomPanel(room = null, reason = "請先查詢或建立房間。") {
  if (!room) {
    latestRoomSnapshot = null;
    roomReadyStatus = new Map();
    rematchYesVotes = 0;
    rematchVoteStartedAt = 0;
    clearRematchCountdown();
    $("roomStatusText").textContent = "房間不存在";
    $("roomPlayerCount").textContent = "0 / 4";
    $("roomHost").textContent = "-";
    $("roomPlayers").textContent = "尚無玩家";
    if ($("removePlayerSelect")) $("removePlayerSelect").innerHTML = `<option value="">沒有可移除玩家</option>`;
    $("startReason").textContent = reason;
    $("joinReason").textContent = "不能加入：找不到房間，請先建立房間。";
    return;
  }

  const players = Array.from(room.players);
  const status = Number(room.status);
  latestRoomSnapshot = room;
  ensureTablePlayers(players);
  $("roomStatusText").textContent = ROOM_STATUS[status] || `未知狀態 ${status}`;
  $("roomPlayerCount").textContent = `${players.length} / 4`;
  $("roomHost").textContent = short(room.host);
  renderRoomPlayers(players, status);
  $("startReason").textContent = getStartBlockReason(room);
  updateJoinReason(room);
}

function updateBotLobbyPanel() {
  $("roomStatusText").textContent = "電腦玩家模式";
  $("roomPlayerCount").textContent = `${tablePlayers.length} / 4`;
  $("roomHost").textContent = account ? short(account) : "-";
  renderRoomPlayers(tablePlayers, 1);
  $("joinReason").textContent = "電腦玩家模式由前端模擬，不需要鏈上加入。";
  $("startReason").textContent = tablePlayers.length >= 4
    ? "電腦玩家已滿，已自動洗牌並開始。"
    : `電腦玩家模式：目前 ${tablePlayers.length} / 4，還差 ${4 - tablePlayers.length} 位。`;
}

function roomLikeFromPlayers(players, status = 1) {
  return {
    host: players[0] || account || ethers.ZeroAddress,
    stakeRequired: ethers.parseEther($("stakeRequired").value || "100"),
    deckCommitment: ethers.ZeroHash,
    status,
    players
  };
}

function applyRoomPlayers(players, status = 1) {
  const list = Array.from(players || []).slice(0, 4);
  roomViewCache = { roomId: roomId(), players: list, status };
  ensureTablePlayers(list, false);
  updateRoomPanel(roomLikeFromPlayers(list, status));
  renderSeats();
  updateControls();
}

function mergeRoomWithCache(room) {
  if (!room) return null;
  const currentRoomId = roomId();
  const players = Array.from(room.players);
  roomViewCache = { roomId: currentRoomId, players, status: Number(room.status) };
  return room;
}

function readyMapFromStatus(result, players = []) {
  const ready = result?.ready || {};
  return new Map(Array.from(players || []).map((player) => [handKey(player), Boolean(ready[player] ?? ready[ethers.getAddress(player)] ?? ready[handKey(player)])]));
}

async function fetchReadyStatus(players = []) {
  try {
    const response = await fetch(`${getRelayerUrl()}/rooms/ready-status?roomId=${encodeURIComponent(roomId())}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
    return readyMapFromStatus(result.result, players);
  } catch (err) {
    log(`準備狀態同步失敗：${explainError(err)}`);
    return new Map(Array.from(players || []).map((player) => [handKey(player), isBot(player)]));
  }
}

async function setOffchainReady(player, ready) {
  const response = await fetch(`${getRelayerUrl()}/rooms/ready`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: roomId(), player, ready })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  return result.result;
}

async function clearOffchainReady() {
  const response = await fetch(`${getRelayerUrl()}/rooms/ready-clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: roomId() })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  return result.result;
}

async function updateReadyStatus(room) {
  if (!room) return;
  const status = Number(room.status);
  const players = Array.from(room.players);
  if (status === 3) {
    try {
      const game = getReadContract();
      rematchYesVotes = Number(await game.rematchVoteCount(roomId()));
      rematchVoteStartedAt = Number(await game.rematchVoteStartedAt(roomId()));
      if (rematchVoteStartedAt > 0) {
        startRematchCountdown((rematchVoteStartedAt * 1000) + REMATCH_WINDOW_MS, players.length);
      } else {
        clearRematchCountdown();
      }
    } catch (_err) {
      rematchYesVotes = 0;
      rematchVoteStartedAt = 0;
      clearRematchCountdown();
    }
  } else {
    rematchYesVotes = 0;
    rematchVoteStartedAt = 0;
    clearRematchCountdown();
  }
  if (![1, 2, 3].includes(status) || !players.length) {
    roomReadyStatus = new Map();
    renderRoomPlayers(players, status);
    return;
  }
  roomReadyStatus = await fetchReadyStatus(players);
  renderRoomPlayers(players, status);
  $("startReason").textContent = getStartBlockReason(room);
  updateControls();
}

function getStartBlockReason(room) {
  const players = Array.from(room.players);
  const status = Number(room.status);
  if (![1, 3].includes(status)) return `不能開始：房間目前是「${ROOM_STATUS[status] || "未知狀態"}」。`;
  if (players.length < 4) return `不能開始：目前只有 ${players.length} 位玩家，還差 ${4 - players.length} 位。`;
  if (players.length > 4) return "不能開始：玩家數超過 4 位。";
  if (!account) return "不能開始：請先連接房主錢包。";
  if (room.host.toLowerCase() !== account.toLowerCase()) return `不能開始：只有房主 ${short(room.host)} 可以開始遊戲。`;
  if (status === 3 && rematchYesVotes <= players.length / 2) return `不能開始：再開一局投票尚未過半（${rematchYesVotes} / ${players.length}）。`;
  const notReady = players.filter((player) => !roomReadyStatus.get(handKey(player)));
  if (notReady.length) return `不能開始：尚未準備：${notReady.map(playerLabel).join("、")}。`;
  return "可以開始遊戲。";
}

async function updateJoinReason(room) {
  $("joinReason").textContent = await getJoinBlockReason(room);
}

async function getJoinBlockReason(room) {
  const players = Array.from(room.players);
  const status = Number(room.status);
  if (!account) return "不能加入：請先連接錢包。";
  if (status !== 1) return `不能加入：房間目前是「${ROOM_STATUS[status] || "未知狀態"}」。`;
  if (players.some((player) => player.toLowerCase() === account.toLowerCase())) return "不能加入：你已經在這個房間裡。";
  if (players.length >= 4) return "不能加入：房間已滿 4 位玩家。";

  const game = await getContract();
  const balance = await game.deposits(account);
  if (balance < room.stakeRequired) {
    return `不能加入：你的押金是 ${ethers.formatEther(balance)} ETH，房間需要 ${ethers.formatEther(room.stakeRequired)} ETH。`;
  }
  return "可以加入房間。";
}

async function getDepositShortfall(address, stakeRequired) {
  const game = getReadContract();
  const balance = await game.deposits(address);
  return {
    balance,
    missing: balance >= stakeRequired ? 0n : stakeRequired - balance
  };
}

async function getContract() {
  syncContractAddress();
  if (!ethers.isAddress(CONTRACT_ADDRESS)) throw new Error("內建合約地址格式錯誤。");
  if (!signer) await connectWallet();
  contract = new ethers.Contract(CONTRACT_ADDRESS, abi, signer);
  return contract;
}

function getReadContract() {
  syncContractAddress();
  if (!ethers.isAddress(CONTRACT_ADDRESS)) throw new Error("內建合約地址格式錯誤。");
  if (contract) return contract;
  return new ethers.Contract(CONTRACT_ADDRESS, abi, getReadProvider());
}

function getReadProvider() {
  readProvider ||= new ethers.JsonRpcProvider(getRpcUrl());
  return readProvider;
}

async function refreshRoomStatus() {
  const game = getReadContract();
  try {
    const room = mergeRoomWithCache(await game.getRoom(roomId()));
    updateRoomPanel(room);
    await updateReadyStatus(room);
    handleRoomSync(room);
    return room;
  } catch (_err) {
    roomViewCache = { roomId: null, players: [], status: null };
    updateRoomPanel(null, "找不到房間，請先建立房間。");
    return null;
  }
}

function handleRoomSync(room) {
  if (!room) return;
  const status = Number(room.status);
  const players = Array.from(room.players);
  const isInRoom = account && players.some((player) => sameAddress(player, account));
  botMode = players.some(isBot);

  if (status === 2 && isInRoom && !gameLocked && !winnerAddress) {
    gameLocked = true;
    ensureTablePlayers(players, false);
    restoreDealForRoom();
    resetTurnState(players, false, startingIndexFromCommitment(room.deckCommitment, players.length));
    openTable("遊戲進行中");
    log("房主已開始遊戲，已自動進入牌桌。");
    return;
  }

  if ((status === 3 || status === 4) && gameLocked) {
    gameLocked = false;
    if ($("tableStatus")) $("tableStatus").textContent = ROOM_STATUS[status] || "房間已結束";
    if ($("lastMove")) $("lastMove").textContent = status === 4 ? "房間已解散。" : "鏈上房間已結束。";
    updateControls();
  }
}

async function waitForRoomPlayerCount(minCount, attempts = 10, delayMs = 350) {
  const game = getReadContract();
  let bestRoom = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const room = mergeRoomWithCache(await game.getRoom(roomId()));
    bestRoom = room;
    if (Array.from(room.players).length >= minCount) return room;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return bestRoom;
}

async function waitForRoomPlayerEventOrPoll({ eventName, player, expectedCount, timeoutMs = 5000, eventPromise = null }) {
  const expectedRoomId = roomId();
  try {
    if (eventPromise) {
      await eventPromise;
    } else {
      await waitForRoomEvent([eventName], (args) => {
        const [eventRoomId, eventPlayer, playerCount] = Array.from(args || []);
        if (eventRoomId !== expectedRoomId) return false;
        if (player && !sameAddress(eventPlayer, player)) return false;
        if (expectedCount !== undefined && Number(playerCount) !== Number(expectedCount)) return false;
        return true;
      }, timeoutMs);
    }
    return await refreshRoomStatus();
  } catch (_err) {
    const game = getReadContract();
    let bestRoom = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const room = mergeRoomWithCache(await game.getRoom(expectedRoomId));
      bestRoom = room;
      const players = Array.from(room.players);
      const hasPlayer = !player || players.some((candidate) => sameAddress(candidate, player));
      const removedPlayer = !player || players.every((candidate) => !sameAddress(candidate, player));
      const countMatches = expectedCount === undefined || players.length === Number(expectedCount);
      if (eventName === "PlayerJoined" && hasPlayer && countMatches) break;
      if (eventName === "PlayerRemoved" && removedPlayer && countMatches) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    updateRoomPanel(bestRoom);
    if (bestRoom) await updateReadyStatus(bestRoom);
    if (bestRoom) handleRoomSync(bestRoom);
    return bestRoom;
  }
}

async function getRoomByText(roomName) {
  const game = getReadContract();
  return game.getRoom(roomIdFromText(roomName));
}

async function cancelHostedLobbyRoomBeforeNewRoom({ includeCurrent = false } = {}) {
  if (!account) return;
  const oldRoomName = localStorage.getItem(hostedRoomKey());
  if (!oldRoomName || (!includeCurrent && oldRoomName === $("roomText").value)) return;

  try {
    const oldRoom = await getRoomByText(oldRoomName);
    if (!sameAddress(oldRoom.host, account)) return;
    const oldStatus = Number(oldRoom.status);
    if (oldStatus === 2) {
      log(`略過舊進行中房間 ${oldRoomName}：不會自動取消 active 房間。本機鎖已清除，可建立新房。`);
      return;
    }
    if (oldStatus !== 1) return;
    const game = await getContract();
    await wait(await game.cancelLobbyRoom(roomIdFromText(oldRoomName), await txOverrides()), `解散舊房間 ${oldRoomName}`);
    log(`已解散舊房間 ${oldRoomName}。`);
  } catch (err) {
    const message = explainError(err);
    if (!message.includes("RoomNotFound") && !message.includes("找不到")) {
      log(`舊房間解散略過：${message}`);
    }
  } finally {
    localStorage.removeItem(hostedRoomKey());
  }
}

async function refreshBalance() {
  const address = account || localStorage.getItem("lastWalletAddress");
  if (!address || !ethers.isAddress(address)) {
    $("depositBalance").textContent = "連接後讀取";
    return;
  }
  const game = getReadContract();
  const balance = await game.deposits(address);
  const formatted = `${ethers.formatEther(balance)} ETH`;
  $("depositBalance").textContent = formatted;
  if ($("settlementBalance")) $("settlementBalance").value = formatted;
  if ($("settlementWithdrawAmount") && (!$("settlementWithdrawAmount").value || $("settlementWithdrawAmount").value === "100")) {
    $("settlementWithdrawAmount").value = ethers.formatEther(balance);
  }
  if (!account) $("walletAddress").textContent = `${address}（上次連接）`;
}

async function refreshBalanceSoon(attempts = 3, delayMs = 700) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await refreshBalance();
      return true;
    } catch (err) {
      if (attempt === attempts - 1) {
        log(`自動讀取押金失敗：${explainError(err)}`);
        return false;
      }
    }
  }
  return false;
}

async function restoreWalletSession() {
  syncContractAddress();
  const lastAddress = localStorage.getItem("lastWalletAddress");
  if (!window.ethereum) {
    if (lastAddress && ethers.isAddress(lastAddress)) {
      $("walletAddress").textContent = `${lastAddress}（上次連接）`;
      await refreshBalance();
    } else {
      $("depositBalance").textContent = "請安裝 MetaMask";
    }
    return;
  }

  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  if (!accounts.length) {
    if (lastAddress && ethers.isAddress(lastAddress)) {
      $("walletAddress").textContent = `${lastAddress}（上次連接）`;
      await refreshBalance();
      log(`已用上次錢包地址讀取押金：${lastAddress}`);
    } else {
      $("depositBalance").textContent = "連接後讀取";
    }
    return;
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  contract = new ethers.Contract(CONTRACT_ADDRESS, abi, signer);
  localStorage.setItem("lastWalletAddress", account);
  $("walletAddress").textContent = account;
  if ($("seatYou")) $("seatYou").textContent = short(account);
  updateNicknameInput();
  setupWalletEvents();
  await refreshBalance();
  await refreshRoomStatus();
  await ensureListeners();
  renderHand();
  renderSeats();
  renderTurn();
  log(`已自動恢復錢包：${account}`);
}

function startRoomSyncLoop() {
  if (roomSyncTimer) return;
  roomSyncTimer = setInterval(() => {
    if (!document.hidden) void refreshRoomStatus().catch(() => {});
  }, 1200);
}

async function wait(tx, label) {
  log(`${label}：交易已送出 ${tx.hash}`);
  const receipt = await tx.wait();
  log(`${label}：已確認，區塊 ${receipt.blockNumber}`);
  await refreshBalance();
  await refreshRoomStatus();
  return receipt;
}

async function txOverrides(extra = {}) {
  if (!account) return extra;
  const nonceProvider = readProvider || new ethers.JsonRpcProvider(getRpcUrl());
  const nonce = await nonceProvider.getTransactionCount(account, "pending");
  return { ...extra, nonce };
}

async function connectWallet() {
  if (connecting) throw new Error("MetaMask 請求已開啟，請先檢查 MetaMask。");
  if (!window.ethereum) throw new Error("請先安裝 MetaMask。");
  connecting = true;
  try {
    await ensureHardhatNetwork();
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    localStorage.setItem("lastWalletAddress", account);
    $("walletAddress").textContent = account;
    if ($("seatYou")) $("seatYou").textContent = short(account);
    log(`錢包已連接：${account}`);
    updateNicknameInput();
    setupWalletEvents();
    updateNicknameInput();
    await refreshBalance();
    await refreshRoomStatus();
    renderHand();
    renderSeats();
    renderTurn();
  } finally {
    connecting = false;
  }
}

function setupWalletEvents() {
  if (walletEventsReady || !window.ethereum) return;
  walletEventsReady = true;

  window.ethereum.on("accountsChanged", async (accounts) => {
    if (!accounts.length) {
      account = undefined;
      signer = undefined;
      contract = undefined;
      localStorage.removeItem("lastWalletAddress");
      $("walletAddress").textContent = "尚未連接";
      $("depositBalance").textContent = "-";
      updateNicknameInput();
      if ($("seatYou")) $("seatYou").textContent = "目前錢包";
      updateRoomPanel(null, "錢包已斷線，請重新連接。");
      log("MetaMask 錢包已斷線。");
      return;
    }

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    account = await signer.getAddress();
    contract = new ethers.Contract(CONTRACT_ADDRESS, abi, signer);
    localStorage.setItem("lastWalletAddress", account);
    $("walletAddress").textContent = account;
    if ($("seatYou")) $("seatYou").textContent = short(account);
    updateNicknameInput();
    log(`已切換玩家錢包：${account}`);
    await refreshBalance();
    await refreshRoomStatus();
    renderHand();
    renderSeats();
    renderTurn();
  });

  window.ethereum.on("chainChanged", () => {
    log("MetaMask 網路已切換，請確認目前是 Hardhat Localhost / Chain ID 31337。");
  });
}

async function ensureListeners() {
  const game = await getContract();
  if (eventContract) eventContract.removeAllListeners();
  eventContract = game;
  game.removeAllListeners();
  for (const name of ["Deposit", "Withdrawal", "RoomCreated", "PlayerJoined", "PlayerRemoved", "RematchVoted", "RematchExpired", "GameStarted", "GameFinished", "ChallengeSettled", "FinalWinnerSettled", "FinalPenaltiesSettled", "AutoFinalSettlementTriggered", "PlayerForfeited"]) {
    game.on(name, async (...args) => {
      const event = args.at(-1);
      const key = eventKey(name, event);
      if (seenContractEvents.has(key)) return;
      seenContractEvents.add(key);
      notifyRoomEventWaiters(name, event.args);
      log(formatContractEvent(name, event.args));
      if (["Deposit", "Withdrawal", "FinalWinnerSettled", "FinalPenaltiesSettled", "AutoFinalSettlementTriggered", "PlayerForfeited"].includes(name)) {
        void refreshBalanceSoon(3, 700);
      }
      await refreshRoomStatus();
    });
  }
}

function wire(id, handler) {
  $(id).onclick = async () => {
    try {
      await handler();
    } catch (err) {
      log(explainError(err));
      await refreshRoomStatus().catch(() => {});
    }
  };
}

wire("connectWallet", async () => {
  await connectWallet();
  await ensureListeners();
});

wire("depositButton", async () => {
  const game = await getContract();
  await wait(await game.deposit(await txOverrides({ value: ethers.parseEther($("depositAmount").value) })), "存入押金");
});

wire("refreshSettlementBalanceButton", refreshBalance);

wire("settlementWithdrawButton", async () => {
  const game = await getContract();
  await wait(await game.withdraw(ethers.parseEther($("settlementWithdrawAmount").value), await txOverrides()), "領出押金");
});

wire("createRoomButton", async () => {
  const game = await getContract();
  if (!$("roomText").value.trim()) $("roomText").value = makeRoomName();
  const stakeRequired = ethers.parseEther($("stakeRequired").value || "100");
  const { balance } = await getDepositShortfall(account, stakeRequired);
  if (balance < stakeRequired) {
    log(`不能建立房間：你的押金是 ${ethers.formatEther(balance)} ETH，房間需要 ${ethers.formatEther(stakeRequired)} ETH。請先存入押金。`);
    await refreshBalanceSoon(1, 0);
    return;
  }
  await cancelHostedLobbyRoomBeforeNewRoom();
  roomViewCache = { roomId: null, players: [], status: null };
  const existing = await refreshRoomStatus();
  if (existing) {
    log("房間已存在，請改用新房號或加入房間。");
    return;
  }
  await wait(await game.createRoom(roomId(), stakeRequired, await txOverrides()), "建立房間");
  localStorage.setItem(hostedRoomKey(), $("roomText").value);
  await refreshRoomStatus();
});

wire("joinRoomButton", async () => {
  const game = await getContract();
  const room = await refreshRoomStatus();
  if (!room) {
    log("不能加入：找不到房間，請先建立房間。");
    return;
  }
  const reason = await getJoinBlockReason(room);
  $("joinReason").textContent = reason;
  if (reason !== "可以加入房間。") {
    log(reason);
    return;
  }
  await wait(await game.joinRoom(roomId(), await txOverrides()), "加入房間");
});

wire("refreshRoomButton", refreshRoomStatus);

wire("readyButton", async () => {
  const room = await refreshRoomStatus();
  if (!room) return log("準備失敗：找不到房間。");
  const status = Number(room.status);
  const players = Array.from(room.players);
  if (!account || !players.some((player) => sameAddress(player, account))) return log("準備失敗：你不在這個房間裡。");
  if (![1, 3].includes(status)) return log("準備失敗：只有大廳或已結束房間可以準備。");
  const nextReady = !roomReadyStatus.get(handKey(account));
  const result = await setOffchainReady(account, nextReady);
  roomReadyStatus = readyMapFromStatus(result, players);
  log(nextReady ? "已準備。" : "已取消準備。");
  renderRoomPlayers(players, status);
  updateControls();
  await refreshRoomStatus();
});

wire("leaveRoomButton", async () => {
  const game = await getContract();
  const room = await refreshRoomStatus();
  if (!room) return log("退出失敗：找不到房間。");
  if (!account || !Array.from(room.players).some((player) => sameAddress(player, account))) return log("退出失敗：你不在這個房間裡。");
  if (sameAddress(room.host, account)) return log("退出失敗：房主請使用「解散房間」。");
  if (Number(room.status) !== 1) return log("退出失敗：只有大廳等待中可以直接退出；遊戲中請使用認輸退出。");
  await wait(await game.leaveLobbyRoom(roomId(), await txOverrides()), "退出房間");
  roomViewCache = { roomId: null, players: [], status: null };
  resetTurnState([], true);
  await refreshRoomStatus();
});

wire("disbandRoomButton", async () => {
  const game = await getContract();
  const room = await refreshRoomStatus();
  if (!room) return log("解散失敗：找不到房間。");
  if (!account || !sameAddress(room.host, account)) return log("解散失敗：只有房主可以解散房間。");
  const status = Number(room.status);
  if (![1, 3].includes(status)) return log("解散失敗：只有大廳等待中或已結束的房間可以解散。");
  if (status === 1) {
    await wait(await game.cancelLobbyRoom(roomId(), await txOverrides()), "解散房間");
  } else {
    await wait(await game.closeFinishedRoom(roomId(), await txOverrides()), "關閉已結束房間");
  }
  localStorage.removeItem(hostedRoomKey());
  roomViewCache = { roomId: null, players: [], status: null };
  roomReadyStatus = new Map();
  botMode = false;
  gameLocked = false;
  resetTurnState(account ? [account] : [], true);
  updateRoomPanel(null, "房間已解散，可以建立新房間。");
});

async function startGameConfirmed() {
  if (botJoinInProgress) return log("電腦玩家仍在加入中，請等房間人數更新後再開始。");
  const game = await getContract();
  let room;
  try {
    room = await waitForRoomPlayerCount(4);
  } catch (_err) {
    log("不能開始：找不到房間，請先建立房間。");
    return;
  }
  if (!room) return log("不能開始：找不到房間，請先建立房間。");
  updateRoomPanel(room);
  await updateReadyStatus(room);
  const playersBeforeStart = Array.from(room.players);
  const status = Number(room.status);
  if (![1, 3].includes(status)) return log("不能開始：房間不是大廳或已結束狀態。");
  if (playersBeforeStart.length !== 4) return log(`不能開始：目前只有 ${playersBeforeStart.length} 位玩家，還差 ${4 - playersBeforeStart.length} 位。`);
  if (!account || !sameAddress(room.host, account)) return log(`不能開始：只有房主 ${short(room.host)} 可以開始遊戲。`);
  const notReady = playersBeforeStart.filter((player) => !roomReadyStatus.get(handKey(player)));
  if (status === 3 && rematchYesVotes <= playersBeforeStart.length / 2) {
    return log(`不能開始：再開一局投票尚未過半（${rematchYesVotes} / ${playersBeforeStart.length}）。`);
  }
  if (notReady.length) return log(`不能開始：尚未準備：${notReady.map(playerLabel).join("、")}。`);
  const depositChecks = await Promise.all(playersBeforeStart.map(async (player) => ({
    player,
    ...(await getDepositShortfall(player, room.stakeRequired))
  })));
  const insufficient = depositChecks.filter((item) => item.balance < room.stakeRequired);
  if (insufficient.length) {
    const details = insufficient
      .map((item) => `${playerLabel(item.player)} ${ethers.formatEther(item.balance)} / ${ethers.formatEther(room.stakeRequired)} ETH`)
      .join("、");
    return log(`不能開始：玩家押金不足：${details}。`);
  }
  ensureTablePlayers(playersBeforeStart, false);
  const dealt = await dealRandomEncryptedHands();
  if (!dealt) return;
  const commitment = $("deckCommitment").value.trim() || ethers.keccak256(ethers.toUtf8Bytes(`deck:${Date.now()}`));
  $("deckCommitment").value = commitment;
  await wait(await game.startGame(roomId(), commitment, await txOverrides()), "開始遊戲");
  await clearOffchainReady().catch(() => {});
  roomReadyStatus = new Map();
  const startedRoom = mergeRoomWithCache(await game.getRoom(roomId()));
  const startedPlayers = Array.from(startedRoom.players);
  updateRoomPanel(startedRoom);
  botMode = startedPlayers.some(isBot);
  gameLocked = true;
  resetTurnState(startedPlayers, false, startingIndexFromCommitment(commitment, startedPlayers.length));
  openTable("遊戲進行中");
}

function countRematchVotes() {
  const players = tablePlayers.length ? tablePlayers : (account ? [account] : []);
  const humanYes = account ? 1 : 0;
  const botYes = players.filter(isBot).length;
  return { yes: humanYes + botYes, total: Math.max(players.length, 1) };
}

function endCurrentGameView(message = "本局已結束。") {
  gameLocked = false;
  rematchVoteInProgress = false;
  clearRematchCountdown();
  hidePostGameActions();
  if ($("tableStatus")) $("tableStatus").textContent = "遊戲已結束";
  if ($("lastMove")) $("lastMove").textContent = message;
  if ($("settlementSuggestion")) $("settlementSuggestion").textContent = message;
  showView("lobbySection");
  updateControls();
}

function clearRematchCountdown() {
  if (rematchCountdownTimer) clearInterval(rematchCountdownTimer);
  rematchCountdownTimer = null;
  rematchCountdownDeadlineMs = 0;
  rematchAutoClosing = false;
  if ($("rematchCountdown")) $("rematchCountdown").textContent = "";
}

function renderRematchCountdown(playersLength = 4) {
  if (!$("rematchCountdown") || !rematchCountdownDeadlineMs) return;
  const remainingMs = Math.max(0, rematchCountdownDeadlineMs - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  $("rematchCountdown").textContent = `再開投票倒數 ${seconds} 秒，票數 ${rematchYesVotes} / ${playersLength}`;
  if (remainingMs <= 0 && rematchYesVotes <= playersLength / 2) {
    void closeExpiredRematchIfNeeded();
  }
}

function startRematchCountdown(deadlineMs, playersLength) {
  if (!deadlineMs) return clearRematchCountdown();
  if (rematchCountdownDeadlineMs !== deadlineMs) {
    if (rematchCountdownTimer) clearInterval(rematchCountdownTimer);
    rematchCountdownDeadlineMs = deadlineMs;
    rematchCountdownTimer = setInterval(() => renderRematchCountdown(playersLength), 1000);
  }
  renderRematchCountdown(playersLength);
}

async function closeExpiredRematchIfNeeded() {
  if (rematchAutoClosing) return;
  rematchAutoClosing = true;
  try {
    const room = latestRoomSnapshot || await refreshRoomStatus();
    if (!room || Number(room.status) !== 3) return;
    const players = Array.from(room.players);
    if (rematchYesVotes > players.length / 2) return;
    await relayerCloseExpiredRematch();
    clearRematchCountdown();
    await refreshRoomStatus();
    endCurrentGameView("再開一局投票逾時未過半，遊戲已結束。");
    log("再開一局投票 30 秒未過半，已自動結束遊戲。");
  } catch (err) {
    log(`再開投票逾時關閉失敗：${explainError(err)}`);
  } finally {
    rematchAutoClosing = false;
  }
}

async function startRematchRound() {
  if (rematchVoteInProgress) return;
  if (!account) return log("請先連接錢包。");

  rematchVoteInProgress = true;
  updateControls();

  try {
    const game = await getContract();
    const room = await refreshRoomStatus();
    if (!room) return log("再開一局失敗：找不到房間。");
    if (Number(room.status) !== 3) return log("再開一局需要目前房間已結束。");
    if (!Array.from(room.players).some((player) => sameAddress(player, account))) return log("再開一局失敗：你不在這個房間裡。");

    await wait(await game.voteRematch(roomId(), true, await txOverrides()), "再開一局投票");
    const readyResult = await setOffchainReady(account, true);
    roomReadyStatus = readyMapFromStatus(readyResult, Array.from(room.players));
    log("已準備再開一局。");
    if (Array.from(room.players).some(isBot)) {
      try {
        await relayerReadyBots();
      } catch (err) {
        log(`電腦玩家準備失敗：${explainError(err)}`);
      }
    }
    await refreshRoomStatus();
    showView("lobbySection");
    log("已投票再開一局；30 秒內過半且所有玩家準備後，房主即可開始。");
  } catch (err) {
    log(explainError(err));
  } finally {
    rematchVoteInProgress = false;
    updateControls();
  }
}

$("startGameButton").onclick = () => {
  if (botJoinInProgress) return log("電腦玩家仍在加入中，請等交易完成。");
  startGamePending = true;
  $("startGameModal").classList.remove("is-hidden");
};

$("confirmStartGameButton").onclick = async () => {
  try {
    $("startGameModal").classList.add("is-hidden");
    if (startGamePending) await startGameConfirmed();
  } catch (err) {
    log(explainError(err));
  } finally {
    startGamePending = false;
  }
};

$("cancelStartGameButton").onclick = () => {
  startGamePending = false;
  $("startGameModal").classList.add("is-hidden");
};

wire("finishGameButton", async () => {
  const game = await getContract();
  await wait(await game.finishGame(roomId(), await txOverrides()), "結束遊戲");
  gameLocked = false;
  $("tableStatus").textContent = "遊戲已結束";
  log("已送出結束遊戲交易，合約會觸發 GameFinished 事件。");
});

$("showLobbyButton").onclick = () => showView("lobbySection");
$("showGameButton").onclick = () => showView("gameSection");
$("openTableButton").onclick = () => openTable();
wire("rematchButton", startRematchRound);
wire("endGameButton", () => endCurrentGameView("遊戲已結束。"));
wire("clearHostedRoomButton", () => {
  if (account) localStorage.removeItem(hostedRoomKey());
  roomViewCache = { roomId: null, players: [], status: null };
  $("roomText").value = makeRoomName();
  $("deckCommitment").value = "";
  botMode = false;
  gameLocked = false;
  resetTurnState(account ? [account] : [], true);
  updateRoomPanel(null, "已解除本機舊房間鎖，可以建立新房間。");
  showView("lobbySection");
  log("已解除本機舊房間鎖。若你其實仍在進行中的鏈上房間，請先回遊戲畫面認輸退出。");
});

wire("saveNicknameButton", () => {
  if (!account) return log("暱稱儲存失敗：請先連接錢包。");
  const nickname = sanitizeNickname($("nicknameInput").value);
  if (nickname) localStorage.setItem(nicknameKey(account), nickname);
  else localStorage.removeItem(nicknameKey(account));
  updateNicknameInput();
  renderSeats();
  renderTurn();
  refreshRoomStatus();
  log(nickname ? `暱稱已儲存：${nickname}` : "暱稱已清除。");
});

async function relayerJoinBot() {
  const response = await fetch(`${getRelayerUrl()}/bots/join-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: roomId()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  return result.result;
}

async function relayerRemoveBot(botAddress = null) {
  const response = await fetch(`${getRelayerUrl()}/bots/remove-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: roomId(),
      botAddress
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  return result.result;
}

async function relayerReadyBots() {
  const response = await fetch(`${getRelayerUrl()}/bots/ready-room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: roomId()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  if (result.result?.readyStatus) {
    const players = result.result.readyStatus.players || tablePlayers;
    roomReadyStatus = readyMapFromStatus(result.result.readyStatus, players);
    renderRoomPlayers(players, Number(result.result.readyStatus.status || latestRoomSnapshot?.status || 1));
    updateControls();
  }
  return result.result;
}

async function relayerCloseExpiredRematch() {
  const response = await fetch(`${getRelayerUrl()}/rooms/close-expired-rematch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: roomId()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Relayer error ${response.status}`);
  return result.result;
}

$("addBotsButton").onclick = async () => {
  if (botJoinInProgress) return log("電腦玩家正在加入中，請等交易完成。");
  if (!account) return log("請先連接錢包，再加入電腦玩家。");
  if (gameLocked) return log("遊戲進行中，不能再加入電腦玩家。");

  botJoinInProgress = true;
  updateControls();
  let relayerPlayers = null;

  try {
    const room = await refreshRoomStatus();
    if (!room) return log("請先建立房間，再一位一位加入電腦玩家。");
    const players = Array.from(room.players);
    const expectedCount = Math.min(4, players.length + 1);
    if (Number(room.status) !== 1) return log("房間不是大廳狀態，不能再加入電腦玩家。");
    if (players.length >= 4) {
      applyRoomPlayers(players, Number(room.status));
      return log("房間已滿 4 人。");
    }

    const joinedEventPromise = waitForRoomEvent(["PlayerJoined"], (args) => {
      const [eventRoomId, _eventPlayer, playerCount] = Array.from(args || []);
      return eventRoomId === roomId() && Number(playerCount) === expectedCount;
    }, 5000).catch(() => null);

    log("正在讓下一位電腦玩家存入押金並加入房間...");
    const result = await relayerJoinBot();
    botMode = true;
    if (Array.isArray(result.players)) {
      relayerPlayers = result.players;
      applyRoomPlayers(relayerPlayers, 1);
    }

    await waitForRoomPlayerEventOrPoll({
      eventName: "PlayerJoined",
      player: result.bot,
      expectedCount,
      eventPromise: joinedEventPromise
    });
    log(`${playerLabel(result.bot)} 已鏈上加入房間，押金餘額 ${ethers.formatEther(result.deposit)} ETH。`);
  } catch (err) {
    log(explainError(err));
    await refreshRoomStatus().catch(() => {});
  } finally {
    botJoinInProgress = false;
    updateControls();
  }
};

$("removeBotButton").onclick = async () => {
  if (botJoinInProgress) return log("玩家移除交易處理中，請稍等。");
  if (!account) return log("請先連接錢包，再移除玩家。");
  if (gameLocked) return log("遊戲進行中，不能移除玩家。");

  botJoinInProgress = true;
  updateControls();

  try {
    const room = await refreshRoomStatus();
    if (!room) return log("請先建立或查詢房間。");
    if (![1, 3].includes(Number(room.status))) return log("只有大廳或遊戲結束後可以移除玩家。");
    if (!sameAddress(room.host, account)) return log("移除失敗：只有房主可以移除玩家。");
    const selected = $("removePlayerSelect")?.value;
    const players = Array.from(room.players);
    const target = selected && players.some((player) => sameAddress(player, selected))
      ? players.find((player) => sameAddress(player, selected))
      : [...players].reverse().find((player) => !sameAddress(player, room.host));
    if (!target) return log("這個房間目前沒有可移除的玩家。");
    if (sameAddress(target, room.host)) return log("不能移除房主。");

    const removedEventPromise = waitForRoomEvent(["PlayerRemoved"], (args) => {
      const [eventRoomId, eventPlayer, playerCount] = Array.from(args || []);
      return eventRoomId === roomId()
        && sameAddress(eventPlayer, target)
        && Number(playerCount) === Math.max(0, players.length - 1);
    }, 5000).catch(() => null);

    log(`正在移除 ${playerLabel(target)}...`);
    if (isBot(target)) {
      const result = await relayerRemoveBot(target);
      if (Array.isArray(result.players)) applyRoomPlayers(result.players, Number(room.status));
    } else {
      const game = await getContract();
      await wait(await game.removeLobbyPlayer(roomId(), target, await txOverrides()), "移除玩家");
      await setOffchainReady(target, false).catch(() => {});
    }
    await waitForRoomPlayerEventOrPoll({
      eventName: "PlayerRemoved",
      player: target,
      expectedCount: Math.max(0, players.length - 1),
      eventPromise: removedEventPromise
    });
    botMode = tablePlayers.some(isBot);
    log(`${playerLabel(target)} 已從大廳移除。`);
  } catch (err) {
    log(explainError(err));
    await refreshRoomStatus().catch(() => {});
  } finally {
    botJoinInProgress = false;
    updateControls();
  }
};
$("lookupBalanceButton").onclick = async () => {
  try {
    const address = account || localStorage.getItem("lastWalletAddress");
    if (!ethers.isAddress(address)) {
      log("請先連接錢包後再讀取押金。");
      return;
    }
    localStorage.setItem("lastWalletAddress", address);
    await refreshBalance();
    log(`已讀取 ${short(address)} 的押金。`);
  } catch (err) {
    log(`讀取押金失敗：${explainError(err)}`);
  }
};
$("newRoomButton").onclick = async () => {
  await cancelHostedLobbyRoomBeforeNewRoom({ includeCurrent: true });
  roomViewCache = { roomId: null, players: [], status: null };
  botMode = false;
  gameLocked = false;
  $("roomText").value = makeRoomName();
  $("roomHint").textContent = "已產生新房號，可以建立新房間。";
  updateRoomPanel(null, "新房號尚未建立，請按「建立房間」。");
  $("joinReason").textContent = "不能加入：新房號尚未建立。";
  resetTurnState([], true);
  log(`已產生新房號：${$("roomText").value}`);
};

function openTable(status = "遊戲進行中") {
  showView("gameSection");
  $("gameSection").scrollIntoView({ behavior: "smooth", block: "start" });
  $("tableStatus").textContent = status;
  if ($("seatYou")) $("seatYou").textContent = account ? short(account) : "目前錢包";
  ensureTablePlayers();
  renderHand();
}

function validateClaim(player, count, rank, selectedCount) {
  if (count < 1 || count > 3) {
    log("喊牌失敗：一次只能出 1 至 3 張。");
    return false;
  }
  if (roundRank && rank !== roundRank) {
    log(`出牌失敗：本輪必須繼續喊 ${roundRank}，或選擇 Pass。`);
    return false;
  }
  if (discardedRanks.has(rank)) {
    log(`喊牌失敗：${rank} 已經進入棄牌堆，不能再喊這個點數。`);
    return false;
  }
  if (selectedCount !== count) {
    log(`出牌失敗：喊 ${count} 張，就必須實際選 ${count} 張牌。目前選了 ${selectedCount} 張。`);
    return false;
  }
  if (getPlayerHand(player).length < count) {
    log("出牌失敗：手牌不足。");
    return false;
  }
  return true;
}

function applyClaim(player, count, rank, selectedIndexesAscending) {
  clearBotTimer();
  clearBotTurnInFlight();
  clearBotChallengeTimers();
  if (!sameAddress(currentTurnPlayer(), player)) {
    log(`出牌失敗：目前輪到 ${playerLabel(currentTurnPlayer())}。`);
    return false;
  }
  actionStamp += 1;
  claimSequence += 1;
  challengeAccepted = false;
  if (challengeWindowOpen) {
    challengeWindowOpen = false;
    challengeHardLock = false;
    challengeHardLockUntil = 0;
    challengeWindowToken += 1;
    challengeWindowExpiresAt = 0;
    clearChallengeWindowTimer();
  }
  closeChallengeableTableLogs();
  const handBeforePlay = [...getPlayerHand(player)];
  const selectedIndexes = [...selectedIndexesAscending].sort((a, b) => b - a);
  const actualCards = selectedIndexesAscending.map((index) => handBeforePlay[index]).filter(Boolean);

  $("currentClaim").textContent = `${count} 張 ${rank}`;
  $("lastMove").textContent = `${playerLabel(player)} 宣稱出了 ${count} 張 ${rank}`;
  roundRank = rank;
  lastActor = player;
  lastPlayedBy = player;
  passedPlayers.clear();
  lastClaim = { actor: player, count, rank, actualCards, revealed: false };
  roundPlays.push({ actor: player, count, rank, actualCards, revealed: false });
  updateClaimBoard();

  const hand = [...handBeforePlay];
  selectedIndexes.forEach((index) => hand.splice(index, 1));
  setPlayerHand(player, hand);
  playPile.push(...actualCards);
  updatePileDisplay();
  renderHand();
  renderSeats();
  log(`遊戲：${playerLabel(player)} 宣稱 ${count} 張 ${rank}`);
  tableLog(`${playerLabel(player)} 出牌：宣稱 ${count} 張 ${rank}`, "challengeable");
  const isPendingWinner = checkWinner(player);
  renderHand();
  renderSeats();
  if (!isPendingWinner) advanceTurnFrom(player);
  openChallengeWindow();
  if (isPendingWinner) return true;
  return true;
}

function handlePlayClaim() {
  try {
    const selected = [...document.querySelectorAll(".card.selected")];
    const count = selected.length;
    const rank = roundRank || $("claimRank").value;
    const turnPlayer = currentTurnPlayer();

    if (resolvingChallenge) return log("出牌失敗：目前正在展示抓吹牛結果，請稍等。");
    if (!account) return log("出牌失敗：請先連接錢包。");
    if (!turnPlayer) return log("出牌失敗：尚未同步玩家順序。");
    if (!sameAddress(turnPlayer, account)) return log(`出牌失敗：目前輪到 ${playerLabel(turnPlayer)}，不是你。`);
    if (challengeHardLock) return log("出牌失敗：前 10 秒只能抓吹牛，稍後才能出牌。");
    if (pendingWinner) return log("出牌失敗：最後一手審查中，等待抓吹牛或自動結算。");
    if (winnerAddress) return log("出牌失敗：遊戲已結束，請進行最後結算。");
    if (!validateClaim(account, count, rank, selected.length)) return;

    const selectedIndexesAscending = selected.map((card) => Number(card.dataset.index)).sort((a, b) => a - b);
    applyClaim(account, count, rank, selectedIndexesAscending);
  } catch (err) {
    log(`出牌失敗：${explainError(err)}`);
  }
}

document.addEventListener("click", (event) => {
  const card = event.target.closest?.("#handCards .card");
  if (card) {
    if (!card.classList.contains("selected") && document.querySelectorAll(".card.selected").length >= 3) {
      log("選牌失敗：一次最多只能出 3 張。");
      return;
    }
    card.classList.toggle("selected");
    updateControls();
    return;
  }

  if (event.target.closest?.("#playClaimButton")) {
    handlePlayClaim();
  }
});

function resolveChallenge(challenger, options = {}) {
  const canUseGrace = Boolean(
    options.allowGrace
    && options.expectedActionStamp === actionStamp
    && lastClaim
    && Date.now() <= challengeWindowExpiresAt + 1200
  );

  if (!lastActor || !lastClaim) {
    log("抓吹牛失敗：目前還沒有人出牌。");
    return { ok: false, reason: "no-claim" };
  }
  if (sameAddress(lastActor, challenger)) {
    log("抓吹牛失敗：不能抓自己上一手出的牌。");
    return { ok: false, reason: "self" };
  }
  if (!challengeWindowOpen && !canUseGrace) {
    log("抓吹牛失敗：可抓時間已結束。");
    return { ok: false, reason: "closed" };
  }
  if (winnerAddress) {
    log("抓吹牛失敗：遊戲已結束。");
    return { ok: false, reason: "game-over" };
  }
  if (challengeAccepted) {
    log("抓吹牛失敗：已經有人先抓了。");
    return { ok: false, reason: "accepted" };
  }
  challengeAccepted = true;
  clearBotChallengeTimers();
  challengeWindowOpen = false;
  challengeHardLock = false;
  challengeHardLockUntil = 0;
  challengeWindowToken += 1;
  challengeWindowExpiresAt = 0;
  const resolvedRoundStamp = roundStamp + 1;
  roundStamp = resolvedRoundStamp;
  actionStamp += 1;
  clearChallengeWindowTimer();
  closeChallengeableTableLogs();
  clearBotTimer();
  clearBotTurnInFlight();
  resolvingChallenge = true;
  lastClaim.revealed = true;
  roundPlays.forEach((play) => {
    play.revealed = true;
  });
  const honest = isClaimHonest(lastClaim);
  const loser = honest ? challenger : lastClaim.actor;
  const nextStarter = honest ? lastClaim.actor : challenger;
  const challengeLine = `${playerLabel(challenger)} 抓 ${playerLabel(lastClaim.actor)} 吹牛`;
  const result = honest
    ? `抓錯了：${playerLabel(lastClaim.actor)} 的宣稱成立，${playerLabel(challenger)} 拿走出牌堆。`
    : `抓成功：${playerLabel(lastClaim.actor)} 的宣稱不成立，出牌者拿走出牌堆。`;
  updateClaimBoard(result);
  $("lastMove").textContent = `翻牌：${lastClaim.actualCards.join("、")}。${result}`;
  log(`抓吹牛判定：${result}`);
  $("lastMove").textContent = `${challengeLine}，翻牌：${lastClaim.actualCards.join("、")}。${result}`;
  log(`${challengeLine}。${result}`);
  tableLog(`${challengeLine}：${honest ? "抓錯" : "抓成功"}`);
  givePileTo(loser);
  const confirmedWinner = honest && pendingWinner && sameAddress(pendingWinner, lastClaim.actor) ? pendingWinner : null;
  if (!honest) pendingWinner = null;
  $("settlementSuggestion").textContent = confirmedWinner
    ? `判定展示中，${playerLabel(confirmedWinner)} 的最後一手通過，稍後結束遊戲。`
    : `判定展示中，下一輪將由 ${playerLabel(nextStarter)} 開始。`;
  renderSeats();
  updateControls();
  setTimeout(() => {
    if (roundStamp !== resolvedRoundStamp) return;
    lastClaim = null;
    resolvingChallenge = false;
    if (confirmedWinner) {
      setWinner(confirmedWinner);
      void autoSettleFinalPenalties();
      renderHand();
      renderSeats();
      updateControls();
      return;
    }
    $("currentClaim").textContent = "新回合，可自由喊點數";
    $("settlementSuggestion").textContent = `抓牛後由 ${playerLabel(nextStarter)} 開始新的一輪，金錢等遊戲結束後才結算。`;
    setTurnTo(nextStarter);
    renderHand();
    renderSeats();
    updateControls();
  }, 4000);
  return { ok: true };
}

function requestChallengeWithRetry(challenger) {
  const expectedActionStamp = actionStamp;
  const result = resolveChallenge(challenger, { expectedActionStamp });
  if (result.ok || result.reason !== "closed") return;

  log("抓吹牛請求失敗，正在重送一次。");
  setTimeout(() => {
    if (actionStamp !== expectedActionStamp) {
      log("抓吹牛重送取消：上一手已被新的動作取代。");
      return;
    }
    const retryResult = resolveChallenge(challenger, { allowGrace: true, expectedActionStamp });
    if (!retryResult.ok) log("抓吹牛重送後仍失敗：可抓時間已結束。");
  }, 250);
}

$("challengeButton").onclick = () => {
  if (!account) return log("抓吹牛失敗：請先連接錢包。");
  requestChallengeWithRetry(account);
};

wire("openRulesButton", () => {
  $("rulesModal")?.classList.remove("is-hidden");
});

wire("closeRulesButton", () => {
  $("rulesModal")?.classList.add("is-hidden");
});

wire("rulesModal", (event) => {
  if (event.target === $("rulesModal")) $("rulesModal").classList.add("is-hidden");
});

function applyPass(player) {
  clearBotTimer();
  clearBotTurnInFlight();
  if (pendingWinner) {
    return markFinalReviewAction(player, "Pass，放棄抓吹牛");
  }
  const turnPlayer = currentTurnPlayer();
  if (!turnPlayer) return log("Pass 失敗：尚未同步玩家順序。");
  if (!sameAddress(turnPlayer, player)) return log(`Pass 失敗：目前輪到 ${playerLabel(turnPlayer)}。`);
  if (challengeHardLock) return log("Pass 失敗：前 10 秒只能抓吹牛，稍後才能 Pass。");
  if (!roundRank || !lastPlayedBy) return log("Pass 失敗：新回合第一位玩家必須出牌，不能 pass。");
  if (sameAddress(lastPlayedBy, player)) return log("Pass 失敗：最後出牌者需要等待其他玩家。");

  actionStamp += 1;
  clearBotTurnInFlight();
  passedPlayers.add(handKey(player));
  log(`${playerLabel(player)} pass。`);
  tableLog(`${playerLabel(player)} Pass`);
  const activeOthers = tablePlayers.filter((player) => !sameAddress(player, lastPlayedBy));
  const allOthersPassed = activeOthers.every((player) => passedPlayers.has(handKey(player)));
  if (allOthersPassed) {
    finishPassCycle();
    renderSeats();
    renderTurn();
    return;
  }
  advanceTurnFrom(player);
  return true;
}

$("passButton").onclick = () => {
  if (!account) return log("Pass 失敗：請先連接錢包。");
  applyPass(account);
};

async function runBotAction(expectedRoundStamp = roundStamp, expectedActionStamp = actionStamp, inFlightKey = null) {
  if (expectedRoundStamp !== roundStamp) return false;
  if (expectedActionStamp !== actionStamp) return false;
  if (inFlightKey && botTurnInFlight !== inFlightKey) return false;
  if (challengeHardLock) return false;
  const bot = currentTurnPlayer();
  if (!bot || !isBot(bot)) return false;
  if (winnerAddress) return false;
  if (pendingWinner) return false;
  if (getPlayerHand(bot).length === 0) {
    setWinner(bot);
    void autoSettleFinalPenalties();
    return true;
  }

  let choice = null;
  try {
    const aiPayload = await requestAiBotChoice(bot);
    choice = normalizeAiChoice(bot, aiPayload.decision);
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    if (inFlightKey && botTurnInFlight !== inFlightKey) return false;
    if (choice) log(`${playerLabel(bot)} 使用 ${aiLabel(aiPayload)} 決策：${choice.action}`);
  } catch (err) {
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    if (inFlightKey && botTurnInFlight !== inFlightKey) return false;
    log(`${playerLabel(bot)} AI 決策失敗，改用本地規則：${err.message || err}`);
  }

  if (expectedRoundStamp !== roundStamp) return false;
  if (expectedActionStamp !== actionStamp) return false;
  if (inFlightKey && botTurnInFlight !== inFlightKey) return false;
  if (challengeHardLock) {
    if (choice?.action === "challenge" || (!choice && lastClaim && !sameAddress(lastClaim.actor, bot) && botShouldChallenge(bot))) {
      resolveChallenge(bot);
      return true;
    }
    const waitMs = Math.max(0, challengeHardLockUntil - Date.now()) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    if (winnerAddress || pendingWinner || resolvingChallenge || !sameAddress(currentTurnPlayer(), bot)) return false;
  }

  if (!choice && lastClaim && !sameAddress(lastClaim.actor, bot) && botShouldChallenge(bot)) {
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    resolveChallenge(bot);
    return true;
  }

  choice ||= chooseBotPlay(bot);
  if (choice.action === "challenge") {
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    resolveChallenge(bot);
    return true;
  }
  if (choice.action === "pass") {
    if (expectedRoundStamp !== roundStamp) return false;
    if (expectedActionStamp !== actionStamp) return false;
    applyPass(bot);
    return true;
  }

  const hand = getPlayerHand(bot);
  const selectedIndexes = [];
  for (const card of choice.cards.slice(0, 3)) {
    const index = hand.findIndex((candidate, candidateIndex) => candidate === card && !selectedIndexes.includes(candidateIndex));
    if (index >= 0) selectedIndexes.push(index);
  }
  const count = selectedIndexes.length;
  if (!validateClaim(bot, count, choice.rank, count)) return;
  if (expectedRoundStamp !== roundStamp) return false;
  if (expectedActionStamp !== actionStamp) return false;
  applyClaim(bot, count, choice.rank, selectedIndexes.sort((a, b) => a - b));
  return true;
}

$("forfeitButton").onclick = async () => {
  if (!account) return log("認輸退出失敗：請先連接錢包。");
  const room = await refreshRoomStatus();
  const isInRoom = room && Array.from(room.players).some((player) => sameAddress(player, account));
  if ((!gameLocked && Number(room?.status || 0) !== 2) || winnerAddress || !isInRoom) return log("認輸退出失敗：目前沒有你參與中的遊戲。");
  const amount = BigInt(room?.stakeRequired || 0);
  if (amount <= 0n) return log("認輸退出失敗：房間押金資料尚未同步。");
  const confirmed = window.confirm(`認輸退出會由合約扣除你的押金，支付每位對手 ${ethers.formatEther(amount)} ETH。確定要退出嗎？`);
  if (!confirmed) return;
  try {
    const game = await getContract();
    await wait(await game.forfeitGame(roomId(), amount, await txOverrides()), "認輸退出");
    log("已完成鏈上認輸退出。");
  } catch (err) {
    const message = explainError(err);
    log(`鏈上認輸退出未完成：${message}`);
    log("已解除本機遊戲鎖。若鏈上房間其實仍在進行，押金不會被這次本機解除扣除。");
  } finally {
    botMode = false;
    gameLocked = false;
    pendingWinner = null;
    winnerAddress = null;
    localStorage.removeItem(hostedRoomKey());
    $("roomText").value = makeRoomName();
    $("deckCommitment").value = "";
    roomViewCache = { roomId: null, players: [], status: null };
    resetTurnState(account ? [account] : [], true);
    updateRoomPanel(null, "已解除本機遊戲狀態，可以建立新房間。");
    $("tableStatus").textContent = "已退出";
    $("settlementSuggestion").textContent = "已解除本機遊戲狀態。";
    showView("lobbySection");
    updateControls();
    await refreshBalance().catch(() => {});
  }
};

wire("settleFinalButton", async () => {
  const payload = fillLatestFinalSettlementPayload(true);
  if (payload?.type === "final-penalties") {
    await settleFinalSettlementBundle(payload);
    return;
  }
  if (winnerAddress) {
    await autoSettleFinalPenalties();
    const nextPayload = fillLatestFinalSettlementPayload(true);
    if (nextPayload?.type === "final-penalties") await settleFinalSettlementBundle(nextPayload);
    return;
  }
  if (!winnerAddress) {
    log("最後結算失敗：尚未有玩家打完手牌。");
    return;
  }
  const losers = tablePlayers.filter((player) => !sameAddress(player, winnerAddress));
  const penaltyEthByLoser = losers.map((loser) => getPlayerHand(loser).length);
  const summary = losers
    .map((loser, index) => `${playerLabel(loser)} ${penaltyEthByLoser[index]} ETH`)
    .join("、");

  const game = await getContract();
  const room = await game.getRoom(roomId());
  if (!account || !sameAddress(account, room.host)) {
    const message = `最後結算只能由房主 ${short(room.host)} 執行，請切回建立房間的錢包。`;
    $("settlementSuggestion").textContent = message;
    log(message);
    return;
  }
  const payableLosers = losers.filter((loser) => getPlayerHand(loser).length > 0);
  const amounts = payableLosers.map((loser) => ethers.parseEther(String(getPlayerHand(loser).length)));
  if (!payableLosers.length) {
    gameLocked = false;
    $("settlementSuggestion").textContent = "沒有剩餘手牌需要扣款，已解除遊戲鎖定。";
    log("最後結算：沒有剩餘手牌需要扣款。");
    return;
  }
  await wait(await game.settleFinalPenalties(roomId(), winnerAddress, payableLosers, amounts, await txOverrides()), "最終贏家結算");
  gameLocked = false;
  $("settlementSuggestion").textContent = `合約已完成最終結算：${summary}，支付給 ${short(winnerAddress)}。`;
});

window.addEventListener("beforeunload", (event) => {
  if (!gameLocked || winnerAddress) return;
  event.preventDefault();
  event.returnValue = "遊戲進行中離開可能需要支付入場費。";
});

async function settleFinalSettlementBundle(payload) {
  if (payload.simulated) {
    $("settlementSuggestion").textContent = "電腦玩家局是前端模擬，沒有真實輸家錢包押金可扣；已完成前端結算展示。";
    log("電腦玩家局只做前端展示，不送鏈上結算。");
    return;
  }
  if (!payload.winner || !ethers.isAddress(payload.winner)) throw new Error("結算資料缺少贏家地址。");
  if (!payload.losers?.length) {
    log("結算失敗：本局沒有可扣款的輸家。");
    return;
  }

  log("正在由後端 relayer 自動提交鏈上結算。");
  const response = await fetch(`${getRelayerUrl()}/settle-final`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Relayer error ${response.status}`);
  }

  gameLocked = false;
  finalSettlementDone = true;
  const message = `本局押金已由 relayer 自動結算：${result.result.hash}`;
  $("settlementSuggestion").textContent = `合約已從輸家押金扣款並轉給贏家 ${short(payload.winner)}。Tx: ${result.result.hash}`;
  log(message);
  completePostSettlement(message);
  localStorage.removeItem(`final-settlement:${payload.roomId}:${payload.winner.toLowerCase()}`);
  if ($("settleNoteInput")) $("settleNoteInput").value = "";
  await refreshBalanceSoon(4, 800);
  await refreshRoomStatus().catch(() => {});
}

wire("resendSettlementButton", async () => {
  const payload = fillLatestFinalSettlementPayload(true);
  if (!payload?.type) {
    log("結算失敗：尚未產生本局贏家與扣款金額。");
    return;
  }
  await settleFinalSettlementBundle(payload);
});

async function initApp() {
  syncContractAddress();
  startRoomSyncLoop();
  if (!$("roomText").value.trim() || $("roomText").value === "room-001") {
    $("roomText").value = makeRoomName();
  }
  renderHand();
  updateRoomPanel();
  showView("lobbySection");
  updateControls();
  try {
    await restoreWalletSession();
  } catch (err) {
    log(`自動讀取錢包失敗：${explainError(err)}`);
  }
  fillLatestFinalSettlementPayload(false);
}

initApp();

