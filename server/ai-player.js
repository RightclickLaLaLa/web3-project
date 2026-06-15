import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.AI_PORT || 8787);
const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL = process.env.GEMMA_MODEL || "gemma-3-27b-it";
const MODEL_PATH = MODEL.startsWith("models/") ? MODEL : `models/${MODEL}`;
const AI_PROVIDER = (process.env.AI_PROVIDER || "google").toLowerCase();
const LMSTUDIO_BASE_URL = (process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || "qwen3.5-4b";
const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "ai-monitor.log");

fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size === 0) {
  fs.writeFileSync(LOG_FILE, "\uFEFF", "utf8");
}

function writeAiLog(type, payload) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    type,
    payload
  });
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  console.log(line);
}

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

function extractJson(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("Model did not return JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return JSON.parse(trimmed.slice(start, index + 1));
  }
  throw new Error("Model returned incomplete JSON");
}

function buildPrompt(state) {
  return [
    "/no_think",
    "你是吹牛撲克牌遊戲的電腦玩家。請只回傳 JSON，不要 Markdown，不要解釋。",
    "合法 action 只有 challenge、pass、play。",
    "一定要包含 action 欄位。不要回傳 actor/count/rank 來描述上一手；如果你要抓上一手，必須只回 {\"action\":\"challenge\"}。",
    "規則：每次出 1 到 3 張；同一輪若已有喊牌點數，只能繼續喊同點數或 pass；鬼牌可當任意點數。",
    "如果目前不是你的出牌回合，而 lastClaim 存在，這次是在判斷要不要抓吹牛；此時只能回 challenge 或 pass，不要回 play。",
    "如果你手上完全沒有 lastClaim.rank 或鬼牌，且出牌堆已經有 4 張以上，應該偏向 challenge。",
    "如果上一手宣稱 2 張以上、出牌堆已經有 6 張以上，應該偏向 challenge。",
    "若上一手明顯可疑，可以 challenge。若出牌堆太大且沒有可用牌，可以 pass。否則選 1 到 3 張手牌出牌，可誠實也可吹牛。",
    "回傳格式：{\"action\":\"play\",\"rank\":\"A\",\"cards\":[\"A\"]} 或 {\"action\":\"pass\"} 或 {\"action\":\"challenge\"}。",
    `目前狀態：${JSON.stringify(state)}`
  ].join("\n");
}

function normalizeDecision(decision, state) {
  const action = String(decision?.action || "").toLowerCase();
  if (["challenge", "pass"].includes(action)) return { action };
  if (action === "play") {
    return {
      action: "play",
      rank: String(decision?.rank || state.roundRank || "").toUpperCase(),
      cards: Array.isArray(decision?.cards) ? decision.cards.map(String) : []
    };
  }

  const actor = String(decision?.actor || "");
  const claim = state?.lastClaim;
  const describesLastClaim = Boolean(
    claim
    && actor
    && actor === String(claim.actor || "")
    && (!decision?.rank || String(decision.rank).toUpperCase() === String(claim.rank || "").toUpperCase())
    && (!decision?.count || Number(decision.count) === Number(claim.count))
  );
  if (describesLastClaim) return { action: "challenge", inferredFrom: "claim-shaped-response" };

  if (claim && actor) return { action: "challenge", inferredFrom: "actor-response" };
  return { action: "pass", inferredFrom: "invalid-response" };
}

function localRuleDecision(state) {
  const hand = Array.isArray(state.hand) ? state.hand.map(String) : [];
  const roundRank = state.roundRank ? String(state.roundRank).toUpperCase() : "";
  const lastClaim = state.lastClaim;
  const jokers = hand.filter((card) => card === "鬼牌").length;
  const matching = roundRank ? hand.filter((card) => String(card).toUpperCase() === roundRank).length : 0;

  if (lastClaim && String(lastClaim.actor || "") !== String(state.bot || "")) {
    const claimRank = String(lastClaim.rank || "").toUpperCase();
    const knownRank = hand.filter((card) => String(card).toUpperCase() === claimRank).length;
    const claimCount = Number(lastClaim.count || 0);
    if (claimCount + knownRank + jokers > 6) return { action: "challenge", inferredFrom: "local-impossible" };
    if (claimCount >= 3 && Number(state.playPileCount || 0) >= 8) return { action: "challenge", inferredFrom: "local-large-pile" };
  }

  if (roundRank) {
    const playable = hand.filter((card) => String(card).toUpperCase() === roundRank || card === "鬼牌").slice(0, 3);
    if (playable.length) return { action: "play", rank: roundRank, cards: playable };
    if (Number(state.playPileCount || 0) >= 10) return { action: "pass", inferredFrom: "local-large-pile-no-card" };
    return { action: "play", rank: roundRank, cards: hand.slice(0, 1) };
  }

  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const bestRank = ranks
    .map((rank) => ({ rank, count: hand.filter((card) => String(card).toUpperCase() === rank || card === "鬼牌").length }))
    .sort((a, b) => b.count - a.count)[0]?.rank || "A";
  const cards = hand.filter((card) => String(card).toUpperCase() === bestRank || card === "鬼牌").slice(0, 3);
  return { action: "play", rank: bestRank, cards: cards.length ? cards : hand.slice(0, 1), inferredFrom: "local-opening" };
}

async function callGoogleModel(state) {
  if (!API_KEY) throw new Error("GOOGLE_API_KEY is missing in .env");
  const url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_PATH}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(state) }] }],
      generationConfig: {
        temperature: 0.55,
        responseMimeType: "application/json"
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || response.statusText;
    throw new Error(`Google API error ${response.status}: ${message}`);
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  return extractJson(text);
}

async function callLmStudioModel(state) {
  const response = await fetch(`${LMSTUDIO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: LMSTUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: "你是吹牛撲克牌遊戲的電腦玩家。只回傳 JSON，不要 Markdown，不要解釋。"
        },
        {
          role: "user",
          content: buildPrompt(state)
        }
      ],
      temperature: 0.55,
      max_tokens: 800,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "bullshit_game_decision",
          schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["challenge", "pass", "play"] },
              rank: { type: "string" },
              cards: { type: "array", items: { type: "string" } }
            },
            required: ["action"],
            additionalProperties: false
          }
        }
      },
      stream: false
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || response.statusText;
    throw new Error(`LM Studio API error ${response.status}: ${message}`);
  }
  const message = payload?.choices?.[0]?.message || {};
  const text = message.content || message.reasoning_content || "";
  return extractJson(text);
}

async function callConfiguredModel(state) {
  if (AI_PROVIDER === "lmstudio") return { provider: "lmstudio", rawDecision: await callLmStudioModel(state) };
  if (AI_PROVIDER === "google") return { provider: "google", rawDecision: await callGoogleModel(state) };

  try {
    return { provider: "lmstudio", rawDecision: await callLmStudioModel(state) };
  } catch (lmErr) {
    writeAiLog("fallback", { from: "lmstudio", to: "google", message: lmErr.message || String(lmErr) });
    return { provider: "google", rawDecision: await callGoogleModel(state) };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        provider: AI_PROVIDER,
        googleModel: MODEL,
        googleModelPath: MODEL_PATH,
        hasGoogleKey: Boolean(API_KEY),
        lmstudioBaseUrl: LMSTUDIO_BASE_URL,
        lmstudioModel: LMSTUDIO_MODEL
      });
    }
    if (req.method === "POST" && req.url === "/bot-action") {
      const body = await readBody(req);
      const state = JSON.parse(body || "{}");
      writeAiLog("request", {
        bot: state.bot,
        currentTurn: state.currentTurn,
        hand: state.hand,
        roundRank: state.roundRank,
        playPileCount: state.playPileCount,
        discardPileCount: state.discardPileCount,
        passedPlayers: state.passedPlayers,
        lastClaim: state.lastClaim,
        seats: state.seats
      });
      let provider;
      let rawDecision;
      let decision;
      try {
        const modelResult = await callConfiguredModel(state);
        provider = modelResult.provider;
        rawDecision = modelResult.rawDecision;
        decision = normalizeDecision(rawDecision, state);
      } catch (modelErr) {
        provider = "local-rule";
        rawDecision = { error: modelErr.message || String(modelErr) };
        decision = localRuleDecision(state);
        writeAiLog("fallback", { from: AI_PROVIDER, to: "local-rule", message: rawDecision.error });
      }
      writeAiLog("response", { bot: state.bot, provider, model: provider === "lmstudio" ? LMSTUDIO_MODEL : MODEL, rawDecision, decision });
      return sendJson(res, 200, { ok: true, provider, model: provider === "lmstudio" ? LMSTUDIO_MODEL : MODEL, decision });
    }
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    writeAiLog("error", { url: req.url, message: err.message || String(err) });
    return sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`AI player server listening on http://127.0.0.1:${PORT}`);
  console.log(`AI provider: ${AI_PROVIDER}`);
  console.log(`Google model: ${MODEL}`);
  console.log(`LM Studio: ${LMSTUDIO_BASE_URL} / ${LMSTUDIO_MODEL}`);
  writeAiLog("server-start", {
    port: PORT,
    provider: AI_PROVIDER,
    googleModel: MODEL,
    googleModelPath: MODEL_PATH,
    hasGoogleKey: Boolean(API_KEY),
    lmstudioBaseUrl: LMSTUDIO_BASE_URL,
    lmstudioModel: LMSTUDIO_MODEL
  });
});
