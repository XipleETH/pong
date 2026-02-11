import { ARENA_HEIGHT, SLOT_LANES, SLOT_TO_TEAM } from "./constants.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function reflectIntoRange(value, min, max) {
  const span = max - min;
  if (span <= 0) {
    return value;
  }
  let normalized = (value - min) % (span * 2);
  if (normalized < 0) {
    normalized += span * 2;
  }
  if (normalized <= span) {
    return min + normalized;
  }
  return max - (normalized - span);
}

function movementBounds(paddle, lane) {
  return {
    min: lane.min + paddle.height / 2,
    max: lane.max - paddle.height / 2,
  };
}

function buildSegmentProfile(paddle) {
  const segmentHp = paddle.segmentHp ?? [];
  const segmentMaxHp = paddle.segmentMaxHp ?? 36;
  const segmentBaseHeight = paddle.height / 3;
  const segments = [];

  for (let index = 0; index < 3; index += 1) {
    const hp = segmentHp[index] ?? segmentMaxHp;
    if (hp <= 0) {
      continue;
    }
    const hpFactor = clamp(hp / segmentMaxHp, 0.18, 1);
    const centerOffset = -paddle.height / 2 + segmentBaseHeight * (index + 0.5);
    segments.push({
      index,
      centerOffset,
      height: segmentBaseHeight * hpFactor,
    });
  }

  if (segments.length === 0) {
    return null;
  }

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    const bottom = paddle.y + segment.centerOffset - segment.height / 2;
    const top = paddle.y + segment.centerOffset + segment.height / 2;
    minY = Math.min(minY, bottom);
    maxY = Math.max(maxY, top);
  }

  return {
    segments,
    activeSpan: Math.max(0.2, maxY - minY),
    activeCenter: (minY + maxY) / 2,
  };
}

function choosePaddleCenterForTarget(paddle, lane, profile, targetY) {
  const bounds = movementBounds(paddle, lane);
  let best = paddle.y;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const segment of profile.segments) {
    const candidate = clamp(targetY - segment.centerOffset, bounds.min, bounds.max);
    const score = Math.abs(candidate - paddle.y);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function predictBallAtPaddle(ball, paddleX) {
  if (Math.abs(ball.vx) < 0.01) {
    return { y: ball.y, time: Number.POSITIVE_INFINITY };
  }
  const time = (paddleX - ball.x) / ball.vx;
  if (time < 0) {
    return { y: ball.y, time: Number.POSITIVE_INFINITY };
  }
  const minY = -ARENA_HEIGHT / 2 + 1.2;
  const maxY = ARENA_HEIGHT / 2 - 1.2;
  const projectedY = reflectIntoRange(ball.y + ball.vy * time, minY, maxY);
  return { y: projectedY, time };
}

function chooseTargetBall(slot, state, paddle) {
  const team = SLOT_TO_TEAM[slot];
  const incoming = (state.balls ?? []).filter((ball) =>
    team === 0 ? ball.vx < 0 : ball.vx > 0
  );
  const pool = incoming.length > 0 ? incoming : state.balls ?? [];
  if (pool.length === 0) {
    return null;
  }

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const ball of pool) {
    const projection = predictBallAtPaddle(ball, paddle.x);
    const incomingBias = team === 0 ? (ball.vx < 0 ? 0 : 4.2) : ball.vx > 0 ? 0 : 4.2;
    const score =
      incomingBias +
      projection.time * 2.7 +
      Math.abs(projection.y - paddle.y) * 0.16 +
      Math.abs(ball.x - paddle.x) * 0.06;
    if (score < bestScore) {
      bestScore = score;
      best = { ball, projection };
    }
  }
  return best;
}

function pickProjectileThreat(slot, state, paddle, lane, profile) {
  const team = SLOT_TO_TEAM[slot];
  const projectiles = state.projectiles ?? [];
  let bestThreat = null;
  let bestScore = 0;

  for (const projectile of projectiles) {
    if (projectile.team === team) {
      continue;
    }
    const towardPaddle = team === 0 ? projectile.vx < -1 : projectile.vx > 1;
    if (!towardPaddle) {
      continue;
    }
    const time = (paddle.x - projectile.x) / projectile.vx;
    if (!Number.isFinite(time) || time < 0 || time > 0.82) {
      continue;
    }

    const predictedY = projectile.y + projectile.vy * time;
    if (predictedY < lane.min - 2 || predictedY > lane.max + 2) {
      continue;
    }

    const hitWindow = profile.activeSpan * 0.5 + (projectile.radius ?? 0.4) + 0.55;
    const distance = Math.abs(predictedY - profile.activeCenter);
    if (distance > hitWindow + 1.4) {
      continue;
    }

    const score =
      (1 - time / 0.82) * 0.72 +
      clamp((hitWindow - distance) / Math.max(hitWindow, 0.15), -0.2, 1.3) * 0.65;
    if (score > bestScore) {
      bestScore = score;
      bestThreat = {
        time,
        predictedY,
        score,
      };
    }
  }

  return bestThreat;
}

function computeBotAxis(slot, state) {
  const lane = SLOT_LANES[slot];
  const paddle = state.paddles[slot];
  if (!paddle) {
    return 0;
  }
  if ((paddle.respawnUntil ?? 0) > state.time) {
    return 0;
  }

  const profile = buildSegmentProfile(paddle);
  if (!profile) {
    return 0;
  }

  const ballTarget = chooseTargetBall(slot, state, paddle);
  const projectileThreat = pickProjectileThreat(slot, state, paddle, lane, profile);

  let desiredY = paddle.y;
  let ballTargetY = null;
  let ballTime = Number.POSITIVE_INFINITY;
  if (ballTarget) {
    ballTargetY = choosePaddleCenterForTarget(
      paddle,
      lane,
      profile,
      ballTarget.projection.y
    );
    ballTime = ballTarget.projection.time;
    desiredY = ballTargetY;
  }

  if (projectileThreat) {
    let direction = profile.activeCenter <= projectileThreat.predictedY ? -1 : 1;
    if (Math.abs(profile.activeCenter - projectileThreat.predictedY) < 0.18) {
      direction = projectileThreat.predictedY > 0 ? -1 : 1;
    }
    const dodgeDistance = profile.activeSpan * 0.82 + 1.3;
    const safeY = clamp(
      projectileThreat.predictedY + direction * dodgeDistance,
      lane.min + 0.9,
      lane.max - 0.9
    );
    const dodgeY = choosePaddleCenterForTarget(paddle, lane, profile, safeY);

    if (!ballTarget) {
      desiredY = dodgeY;
    } else {
      const imminentBall = ballTime < 0.78;
      const emergency = projectileThreat.time < 0.2 && Math.abs(ballTargetY - paddle.y) < 1.2;
      const ballDelta = ballTargetY - paddle.y;
      const dodgeDelta = dodgeY - paddle.y;
      const oppositeDirections = ballDelta * dodgeDelta < 0;
      const projectileArrivesFirst = projectileThreat.time + 0.08 < ballTime;
      let dodgeWeight = emergency ? 0.34 : imminentBall ? 0.2 : 0.46;

      // Keep ball contact as the priority when both goals conflict.
      if (imminentBall && oppositeDirections && !projectileArrivesFirst) {
        dodgeWeight = emergency ? 0.14 : 0.1;
      } else if (imminentBall && !projectileArrivesFirst) {
        dodgeWeight = Math.min(dodgeWeight, 0.18);
      }
      desiredY = ballTargetY * (1 - dodgeWeight) + dodgeY * dodgeWeight;
      if (
        imminentBall &&
        oppositeDirections &&
        !projectileArrivesFirst &&
        (desiredY - paddle.y) * ballDelta < 0
      ) {
        desiredY = paddle.y + ballDelta * 0.82;
      }
    }
  }

  const delta = desiredY - paddle.y;
  if (Math.abs(delta) < 0.34) {
    return 0;
  }
  return clamp(delta / 2.8, -1, 1);
}

export function buildBotInputs(state, occupiedSlots) {
  const inputs = {};
  for (let slot = 0; slot < 4; slot += 1) {
    if (occupiedSlots.has(slot)) {
      continue;
    }
    inputs[slot] = computeBotAxis(slot, state);
  }
  return inputs;
}

export function buildBotFireSlots(state, occupiedSlots) {
  const fireSlots = [];
  for (let slot = 0; slot < 4; slot += 1) {
    if (occupiedSlots.has(slot)) {
      continue;
    }
    const paddle = state.paddles[slot];
    if (!paddle) {
      continue;
    }
    if ((paddle.respawnUntil ?? 0) > state.time) {
      continue;
    }
    const profile = buildSegmentProfile(paddle);
    if (!profile) {
      continue;
    }
    const team = SLOT_TO_TEAM[slot];
    const candidate = state.balls.find((ball) =>
      team === 0 ? ball.vx > 0 : ball.vx < 0
    );
    if (!candidate) {
      continue;
    }
    const projected = predictBallAtPaddle(candidate, paddle.x);
    const aligned =
      Math.abs(projected.y - profile.activeCenter) <
      Math.max(1.15, profile.activeSpan * 0.45);
    if (!aligned) {
      continue;
    }
    const threat = pickProjectileThreat(slot, state, paddle, SLOT_LANES[slot], profile);
    if (threat && threat.time < 0.24) {
      continue;
    }
    const rhythm = Math.floor(state.time * 3.2 + slot * 0.9) % 7 === 0;
    if (rhythm) {
      fireSlots.push(slot);
    }
  }
  return fireSlots;
}
