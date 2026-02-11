import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BALL_BASE_SPEED,
  BALL_MAX_SPEED,
  BALL_RADIUS,
  PADDLE_HEIGHT,
  PADDLE_SPEED,
  PADDLE_WIDTH,
  POWERUP_SPAWN_MAX,
  POWERUP_SPAWN_MIN,
  POWERUP_TYPES,
  SLOT_LANES,
  SLOT_SPAWN_Y,
  SLOT_TO_TEAM,
  SLOT_X,
  TEAM_META,
} from "./constants.js";
import { generateRogueMap } from "./mapGenerator.js";
import { obstaclePositionAt } from "./obstacleMotion.js";
import { hashString, mulberry32, pick, range } from "./random.js";

const EPSILON = 1e-6;
const PADDLE_SEGMENT_COUNT = 3;
const PADDLE_SEGMENT_MAX_HP = 36;
const PADDLE_RESPAWN_TIME = 3.8;
const PROJECTILE_BASE_TTL = 2.55;
const PROJECTILE_LIMIT_X = ARENA_WIDTH / 2 + 8;
const PROJECTILE_LIMIT_Y = ARENA_HEIGHT / 2 + 8;
const OBSTACLE_MIN_INTEGRITY = 0.08;
const OBSTACLE_SHAPES = ["rect", "circle", "triangle"];

const POWERUP_WEIGHT_TABLE = [
  { type: "paddle", weight: 12 },
  { type: "shield", weight: 10 },
  { type: "boost", weight: 10 },
  { type: "split", weight: 8 },
  { type: "weapon", weight: 15 },
  { type: "heal", weight: 11 },
  { type: "spawnObstacle", weight: 8 },
  { type: "restore", weight: 2 },
].filter((entry) => POWERUP_TYPES.includes(entry.type));

let ballSequence = 1;
let noticeSequence = 1;
let projectileSequence = 1;
let obstacleSequence = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBuffState() {
  return {
    paddleUntil: 0,
    shieldUntil: 0,
    boostUntil: 0,
  };
}

function createPaddle(slot) {
  return {
    slot,
    team: SLOT_TO_TEAM[slot],
    x: SLOT_X[slot],
    y: SLOT_SPAWN_Y[slot],
    width: PADDLE_WIDTH,
    height: PADDLE_HEIGHT,
    input: 0,
    segmentMaxHp: PADDLE_SEGMENT_MAX_HP,
    segmentHp: Array.from({ length: PADDLE_SEGMENT_COUNT }, () => PADDLE_SEGMENT_MAX_HP),
    respawnUntil: 0,
    fireCooldownUntil: 0,
  };
}

function circleRectIntersection(circle, rect) {
  const closestX = clamp(circle.x, rect.left, rect.right);
  const closestY = clamp(circle.y, rect.bottom, rect.top);
  const dx = circle.x - closestX;
  const dy = circle.y - closestY;
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

function obstaclePulse(obstacle, time, pulseStrength) {
  return 1 + Math.sin(time * 2.2 + obstacle.phase) * pulseStrength;
}

function obstacleIntegrity(obstacle) {
  const cells = obstacle.damageCells ?? [1, 1, 1, 1];
  return (cells[0] + cells[1] + cells[2] + cells[3]) / 4;
}

function obstacleRadiusForShape(shape) {
  if (!shape) {
    return 0;
  }
  if (shape.shape === "rect") {
    return Math.hypot(shape.w / 2, shape.h / 2);
  }
  return shape.r;
}

function obstacleShapeAt(obstacle, time, map, pulseStrength) {
  if (obstacle.destroyed) {
    return null;
  }
  const cells = obstacle.damageCells ?? [1, 1, 1, 1];
  const integrity = obstacleIntegrity(obstacle);
  if (integrity <= OBSTACLE_MIN_INTEGRITY) {
    return null;
  }

  const position = obstaclePositionAt(obstacle, time, map);
  const pulse = obstaclePulse(obstacle, time, pulseStrength);
  const left = (cells[0] + cells[2]) / 2;
  const right = (cells[1] + cells[3]) / 2;
  const top = (cells[0] + cells[1]) / 2;
  const bottom = (cells[2] + cells[3]) / 2;

  if (obstacle.shape === "circle") {
    const baseR = (obstacle.r ?? 1.8) * pulse;
    const radius = Math.max(0.2, baseR * integrity);
    return {
      shape: "circle",
      x: position.x + (right - left) * baseR * 0.18,
      y: position.y + (top - bottom) * baseR * 0.18,
      r: radius,
      integrity,
    };
  }

  if (obstacle.shape === "triangle") {
    const baseR = (obstacle.r ?? 2.2) * pulse;
    const radius = Math.max(0.24, baseR * integrity);
    return {
      shape: "triangle",
      x: position.x + (right - left) * baseR * 0.16,
      y: position.y + (top - bottom) * baseR * 0.16,
      r: radius,
      rot: obstacle.rot ?? 0,
      integrity,
    };
  }

  const baseW = (obstacle.w ?? 2.2) * pulse;
  const baseH = (obstacle.h ?? 5.0) * pulse;
  const w = Math.max(0.24, baseW * ((left + right) / 2));
  const h = Math.max(0.24, baseH * ((top + bottom) / 2));
  const x = position.x + (right - left) * baseW * 0.24;
  const y = position.y + (top - bottom) * baseH * 0.24;

  return {
    shape: "rect",
    x,
    y,
    w,
    h,
    left: x - w / 2,
    right: x + w / 2,
    bottom: y - h / 2,
    top: y + h / 2,
    integrity,
  };
}

function triangleVertices(triangle) {
  const vertices = [];
  for (let i = 0; i < 3; i += 1) {
    const angle = triangle.rot + (i * Math.PI * 2) / 3;
    vertices.push({
      x: triangle.x + Math.cos(angle) * triangle.r,
      y: triangle.y + Math.sin(angle) * triangle.r,
    });
  }
  return vertices;
}

function closestPointOnSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= EPSILON) {
    return { x: a.x, y: a.y };
  }
  const t = clamp(
    ((point.x - a.x) * abx + (point.y - a.y) * aby) / lenSq,
    0,
    1
  );
  return {
    x: a.x + abx * t,
    y: a.y + aby * t,
  };
}

function signedArea(point, a, b) {
  return (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y);
}

function pointInTriangle(point, vertices) {
  const [a, b, c] = vertices;
  const d1 = signedArea(point, a, b);
  const d2 = signedArea(point, b, c);
  const d3 = signedArea(point, c, a);
  const hasNeg = d1 < -EPSILON || d2 < -EPSILON || d3 < -EPSILON;
  const hasPos = d1 > EPSILON || d2 > EPSILON || d3 > EPSILON;
  return !(hasNeg && hasPos);
}

function normalizeOrFallback(x, y, fallbackX = 1, fallbackY = 0) {
  const len = Math.hypot(x, y);
  if (len > EPSILON) {
    return { x: x / len, y: y / len };
  }
  return { x: fallbackX, y: fallbackY };
}
function getRectCollision(point, radius, rect) {
  const closestX = clamp(point.x, rect.left, rect.right);
  const closestY = clamp(point.y, rect.bottom, rect.top);
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  const distSq = dx * dx + dy * dy;
  if (distSq > radius * radius) {
    return null;
  }

  if (distSq > EPSILON) {
    const dist = Math.sqrt(distSq);
    return {
      nx: dx / dist,
      ny: dy / dist,
      penetration: radius - dist,
    };
  }

  const toLeft = Math.abs(point.x - rect.left);
  const toRight = Math.abs(rect.right - point.x);
  const toBottom = Math.abs(point.y - rect.bottom);
  const toTop = Math.abs(rect.top - point.y);
  const minSide = Math.min(toLeft, toRight, toBottom, toTop);

  if (minSide === toLeft) {
    return { nx: -1, ny: 0, penetration: radius + toLeft };
  }
  if (minSide === toRight) {
    return { nx: 1, ny: 0, penetration: radius + toRight };
  }
  if (minSide === toBottom) {
    return { nx: 0, ny: -1, penetration: radius + toBottom };
  }
  return { nx: 0, ny: 1, penetration: radius + toTop };
}

function getCircleCollision(point, radius, obstacle) {
  const dx = point.x - obstacle.x;
  const dy = point.y - obstacle.y;
  const combinedRadius = radius + obstacle.r;
  const distSq = dx * dx + dy * dy;
  if (distSq > combinedRadius * combinedRadius) {
    return null;
  }

  const normal = normalizeOrFallback(dx, dy, 1, 0);
  const dist = Math.sqrt(Math.max(distSq, EPSILON));
  return {
    nx: normal.x,
    ny: normal.y,
    penetration: combinedRadius - dist,
  };
}

function getTriangleCollision(point, radius, obstacle) {
  const vertices = triangleVertices(obstacle);
  const edges = [
    [vertices[0], vertices[1]],
    [vertices[1], vertices[2]],
    [vertices[2], vertices[0]],
  ];

  let bestPoint = null;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestEdge = null;

  for (const [a, b] of edges) {
    const closest = closestPointOnSegment(point, a, b);
    const dx = point.x - closest.x;
    const dy = point.y - closest.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestPoint = closest;
      bestEdge = [a, b];
    }
  }

  const inside = pointInTriangle(point, vertices);
  const dist = Math.sqrt(Math.max(bestDistSq, 0));
  if (!inside && dist > radius) {
    return null;
  }

  if (!bestPoint || !bestEdge) {
    return null;
  }

  if (inside) {
    const inward = normalizeOrFallback(
      point.x - bestPoint.x,
      point.y - bestPoint.y,
      1,
      0
    );
    return {
      nx: -inward.x,
      ny: -inward.y,
      penetration: radius + dist,
    };
  }

  const outward = normalizeOrFallback(
    point.x - bestPoint.x,
    point.y - bestPoint.y,
    1,
    0
  );
  return {
    nx: outward.x,
    ny: outward.y,
    penetration: radius - dist,
  };
}

function getObstacleCollision(point, radius, obstacleShape) {
  if (!obstacleShape) {
    return null;
  }
  if (obstacleShape.shape === "circle") {
    return getCircleCollision(point, radius, obstacleShape);
  }
  if (obstacleShape.shape === "triangle") {
    return getTriangleCollision(point, radius, obstacleShape);
  }
  return getRectCollision(point, radius, obstacleShape);
}

function obstacleMaxHp(obstacle) {
  if (obstacle.shape === "rect") {
    const w = obstacle.w ?? 2.2;
    const h = obstacle.h ?? 4.8;
    return 35 + w * h * 3.2;
  }
  if (obstacle.shape === "circle") {
    const r = obstacle.r ?? 1.8;
    return 32 + r * 16;
  }
  const r = obstacle.r ?? 2.2;
  return 34 + r * 15;
}

function prepareObstacleForMatch(obstacle) {
  const maxHp = obstacleMaxHp(obstacle);
  return {
    ...obstacle,
    id: obstacle.id ?? obstacleSequence++,
    maxHp,
    hp: maxHp,
    damageCells: [1, 1, 1, 1],
    destroyed: false,
  };
}

function weaponProfile(tier) {
  if (tier >= 4) {
    return {
      projectileCount: 2,
      radius: 0.58,
      damage: 24,
      speed: 54,
      spreadY: 1.15,
      cooldown: 0.32,
    };
  }
  if (tier === 3) {
    return {
      projectileCount: 2,
      radius: 0.34,
      damage: 16,
      speed: 58,
      spreadY: 1.05,
      cooldown: 0.3,
    };
  }
  if (tier === 2) {
    return {
      projectileCount: 1,
      radius: 0.55,
      damage: 29,
      speed: 53,
      spreadY: 0,
      cooldown: 0.31,
    };
  }
  return {
    projectileCount: 1,
    radius: 0.33,
    damage: 18,
    speed: 59,
    spreadY: 0,
    cooldown: 0.26,
  };
}

function pickWeighted(rng, entries) {
  const total = entries.reduce((acc, entry) => acc + entry.weight, 0);
  if (total <= 0) {
    return entries[0]?.type ?? "boost";
  }
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.type;
    }
  }
  return entries[entries.length - 1]?.type ?? "boost";
}

export class GameCore {
  constructor(options = {}) {
    const seed = String(
      options.seed ?? `${Date.now()}-${Math.floor(Math.random() * 100000)}`
    );
    this.seed = seed;
    this.rng = mulberry32(hashString(seed));

    const rawMap = options.map ? deepClone(options.map) : generateRogueMap(seed);
    rawMap.obstacles = (rawMap.obstacles ?? []).map((obstacle) =>
      prepareObstacleForMatch(obstacle)
    );

    this.initialObstacleBlueprints = rawMap.obstacles.map((obstacle) => ({
      shape: obstacle.shape,
      x: obstacle.x,
      y: obstacle.y,
      w: obstacle.w,
      h: obstacle.h,
      r: obstacle.r,
      rot: obstacle.rot,
      phase: obstacle.phase,
      motionPhase: obstacle.motionPhase,
      sidePhase: obstacle.sidePhase,
    }));

    this.state = {
      seed,
      time: 0,
      map: rawMap,
      score: [0, 0],
      paddles: Array.from({ length: 4 }, (_, slot) => createPaddle(slot)),
      balls: [],
      projectiles: [],
      weaponTier: [1, 1],
      buffs: [createBuffState(), createBuffState()],
      powerup: null,
      notices: [],
    };
    this.powerupCooldown = range(this.rng, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
    this.spawnBall(this.rng() > 0.5 ? 1 : -1);
  }

  pushNotice(text) {
    this.state.notices.push({
      id: noticeSequence,
      t: this.state.time,
      text,
    });
    noticeSequence += 1;
    if (this.state.notices.length > 8) {
      this.state.notices.splice(0, this.state.notices.length - 8);
    }
  }

  isBuffActive(team, buffKey) {
    return this.state.buffs[team][buffKey] > this.state.time;
  }

  paddleAlive(paddle) {
    if (paddle.respawnUntil > this.state.time) {
      return false;
    }
    return paddle.segmentHp.some((hp) => hp > 0);
  }

  fullRestorePaddle(paddle, reposition = false) {
    paddle.segmentHp = Array.from(
      { length: PADDLE_SEGMENT_COUNT },
      () => paddle.segmentMaxHp
    );
    paddle.respawnUntil = 0;
    if (reposition) {
      paddle.y = SLOT_SPAWN_Y[paddle.slot];
    }
  }

  restoreAllPaddles(reposition = true) {
    for (const paddle of this.state.paddles) {
      this.fullRestorePaddle(paddle, reposition);
    }
  }

  getPaddleSegmentRects(paddle) {
    if (!this.paddleAlive(paddle)) {
      return [];
    }
    const segmentBaseHeight = paddle.height / PADDLE_SEGMENT_COUNT;
    const segmentRects = [];
    for (let index = 0; index < PADDLE_SEGMENT_COUNT; index += 1) {
      const hp = paddle.segmentHp[index] ?? 0;
      if (hp <= 0) {
        continue;
      }
      const hpFactor = clamp(hp / paddle.segmentMaxHp, 0.18, 1);
      const segmentHeight = segmentBaseHeight * hpFactor;
      const centerY =
        paddle.y - paddle.height / 2 + segmentBaseHeight * (index + 0.5);
      segmentRects.push({
        index,
        rect: {
          left: paddle.x - paddle.width / 2,
          right: paddle.x + paddle.width / 2,
          bottom: centerY - segmentHeight / 2,
          top: centerY + segmentHeight / 2,
        },
      });
    }
    return segmentRects;
  }
  spawnBall(direction, overrides = {}) {
    const angle = range(this.rng, -0.42, 0.42);
    const speed = BALL_BASE_SPEED;
    const ball = {
      id: ballSequence,
      x: 0,
      y: 0,
      vx: Math.cos(angle) * speed * Math.sign(direction || 1),
      vy: Math.sin(angle) * speed,
      radius: BALL_RADIUS,
      life: Number.POSITIVE_INFINITY,
      lastTeam: null,
      lastSlot: null,
      ...overrides,
    };
    ballSequence += 1;
    this.state.balls.push(ball);
    return ball;
  }

  spawnProjectile(slot, profile, offsetY = 0) {
    const paddle = this.state.paddles[slot];
    if (!paddle || !this.paddleAlive(paddle)) {
      return null;
    }

    const direction = paddle.team === 0 ? 1 : -1;
    const projectile = {
      id: projectileSequence,
      slot,
      team: paddle.team,
      x: paddle.x + direction * (paddle.width / 2 + 0.82),
      y: clamp(
        paddle.y + offsetY,
        -ARENA_HEIGHT / 2 + 1.4,
        ARENA_HEIGHT / 2 - 1.4
      ),
      vx: direction * profile.speed,
      vy: paddle.input * 4 + offsetY * 0.35,
      radius: profile.radius,
      damage: profile.damage,
      ttl: PROJECTILE_BASE_TTL,
    };
    projectileSequence += 1;
    this.state.projectiles.push(projectile);
    return projectile;
  }

  resetRound(scoringTeam) {
    this.state.score[scoringTeam] += 1;
    this.state.balls = [];
    this.state.projectiles = [];
    this.state.powerup = null;
    this.powerupCooldown = range(this.rng, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
    for (const paddle of this.state.paddles) {
      paddle.y = SLOT_SPAWN_Y[paddle.slot];
      paddle.input = 0;
      paddle.fireCooldownUntil = 0;
      if (!this.paddleAlive(paddle)) {
        this.fullRestorePaddle(paddle);
      }
    }
    const direction = scoringTeam === 0 ? 1 : -1;
    this.spawnBall(direction);
    this.pushNotice(`${TEAM_META[scoringTeam].name} anota`);
  }

  resolveObstacleCollision(ball, collision, speedBoost) {
    if (!collision) {
      return;
    }
    const nx = Number(collision.nx);
    const ny = Number(collision.ny);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return;
    }
    const normal = normalizeOrFallback(nx, ny, 1, 0);
    const penetration = Math.max(0, Number(collision.penetration) || 0);

    ball.x += normal.x * (penetration + 0.001);
    ball.y += normal.y * (penetration + 0.001);

    const dot = ball.vx * normal.x + ball.vy * normal.y;
    if (dot < 0) {
      ball.vx -= 2 * dot * normal.x;
      ball.vy -= 2 * dot * normal.y;

      const speed = Math.min(
        Math.hypot(ball.vx, ball.vy) * speedBoost,
        BALL_MAX_SPEED
      );
      const angle = Math.atan2(ball.vy, ball.vx);
      ball.vx = Math.cos(angle) * speed;
      ball.vy = Math.sin(angle) * speed;
      return;
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > BALL_MAX_SPEED) {
      const scale = BALL_MAX_SPEED / speed;
      ball.vx *= scale;
      ball.vy *= scale;
    }
  }

  fireCommands(fireSlots) {
    const uniqueSlots = [...new Set(fireSlots ?? [])];
    for (const slotRaw of uniqueSlots) {
      const slot = Number(slotRaw);
      if (!Number.isFinite(slot) || slot < 0 || slot > 3) {
        continue;
      }
      const paddle = this.state.paddles[slot];
      if (!paddle || !this.paddleAlive(paddle)) {
        continue;
      }
      if (paddle.fireCooldownUntil > this.state.time) {
        continue;
      }
      const activeFromSlot = this.state.projectiles.some(
        (projectile) => projectile.slot === slot
      );
      if (activeFromSlot) {
        continue;
      }

      const tier = this.state.weaponTier[paddle.team] ?? 1;
      const profile = weaponProfile(tier);
      if (profile.projectileCount === 1) {
        this.spawnProjectile(slot, profile, 0);
      } else {
        this.spawnProjectile(slot, profile, -profile.spreadY);
        this.spawnProjectile(slot, profile, profile.spreadY);
      }
      paddle.fireCooldownUntil = this.state.time + profile.cooldown;
    }
  }

  applyObstacleDamage(obstacle, damageAmount, hitPoint, obstacleShape = null) {
    if (obstacle.destroyed) {
      return;
    }
    const cells = obstacle.damageCells ?? [1, 1, 1, 1];
    const refX = obstacleShape?.x ?? obstacle.x;
    const refY = obstacleShape?.y ?? obstacle.y;
    const localX = hitPoint.x - refX;
    const localY = hitPoint.y - refY;

    const quadrant =
      localX >= 0
        ? localY >= 0
          ? 1
          : 3
        : localY >= 0
          ? 0
          : 2;
    const splashByQuadrant = [
      [1, 2],
      [0, 3],
      [0, 3],
      [1, 2],
    ];

    const hitDamage = clamp(damageAmount / Math.max(obstacle.maxHp, 1), 0.08, 0.42);
    cells[quadrant] = clamp(cells[quadrant] - hitDamage, 0, 1);
    for (const neighbor of splashByQuadrant[quadrant]) {
      cells[neighbor] = clamp(cells[neighbor] - hitDamage * 0.35, 0, 1);
    }
    obstacle.damageCells = cells;
    obstacle.hp = Math.max(0, obstacle.hp - damageAmount);

    if (obstacleIntegrity(obstacle) <= OBSTACLE_MIN_INTEGRITY || obstacle.hp <= 0) {
      obstacle.destroyed = true;
      this.pushNotice("Obstaculo destruido");
    }
  }

  applyPaddleDamage(paddle, segmentIndex, damageAmount) {
    if (!this.paddleAlive(paddle)) {
      return;
    }
    paddle.segmentHp[segmentIndex] = Math.max(
      0,
      paddle.segmentHp[segmentIndex] - damageAmount
    );
    const aliveSegments = paddle.segmentHp.some((hp) => hp > 0);
    if (!aliveSegments) {
      paddle.respawnUntil = this.state.time + PADDLE_RESPAWN_TIME;
      paddle.fireCooldownUntil = paddle.respawnUntil;
      this.pushNotice(
        `${TEAM_META[paddle.team].name} pierde a P${paddle.slot + 1}`
      );
    }
  }
  updateProjectiles(dt) {
    const map = this.state.map;
    const activeProjectiles = [];

    for (const projectile of this.state.projectiles) {
      projectile.ttl -= dt;
      if (projectile.ttl <= 0) {
        continue;
      }

      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;

      if (
        Math.abs(projectile.x) > PROJECTILE_LIMIT_X ||
        Math.abs(projectile.y) > PROJECTILE_LIMIT_Y
      ) {
        continue;
      }

      let consumed = false;
      for (const obstacle of map.obstacles) {
        if (obstacle.destroyed) {
          continue;
        }
        const obstacleShape = obstacleShapeAt(
          obstacle,
          this.state.time,
          map,
          map.pulseStrength
        );
        const collision = getObstacleCollision(
          projectile,
          projectile.radius,
          obstacleShape
        );
        if (!collision) {
          continue;
        }
        this.applyObstacleDamage(
          obstacle,
          projectile.damage,
          {
            x: projectile.x,
            y: projectile.y,
          },
          obstacleShape
        );
        consumed = true;
        break;
      }
      if (consumed) {
        continue;
      }

      for (const paddle of this.state.paddles) {
        if (paddle.team === projectile.team) {
          continue;
        }
        if (!this.paddleAlive(paddle)) {
          continue;
        }
        const segments = this.getPaddleSegmentRects(paddle);
        let hitSegment = null;
        for (const segment of segments) {
          if (circleRectIntersection(projectile, segment.rect)) {
            hitSegment = segment.index;
            break;
          }
        }
        if (hitSegment === null) {
          continue;
        }
        this.applyPaddleDamage(paddle, hitSegment, projectile.damage * 1.06);
        consumed = true;
        break;
      }
      if (consumed) {
        continue;
      }

      activeProjectiles.push(projectile);
    }

    this.state.projectiles = activeProjectiles;
  }

  updatePaddles(dt, inputBySlot) {
    for (const paddle of this.state.paddles) {
      if (paddle.respawnUntil > 0 && paddle.respawnUntil <= this.state.time) {
        this.fullRestorePaddle(paddle, true);
      }
      if (!this.paddleAlive(paddle)) {
        paddle.input = 0;
        continue;
      }

      const lane = SLOT_LANES[paddle.slot];
      const rawAxis = Number(inputBySlot[paddle.slot] ?? 0);
      const axis = Number.isFinite(rawAxis) ? clamp(rawAxis, -1, 1) : 0;
      const sizeMultiplier = this.isBuffActive(paddle.team, "paddleUntil")
        ? 1.35
        : 1;
      paddle.height = PADDLE_HEIGHT * sizeMultiplier;
      paddle.input = axis;
      paddle.y = clamp(
        paddle.y + axis * PADDLE_SPEED * dt,
        lane.min + paddle.height / 2,
        lane.max - paddle.height / 2
      );
    }
  }

  findTeamPaddleSlot(team, preferredSlot) {
    if (
      Number.isFinite(preferredSlot) &&
      this.state.paddles[preferredSlot]?.team === team
    ) {
      return preferredSlot;
    }
    const alive = this.state.paddles.find(
      (paddle) => paddle.team === team && this.paddleAlive(paddle)
    );
    if (alive) {
      return alive.slot;
    }
    return this.state.paddles.find((paddle) => paddle.team === team)?.slot ?? null;
  }

  healPaddle(slot) {
    const paddle = this.state.paddles[slot];
    if (!paddle) {
      return;
    }
    this.fullRestorePaddle(paddle, false);
  }

  spawnRuntimeObstacleDifferentShape() {
    const baseShape = this.state.map.obstacleShape;
    const options = OBSTACLE_SHAPES.filter((shape) => shape !== baseShape);
    if (options.length === 0) {
      return false;
    }
    const shape = pick(this.rng, options);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = range(this.rng, -15, 15);
      const y = range(this.rng, -10.5, 10.5);
      const candidate = {
        id: obstacleSequence++,
        shape,
        x,
        y,
        phase: range(this.rng, 0, Math.PI * 2),
        motionPhase: range(this.rng, 0, Math.PI * 2),
        sidePhase: range(this.rng, 0, Math.PI * 2),
      };

      if (shape === "rect") {
        candidate.w = range(this.rng, 1.2, 2.2);
        candidate.h = range(this.rng, 2.2, 4.1);
      } else if (shape === "circle") {
        candidate.r = range(this.rng, 0.9, 1.8);
      } else {
        candidate.r = range(this.rng, 1.1, 2.0);
        candidate.rot = range(this.rng, 0, Math.PI * 2);
      }

      const prepared = prepareObstacleForMatch(candidate);
      const shapeAtNow = obstacleShapeAt(
        prepared,
        this.state.time,
        this.state.map,
        this.state.map.pulseStrength
      );
      if (!shapeAtNow) {
        continue;
      }
      const radiusA = obstacleRadiusForShape(shapeAtNow);

      let overlap = false;
      for (const obstacle of this.state.map.obstacles) {
        if (obstacle.destroyed) {
          continue;
        }
        const obstacleNow = obstacleShapeAt(
          obstacle,
          this.state.time,
          this.state.map,
          this.state.map.pulseStrength
        );
        if (!obstacleNow) {
          continue;
        }
        const radiusB = obstacleRadiusForShape(obstacleNow);
        const distance = Math.hypot(
          shapeAtNow.x - obstacleNow.x,
          shapeAtNow.y - obstacleNow.y
        );
        if (distance < radiusA + radiusB + 1.1) {
          overlap = true;
          break;
        }
      }
      if (overlap) {
        continue;
      }
      this.state.map.obstacles.push(prepared);
      return true;
    }
    return false;
  }

  restoreScenario() {
    this.state.map.obstacles = this.initialObstacleBlueprints.map((blueprint) =>
      prepareObstacleForMatch(deepClone(blueprint))
    );
    this.state.projectiles = [];
    this.restoreAllPaddles(false);
    this.pushNotice("Escenario restaurado");
  }

  applyPowerup(team, type, sourceBall) {
    const buffs = this.state.buffs[team];
    switch (type) {
      case "paddle":
        buffs.paddleUntil = Math.max(buffs.paddleUntil, this.state.time + 10);
        this.pushNotice(`${TEAM_META[team].name} extiende paletas`);
        break;
      case "shield":
        buffs.shieldUntil = Math.max(buffs.shieldUntil, this.state.time + 7);
        this.pushNotice(`${TEAM_META[team].name} activa escudo`);
        break;
      case "boost":
        buffs.boostUntil = Math.max(buffs.boostUntil, this.state.time + 10);
        this.pushNotice(`${TEAM_META[team].name} obtiene turbo`);
        break;
      case "split":
        if (this.state.balls.length < 3) {
          const speed = Math.min(
            Math.hypot(sourceBall.vx, sourceBall.vy) * 0.95,
            BALL_MAX_SPEED * 0.9
          );
          const angle =
            Math.atan2(sourceBall.vy, sourceBall.vx) +
            (this.rng() > 0.5 ? 0.64 : -0.64);
          this.spawnBall(Math.sign(Math.cos(angle)) || 1, {
            x: sourceBall.x,
            y: sourceBall.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            radius: BALL_RADIUS * 0.92,
            life: 12,
            lastTeam: team,
            lastSlot: sourceBall.lastSlot ?? null,
          });
          this.pushNotice(`${TEAM_META[team].name} divide la pelota`);
        } else {
          buffs.boostUntil = Math.max(buffs.boostUntil, this.state.time + 8);
          this.pushNotice(`${TEAM_META[team].name} convierte split en turbo`);
        }
        break;
      case "weapon":
        this.state.weaponTier[team] = clamp(this.state.weaponTier[team] + 1, 1, 4);
        this.pushNotice(
          `${TEAM_META[team].name} mejora arma T${this.state.weaponTier[team]}`
        );
        break;
      case "heal": {
        const slot = this.findTeamPaddleSlot(team, sourceBall.lastSlot);
        if (slot !== null) {
          this.healPaddle(slot);
          this.pushNotice(`P${slot + 1} restaura vida`);
        }
        break;
      }
      case "restore":
        this.restoreScenario();
        break;
      case "spawnObstacle":
        if (this.spawnRuntimeObstacleDifferentShape()) {
          this.pushNotice(`${TEAM_META[team].name} invoca obstaculo`);
        } else {
          const slot = this.findTeamPaddleSlot(team, sourceBall.lastSlot);
          if (slot !== null) {
            this.healPaddle(slot);
          }
        }
        break;
      default:
        break;
    }
  }
  spawnPowerup() {
    const radius = 1.2;
    let x = 0;
    let y = 0;
    let valid = false;

    for (let i = 0; i < 36; i += 1) {
      x = range(this.rng, -12, 12);
      y = range(this.rng, -12, 12);
      valid = true;

      for (const obstacle of this.state.map.obstacles) {
        if (obstacle.destroyed) {
          continue;
        }
        const obstacleShape = obstacleShapeAt(
          obstacle,
          this.state.time,
          this.state.map,
          this.state.map.pulseStrength
        );
        if (getObstacleCollision({ x, y }, radius + 0.5, obstacleShape)) {
          valid = false;
          break;
        }
      }
      if (valid) {
        break;
      }
    }
    if (!valid) {
      return;
    }

    this.state.powerup = {
      type: pickWeighted(this.rng, POWERUP_WEIGHT_TABLE),
      x,
      y,
      radius,
      ttl: 14,
    };
  }

  updatePowerup(dt) {
    if (this.state.powerup) {
      this.state.powerup.ttl -= dt;
      if (this.state.powerup.ttl <= 0) {
        this.state.powerup = null;
        this.powerupCooldown = range(this.rng, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
      }
      return;
    }
    this.powerupCooldown -= dt;
    if (this.powerupCooldown <= 0) {
      this.spawnPowerup();
      this.powerupCooldown = range(this.rng, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
    }
  }

  updateBalls(dt) {
    const map = this.state.map;
    const activeBalls = [];

    for (const ball of this.state.balls) {
      if (Number.isFinite(ball.life)) {
        ball.life -= dt;
        if (ball.life <= 0) {
          continue;
        }
      }

      const windPulse = Math.sin(this.state.time * 2 + ball.id * 0.7);
      ball.vy += windPulse * map.windStrength * dt * 13;
      if (map.mutator.id === "storm") {
        ball.vx += Math.cos(this.state.time * 3.1 + ball.id) * dt * 2.1;
      }

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      const topLimit = ARENA_HEIGHT / 2 - ball.radius;
      const bottomLimit = -ARENA_HEIGHT / 2 + ball.radius;
      if (ball.y > topLimit) {
        ball.y = topLimit;
        ball.vy *= -1;
      } else if (ball.y < bottomLimit) {
        ball.y = bottomLimit;
        ball.vy *= -1;
      }

      for (const obstacle of map.obstacles) {
        const obstacleShape = obstacleShapeAt(
          obstacle,
          this.state.time,
          map,
          map.pulseStrength
        );
        if (!obstacleShape) {
          continue;
        }
        const collision = getObstacleCollision(ball, ball.radius, obstacleShape);
        if (!collision) {
          continue;
        }
        this.resolveObstacleCollision(ball, collision, map.obstacleSpeedBoost);
      }

      for (const paddle of this.state.paddles) {
        if (!this.paddleAlive(paddle)) {
          continue;
        }
        const incoming = paddle.team === 0 ? ball.vx < 0 : ball.vx > 0;
        if (!incoming) {
          continue;
        }
        const segments = this.getPaddleSegmentRects(paddle);
        let hit = false;
        for (const segment of segments) {
          if (!circleRectIntersection(ball, segment.rect)) {
            continue;
          }
          const speed = Math.min(Math.hypot(ball.vx, ball.vy) * 1.04, BALL_MAX_SPEED);
          const hitOffset = clamp((ball.y - paddle.y) / (paddle.height / 2), -1, 1);
          const towardRight = paddle.team === 0;
          ball.vx = towardRight ? speed : -speed;
          ball.vy = clamp(
            ball.vy + hitOffset * 14 + paddle.input * 5,
            -BALL_MAX_SPEED * 0.8,
            BALL_MAX_SPEED * 0.8
          );

          if (this.isBuffActive(paddle.team, "boostUntil")) {
            ball.vx *= 1.08;
            ball.vy *= 1.06;
          }

          ball.x = towardRight
            ? segment.rect.right + ball.radius
            : segment.rect.left - ball.radius;
          ball.lastTeam = paddle.team;
          ball.lastSlot = paddle.slot;
          hit = true;
          break;
        }
        if (hit) {
          break;
        }
      }

      if (this.state.powerup) {
        const dx = ball.x - this.state.powerup.x;
        const dy = ball.y - this.state.powerup.y;
        const sum = ball.radius + this.state.powerup.radius;
        if (dx * dx + dy * dy <= sum * sum) {
          const ownerTeam = ball.lastTeam ?? (ball.x < 0 ? 0 : 1);
          this.applyPowerup(ownerTeam, this.state.powerup.type, ball);
          this.state.powerup = null;
          this.powerupCooldown = range(this.rng, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX);
        }
      }

      const leftGoal = -ARENA_WIDTH / 2 - 0.9;
      const rightGoal = ARENA_WIDTH / 2 + 0.9;
      if (ball.x < leftGoal) {
        if (this.isBuffActive(0, "shieldUntil")) {
          ball.x = -ARENA_WIDTH / 2 + 1.5;
          ball.vx = Math.abs(ball.vx) * 0.92;
        } else {
          this.resetRound(1);
          return;
        }
      } else if (ball.x > rightGoal) {
        if (this.isBuffActive(1, "shieldUntil")) {
          ball.x = ARENA_WIDTH / 2 - 1.5;
          ball.vx = -Math.abs(ball.vx) * 0.92;
        } else {
          this.resetRound(0);
          return;
        }
      }

      activeBalls.push(ball);
    }

    this.state.balls = activeBalls;
    if (this.state.balls.length === 0) {
      this.spawnBall(this.rng() > 0.5 ? 1 : -1);
    }
  }

  step(dt, inputBySlot = {}, fireSlots = []) {
    const fixedDt = clamp(dt, 1 / 240, 1 / 20);
    this.state.time += fixedDt;
    this.updatePaddles(fixedDt, inputBySlot);
    this.fireCommands(fireSlots);
    this.updateProjectiles(fixedDt);
    this.updatePowerup(fixedDt);
    this.updateBalls(fixedDt);
    return this.getSerializableState();
  }

  getSerializableState() {
    return {
      seed: this.state.seed,
      time: this.state.time,
      map: {
        ...this.state.map,
        obstacles: this.state.map.obstacles.map((obstacle) => ({
          ...obstacle,
          damageCells: [...(obstacle.damageCells ?? [1, 1, 1, 1])],
        })),
      },
      score: [...this.state.score],
      paddles: this.state.paddles.map((paddle) => ({
        ...paddle,
        segmentHp: [...paddle.segmentHp],
      })),
      balls: this.state.balls.map((ball) => ({ ...ball })),
      projectiles: this.state.projectiles.map((projectile) => ({ ...projectile })),
      weaponTier: [...this.state.weaponTier],
      buffs: this.state.buffs.map((buff) => ({ ...buff })),
      powerup: this.state.powerup ? { ...this.state.powerup } : null,
      notices: this.state.notices.map((notice) => ({ ...notice })),
    };
  }

  loadSerializableState(snapshot) {
    this.state = {
      seed: snapshot.seed,
      time: snapshot.time,
      map: {
        ...snapshot.map,
        obstacles: (snapshot.map?.obstacles ?? []).map((obstacle) => ({
          ...obstacle,
          damageCells: [...(obstacle.damageCells ?? [1, 1, 1, 1])],
        })),
      },
      score: [...snapshot.score],
      paddles: snapshot.paddles.map((paddle) => ({
        ...paddle,
        segmentHp: [...(paddle.segmentHp ?? [36, 36, 36])],
      })),
      balls: snapshot.balls.map((ball) => ({ ...ball })),
      projectiles: (snapshot.projectiles ?? []).map((projectile) => ({
        ...projectile,
      })),
      weaponTier: [...(snapshot.weaponTier ?? [1, 1])],
      buffs: snapshot.buffs.map((buff) => ({ ...buff })),
      powerup: snapshot.powerup ? { ...snapshot.powerup } : null,
      notices: snapshot.notices.map((notice) => ({ ...notice })),
    };

    const maxBallId = this.state.balls.reduce(
      (acc, ball) => Math.max(acc, ball.id ?? 0),
      0
    );
    const maxProjectileId = this.state.projectiles.reduce(
      (acc, projectile) => Math.max(acc, projectile.id ?? 0),
      0
    );
    const maxObstacleId = this.state.map.obstacles.reduce(
      (acc, obstacle) => Math.max(acc, obstacle.id ?? 0),
      0
    );
    ballSequence = Math.max(ballSequence, maxBallId + 1);
    projectileSequence = Math.max(projectileSequence, maxProjectileId + 1);
    obstacleSequence = Math.max(obstacleSequence, maxObstacleId + 1);
  }
}
