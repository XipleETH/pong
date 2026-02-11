import "./styles.css";
import { buildBotFireSlots, buildBotInputs } from "./game/aiController.js";
import { GameCore } from "./game/gameCore.js";
import { TEAM_META } from "./game/constants.js";
import { InputManager } from "./game/inputManager.js";
import { GameRenderer } from "./game/renderer.js";
import { MatchClient } from "./net/client.js";

const modeEl = document.querySelector("#mode");
const nicknameEl = document.querySelector("#nickname");
const localCountEl = document.querySelector("#local-count");
const startBtn = document.querySelector("#start-btn");
const leaveBtn = document.querySelector("#leave-btn");
const statusEl = document.querySelector("#status");
const mapNameEl = document.querySelector("#map-name");
const buffsEl = document.querySelector("#buffs");
const eventLogEl = document.querySelector("#event-log");
const scoreEmberEl = document.querySelector("#score-ember");
const scoreAzureEl = document.querySelector("#score-azure");
const canvas = document.querySelector("#game-canvas");

const renderer = new GameRenderer(canvas);
const inputManager = new InputManager();
const network = new MatchClient();

let game = null;
let running = false;
let roomId = null;
let localSlots = [0];
let onlineMatch = false;
let remoteSnapshot = null;
let pendingLocalFireSlots = new Set();
let inputAccumulator = 0;
let lastFrame = performance.now();
let slotOwners = new Map();
let currentMapSeed = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setRendererMap(snapshot) {
  if (!snapshot?.map) {
    return;
  }
  if (snapshot.seed && snapshot.seed === currentMapSeed) {
    return;
  }
  renderer.setMap(snapshot.map);
  currentMapSeed = snapshot.seed ?? `${Date.now()}`;
}

function applyRoster(roster) {
  slotOwners = new Map();
  for (const player of roster ?? []) {
    for (const slot of player.slots ?? []) {
      slotOwners.set(slot, player.playerId ?? player.socketId ?? "unknown");
    }
  }
}

function formatBuffLine(snapshot, team) {
  const buff = snapshot.buffs[team];
  const weaponTier = snapshot.weaponTier?.[team] ?? 1;
  const labels = [];
  if (buff.paddleUntil > snapshot.time) {
    labels.push(`Paddle ${Math.ceil(buff.paddleUntil - snapshot.time)}s`);
  }
  if (buff.shieldUntil > snapshot.time) {
    labels.push(`Shield ${Math.ceil(buff.shieldUntil - snapshot.time)}s`);
  }
  if (buff.boostUntil > snapshot.time) {
    labels.push(`Boost ${Math.ceil(buff.boostUntil - snapshot.time)}s`);
  }
  labels.push(`Arma T${weaponTier}`);
  return `${TEAM_META[team].name}: ${labels.join(", ")}`;
}

function updateHud(snapshot) {
  scoreEmberEl.textContent = String(snapshot.score[0]);
  scoreAzureEl.textContent = String(snapshot.score[1]);
  mapNameEl.textContent = `Mapa: ${snapshot.map.biome.name} / ${snapshot.map.mutator.name}`;
  buffsEl.textContent = `Buffs: ${formatBuffLine(snapshot, 0)} | ${formatBuffLine(
    snapshot,
    1
  )}`;
  const lastNotice = snapshot.notices.at(-1)?.text ?? "-";
  eventLogEl.textContent = `Evento: ${lastNotice}`;
}

function resetRuntimeState() {
  game = null;
  running = false;
  roomId = null;
  onlineMatch = false;
  remoteSnapshot = null;
  pendingLocalFireSlots = new Set();
  inputAccumulator = 0;
  slotOwners.clear();
  localSlots = [0];
  inputManager.setLocalSlots(localSlots);
  currentMapSeed = null;
}

function startOffline() {
  network.leaveQueue();
  if (roomId) {
    network.leaveMatch(roomId);
  }
  network.clearReconnect();
  resetRuntimeState();

  const localCount = clamp(Number(localCountEl.value) || 1, 1, 4);
  localSlots = [0, 1, 2, 3].slice(0, localCount);
  inputManager.setLocalSlots(localSlots);
  slotOwners = new Map(localSlots.map((slot) => [slot, "local"]));

  game = new GameCore();
  renderer.setMap(game.state.map);
  currentMapSeed = game.state.seed;
  running = true;
  startBtn.disabled = false;
  setStatus(`Partida local iniciada (${localCount} jugador(es) local(es))`);
}

async function queueOnline() {
  const nickname = nicknameEl.value.trim() || "Jugador";
  const requestedPartySize = clamp(Number(localCountEl.value) || 1, 1, 4);
  const partySize = clamp(requestedPartySize, 1, 2);
  resetRuntimeState();
  startBtn.disabled = true;

  setStatus("Conectando al matchmaking...");
  await network.connect();
  network.queueForMatch({ nickname, partySize });
  if (requestedPartySize !== partySize) {
    setStatus(
      `En cola (${nickname}) con party size ${partySize} (ajustado para ranked 2v2).`
    );
  } else {
    setStatus(`En cola (${nickname}) con party size ${partySize}.`);
  }
}

function stopSession(message = "Sesion detenida") {
  network.leaveQueue();
  if (roomId) {
    network.leaveMatch(roomId);
  }
  network.clearReconnect();
  resetRuntimeState();
  startBtn.disabled = false;
  setStatus(message);
}

network.on("identity", (payload) => {
  const currentNick = payload?.nickname ?? "Jugador";
  if (!nicknameEl.value || nicknameEl.value === "Jugador") {
    nicknameEl.value = currentNick;
  }
});

network.on("queued", (payload) => {
  if (modeEl.value !== "online") {
    return;
  }
  setStatus(
    `En cola: posicion ${payload.position}/${payload.total} | MMR ${payload.mmr} | rango +/-${payload.mmrRange}`
  );
});

network.on("queueUpdate", (payload) => {
  if (modeEl.value !== "online" || roomId) {
    return;
  }
  setStatus(
    `En cola: posicion ${payload.position}/${payload.total} | espera ${payload.waitSeconds}s | rango +/-${payload.mmrRange}`
  );
});

network.on("readyCheck", (payload) => {
  if (modeEl.value !== "online") {
    return;
  }
  const remainingMs = Math.max(0, payload.expiresAt - Date.now());
  setStatus(
    `Match encontrado. Confirmando (${Math.ceil(remainingMs / 1000)}s)...`
  );
  network.respondReady(payload.matchId, true);
});

network.on("readyUpdate", (payload) => {
  if (modeEl.value !== "online") {
    return;
  }
  setStatus(`Ready-check: ${payload.acceptedCount}/${payload.total} confirmados.`);
});

network.on("readyCancelled", (payload) => {
  if (modeEl.value !== "online") {
    return;
  }
  setStatus(`Ready-check cancelado: ${payload.reason}. Reintentando cola...`);
});

network.on("matchFound", (payload) => {
  if (modeEl.value !== "online") {
    network.leaveMatch(payload.roomId);
    return;
  }
  roomId = payload.roomId;
  onlineMatch = true;
  running = true;
  localSlots = payload.assignedSlots?.length ? payload.assignedSlots : [0];
  inputManager.setLocalSlots(localSlots);
  applyRoster(payload.roster);
  pendingLocalFireSlots.clear();
  inputAccumulator = 0;
  network.rememberReconnect(payload.roomId, payload.reconnectToken);

  const preview = new GameCore({ seed: payload.seed });
  remoteSnapshot = preview.getSerializableState();
  setRendererMap(remoteSnapshot);
  startBtn.disabled = true;
  setStatus(
    `Match ${roomId} listo. Slots locales: ${localSlots.join(", ")}. Simulacion autoritativa en servidor.`
  );
});

network.on("matchRejoined", (payload) => {
  if (modeEl.value !== "online") {
    return;
  }
  roomId = payload.roomId;
  onlineMatch = true;
  running = true;
  localSlots = payload.assignedSlots?.length ? payload.assignedSlots : [0];
  inputManager.setLocalSlots(localSlots);
  applyRoster(payload.roster);
  pendingLocalFireSlots.clear();
  inputAccumulator = 0;
  network.rememberReconnect(payload.roomId, payload.reconnectToken);

  remoteSnapshot = payload.snapshot ?? remoteSnapshot;
  setRendererMap(remoteSnapshot);
  startBtn.disabled = true;
  setStatus(`Reconexion completada en match ${roomId}.`);
});

network.on("stateSnapshot", (payload) => {
  if (!onlineMatch) {
    return;
  }
  if (roomId && payload?.roomId && payload.roomId !== roomId) {
    return;
  }
  remoteSnapshot = payload.snapshot;
  setRendererMap(remoteSnapshot);
});

network.on("playerLeft", (payload) => {
  const leftSlots = payload?.slots ?? [];
  for (const slot of leftSlots) {
    slotOwners.delete(slot);
  }
  setStatus(`Jugador fuera. Slots ${leftSlots.join(", ")} pasan a bot servidor.`);
});

network.on("playerPresence", (payload) => {
  const slots = payload?.slots ?? [];
  const state = payload?.connected ? "reconectado" : "desconectado";
  if (slots.length > 0) {
    setStatus(`Jugador ${state} en slots ${slots.join(", ")}.`);
  }
});

network.on("serverNotice", (payload) => {
  if (!payload?.message) {
    return;
  }
  setStatus(payload.message);
});

network.on("matchEnded", (payload) => {
  if (roomId && payload?.roomId && payload.roomId !== roomId) {
    return;
  }
  const myId = network.profile?.playerId;
  const mine = (payload?.ratingChanges ?? []).find((entry) => entry.playerId === myId);
  const ratingSuffix = mine
    ? ` | Rating ${mine.ratingBefore} -> ${mine.ratingAfter} (${mine.delta >= 0 ? "+" : ""}${mine.delta})`
    : "";

  resetRuntimeState();
  network.clearReconnect();
  startBtn.disabled = false;
  setStatus(`Partida finalizada: ${payload?.reason ?? "sin motivo"}${ratingSuffix}`);
});

network.on("disconnect", () => {
  if (modeEl.value === "online") {
    running = false;
    onlineMatch = false;
    startBtn.disabled = false;
    setStatus("Desconectado del servidor. Puedes volver a iniciar para reconectar/cola.");
  }
});

startBtn.addEventListener("click", async () => {
  if (modeEl.value === "offline") {
    startOffline();
    return;
  }
  await queueOnline();
});

leaveBtn.addEventListener("click", () => {
  stopSession();
});

modeEl.addEventListener("change", () => {
  if (modeEl.value === "offline") {
    setStatus("Modo local listo.");
    startBtn.disabled = false;
  } else {
    setStatus("Modo online listo para cola.");
  }
});

function runOfflineStep(dt) {
  if (!game) {
    return;
  }
  const localInputs = inputManager.sample();
  inputManager.consumeFireEvents().forEach((slot) => pendingLocalFireSlots.add(slot));
  const mergedInputs = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const fireSlots = new Set();
  const occupied = new Set();

  for (const slot of localSlots) {
    mergedInputs[slot] = localInputs[slot] ?? 0;
    occupied.add(slot);
    if (pendingLocalFireSlots.has(slot)) {
      fireSlots.add(slot);
    }
  }

  const botInputs = buildBotInputs(game.state, occupied);
  Object.assign(mergedInputs, botInputs);
  const botFireSlots = buildBotFireSlots(game.state, occupied);
  botFireSlots.forEach((slot) => fireSlots.add(slot));

  const snapshot = game.step(dt, mergedInputs, [...fireSlots]);
  fireSlots.forEach((slot) => {
    pendingLocalFireSlots.delete(slot);
  });

  renderer.render(snapshot);
  updateHud(snapshot);
}

function runOnlineStep(dt) {
  if (roomId) {
    const axes = inputManager.sample();
    const localAxes = {};
    for (const slot of localSlots) {
      localAxes[slot] = axes[slot] ?? 0;
    }
    inputManager.consumeFireEvents().forEach((slot) => {
      if (localSlots.includes(slot)) {
        pendingLocalFireSlots.add(slot);
      }
    });
    inputAccumulator += dt;
    if (inputAccumulator >= 1 / 30) {
      network.sendInput(roomId, {
        axes: localAxes,
        fires: [...pendingLocalFireSlots],
      });
      pendingLocalFireSlots.clear();
      inputAccumulator = 0;
    }
  }

  if (remoteSnapshot) {
    renderer.render(remoteSnapshot);
    updateHud(remoteSnapshot);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 1 / 20);
  lastFrame = now;

  if (!running) {
    return;
  }

  if (modeEl.value === "offline") {
    runOfflineStep(dt);
  } else if (onlineMatch) {
    runOnlineStep(dt);
  }
}

setStatus("Selecciona modo y pulsa Iniciar.");
requestAnimationFrame(frame);

