import { hashString, mulberry32, pick, range } from "./random.js";
import { obstaclePositionAt } from "./obstacleMotion.js";

const BIOMES = [
  {
    id: "sunset-dunes",
    name: "Sunset Dunes",
    floorA: "#fbe7b2",
    floorB: "#f39b51",
    obstacle: "#9f5a2e",
    fog: "#ffd1a1",
    baseWind: 0.18,
    basePulse: 0.1,
  },
  {
    id: "ion-harbor",
    name: "Ion Harbor",
    floorA: "#d8f5ed",
    floorB: "#39bfa3",
    obstacle: "#1f6f64",
    fog: "#96e8da",
    baseWind: 0.1,
    basePulse: 0.18,
  },
  {
    id: "glacier-grid",
    name: "Glacier Grid",
    floorA: "#eff7ff",
    floorB: "#8fc7ff",
    obstacle: "#4b82bd",
    fog: "#c8e8ff",
    baseWind: 0.08,
    basePulse: 0.14,
  },
  {
    id: "ember-forge",
    name: "Ember Forge",
    floorA: "#ffdfcf",
    floorB: "#ff7f50",
    obstacle: "#a33624",
    fog: "#ffc6a8",
    baseWind: 0.13,
    basePulse: 0.22,
  },
];

const MUTATORS = [
  {
    id: "calm",
    name: "Calm Drift",
    windScale: 0.6,
    pulseScale: 0.8,
    obstacleSpeedBoost: 1.0,
  },
  {
    id: "storm",
    name: "Storm Current",
    windScale: 1.8,
    pulseScale: 1.0,
    obstacleSpeedBoost: 1.0,
  },
  {
    id: "pulse",
    name: "Pulse Cathedral",
    windScale: 1.0,
    pulseScale: 2.2,
    obstacleSpeedBoost: 1.05,
  },
  {
    id: "pinball",
    name: "Pinball Echo",
    windScale: 0.9,
    pulseScale: 1.25,
    obstacleSpeedBoost: 1.14,
  },
];

const MAX_PULSE_SCALE = 1.55;
const OBSTACLE_BUFFER = 1.2;
const MOTION_SAMPLE_COUNT = 240;

function pickObstacleShape(rng) {
  const roll = rng();
  if (roll < 0.46) {
    return "rect";
  }
  if (roll < 0.76) {
    return "circle";
  }
  return "triangle";
}

function createObstacle(rng, x, y, compact = false, shape = "rect") {
  const phase = range(rng, 0, Math.PI * 2);
  const motionPhase = range(rng, 0, Math.PI * 2);
  const sidePhase = range(rng, 0, Math.PI * 2);
  if (shape === "rect") {
    return {
      shape,
      x,
      y,
      w: range(rng, compact ? 0.9 : 1.1, compact ? 1.6 : 2.4),
      h: range(rng, compact ? 1.9 : 2.1, compact ? 3.8 : 5.6),
      phase,
      motionPhase,
      sidePhase,
    };
  }

  if (shape === "circle") {
    return {
      shape,
      x,
      y,
      r: range(rng, compact ? 0.7 : 0.95, compact ? 1.35 : 2.15),
      phase,
      motionPhase,
      sidePhase,
    };
  }

  return {
    shape,
    x,
    y,
    r: range(rng, compact ? 0.9 : 1.15, compact ? 1.6 : 2.35),
    rot: range(rng, 0, Math.PI * 2),
    phase,
    motionPhase,
    sidePhase,
  };
}

function obstacleBoundRadius(obstacle) {
  if (obstacle.shape === "rect") {
    return Math.hypot(obstacle.w / 2, obstacle.h / 2);
  }
  return obstacle.r;
}

function obstaclesOverlapAtTime(a, b, time, movement) {
  const motionMap = {
    obstacleVerticalAmplitude: movement.verticalAmplitude,
    obstacleVerticalSpeed: movement.verticalSpeed,
    obstacleSwapInterval: movement.sideSwapInterval,
  };
  const pa = obstaclePositionAt(a, time, motionMap);
  const pb = obstaclePositionAt(b, time, motionMap);
  const ra = obstacleBoundRadius(a) * MAX_PULSE_SCALE;
  const rb = obstacleBoundRadius(b) * MAX_PULSE_SCALE;
  const required = ra + rb + OBSTACLE_BUFFER;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) < required;
}

function obstaclesOverlap(a, b, movement) {
  const verticalPeriod = (Math.PI * 2) / Math.max(movement.verticalSpeed, 0.01);
  const sidePeriod = Math.max(0.2, movement.sideSwapInterval) * 2;
  const cycleDuration = Math.max(verticalPeriod, sidePeriod);
  for (let i = 0; i <= MOTION_SAMPLE_COUNT; i += 1) {
    const t = (cycleDuration * i) / MOTION_SAMPLE_COUNT;
    if (obstaclesOverlapAtTime(a, b, t, movement)) {
      return true;
    }
  }
  return false;
}

function canPlaceObstacle(candidate, existing, movement) {
  for (const obstacle of existing) {
    if (obstaclesOverlap(candidate, obstacle, movement)) {
      return false;
    }
  }
  return true;
}

function mirrorObstacle(obstacle) {
  const mirrored = {
    ...obstacle,
    x: -obstacle.x,
    phase: obstacle.phase + Math.PI * 0.5,
    motionPhase: (obstacle.motionPhase ?? 0) + Math.PI,
    sidePhase: obstacle.sidePhase ?? 0,
  };
  if (mirrored.shape === "triangle") {
    mirrored.rot = Math.PI - mirrored.rot;
  }
  return mirrored;
}

function placeSideObstacle(rng) {
  let x = range(rng, 5, 16);
  let y = range(rng, -11.5, 11.5);
  if (Math.abs(y) < 2.4 && x < 9) {
    x += 3.5;
    y += Math.sign(y || 1) * 3;
  }
  return { x, y };
}

export function generateRogueMap(seed) {
  const normalizedSeed = String(seed ?? Date.now());
  const rng = mulberry32(hashString(normalizedSeed));

  const biome = pick(rng, BIOMES);
  const mutator = pick(rng, MUTATORS);
  const mapObstacleShape = pickObstacleShape(rng);
  const sideSwapInterval = range(rng, 3.0, 4.7);
  const baseVerticalCycles = Math.floor(range(rng, 2, 6));
  const cycleSpeedFactor = 0.9 + mutator.obstacleSpeedBoost * 0.15;
  const tunedVerticalCycles = Math.max(
    2,
    Math.min(7, Math.round(baseVerticalCycles * cycleSpeedFactor))
  );
  const movement = {
    verticalAmplitude: range(rng, 2.8, 5.6),
    verticalSpeed: (Math.PI * tunedVerticalCycles) / sideSwapInterval,
    sideSwapInterval,
  };
  const obstacles = [];

  for (let i = 0; i < 5; i += 1) {
    let placed = false;
    for (let attempt = 0; attempt < 160 && !placed; attempt += 1) {
      const { x, y } = placeSideObstacle(rng);
      const compact = attempt > 80;
      const obstacle = createObstacle(rng, x, y, compact, mapObstacleShape);
      const mirrored = mirrorObstacle(obstacle);
      if (!canPlaceObstacle(obstacle, obstacles, movement)) {
        continue;
      }
      if (!canPlaceObstacle(mirrored, obstacles, movement)) {
        continue;
      }
      if (obstaclesOverlap(obstacle, mirrored, movement)) {
        continue;
      }
      obstacles.push(obstacle, mirrored);
      placed = true;
    }
  }

  if (rng() > 0.45) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const centerObstacle = createObstacle(
        rng,
        0,
        range(rng, -7, 7),
        true,
        mapObstacleShape
      );
      if (!canPlaceObstacle(centerObstacle, obstacles, movement)) {
        continue;
      }
      obstacles.push(centerObstacle);
      break;
    }
  }
  return {
    seed: normalizedSeed,
    biome,
    mutator,
    obstacleShape: mapObstacleShape,
    obstacles,
    obstacleVerticalAmplitude: movement.verticalAmplitude,
    obstacleVerticalSpeed: movement.verticalSpeed,
    obstacleSwapInterval: movement.sideSwapInterval,
    windStrength: biome.baseWind * mutator.windScale,
    pulseStrength: biome.basePulse * mutator.pulseScale,
    obstacleSpeedBoost: mutator.obstacleSpeedBoost,
  };
}
