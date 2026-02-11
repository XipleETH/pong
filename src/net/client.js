import { io } from "socket.io-client";

const IDENTITY_KEY = "pv.identity.v1";
const RECONNECT_KEY = "pv.reconnect.v1";

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class MatchClient {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.identity = safeParse(localStorage.getItem(IDENTITY_KEY), null);
    this.reconnect = safeParse(localStorage.getItem(RECONNECT_KEY), null);
  }

  get socketId() {
    return this.socket?.id ?? null;
  }

  get profile() {
    return this.identity;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }

  emitLocal(event, payload) {
    const callbacks = this.handlers.get(event) ?? [];
    for (const callback of callbacks) {
      callback(payload);
    }
  }

  async connect() {
    const auth = {
      playerId: this.identity?.playerId ?? null,
      playerToken: this.identity?.playerToken ?? null,
      nickname: this.identity?.nickname ?? "Jugador",
      reconnect: this.reconnect ?? null,
    };

    if (this.socket) {
      if (this.socket.connected) {
        return;
      }
      this.socket.auth = auth;
      this.socket.connect();
      return;
    }

    const baseUrl = import.meta.env.VITE_SERVER_URL || undefined;
    this.socket = io(baseUrl, {
      transports: ["websocket"],
      path: "/socket.io",
      auth,
    });

    const events = [
      "connect",
      "disconnect",
      "identity",
      "readyCheck",
      "readyUpdate",
      "readyCancelled",
      "queueUpdate",
      "queued",
      "matchFound",
      "matchRejoined",
      "stateSnapshot",
      "playerInput",
      "playerLeft",
      "playerPresence",
      "matchEnded",
      "serverNotice",
      "pingProbe",
    ];

    events.forEach((event) => {
      this.socket.on(event, (payload) => {
        if (event === "identity") {
          this.identity = {
            playerId: payload?.playerId,
            playerToken: payload?.playerToken,
            nickname: payload?.nickname,
            rating: payload?.rating,
            stats: payload?.stats,
          };
          localStorage.setItem(IDENTITY_KEY, JSON.stringify(this.identity));
        } else if (event === "pingProbe") {
          this.socket?.emit("pingPong", { t: payload?.t ?? Date.now() });
        }
        this.emitLocal(event, payload);
      });
    });

    await new Promise((resolve) => {
      if (this.socket.connected) {
        resolve();
        return;
      }
      this.socket.once("connect", () => resolve());
    });
  }

  queueForMatch({ nickname, partySize }) {
    this.socket?.emit("joinQueue", {
      nickname,
      partySize,
      playlist: "ranked",
      region: "na",
      inputMode: "mixed",
      maxPingMs: 220,
    });
  }

  leaveQueue() {
    this.socket?.emit("leaveQueue");
  }

  leaveMatch(roomId) {
    this.socket?.emit("leaveMatch", { roomId });
  }

  respondReady(matchId, accept = true) {
    this.socket?.emit("readyCheckResponse", {
      matchId,
      accept,
    });
  }

  sendInput(roomId, inputs) {
    this.socket?.emit("playerInput", { roomId, inputs });
  }

  rememberReconnect(roomId, token) {
    if (!roomId || !token) {
      return;
    }
    this.reconnect = { roomId, token };
    localStorage.setItem(RECONNECT_KEY, JSON.stringify(this.reconnect));
  }

  clearReconnect() {
    this.reconnect = null;
    localStorage.removeItem(RECONNECT_KEY);
  }
}
