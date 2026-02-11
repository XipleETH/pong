export const ARENA_WIDTH = 64;
export const ARENA_HEIGHT = 36;

export const PADDLE_WIDTH = 1.4;
export const PADDLE_HEIGHT = 6.8;
export const PADDLE_SPEED = 29;

export const BALL_RADIUS = 0.85;
export const BALL_BASE_SPEED = 20;
export const BALL_MAX_SPEED = 45;

export const POWERUP_SPAWN_MIN = 5;
export const POWERUP_SPAWN_MAX = 9;

export const TEAM_META = [
  { id: 0, name: "EMBER", color: "#ff6a3d", ui: "#ff855f" },
  { id: 1, name: "AZURE", color: "#2e87ff", ui: "#58a5ff" },
];

export const SLOT_TO_TEAM = [0, 0, 1, 1];

const LANE_INSET = 2.6;
const FULL_ZONE = {
  min: -ARENA_HEIGHT / 2 + LANE_INSET,
  max: ARENA_HEIGHT / 2 - LANE_INSET,
};

export const SLOT_LANES = [FULL_ZONE, FULL_ZONE, FULL_ZONE, FULL_ZONE];

export const SLOT_X = [
  -ARENA_WIDTH / 2 + 2.4,
  -ARENA_WIDTH / 2 + 2.4,
  ARENA_WIDTH / 2 - 2.4,
  ARENA_WIDTH / 2 - 2.4,
];

export const SLOT_SPAWN_Y = [
  -ARENA_HEIGHT * 0.22,
  ARENA_HEIGHT * 0.22,
  -ARENA_HEIGHT * 0.22,
  ARENA_HEIGHT * 0.22,
];

export const POWERUP_TYPES = [
  "paddle",
  "shield",
  "boost",
  "split",
  "weapon",
  "heal",
  "restore",
  "spawnObstacle",
];

export const KEY_BINDINGS = [
  { up: "KeyW", down: "KeyS" },
  { up: "ArrowUp", down: "ArrowDown" },
  { up: "KeyT", down: "KeyG" },
  { up: "KeyI", down: "KeyK" },
];

export const FIRE_BINDINGS = [
  ["KeyD"],
  ["KeyL", "Numpad0"],
  ["KeyH"],
  ["KeyO"],
];
