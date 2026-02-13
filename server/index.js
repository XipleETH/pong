import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { buildBotFireSlots, buildBotInputs } from "../src/game/aiController.js";
import { GameCore } from "../src/game/gameCore.js";
import { createPersistence, matchmakingDefaults } from "./persistence.js";

const PORT = Number(process.env.PORT ?? 3001);
const TICK_RATE = 60;
const SNAPSHOT_RATE = 20;
const INPUT_STALE_MS = 380;
const READY_CHECK_MS = 10000;
const RECONNECT_GRACE_MS = 45000;
const QUEUE_SCAN_INTERVAL_MS = 350;
const QUEUE_BASE_MMR_RANGE = 120;
const QUEUE_EXPAND_STEP = 40;
const QUEUE_EXPAND_EVERY_MS = 10000;
const QUEUE_MAX_MMR_RANGE = 720;
const QUEUE_REQUEUE_PRIORITY_MS = 12000;
const SCORE_LIMIT = Number(process.env.MATCH_SCORE_LIMIT ?? 7);
const MATCH_MAX_DURATION_MS = 8 * 60 * 1000;
const DEFAULT_MAX_PING_MS = 220;
const ELO_K = 26;
const ABANDON_PENALTY = 24;
const INACTIVE_SLOT_RESPAWN_SECONDS = 60 * 60 * 24;

const PLAYLISTS = {
  ranked: {
    id: "ranked",
    label: "2v2 Ranked",
    teamSize: 2,
    totalSeats: 4,
    teamSlots: {
      0: [0, 1],
      1: [2, 3],
    },
    maxPartySize: 2,
  },
  duel: {
    id: "duel",
    label: "1v1 Duel",
    teamSize: 1,
    totalSeats: 2,
    teamSlots: {
      0: [0],
      1: [2],
    },
    maxPartySize: 1,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeNickname(value) {
  return (
    String(value ?? "Jugador")
      .trim()
      .slice(0, 18) || "Jugador"
  );
}

function normalizePlaylist(value) {
  const normalized = String(value ?? "ranked").toLowerCase().trim();
  if (normalized === "duel" || normalized === "1v1") {
    return "duel";
  }
  return "ranked";
}

function getPlaylistConfig(playlist) {
  return PLAYLISTS[playlist] ?? PLAYLISTS.ranked;
}

function normalizeRegion(value) {
  const normalized = String(value ?? "na")
    .toLowerCase()
    .trim()
    .slice(0, 8);
  return normalized || "na";
}

function normalizeInputMode(value) {
  const normalized = String(value ?? "mixed").toLowerCase();
  if (normalized === "keyboard" || normalized === "controller") {
    return normalized;
  }
  return "mixed";
}

function inputModeCompatible(a, b) {
  return a === "mixed" || b === "mixed" || a === b;
}

function mmrRangeForEntry(entry, now) {
  const waitMs = Math.max(0, now - entry.joinedAt);
  const expansions = Math.floor(waitMs / QUEUE_EXPAND_EVERY_MS);
  return Math.min(QUEUE_MAX_MMR_RANGE, QUEUE_BASE_MMR_RANGE + expansions * QUEUE_EXPAND_STEP);
}

function ratingAverage(entries) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.partySize, 0);
  if (totalWeight <= 0) {
    return matchmakingDefaults.defaultRating;
  }
  const weighted = entries.reduce((sum, entry) => sum + entry.rating * entry.partySize, 0);
  return weighted / totalWeight;
}

function getBucketKey(entry) {
  return `${entry.playlist}|${entry.region}`;
}

function createQueueEntry({
  socketState,
  socketId,
  nickname,
  partySize,
  playlist,
  region,
  inputMode,
  maxPingMs,
  joinedAt = Date.now(),
}) {
  return {
    id: `q_${randomUUID()}`,
    socketId,
    playerId: socketState.playerId,
    nickname,
    partySize,
    rating: socketState.rating ?? matchmakingDefaults.defaultRating,
    joinedAt,
    playlist,
    region,
    inputMode,
    pingMs: socketState.pingMs ?? 80,
    maxPingMs,
  };
}

function compareCandidate(a, b) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (a.oldestJoinedAt !== b.oldestJoinedAt) {
    return a.oldestJoinedAt < b.oldestJoinedAt ? a : b;
  }
  if (a.mmrSpan !== b.mmrSpan) {
    return a.mmrSpan < b.mmrSpan ? a : b;
  }
  if (a.teamDiff !== b.teamDiff) {
    return a.teamDiff < b.teamDiff ? a : b;
  }
  return a.avgPing <= b.avgPing ? a : b;
}
function findBestTeamPartition(entries, teamSize) {
  const chosen = [];
  let best = null;

  function evaluatePartition(indices) {
    const pickedSet = new Set(indices);
    const team0 = [];
    const team1 = [];
    let team0Seats = 0;
    let team1Seats = 0;

    for (let index = 0; index < entries.length; index += 1) {
      if (pickedSet.has(index)) {
        team0.push(entries[index]);
        team0Seats += entries[index].partySize;
      } else {
        team1.push(entries[index]);
        team1Seats += entries[index].partySize;
      }
    }

    if (team0Seats !== teamSize || team1Seats !== teamSize) {
      return;
    }

    const avg0 = ratingAverage(team0);
    const avg1 = ratingAverage(team1);
    const diff = Math.abs(avg0 - avg1);

    if (!best || diff < best.diff) {
      best = {
        team0,
        team1,
        diff,
      };
    }
  }

  function dfs(startIndex, currentSeats) {
    if (currentSeats === teamSize) {
      evaluatePartition(chosen);
      return;
    }
    if (currentSeats > teamSize) {
      return;
    }
    for (let i = startIndex; i < entries.length; i += 1) {
      chosen.push(i);
      dfs(i + 1, currentSeats + entries[i].partySize);
      chosen.pop();
    }
  }

  dfs(0, 0);
  if (!best) {
    return null;
  }

  const assignmentByEntryId = new Map();
  for (const entry of best.team0) {
    assignmentByEntryId.set(entry.id, { team: 0 });
  }
  for (const entry of best.team1) {
    assignmentByEntryId.set(entry.id, { team: 1 });
  }
  return {
    assignmentByEntryId,
    teamDiff: best.diff,
  };
}

function assignSlots(entries, assignmentByEntryId, playlistConfig) {
  const slotsByTeam = {
    0: [...playlistConfig.teamSlots[0]],
    1: [...playlistConfig.teamSlots[1]],
  };
  const byTeam = {
    0: [],
    1: [],
  };

  for (const entry of entries) {
    const teamInfo = assignmentByEntryId.get(entry.id);
    if (!teamInfo) {
      return null;
    }
    byTeam[teamInfo.team].push(entry);
  }

  for (const team of [0, 1]) {
    byTeam[team].sort((a, b) => {
      if (b.partySize !== a.partySize) {
        return b.partySize - a.partySize;
      }
      return a.joinedAt - b.joinedAt;
    });
  }

  const result = new Map();
  for (const team of [0, 1]) {
    const pool = slotsByTeam[team];
    for (const entry of byTeam[team]) {
      if (entry.partySize > pool.length) {
        return null;
      }
      const slots = [];
      for (let i = 0; i < entry.partySize; i += 1) {
        slots.push(pool.shift());
      }
      result.set(entry.id, slots);
    }
  }
  return result;
}

function comboCompatible(entries, now) {
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i];
    if (a.pingMs > a.maxPingMs) {
      return false;
    }
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j];
      if (!inputModeCompatible(a.inputMode, b.inputMode)) {
        return false;
      }
      const mmrDiff = Math.abs(a.rating - b.rating);
      const limit = Math.min(mmrRangeForEntry(a, now), mmrRangeForEntry(b, now));
      if (mmrDiff > limit) {
        return false;
      }
      if (a.pingMs > b.maxPingMs || b.pingMs > a.maxPingMs) {
        return false;
      }
    }
  }
  return true;
}

function findBestCandidate(entries, now, playlistConfig) {
  if (entries.length < 2) {
    return null;
  }
  const ordered = [...entries].sort((a, b) => a.joinedAt - b.joinedAt);
  const searchPool = ordered.slice(0, 16);
  const current = [];
  let best = null;

  function evaluateCurrent() {
    if (!comboCompatible(current, now)) {
      return;
    }
    const partition = findBestTeamPartition(current, playlistConfig.teamSize);
    if (!partition) {
      return;
    }
    const slotMap = assignSlots(current, partition.assignmentByEntryId, playlistConfig);
    if (!slotMap) {
      return;
    }
    const ratings = current.map((entry) => entry.rating);
    const pings = current.map((entry) => entry.pingMs);
    const candidate = {
      entries: [...current],
      assignmentByEntryId: partition.assignmentByEntryId,
      slotsByEntryId: slotMap,
      playlist: current[0].playlist,
      region: current[0].region,
      oldestJoinedAt: Math.min(...current.map((entry) => entry.joinedAt)),
      mmrSpan: Math.max(...ratings) - Math.min(...ratings),
      teamDiff: partition.teamDiff,
      avgPing: pings.reduce((sum, ping) => sum + ping, 0) / pings.length,
    };
    best = compareCandidate(best, candidate);
  }

  function dfs(startIndex, seatCount) {
    if (seatCount === playlistConfig.totalSeats) {
      evaluateCurrent();
      return;
    }
    if (seatCount > playlistConfig.totalSeats) {
      return;
    }
    for (let i = startIndex; i < searchPool.length; i += 1) {
      current.push(searchPool[i]);
      dfs(i + 1, seatCount + searchPool[i].partySize);
      current.pop();
    }
  }

  dfs(0, 0);
  return best;
}

function makeRosterPayload(room) {
  return [...room.members.values()].map((member) => ({
    playerId: member.playerId,
    socketId: member.socketId,
    nickname: member.nickname,
    team: member.team,
    slots: [...member.slots],
    connected: Boolean(member.socketId),
    rating: member.ratingBefore,
  }));
}

function buildRatingChanges(participants, winnerTeam) {
  const team0 = participants.filter((member) => member.team === 0);
  const team1 = participants.filter((member) => member.team === 1);
  const avg0 = ratingAverage(team0);
  const avg1 = ratingAverage(team1);
  const expected0 = 1 / (1 + 10 ** ((avg1 - avg0) / 400));
  const result0 = winnerTeam === null ? 0.5 : winnerTeam === 0 ? 1 : 0;
  const delta0 = Math.round(ELO_K * (result0 - expected0));

  return participants.map((member) => {
    let delta = member.team === 0 ? delta0 : -delta0;
    const abandoned = Boolean(member.abandoned);
    if (abandoned) {
      delta -= ABANDON_PENALTY;
    }
    const ratingAfter = clamp(Math.round(member.ratingBefore + delta), 100, 4000);
    return {
      playerId: member.playerId,
      delta,
      ratingBefore: member.ratingBefore,
      ratingAfter,
      abandoned,
      reconnectCount: member.reconnectCount,
      result: winnerTeam === null ? "draw" : winnerTeam === member.team ? "win" : "loss",
      team: member.team,
      slots: [...member.slots],
      partySize: member.partySize,
    };
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

const queueByBucket = new Map();
const queueEntryBySocket = new Map();
const activeRooms = new Map();
const pendingReadyById = new Map();
const socketState = new Map();
const playerSocket = new Map();

let roomSequence = 1;
let readySequence = 1;

const persistence = await createPersistence();
function bucketEntries(bucketKey) {
  if (!queueByBucket.has(bucketKey)) {
    queueByBucket.set(bucketKey, []);
  }
  return queueByBucket.get(bucketKey);
}

function removeQueueEntry(socketId) {
  const current = queueEntryBySocket.get(socketId);
  if (!current) {
    return null;
  }
  const list = queueByBucket.get(current.bucketKey) ?? [];
  const index = list.findIndex((entry) => entry.id === current.entry.id);
  if (index !== -1) {
    list.splice(index, 1);
  }
  if (list.length === 0) {
    queueByBucket.delete(current.bucketKey);
  }
  queueEntryBySocket.delete(socketId);
  return current.entry;
}

function updateQueuePositions(bucketKey) {
  const list = queueByBucket.get(bucketKey) ?? [];
  list.sort((a, b) => a.joinedAt - b.joinedAt);
  const total = list.length;
  list.forEach((entry, index) => {
    const socket = io.sockets.sockets.get(entry.socketId);
    if (!socket) {
      return;
    }
    const waitMs = Date.now() - entry.joinedAt;
    socket.emit("queueUpdate", {
      position: index + 1,
      total,
      playlist: entry.playlist,
      region: entry.region,
      waitSeconds: Math.floor(waitMs / 1000),
      mmrRange: mmrRangeForEntry(entry, Date.now()),
    });
  });
}

function updateAllQueuePositions() {
  for (const key of queueByBucket.keys()) {
    updateQueuePositions(key);
  }
}

function enqueueFromSocketState(state, payload, priorityMs = 0) {
  const playlist = normalizePlaylist(payload?.playlist);
  const playlistConfig = getPlaylistConfig(playlist);
  const region = normalizeRegion(payload?.region);
  const inputMode = normalizeInputMode(payload?.inputMode);
  const nickname = sanitizeNickname(payload?.nickname ?? state.nickname);
  const requestedParty = clamp(Number(payload?.partySize) || 1, 1, 4);
  const partySize = clamp(requestedParty, 1, playlistConfig.maxPartySize);
  const maxPingMs = clamp(Number(payload?.maxPingMs) || DEFAULT_MAX_PING_MS, 80, 500);

  state.nickname = nickname;
  state.partySize = partySize;
  state.playlist = playlist;
  state.region = region;
  state.inputMode = inputMode;
  persistence.updateNickname(state.playerId, nickname).catch(() => {});

  const joinedAt = Date.now() - Math.max(0, priorityMs);
  const entry = createQueueEntry({
    socketState: state,
    socketId: state.socketId,
    nickname,
    partySize,
    playlist,
    region,
    inputMode,
    maxPingMs,
    joinedAt,
  });
  const key = getBucketKey(entry);
  entry.bucketKey = key;
  const list = bucketEntries(key);
  list.push(entry);
  list.sort((a, b) => a.joinedAt - b.joinedAt);
  queueEntryBySocket.set(state.socketId, {
    bucketKey: key,
    entry,
  });

  const socket = io.sockets.sockets.get(state.socketId);
  socket?.emit("queued", {
    position: list.findIndex((item) => item.id === entry.id) + 1,
    total: list.length,
    playlist,
    region,
    partySize,
    mmr: entry.rating,
    mmrRange: mmrRangeForEntry(entry, Date.now()),
  });

  if (requestedParty !== partySize) {
    socket?.emit("serverNotice", {
      message: `Party size ajustado a ${partySize} para cola ${playlistConfig.label}.`,
    });
  }
  updateQueuePositions(key);
}

function clearPendingReadyAssociation(ready) {
  for (const member of ready.members) {
    const state = socketState.get(member.socketId);
    if (state && state.pendingReadyId === ready.id) {
      state.pendingReadyId = null;
    }
  }
}

function cancelReadyCheck(ready, reason, { acceptedOnly = true, excludePlayerId = null } = {}) {
  if (!pendingReadyById.has(ready.id)) {
    return;
  }
  clearTimeout(ready.timeoutHandle);
  pendingReadyById.delete(ready.id);
  clearPendingReadyAssociation(ready);

  for (const member of ready.members) {
    const socket = io.sockets.sockets.get(member.socketId);
    socket?.emit("readyCancelled", {
      matchId: ready.id,
      reason,
    });
  }

  for (const member of ready.members) {
    if (member.playerId === excludePlayerId) {
      continue;
    }
    if (acceptedOnly && !ready.accepted.has(member.playerId)) {
      continue;
    }
    const currentSocketId = playerSocket.get(member.playerId);
    if (!currentSocketId) {
      continue;
    }
    const state = socketState.get(currentSocketId);
    if (!state || state.roomId) {
      continue;
    }
    removeQueueEntry(currentSocketId);
    enqueueFromSocketState(
      state,
      {
        nickname: member.nickname,
        partySize: member.partySize,
        playlist: ready.playlist,
        region: ready.region,
        inputMode: member.inputMode,
      },
      QUEUE_REQUEUE_PRIORITY_MS
    );
  }
}

function finishRoomForSockets(room, payload) {
  for (const member of room.members.values()) {
    if (!member.socketId) {
      continue;
    }
    const state = socketState.get(member.socketId);
    if (state) {
      state.roomId = null;
      state.slots = [];
      state.reconnect = null;
    }
    const socket = io.sockets.sockets.get(member.socketId);
    if (socket) {
      socket.leave(room.id);
      socket.emit("matchEnded", payload);
    }
  }
}

async function endRoom(room, reason, explicitWinner = null) {
  if (room.ended) {
    return;
  }
  room.ended = true;
  activeRooms.delete(room.id);

  const finalSnapshot = room.lastSnapshot ?? room.game.getSerializableState();
  const team0 = finalSnapshot.score?.[0] ?? 0;
  const team1 = finalSnapshot.score?.[1] ?? 0;
  const winnerTeam =
    explicitWinner === null
      ? team0 === team1
        ? null
        : team0 > team1
          ? 0
          : 1
      : explicitWinner;

  const participants = [...room.members.values()];
  const ratingChanges = buildRatingChanges(participants, winnerTeam);
  const byPlayerId = new Map(ratingChanges.map((entry) => [entry.playerId, entry]));

  for (const member of participants) {
    const change = byPlayerId.get(member.playerId);
    if (!change) {
      continue;
    }
    member.ratingAfter = change.ratingAfter;
    const socketId = playerSocket.get(member.playerId);
    const state = socketId ? socketState.get(socketId) : null;
    if (state) {
      state.rating = change.ratingAfter;
    }
  }

  try {
    await persistence.applyMatchResult({
      matchId: room.id,
      playlist: room.playlist,
      seed: room.seed,
      team0Score: team0,
      team1Score: team1,
      winnerTeam,
      startedAt: room.startedAt,
      endedAt: Date.now(),
      durationSeconds: (Date.now() - room.startedAt) / 1000,
      players: ratingChanges,
    });
  } catch (error) {
    console.error("[match] failed to persist match result", error);
  }

  finishRoomForSockets(room, {
    roomId: room.id,
    reason,
    winnerTeam,
    score: [team0, team1],
    ratingChanges,
  });
}

function tryCreateReadyChecks(bucketKey) {
  const list = queueByBucket.get(bucketKey) ?? [];
  if (list.length < 2) {
    return;
  }
  const playlist = list[0]?.playlist ?? "ranked";
  const playlistConfig = getPlaylistConfig(playlist);

  while (true) {
    const now = Date.now();
    const candidate = findBestCandidate(list, now, playlistConfig);
    if (!candidate) {
      break;
    }

    const candidateIds = new Set(candidate.entries.map((entry) => entry.id));
    const selected = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (candidateIds.has(list[i].id)) {
        selected.push(list[i]);
        queueEntryBySocket.delete(list[i].socketId);
        list.splice(i, 1);
      }
    }
    if (selected.length === 0) {
      break;
    }
    if (list.length === 0) {
      queueByBucket.delete(bucketKey);
    }

    const readyId = `ready-${readySequence}`;
    readySequence += 1;
    const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const members = selected
      .map((entry) => {
        const teamInfo = candidate.assignmentByEntryId.get(entry.id);
        const slots = candidate.slotsByEntryId.get(entry.id);
        if (!teamInfo || !slots) {
          return null;
        }
        return {
          socketId: entry.socketId,
          playerId: entry.playerId,
          nickname: entry.nickname,
          partySize: entry.partySize,
          ratingBefore: entry.rating,
          team: teamInfo.team,
          slots: [...slots],
          reconnectToken: `rc_${randomUUID()}`,
          inputMode: entry.inputMode,
        };
      })
      .filter(Boolean);

    if (members.length === 0) {
      continue;
    }

    const ready = {
      id: readyId,
      playlist: selected[0].playlist,
      region: selected[0].region,
      seed,
      members,
      accepted: new Set(),
      createdAt: Date.now(),
      expiresAt: Date.now() + READY_CHECK_MS,
      timeoutHandle: null,
    };

    pendingReadyById.set(ready.id, ready);
    ready.timeoutHandle = setTimeout(() => {
      const current = pendingReadyById.get(ready.id);
      if (!current) {
        return;
      }
      cancelReadyCheck(current, "Ready-check expiro", { acceptedOnly: true });
    }, READY_CHECK_MS + 80);

    for (const member of ready.members) {
      const state = socketState.get(member.socketId);
      if (state) {
        state.pendingReadyId = ready.id;
      }
      const socket = io.sockets.sockets.get(member.socketId);
      socket?.emit("readyCheck", {
        matchId: ready.id,
        playlist: ready.playlist,
        region: ready.region,
        expiresAt: ready.expiresAt,
        acceptedCount: ready.accepted.size,
        total: ready.members.length,
        roster: ready.members.map((entry) => ({
          playerId: entry.playerId,
          nickname: entry.nickname,
          partySize: entry.partySize,
          team: entry.team,
        })),
      });
    }
  }

  updateQueuePositions(bucketKey);
}

function tickQueueMatchmaking() {
  for (const key of [...queueByBucket.keys()]) {
    tryCreateReadyChecks(key);
  }
}

function enforceRoomSlotMask(room) {
  const disabledUntil = room.game.state.time + INACTIVE_SLOT_RESPAWN_SECONDS;
  for (const slot of room.inactiveSlots) {
    const paddle = room.game.state.paddles?.[slot];
    if (!paddle) {
      continue;
    }
    paddle.segmentHp = [0, 0, 0];
    paddle.respawnUntil = Math.max(paddle.respawnUntil ?? 0, disabledUntil);
    paddle.input = 0;
    paddle.fireCooldownUntil = Math.max(paddle.fireCooldownUntil ?? 0, disabledUntil);
  }
}

function createRoomFromReady(ready) {
  const roomId = `match-${roomSequence}`;
  roomSequence += 1;
  const playlistConfig = getPlaylistConfig(ready.playlist);

  const game = new GameCore({ seed: ready.seed });
  const room = {
    id: roomId,
    playlist: ready.playlist,
    playlistConfig,
    region: ready.region,
    seed: ready.seed,
    game,
    startedAt: Date.now(),
    createdAt: Date.now(),
    members: new Map(),
    slotOwner: [null, null, null, null],
    slotInputs: new Map(),
    slotFires: new Set(),
    snapshotAccumulator: 0,
    serverSeq: 0,
    lastSnapshot: game.getSerializableState(),
    activeSlots: new Set(),
    inactiveSlots: new Set([0, 1, 2, 3]),
    ended: false,
  };

  for (const member of ready.members) {
    const socket = io.sockets.sockets.get(member.socketId);
    const state = socketState.get(member.socketId);
    const roomMember = {
      playerId: member.playerId,
      nickname: member.nickname,
      partySize: member.partySize,
      ratingBefore: member.ratingBefore,
      ratingAfter: member.ratingBefore,
      team: member.team,
      slots: [...member.slots],
      reconnectToken: member.reconnectToken,
      reconnectCount: 0,
      socketId: socket?.id ?? null,
      disconnectedAt: socket ? null : Date.now(),
      abandoned: false,
    };

    room.members.set(roomMember.playerId, roomMember);
    for (const slot of roomMember.slots) {
      room.slotOwner[slot] = roomMember.playerId;
      room.activeSlots.add(slot);
      room.inactiveSlots.delete(slot);
    }

    if (state) {
      state.roomId = roomId;
      state.slots = [...roomMember.slots];
      state.pendingReadyId = null;
      state.reconnect = {
        roomId,
        token: roomMember.reconnectToken,
      };
    }
  }

  enforceRoomSlotMask(room);
  room.lastSnapshot = room.game.getSerializableState();
  activeRooms.set(roomId, room);

  for (const member of ready.members) {
    const socket = io.sockets.sockets.get(member.socketId);
    if (!socket) {
      continue;
    }
    socket.join(roomId);
    socket.emit("matchFound", {
      roomId,
      seed: room.seed,
      playlist: room.playlist,
      region: room.region,
      assignedSlots: member.slots,
      reconnectToken: member.reconnectToken,
      scoreLimit: SCORE_LIMIT,
      serverAuthoritative: true,
      roster: makeRosterPayload(room),
    });
    socket.emit("stateSnapshot", {
      roomId,
      snapshot: room.lastSnapshot,
      sentAt: Date.now(),
      serverSeq: room.serverSeq,
    });
  }

  return room;
}

function acceptReady(socket, payload) {
  const state = socketState.get(socket.id);
  if (!state?.pendingReadyId) {
    return;
  }
  const readyId = String(payload?.matchId ?? state.pendingReadyId);
  const ready = pendingReadyById.get(readyId);
  if (!ready) {
    state.pendingReadyId = null;
    return;
  }
  const member = ready.members.find((entry) => entry.playerId === state.playerId);
  if (!member) {
    return;
  }

  const accepted = payload?.accept !== false;
  if (!accepted) {
    cancelReadyCheck(ready, "Un jugador rechazo el ready-check", {
      acceptedOnly: true,
      excludePlayerId: state.playerId,
    });
    return;
  }

  ready.accepted.add(state.playerId);
  for (const readyMember of ready.members) {
    const memberSocket = io.sockets.sockets.get(readyMember.socketId);
    memberSocket?.emit("readyUpdate", {
      matchId: ready.id,
      acceptedCount: ready.accepted.size,
      total: ready.members.length,
    });
  }

  if (ready.accepted.size < ready.members.length) {
    return;
  }

  clearTimeout(ready.timeoutHandle);
  pendingReadyById.delete(ready.id);
  clearPendingReadyAssociation(ready);
  createRoomFromReady(ready);
}

function registerInput(socket, payload) {
  const state = socketState.get(socket.id);
  if (!state?.roomId) {
    return;
  }
  const room = activeRooms.get(state.roomId);
  if (!room) {
    return;
  }
  const member = room.members.get(state.playerId);
  if (!member || member.socketId !== socket.id) {
    return;
  }

  const axes = payload?.inputs?.axes ?? payload?.inputs ?? {};
  for (const [slotRaw, axisRaw] of Object.entries(axes)) {
    const slot = Number(slotRaw);
    if (!Number.isFinite(slot) || slot < 0 || slot > 3) {
      continue;
    }
    if (!member.slots.includes(slot)) {
      continue;
    }
    room.slotInputs.set(slot, {
      value: clamp(Number(axisRaw) || 0, -1, 1),
      seenAt: Date.now(),
    });
  }

  const fires = payload?.inputs?.fires ?? [];
  for (const slotRaw of fires) {
    const slot = Number(slotRaw);
    if (!Number.isFinite(slot) || slot < 0 || slot > 3) {
      continue;
    }
    if (!member.slots.includes(slot)) {
      continue;
    }
    room.slotFires.add(slot);
  }
}

function markMemberDisconnected(state, reason = "Jugador desconectado") {
  if (!state?.roomId) {
    return;
  }
  const room = activeRooms.get(state.roomId);
  if (!room) {
    state.roomId = null;
    state.slots = [];
    state.reconnect = null;
    return;
  }

  const member = room.members.get(state.playerId);
  if (!member) {
    state.roomId = null;
    state.slots = [];
    state.reconnect = null;
    return;
  }
  member.socketId = null;
  if (!member.disconnectedAt) {
    member.disconnectedAt = Date.now();
  }
  io.to(room.id).emit("playerLeft", {
    playerId: member.playerId,
    slots: member.slots,
    reason,
  });
  state.roomId = null;
  state.slots = [];
}

function emitPresence(room, member, connected) {
  io.to(room.id).emit("playerPresence", {
    playerId: member.playerId,
    slots: member.slots,
    connected,
  });
}

function tryReconnectToRoom(socket, state, reconnectPayload) {
  const roomId = reconnectPayload?.roomId;
  const token = reconnectPayload?.token;
  if (!roomId || !token) {
    return false;
  }
  const room = activeRooms.get(String(roomId));
  if (!room) {
    return false;
  }
  const member = room.members.get(state.playerId);
  if (!member) {
    return false;
  }
  if (member.reconnectToken !== token) {
    return false;
  }
  if (member.disconnectedAt && Date.now() - member.disconnectedAt > RECONNECT_GRACE_MS) {
    return false;
  }

  if (member.socketId && member.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(member.socketId);
    oldSocket?.disconnect(true);
  }

  member.socketId = socket.id;
  member.disconnectedAt = null;
  member.reconnectCount += 1;

  state.roomId = room.id;
  state.slots = [...member.slots];
  state.reconnect = {
    roomId: room.id,
    token: member.reconnectToken,
  };

  socket.join(room.id);
  socket.emit("matchRejoined", {
    roomId: room.id,
    assignedSlots: member.slots,
    reconnectToken: member.reconnectToken,
    playlist: room.playlist,
    region: room.region,
    scoreLimit: SCORE_LIMIT,
    roster: makeRosterPayload(room),
    snapshot: room.lastSnapshot,
  });
  socket.emit("stateSnapshot", {
    roomId: room.id,
    snapshot: room.lastSnapshot,
    sentAt: Date.now(),
    serverSeq: room.serverSeq,
  });
  emitPresence(room, member, true);
  return true;
}

function shouldEndRoom(room) {
  const score = room.lastSnapshot.score ?? [0, 0];
  if (Math.max(score[0], score[1]) >= SCORE_LIMIT) {
    const winner = score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1;
    return {
      reason: `Limite de puntuacion alcanzado (${SCORE_LIMIT})`,
      winner,
    };
  }

  if (Date.now() - room.startedAt > MATCH_MAX_DURATION_MS) {
    const winner = score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1;
    return {
      reason: "Tiempo maximo de partida alcanzado",
      winner,
    };
  }

  const teamActive = [false, false];
  for (const member of room.members.values()) {
    if (!member.socketId && member.disconnectedAt) {
      if (Date.now() - member.disconnectedAt > RECONNECT_GRACE_MS) {
        member.abandoned = true;
      }
    }
    const active = !member.abandoned;
    if (active) {
      teamActive[member.team] = true;
    }
  }

  if (!teamActive[0] || !teamActive[1]) {
    const winner = !teamActive[0] && !teamActive[1] ? null : teamActive[0] ? 0 : 1;
    return {
      reason: "Equipo completo abandono la partida",
      winner,
    };
  }
  return null;
}

function tickRooms() {
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  for (const room of activeRooms.values()) {
    if (room.ended) {
      continue;
    }

    enforceRoomSlotMask(room);

    const inputs = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const fireSlots = new Set();
    const occupied = new Set();
    const botBlockedSlots = new Set(room.inactiveSlots);

    for (const member of room.members.values()) {
      if (!member.socketId) {
        continue;
      }
      for (const slot of member.slots) {
        occupied.add(slot);
        const input = room.slotInputs.get(slot);
        if (input && now - input.seenAt <= INPUT_STALE_MS) {
          inputs[slot] = input.value;
        }
      }
    }

    for (const slot of room.slotFires) {
      fireSlots.add(slot);
    }

    const botOccupied = new Set([...occupied, ...botBlockedSlots]);
    const botInputs = buildBotInputs(room.game.state, botOccupied);
    Object.assign(inputs, botInputs);
    const botFire = buildBotFireSlots(room.game.state, botOccupied);
    for (const slot of botFire) {
      fireSlots.add(slot);
    }
    for (const slot of room.inactiveSlots) {
      fireSlots.delete(slot);
      inputs[slot] = 0;
    }

    room.lastSnapshot = room.game.step(dt, inputs, [...fireSlots]);
    room.slotFires.clear();

    room.snapshotAccumulator += dt;
    if (room.snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
      room.serverSeq += 1;
      io.to(room.id).emit("stateSnapshot", {
        roomId: room.id,
        snapshot: room.lastSnapshot,
        sentAt: Date.now(),
        serverSeq: room.serverSeq,
      });
      room.snapshotAccumulator = 0;
    }

    const endDecision = shouldEndRoom(room);
    if (endDecision) {
      endRoom(room, endDecision.reason, endDecision.winner).catch((error) => {
        console.error("[match] endRoom failed", error);
      });
    }
  }
}
const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPath = path.join(rootDir, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get("/api/health", (_req, res) => {
  const queueSize = [...queueByBucket.values()].reduce((sum, entries) => sum + entries.length, 0);
  const queueBuckets = {};
  for (const [bucketKey, entries] of queueByBucket.entries()) {
    queueBuckets[bucketKey] = entries.length;
  }
  res.json({
    ok: true,
    queueSize,
    queueBuckets,
    pendingReady: pendingReadyById.size,
    roomCount: activeRooms.size,
    time: new Date().toISOString(),
  });
});

if (fs.existsSync(distPath)) {
  app.get("/{*rest}", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

io.on("connection", async (socket) => {
  const auth = socket.handshake.auth ?? {};
  const nicknameFromAuth = sanitizeNickname(auth?.nickname);

  let identity;
  try {
    identity = await persistence.getOrCreatePlayer({
      playerId: auth?.playerId,
      playerToken: auth?.playerToken,
      nickname: nicknameFromAuth,
    });
  } catch (error) {
    socket.emit("serverNotice", {
      message: "Error al validar tu identidad. Reintentando...",
    });
    socket.disconnect(true);
    return;
  }

  const activeSocketForPlayer = playerSocket.get(identity.player.playerId);
  if (activeSocketForPlayer && activeSocketForPlayer !== socket.id) {
    const prev = io.sockets.sockets.get(activeSocketForPlayer);
    prev?.emit("serverNotice", {
      message: "Tu cuenta se conecto desde otro cliente.",
    });
    prev?.disconnect(true);
  }
  playerSocket.set(identity.player.playerId, socket.id);

  socketState.set(socket.id, {
    socketId: socket.id,
    playerId: identity.player.playerId,
    nickname: identity.player.nickname,
    rating: identity.player.rating,
    games: identity.player.games,
    wins: identity.player.wins,
    losses: identity.player.losses,
    abandons: identity.player.abandons,
    partySize: 1,
    playlist: "ranked",
    region: "na",
    inputMode: "mixed",
    pendingReadyId: null,
    roomId: null,
    slots: [],
    reconnect: null,
    pingMs: 80,
    pingProbeTimer: null,
  });

  socket.emit("identity", {
    playerId: identity.player.playerId,
    playerToken: identity.playerToken,
    nickname: identity.player.nickname,
    rating: identity.player.rating,
    stats: {
      games: identity.player.games,
      wins: identity.player.wins,
      losses: identity.player.losses,
      abandons: identity.player.abandons,
    },
    serverTime: Date.now(),
  });

  const state = socketState.get(socket.id);
  state.pingProbeTimer = setInterval(() => {
    if (!socket.connected) {
      return;
    }
    socket.emit("pingProbe", { t: Date.now() });
  }, 8000);

  const reconnectOk = tryReconnectToRoom(socket, state, auth?.reconnect);
  if (!reconnectOk && auth?.reconnect?.roomId) {
    socket.emit("serverNotice", {
      message: "No se pudo reconectar a la partida previa.",
    });
  }

  socket.on("joinQueue", (payload) => {
    const socketStateEntry = socketState.get(socket.id);
    if (!socketStateEntry) {
      return;
    }
    if (socketStateEntry.roomId) {
      socket.emit("serverNotice", { message: "Ya estas en una partida activa." });
      return;
    }
    if (socketStateEntry.pendingReadyId) {
      socket.emit("serverNotice", { message: "Ya tienes un ready-check pendiente." });
      return;
    }
    removeQueueEntry(socket.id);
    enqueueFromSocketState(socketStateEntry, {
      ...payload,
      nickname: payload?.nickname ?? socketStateEntry.nickname,
    });
    tickQueueMatchmaking();
  });

  socket.on("leaveQueue", () => {
    const removed = removeQueueEntry(socket.id);
    if (removed?.bucketKey) {
      updateQueuePositions(removed.bucketKey);
    } else {
      updateAllQueuePositions();
    }
  });

  socket.on("readyCheckResponse", (payload) => {
    acceptReady(socket, payload);
  });

  socket.on("leaveMatch", () => {
    const currentState = socketState.get(socket.id);
    if (!currentState?.roomId) {
      return;
    }
    const room = activeRooms.get(currentState.roomId);
    if (!room) {
      currentState.roomId = null;
      currentState.slots = [];
      currentState.reconnect = null;
      return;
    }
    const member = room.members.get(currentState.playerId);
    if (!member) {
      return;
    }
    member.socketId = null;
    member.disconnectedAt = Date.now();
    member.abandoned = true;
    socket.leave(room.id);
    emitPresence(room, member, false);
    io.to(room.id).emit("playerLeft", {
      playerId: member.playerId,
      slots: member.slots,
      reason: "Jugador salio de la partida",
    });
    currentState.roomId = null;
    currentState.slots = [];
    currentState.reconnect = null;
  });

  socket.on("playerInput", (payload) => {
    registerInput(socket, payload);
  });

  socket.on("pingPong", (payload) => {
    const entry = socketState.get(socket.id);
    if (!entry) {
      return;
    }
    const sentAt = Number(payload?.t);
    if (!Number.isFinite(sentAt)) {
      return;
    }
    const rtt = clamp(Date.now() - sentAt, 1, 1000);
    entry.pingMs = Math.round(entry.pingMs * 0.7 + rtt * 0.3);
  });

  socket.on("disconnect", () => {
    const current = socketState.get(socket.id);
    if (!current) {
      return;
    }
    if (current.pingProbeTimer) {
      clearInterval(current.pingProbeTimer);
    }
    removeQueueEntry(socket.id);

    if (current.pendingReadyId) {
      const ready = pendingReadyById.get(current.pendingReadyId);
      if (ready) {
        cancelReadyCheck(ready, "Jugador desconectado durante ready-check", {
          acceptedOnly: true,
          excludePlayerId: current.playerId,
        });
      }
    }

    markMemberDisconnected(current, "Jugador desconectado");
    if (playerSocket.get(current.playerId) === socket.id) {
      playerSocket.delete(current.playerId);
    }
    socketState.delete(socket.id);
    updateAllQueuePositions();
  });
});

const queueTimer = setInterval(() => {
  tickQueueMatchmaking();
}, QUEUE_SCAN_INTERVAL_MS);

const roomTimer = setInterval(() => {
  tickRooms();
}, Math.floor(1000 / TICK_RATE));

server.listen(PORT, () => {
  console.log(`Pong Versus server listening on http://localhost:${PORT}`);
});

async function shutdown(signal) {
  console.log(`[server] shutting down due to ${signal}`);
  clearInterval(queueTimer);
  clearInterval(roomTimer);

  for (const ready of pendingReadyById.values()) {
    clearTimeout(ready.timeoutHandle);
  }
  pendingReadyById.clear();

  for (const room of activeRooms.values()) {
    await endRoom(room, "Servidor en shutdown", null);
  }

  await persistence.close().catch(() => {});
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
