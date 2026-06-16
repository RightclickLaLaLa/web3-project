import "dotenv/config";
import http from "node:http";
import { ethers } from "ethers";

const PORT = Number(process.env.RELAYER_PORT || 8790);
const RPC_URL = process.env.RELAYER_RPC_URL || "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1";
const PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const DEFAULT_BOT_PRIVATE_KEYS = [
  "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd",
  "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0",
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e"
];
const BOT_PRIVATE_KEYS = (process.env.BOT_PRIVATE_KEYS || DEFAULT_BOT_PRIVATE_KEYS.join(","))
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const abi = [
  "function owner() view returns (address)",
  "function deposit() payable",
  "function deposits(address player) view returns (uint256)",
  "function joinRoom(bytes32 roomId)",
  "function voteRematch(bytes32 roomId,bool approve)",
  "function removeLobbyPlayer(bytes32 roomId,address player)",
  "function closeExpiredRematch(bytes32 roomId)",
  "function getRoom(bytes32 roomId) view returns (address host,uint256 stakeRequired,bytes32 deckCommitment,uint8 status,address[] players)",
  "function settleFinalPenalties(bytes32 roomId,address winner,address[] losers,uint256[] amounts)",
  "event AutoFinalSettlementTriggered(bytes32 indexed roomId,address indexed winner,address indexed submitter,address[] losers,uint256[] amounts,uint256 totalWon)"
];

const readyRooms = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function assertAddress(address, label) {
  if (!ethers.isAddress(address)) throw new Error(`${label} is not a valid address`);
  return ethers.getAddress(address);
}

function roomReadyMap(roomId) {
  const key = roomId.toLowerCase();
  if (!readyRooms.has(key)) readyRooms.set(key, new Map());
  return readyRooms.get(key);
}

function setReadyState(roomId, player, ready) {
  const readyMap = roomReadyMap(roomId);
  const address = ethers.getAddress(player);
  if (ready) {
    readyMap.set(address.toLowerCase(), true);
  } else {
    readyMap.delete(address.toLowerCase());
  }
}

function clearReadyState(roomId) {
  readyRooms.delete(roomId.toLowerCase());
}

function removeReadyState(roomId, player) {
  roomReadyMap(roomId).delete(ethers.getAddress(player).toLowerCase());
}

async function getReadyStatus(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  let room;
  try {
    room = await readContract.getRoom(payload.roomId);
  } catch (_err) {
    return {
      roomId: payload.roomId,
      status: 0,
      players: [],
      ready: {}
    };
  }
  const readyMap = roomReadyMap(payload.roomId);
  const players = Array.from(room.players).map((address) => ethers.getAddress(address));
  const ready = Object.fromEntries(players.map((player) => [player, Boolean(readyMap.get(player.toLowerCase()))]));
  return {
    roomId: payload.roomId,
    status: Number(room.status),
    players,
    ready
  };
}

async function setPlayerReady(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
  const player = assertAddress(payload.player, "player");
  const ready = Boolean(payload.ready);
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  const room = await readContract.getRoom(payload.roomId);
  if (![1, 3].includes(Number(room.status))) throw new Error("Room is not readyable");
  const players = Array.from(room.players).map((address) => ethers.getAddress(address));
  const isPlayerInRoom = players.some((candidate) => candidate.toLowerCase() === player.toLowerCase());
  if (ready && !isPlayerInRoom) {
    throw new Error("Player is not in this room");
  }
  setReadyState(payload.roomId, player, ready);
  return getReadyStatus(payload);
}

function validatePayload(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
  const winner = assertAddress(payload.winner, "winner");
  if (!Array.isArray(payload.losers) || !Array.isArray(payload.amounts)) throw new Error("losers and amounts are required");
  if (payload.losers.length !== payload.amounts.length) throw new Error("losers and amounts length mismatch");
  if (!payload.losers.length) throw new Error("at least one loser is required");
  const losers = payload.losers.map((loser) => assertAddress(loser, "loser"));
  const amounts = payload.amounts.map((amount) => {
    const value = BigInt(amount);
    if (value <= 0n) throw new Error("amount must be positive");
    return value;
  });
  return { roomId: payload.roomId, winner, losers, amounts };
}

async function settleFinal(payload) {
  if (!PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY is missing in .env");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
  const args = validatePayload(payload);
  const owner = await contract.owner();
  if (ethers.getAddress(owner) !== wallet.address) throw new Error("Relayer wallet is not contract owner");
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await contract.settleFinalPenalties(args.roomId, args.winner, args.losers, args.amounts, { nonce });
  const receipt = await tx.wait();
  return { hash: tx.hash, blockNumber: receipt.blockNumber, relayer: wallet.address };
}

function botWallets(provider) {
  return BOT_PRIVATE_KEYS.map((key) => new ethers.Wallet(key, provider));
}

function playerSet(players) {
  return new Set(players.map((player) => player.toLowerCase()));
}

async function depositAndJoinBot(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  const room = await readContract.getRoom(payload.roomId);
  if (![1, 3].includes(Number(room.status))) throw new Error("Room is not editable");
  const players = Array.from(room.players).map((address) => ethers.getAddress(address));
  if (players.length >= 4) throw new Error("Room is already full");
  const bots = botWallets(provider);
  const requestedBot = payload.botAddress ? assertAddress(payload.botAddress, "botAddress") : null;
  const joined = playerSet(players);
  const requestedWallet = requestedBot ? bots.find((wallet) => wallet.address === requestedBot) : null;
  if (requestedBot && !requestedWallet) throw new Error("Requested bot wallet is not configured");

  const preferredWallet = requestedWallet && !joined.has(requestedWallet.address.toLowerCase()) ? requestedWallet : null;
  const bot = preferredWallet || bots.find((wallet) => !joined.has(wallet.address.toLowerCase()));

  if (!bot) throw new Error("No available bot wallet");

  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, bot);
  const stakeRequired = BigInt(room.stakeRequired);
  const currentDeposit = BigInt(await readContract.deposits(bot.address));
  const txs = [];
  let nonce = await provider.getTransactionCount(bot.address, "pending");

  if (currentDeposit < stakeRequired) {
    const depositTx = await contract.deposit({ value: stakeRequired - currentDeposit, nonce: nonce++ });
    const depositReceipt = await depositTx.wait();
    txs.push({ type: "deposit", hash: depositTx.hash, blockNumber: depositReceipt.blockNumber });
  }

  const latestRoom = await readContract.getRoom(payload.roomId);
  const alreadyJoined = Array.from(latestRoom.players).some((player) => player.toLowerCase() === bot.address.toLowerCase());
  if (!alreadyJoined) {
    const joinTx = await contract.joinRoom(payload.roomId, { nonce: nonce++ });
    const joinReceipt = await joinTx.wait();
    txs.push({ type: "join", hash: joinTx.hash, blockNumber: joinReceipt.blockNumber });
  }

  setReadyState(payload.roomId, bot.address, true);

  const finalDeposit = await readContract.deposits(bot.address);
  const finalRoom = await readContract.getRoom(payload.roomId);
  return {
    bot: bot.address,
    deposit: finalDeposit.toString(),
    stakeRequired: stakeRequired.toString(),
    players: Array.from(finalRoom.players).map((address) => ethers.getAddress(address)),
    txs
  };
}

async function removeBotFromRoom(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
  if (!PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY is missing in .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  const room = await readContract.getRoom(payload.roomId);
  if (Number(room.status) !== 1) throw new Error("Room is not in lobby");

  const bots = botWallets(provider).map((wallet) => ethers.getAddress(wallet.address));
  const players = Array.from(room.players).map((address) => ethers.getAddress(address));
  const requestedBot = payload.botAddress ? assertAddress(payload.botAddress, "botAddress") : null;
  const removableBot = requestedBot && players.includes(requestedBot) && bots.includes(requestedBot)
    ? requestedBot
    : [...players].reverse().find((player) => bots.includes(player));

  if (!removableBot) throw new Error("No bot player is in this room");

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await contract.removeLobbyPlayer(payload.roomId, removableBot, { nonce });
  const receipt = await tx.wait();
  removeReadyState(payload.roomId, removableBot);
  const finalRoom = await readContract.getRoom(payload.roomId);
  return {
    bot: removableBot,
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    players: Array.from(finalRoom.players).map((address) => ethers.getAddress(address))
  };
}

async function readyBotsInRoom(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const readContract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
  const room = await readContract.getRoom(payload.roomId);
  if (![1, 3].includes(Number(room.status))) throw new Error("Room is not readyable");

  const players = playerSet(Array.from(room.players));
  const bots = botWallets(provider).filter((wallet) => players.has(wallet.address.toLowerCase()));
  const txs = [];
  for (const bot of bots) {
    if (Number(room.status) === 3) {
      const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, bot);
      const nonce = await provider.getTransactionCount(bot.address, "pending");
      const voteTx = await contract.voteRematch(payload.roomId, true, { nonce });
      const voteReceipt = await voteTx.wait();
      txs.push({ bot: bot.address, type: "rematch-vote", hash: voteTx.hash, blockNumber: voteReceipt.blockNumber });
    }
    setReadyState(payload.roomId, bot.address, true);
  }
  return { readyBots: bots.map((bot) => bot.address), readyStatus: await getReadyStatus(payload), txs };
}

async function closeExpiredRematch(payload) {
  if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
  if (!PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY is missing in .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await contract.closeExpiredRematch(payload.roomId, { nonce });
  const receipt = await tx.wait();
  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const url = requestUrl.pathname.startsWith("/relayer/")
      ? requestUrl.pathname.slice("/relayer".length)
      : requestUrl.pathname;
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && url === "/health") {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      return sendJson(res, 200, {
        ok: true,
        contractAddress: CONTRACT_ADDRESS,
        rpcUrl: RPC_URL,
        hasRelayerKey: Boolean(PRIVATE_KEY),
        relayer: PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY).address : null,
        bots: botWallets(provider).map((wallet) => wallet.address)
      });
    }
    if (req.method === "POST" && url === "/settle-final") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await settleFinal(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url === "/bots/join-room") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await depositAndJoinBot(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url === "/bots/remove-room") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await removeBotFromRoom(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url === "/bots/ready-room") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await readyBotsInRoom(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "GET" && url === "/rooms/ready-status") {
      const result = await getReadyStatus({ roomId: requestUrl.searchParams.get("roomId") });
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url === "/rooms/ready") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await setPlayerReady(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url === "/rooms/ready-clear") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      if (!payload?.roomId || !ethers.isHexString(payload.roomId, 32)) throw new Error("roomId must be bytes32");
      clearReadyState(payload.roomId);
      return sendJson(res, 200, { ok: true, result: { roomId: payload.roomId } });
    }
    if (req.method === "POST" && url === "/rooms/close-expired-rematch") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await closeExpiredRematch(payload);
      return sendJson(res, 200, { ok: true, result });
    }
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Settlement relayer listening on http://127.0.0.1:${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
});
