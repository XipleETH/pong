import { ARENA_HEIGHT } from "./constants.js";

const EDGE_MARGIN_Y = 2.4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boundedVerticalAmplitude(obstacle, map) {
  const requestedAmplitude = Math.max(
    0,
    Number(map?.obstacleVerticalAmplitude ?? 0)
  );
  const maxY = ARENA_HEIGHT / 2 - EDGE_MARGIN_Y;
  const minY = -ARENA_HEIGHT / 2 + EDGE_MARGIN_Y;
  const maxUp = maxY - obstacle.y;
  const maxDown = obstacle.y - minY;
  const safeAmplitude = Math.max(0, Math.min(maxUp, maxDown));
  return Math.min(requestedAmplitude, safeAmplitude);
}

export function obstaclePositionAt(obstacle, time, map) {
  const verticalAmplitude = boundedVerticalAmplitude(obstacle, map);
  const verticalSpeed = Number(map?.obstacleVerticalSpeed ?? 0.7);
  const swapInterval = Math.max(0.3, Number(map?.obstacleSwapInterval ?? 6.4));
  const sidePhase = Number(obstacle.sidePhase ?? 0);
  const sideFactor = Math.cos((Math.PI / swapInterval) * time + sidePhase);
  const phaseY = Number(obstacle.motionPhase ?? obstacle.phase ?? 0);
  const yRaw =
    obstacle.y + Math.sin(time * verticalSpeed + phaseY) * verticalAmplitude;
  const minY = -ARENA_HEIGHT / 2 + EDGE_MARGIN_Y;
  const maxY = ARENA_HEIGHT / 2 - EDGE_MARGIN_Y;

  return {
    x: obstacle.x * sideFactor,
    y: clamp(yRaw, minY, maxY),
  };
}
