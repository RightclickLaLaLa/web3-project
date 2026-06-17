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
  const isChallengeCheck = Boolean(
    state.lastClaim
    && String(state.currentTurn || "") !== String(state.bot || "")
  );
  const requestMode = isChallengeCheck ? "CHALLENGE_CHECK_ONLY" : "PLAY_TURN";
  return [
    "/no_think",
    "You are an AI player in a Bullshit / Bluffing card game. Output exactly one JSON object. No Markdown. No extra text.",
    "Your identity is state.bot. Other player names, including Chinese names such as \"你\" or \"右鍵\", are opponents and are not you.",
    `Request mode: ${requestMode}.`,
    "Game rules:",
    "1. The game uses a 54-card deck: each rank A,2,3,4,5,6,7,8,9,10,J,Q,K has exactly 4 natural cards, plus exactly 2 jokers. The joker card string is exactly \"鬼牌\".",
    "2. Players take turns. On a new round, the first player chooses a claimed rank and plays 1 to 3 real cards face down.",
    "3. After a rank is claimed in a round, later players must continue claiming the SAME rank. They may play 1 to 3 cards or pass.",
    "4. A player may lie about the claimed rank. Lying is allowed, but the real cards in play.cards must come from your hand exactly.",
    "5. Any other player may challenge the most recent play before the next play happens.",
    "6. If the challenge is correct, the player who lied takes the whole play pile. The challenger starts the next round.",
    "7. If the challenge is wrong, the challenger takes the whole play pile. The challenged player starts the next round.",
    "8. If everyone else passes, the previous play pile is safe from challenge, and the last player who played starts a new round with a new rank.",
    "9. A player wins only after playing all cards and surviving the final challenge window.",
    "10. Four-of-a-kind discard exists in the real game. Obey discarded-rank information if it appears in state; do not claim a discarded rank.",
    "Important state detail: seats[].handCount is the CURRENT hand count after the latest play. If the actor now has 0 cards, it can simply mean they just played their final cards. Do not call a claim impossible only because actor handCount is lower than lastClaim.count.",
    "Available actions:",
    "{\"action\":\"play\",\"rank\":\"A\",\"cards\":[\"A\"],\"reason\":\"...\",\"risk\":0.2}",
    "{\"action\":\"pass\",\"reason\":\"...\",\"risk\":0.2}",
    "{\"action\":\"challenge\",\"reason\":\"...\",\"risk\":0.8}",
    isChallengeCheck
      ? "Current task: you are NOT the current player. You may only decide whether to challenge the LAST claim. Legal actions are challenge or pass. Do not play."
      : "Current task: you ARE the current player. You may play, pass, or challenge if there is a last claim.",
    "Challenge reasoning:",
    "Estimate whether the latest claim is credible from your private hand and public state.",
    "Deck counting matters: if you hold some cards of the claimed rank, fewer natural cards of that rank remain for the actor. Jokers can still make a claim honest, but there are only 2 jokers in the whole deck.",
    "If your hand contains many copies of the claimed rank or jokers, the claim is more credible, so pass unless the pile is huge.",
    "If your hand contains zero claimed-rank cards and zero jokers, the claim is suspicious. It is especially suspicious when claim.count is 2 or 3, playPileCount is 6 or more, or the actor has few cards left.",
    "A one-card claim can still be challenged when the play pile is large, the actor is near winning, or the same rank has been over-claimed repeatedly.",
    "When someone has just played their final cards, judge honesty from rank evidence and pile pressure, not from the fact that their current handCount is 0.",
    "Use risk as your estimated chance that the latest claim is a lie: 0.0 means very honest, 1.0 means almost certainly lying.",
    "Risk calibration: claim.count >= 2, zero claimed-rank cards, zero jokers, and playPileCount >= 6 should usually be risk 0.55 to 0.75.",
    "Risk calibration: claim.count >= 3, zero claimed-rank cards, zero jokers, and playPileCount >= 8 should usually be risk 0.70 or higher.",
    "Risk calibration: claim.count >= 3 is always a bold claim. Even when the pile is small, zero claimed-rank cards and zero jokers in your hand should usually be risk about 0.55 to 0.65.",
    "Risk calibration: claim.count == 1, zero claimed-rank cards, zero jokers, and playPileCount >= 11 should usually be risk about 0.55.",
    "In CHALLENGE_CHECK_ONLY, if claim.count >= 2 AND your hand has zero claimed-rank cards AND zero jokers AND playPileCount >= 7, choose challenge unless there is a specific reason the actor is very likely honest.",
    "Hard challenge rule: in CHALLENGE_CHECK_ONLY, if claim.count >= 3 AND your hand has zero claimed-rank cards AND zero jokers, choose challenge. This is a bold claim with no private support.",
    "Hard challenge rule: in CHALLENGE_CHECK_ONLY, if claim.count == 1 AND your hand has zero claimed-rank cards AND zero jokers AND playPileCount >= 12, choose challenge. The pile is too large to keep passing.",
    "Challenge when risk is about 0.55 or higher. Pass when risk is clearly lower.",
    "Decision rules:",
    "A. Challenge only the latest lastClaim. Do not challenge older plays.",
    "B. Do not always pass. Bluffing is common in this game, especially when the claimed rank is missing from the player's hand.",
    "C. Not having the claimed rank in your hand is meaningful evidence. Combine it with pile size, claim count, and actor hand count.",
    "D. If you play, cards must be 1 to 3 exact strings from hand, without using any card more times than it appears in hand.",
    "E. If roundRank exists, play.rank must equal roundRank. If roundRank is empty, choose any rank A-K.",
    "F. You may bluff by playing cards that do not match play.rank, but those real cards still must exist in hand.",
    "G. If it is your turn and you have no card matching roundRank, do not automatically pass. Bluffing is legal and often the correct move. Prefer playing 1 low-value or expendable card as a bluff unless the pile is already very dangerous.",
    "H. If evidence is unclear, prefer pass over challenge. If evidence is moderate or strong, challenge.",
    "Before output, internally check: legal action, correct phase, valid rank, cards exist in hand, and reason matches evidence.",
    `State JSON: ${JSON.stringify(state)}`
  ].join("\n");
}

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function normalizeDecision(decision, state) {
  const action = String(decision?.action || "").toLowerCase();
  if (["challenge", "pass"].includes(action)) {
    return {
      action,
      reason: typeof decision?.reason === "string" ? decision.reason.slice(0, 180) : undefined,
      risk: Number.isFinite(Number(decision?.risk)) ? Number(decision.risk) : undefined
    };
  }
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

function selectCardsFromHand(requestedCards, hand) {
  const selected = [];
  const usedIndexes = new Set();
  for (const card of requestedCards.slice(0, 3).map(String)) {
    const index = hand.findIndex((candidate, candidateIndex) => candidate === card && !usedIndexes.has(candidateIndex));
    if (index >= 0) {
      selected.push(hand[index]);
      usedIndexes.add(index);
    }
  }
  return selected;
}

function repairDecision(decision, state) {
  if (decision.action === "challenge" || decision.action === "pass") {
    if (decision.action === "pass" && shouldForceChallengeByHardRule(state)) {
      return {
        action: "challenge",
        reason: "Hard rule: no claimed-rank cards or jokers, with a bold claim or oversized pile.",
        risk: Math.max(Number(decision.risk) || 0, 0.62),
        inferredFrom: "hard-challenge-calibration"
      };
    }
    return decision;
  }

  const hand = Array.isArray(state.hand) ? state.hand.map(String) : [];
  if (decision.action !== "play") return localRuleDecision(state);

  const isChallengeCheck = Boolean(
    state.lastClaim
    && String(state.currentTurn || "") !== String(state.bot || "")
  );
  if (isChallengeCheck) {
    return { ...localRuleDecision(state), inferredFrom: "invalid-play-during-challenge-check" };
  }

  const rank = String(state.roundRank || decision.rank || "").toUpperCase();
  if (!RANKS.includes(rank)) {
    return { ...localRuleDecision(state), inferredFrom: "invalid-rank" };
  }

  const cards = selectCardsFromHand(Array.isArray(decision.cards) ? decision.cards : [], hand);
  if (cards.length < 1 || cards.length > 3) {
    return { ...localRuleDecision(state), inferredFrom: "invalid-or-missing-cards" };
  }

  return { action: "play", rank, cards };
}

function shouldForceChallengeByHardRule(state) {
  const lastClaim = state.lastClaim;
  if (!lastClaim || String(lastClaim.actor || "") === String(state.bot || "")) return false;
  if (String(state.currentTurn || "") === String(state.bot || "")) return false;
  const hand = Array.isArray(state.hand) ? state.hand.map(String) : [];
  const claimRank = String(lastClaim.rank || "").toUpperCase();
  const knownRank = hand.filter((card) => String(card).toUpperCase() === claimRank).length;
  const jokers = hand.filter((card) => card === "鬼牌").length;
  if (knownRank + jokers > 0) return false;
  const claimCount = Number(lastClaim.count || 0);
  const playPileCount = Number(state.playPileCount || 0);
  return claimCount >= 3 || (claimCount === 1 && playPileCount >= 12);
}

function getSeatHandCount(state, player) {
  return Number(
    (Array.isArray(state.seats) ? state.seats : [])
      .find((seat) => String(seat.player || "") === String(player || ""))?.handCount || 99
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
    const handCountByActor = getSeatHandCount(state, lastClaim.actor);
    const playPileCount = Number(state.playPileCount || 0);
    if (claimCount + knownRank + jokers > 6) return { action: "challenge", inferredFrom: "local-impossible" };

    let suspicion = 0.06;
    suspicion += clamp((claimCount - 1) * 0.1, 0, 0.22);
    suspicion += clamp((playPileCount - 6) * 0.03, 0, 0.18);
    suspicion += handCountByActor <= 2 ? 0.22 : handCountByActor <= 4 ? 0.1 : 0;
    suspicion += knownRank + jokers === 0 ? 0.1 : -(knownRank + jokers) * 0.1;
    suspicion += claimCount >= 3 && knownRank + jokers === 0 ? 0.18 : 0;
    suspicion += claimCount >= 2 && knownRank + jokers === 0 && playPileCount >= 7 ? 0.12 : 0;
    suspicion += claimCount === 1 && knownRank + jokers === 0 && playPileCount >= 11 ? 0.16 : 0;
    suspicion += knownRank >= 3 && claimCount >= 2 ? 0.12 : 0;
    suspicion = clamp(suspicion, 0.02, 0.78);

    if (claimCount >= 3 && knownRank + jokers === 0 && Math.random() < 0.45) {
      return { action: "challenge", inferredFrom: "local-bold-three-claim", suspicion: Number(suspicion.toFixed(2)) };
    }
    if (claimCount === 1 && playPileCount >= 11 && knownRank + jokers === 0 && Math.random() < 0.32) {
      return { action: "challenge", inferredFrom: "local-large-pile-single", suspicion: Number(suspicion.toFixed(2)) };
    }
    if (claimCount >= 3 && playPileCount >= 9 && knownRank + jokers <= 1) {
      return { action: "challenge", inferredFrom: "local-large-pile" };
    }
    const challengeThreshold = claimCount === 1 ? 0.7 : 0.58;
    if (suspicion >= challengeThreshold || Math.random() < Math.max(0, suspicion - 0.34)) {
      return { action: "challenge", inferredFrom: "local-suspicion-score", suspicion: Number(suspicion.toFixed(2)) };
    }
    if (String(state.currentTurn || "") !== String(state.bot || "")) {
      return { action: "pass", inferredFrom: "local-challenge-pass", suspicion: Number(suspicion.toFixed(2)) };
    }
  }

  if (roundRank) {
    const playable = hand.filter((card) => String(card).toUpperCase() === roundRank || card === "鬼牌").slice(0, 3);
    if (playable.length) {
      const count = Number(state.playPileCount || 0) >= 8 ? 1 : playable.length;
      return { action: "play", rank: roundRank, cards: playable.slice(0, count) };
    }
    const bluffCards = [...hand]
      .filter((card) => card !== "鬼牌")
      .sort((a, b) => RANKS.indexOf(String(a).toUpperCase()) - RANKS.indexOf(String(b).toUpperCase()));
    const pileIsDangerous = Number(state.playPileCount || 0) >= 12;
    if (pileIsDangerous && Math.random() < 0.55) return { action: "pass", inferredFrom: "local-large-pile-no-card" };
    return { action: "play", rank: roundRank, cards: (bluffCards.length ? bluffCards : hand).slice(0, 1), inferredFrom: "local-bluff-no-rank" };
  }

  const bestRank = RANKS
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
              cards: { type: "array", items: { type: "string" } },
              reason: { type: "string" },
              risk: { type: "number" }
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
    const url = req.url?.startsWith("/ai/") ? req.url.slice("/ai".length) : req.url;
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && url === "/health") {
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
    if (req.method === "POST" && url === "/bot-action") {
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
        decision = repairDecision(normalizeDecision(rawDecision, state), state);
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
