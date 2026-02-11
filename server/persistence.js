import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const DEFAULT_RATING = 1000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function sanitizeNickname(value) {
  return String(value ?? "Jugador")
    .trim()
    .slice(0, 18) || "Jugador";
}

function createSessionToken() {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

function playerFromRow(row) {
  return {
    playerId: row.player_id,
    nickname: row.nickname,
    rating: Number(row.rating ?? DEFAULT_RATING),
    games: Number(row.games ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    abandons: Number(row.abandons ?? 0),
  };
}

class MemoryPersistence {
  constructor() {
    this.playersById = new Map();
    this.playerIdByTokenHash = new Map();
    this.matches = [];
  }

  async init() {}

  async close() {}

  createPlayer(nickname, tokenHash, providedPlayerId = null) {
    const playerId = providedPlayerId || `p_${randomUUID()}`;
    const now = Date.now();
    const player = {
      playerId,
      tokenHash,
      nickname,
      rating: DEFAULT_RATING,
      games: 0,
      wins: 0,
      losses: 0,
      abandons: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.playersById.set(playerId, player);
    this.playerIdByTokenHash.set(tokenHash, playerId);
    return player;
  }

  async getOrCreatePlayer({ playerId, playerToken, nickname }) {
    const cleanNickname = sanitizeNickname(nickname);
    const suppliedToken = String(playerToken ?? "").trim();
    const suppliedHash = suppliedToken ? hashToken(suppliedToken) : null;

    if (playerId && suppliedHash) {
      const player = this.playersById.get(playerId);
      if (player && player.tokenHash === suppliedHash) {
        player.nickname = cleanNickname;
        player.updatedAt = Date.now();
        return {
          player: {
            playerId: player.playerId,
            nickname: player.nickname,
            rating: player.rating,
            games: player.games,
            wins: player.wins,
            losses: player.losses,
            abandons: player.abandons,
          },
          playerToken: suppliedToken,
          created: false,
        };
      }
    }

    if (suppliedHash) {
      const tokenOwnerId = this.playerIdByTokenHash.get(suppliedHash);
      if (tokenOwnerId) {
        const player = this.playersById.get(tokenOwnerId);
        if (player) {
          player.nickname = cleanNickname;
          player.updatedAt = Date.now();
          return {
            player: {
              playerId: player.playerId,
              nickname: player.nickname,
              rating: player.rating,
              games: player.games,
              wins: player.wins,
              losses: player.losses,
              abandons: player.abandons,
            },
            playerToken: suppliedToken,
            created: false,
          };
        }
      }
    }

    const issuedToken = createSessionToken();
    const issuedHash = hashToken(issuedToken);
    const newPlayer = this.createPlayer(cleanNickname, issuedHash, playerId);
    return {
      player: {
        playerId: newPlayer.playerId,
        nickname: newPlayer.nickname,
        rating: newPlayer.rating,
        games: newPlayer.games,
        wins: newPlayer.wins,
        losses: newPlayer.losses,
        abandons: newPlayer.abandons,
      },
      playerToken: issuedToken,
      created: true,
    };
  }

  async updateNickname(playerId, nickname) {
    const player = this.playersById.get(playerId);
    if (!player) {
      return null;
    }
    player.nickname = sanitizeNickname(nickname);
    player.updatedAt = Date.now();
    return {
      playerId: player.playerId,
      nickname: player.nickname,
      rating: player.rating,
      games: player.games,
      wins: player.wins,
      losses: player.losses,
      abandons: player.abandons,
    };
  }

  async applyMatchResult(matchRecord) {
    for (const entry of matchRecord.players) {
      const player = this.playersById.get(entry.playerId);
      if (!player) {
        // Defensive fallback in case an old account was deleted externally.
        const token = createSessionToken();
        const created = this.createPlayer(
          `Jugador-${entry.playerId.slice(-4)}`,
          hashToken(token),
          entry.playerId
        );
        created.rating = entry.ratingBefore;
      }
      const target = this.playersById.get(entry.playerId);
      if (!target) {
        continue;
      }
      target.rating = clamp(Math.round(entry.ratingAfter), 100, 4000);
      target.games += 1;
      if (entry.result === "win") {
        target.wins += 1;
      } else if (entry.result === "loss") {
        target.losses += 1;
      }
      if (entry.abandoned) {
        target.abandons += 1;
      }
      target.updatedAt = Date.now();
    }

    this.matches.push({
      ...matchRecord,
      storedAt: Date.now(),
    });
  }
}

class PostgresPersistence {
  constructor(databaseUrl, logger = console) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      idleTimeoutMillis: 30000,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    this.logger = logger;
  }

  async init() {
    const schema = `
      CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        nickname TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 1000,
        games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        abandons INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        playlist TEXT NOT NULL,
        seed TEXT NOT NULL,
        team0_score INTEGER NOT NULL,
        team1_score INTEGER NOT NULL,
        winner_team INTEGER,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        duration_seconds REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
        team INTEGER NOT NULL,
        slots TEXT NOT NULL,
        rating_before INTEGER NOT NULL,
        rating_after INTEGER NOT NULL,
        result TEXT NOT NULL,
        abandoned BOOLEAN NOT NULL DEFAULT FALSE,
        reconnect_count INTEGER NOT NULL DEFAULT 0,
        party_size INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (match_id, player_id)
      );

      CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating);
      CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at DESC);
    `;
    await this.pool.query(schema);
  }

  async close() {
    await this.pool.end();
  }

  async getOrCreatePlayer({ playerId, playerToken, nickname }) {
    const cleanNickname = sanitizeNickname(nickname);
    const suppliedToken = String(playerToken ?? "").trim();
    const suppliedHash = suppliedToken ? hashToken(suppliedToken) : null;

    if (playerId && suppliedHash) {
      const byIdAndToken = await this.pool.query(
        `SELECT * FROM players WHERE player_id = $1 AND token_hash = $2 LIMIT 1`,
        [playerId, suppliedHash]
      );
      if (byIdAndToken.rows.length > 0) {
        const row = byIdAndToken.rows[0];
        if (row.nickname !== cleanNickname) {
          await this.pool.query(
            `UPDATE players SET nickname = $1, updated_at = NOW() WHERE player_id = $2`,
            [cleanNickname, row.player_id]
          );
          row.nickname = cleanNickname;
        }
        return {
          player: playerFromRow(row),
          playerToken: suppliedToken,
          created: false,
        };
      }
    }

    if (suppliedHash) {
      const byToken = await this.pool.query(
        `SELECT * FROM players WHERE token_hash = $1 LIMIT 1`,
        [suppliedHash]
      );
      if (byToken.rows.length > 0) {
        const row = byToken.rows[0];
        if (row.nickname !== cleanNickname) {
          await this.pool.query(
            `UPDATE players SET nickname = $1, updated_at = NOW() WHERE player_id = $2`,
            [cleanNickname, row.player_id]
          );
          row.nickname = cleanNickname;
        }
        return {
          player: playerFromRow(row),
          playerToken: suppliedToken,
          created: false,
        };
      }
    }

    const issuedToken = createSessionToken();
    const issuedHash = hashToken(issuedToken);
    const issuedPlayerId = playerId || `p_${randomUUID()}`;

    try {
      const inserted = await this.pool.query(
        `
          INSERT INTO players (player_id, token_hash, nickname, rating, games, wins, losses, abandons)
          VALUES ($1, $2, $3, $4, 0, 0, 0, 0)
          RETURNING *
        `,
        [issuedPlayerId, issuedHash, cleanNickname, DEFAULT_RATING]
      );
      return {
        player: playerFromRow(inserted.rows[0]),
        playerToken: issuedToken,
        created: true,
      };
    } catch (error) {
      this.logger.warn("[persistence] create player collision, retrying with new id", {
        playerId: issuedPlayerId,
        message: error?.message,
      });
      const retryPlayerId = `p_${randomUUID()}`;
      const inserted = await this.pool.query(
        `
          INSERT INTO players (player_id, token_hash, nickname, rating, games, wins, losses, abandons)
          VALUES ($1, $2, $3, $4, 0, 0, 0, 0)
          RETURNING *
        `,
        [retryPlayerId, issuedHash, cleanNickname, DEFAULT_RATING]
      );
      return {
        player: playerFromRow(inserted.rows[0]),
        playerToken: issuedToken,
        created: true,
      };
    }
  }

  async updateNickname(playerId, nickname) {
    const cleanNickname = sanitizeNickname(nickname);
    const updated = await this.pool.query(
      `
        UPDATE players
        SET nickname = $1, updated_at = NOW()
        WHERE player_id = $2
        RETURNING *
      `,
      [cleanNickname, playerId]
    );
    if (updated.rows.length === 0) {
      return null;
    }
    return playerFromRow(updated.rows[0]);
  }

  async applyMatchResult(matchRecord) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO matches (
            match_id, playlist, seed, team0_score, team1_score, winner_team,
            started_at, ended_at, duration_seconds
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          matchRecord.matchId,
          matchRecord.playlist,
          matchRecord.seed,
          matchRecord.team0Score,
          matchRecord.team1Score,
          matchRecord.winnerTeam,
          new Date(matchRecord.startedAt),
          new Date(matchRecord.endedAt),
          matchRecord.durationSeconds,
        ]
      );

      for (const player of matchRecord.players) {
        const winInc = player.result === "win" ? 1 : 0;
        const lossInc = player.result === "loss" ? 1 : 0;
        const abandonInc = player.abandoned ? 1 : 0;
        await client.query(
          `
            UPDATE players
            SET
              rating = $1,
              games = games + 1,
              wins = wins + $2,
              losses = losses + $3,
              abandons = abandons + $4,
              updated_at = NOW()
            WHERE player_id = $5
          `,
          [
            clamp(Math.round(player.ratingAfter), 100, 4000),
            winInc,
            lossInc,
            abandonInc,
            player.playerId,
          ]
        );
        await client.query(
          `
            INSERT INTO match_players (
              match_id, player_id, team, slots, rating_before, rating_after,
              result, abandoned, reconnect_count, party_size
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            matchRecord.matchId,
            player.playerId,
            player.team,
            JSON.stringify(player.slots),
            Math.round(player.ratingBefore),
            Math.round(player.ratingAfter),
            player.result,
            player.abandoned,
            player.reconnectCount,
            player.partySize,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function createPersistence({
  databaseUrl = process.env.DATABASE_URL,
  logger = console,
} = {}) {
  if (!databaseUrl) {
    logger.info("[persistence] running in memory mode (DATABASE_URL not set)");
    const memory = new MemoryPersistence();
    await memory.init();
    return memory;
  }

  const postgres = new PostgresPersistence(databaseUrl, logger);
  try {
    await postgres.init();
    logger.info("[persistence] connected to Postgres");
    return postgres;
  } catch (error) {
    logger.error("[persistence] failed to initialize Postgres, using memory fallback", {
      message: error?.message,
    });
    await postgres.close().catch(() => {});
    const memory = new MemoryPersistence();
    await memory.init();
    return memory;
  }
}

export const matchmakingDefaults = {
  defaultRating: DEFAULT_RATING,
};
