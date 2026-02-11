import * as THREE from "three";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
  TEAM_META,
} from "./constants.js";
import { obstaclePositionAt } from "./obstacleMotion.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function disposeMesh(mesh) {
  if (mesh.geometry) {
    mesh.geometry.dispose();
  }
  if (Array.isArray(mesh.material)) {
    for (const material of mesh.material) {
      material.dispose();
    }
  } else if (mesh.material) {
    mesh.material.dispose();
  }
}

function obstacleIntegrity(obstacle) {
  const cells = obstacle.damageCells ?? [1, 1, 1, 1];
  return (cells[0] + cells[1] + cells[2] + cells[3]) / 4;
}

function obstacleRenderShape(obstacle, time, map) {
  if (obstacle.destroyed) {
    return null;
  }
  const integrity = obstacleIntegrity(obstacle);
  if (integrity <= 0.08) {
    return null;
  }

  const cells = obstacle.damageCells ?? [1, 1, 1, 1];
  const left = (cells[0] + cells[2]) / 2;
  const right = (cells[1] + cells[3]) / 2;
  const top = (cells[0] + cells[1]) / 2;
  const bottom = (cells[2] + cells[3]) / 2;
  const pulse = 1 + Math.sin(time * 2.2 + obstacle.phase) * map.pulseStrength;
  const position = obstaclePositionAt(obstacle, time, map);

  if (obstacle.shape === "circle") {
    const baseR = (obstacle.r ?? 1.8) * pulse;
    return {
      shape: "circle",
      x: position.x + (right - left) * baseR * 0.18,
      y: position.y + (top - bottom) * baseR * 0.18,
      r: Math.max(0.2, baseR * integrity),
      integrity,
    };
  }

  if (obstacle.shape === "triangle") {
    const baseR = (obstacle.r ?? 2.2) * pulse;
    return {
      shape: "triangle",
      x: position.x + (right - left) * baseR * 0.16,
      y: position.y + (top - bottom) * baseR * 0.16,
      r: Math.max(0.24, baseR * integrity),
      rot: obstacle.rot ?? 0,
      integrity,
    };
  }

  const baseW = (obstacle.w ?? 2.2) * pulse;
  const baseH = (obstacle.h ?? 5) * pulse;
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
    integrity,
  };
}

export class GameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera();
    this.camera.position.set(0, 0, 80);
    this.camera.lookAt(0, 0, 0);

    const key = new THREE.DirectionalLight("#fff8ed", 2.2);
    key.position.set(-16, 18, 42);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight("#a9deff", 1.2);
    fill.position.set(22, -8, 28);
    this.scene.add(fill);

    const ambient = new THREE.AmbientLight("#ffdcbc", 0.58);
    this.scene.add(ambient);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_WIDTH + 8, ARENA_HEIGHT + 8),
      new THREE.MeshStandardMaterial({
        color: "#f8d7a2",
        roughness: 0.88,
        metalness: 0.03,
      })
    );
    this.floor.position.z = -1.4;
    this.world.add(this.floor);

    this.centerStripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.48, ARENA_HEIGHT - 2.2),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.3 })
    );
    this.centerStripe.position.z = 0.5;
    this.world.add(this.centerStripe);

    this.borderGroup = new THREE.Group();
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: "#fff9d4",
      transparent: true,
      opacity: 0.82,
    });
    const borderThickness = 0.42;
    const topBorder = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_WIDTH + 1.8, borderThickness),
      borderMaterial.clone()
    );
    topBorder.position.set(0, ARENA_HEIGHT / 2, 0.62);
    this.borderGroup.add(topBorder);

    const bottomBorder = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_WIDTH + 1.8, borderThickness),
      borderMaterial.clone()
    );
    bottomBorder.position.set(0, -ARENA_HEIGHT / 2, 0.62);
    this.borderGroup.add(bottomBorder);

    const leftBorder = new THREE.Mesh(
      new THREE.PlaneGeometry(borderThickness, ARENA_HEIGHT + 1.2),
      borderMaterial.clone()
    );
    leftBorder.position.set(-ARENA_WIDTH / 2, 0, 0.62);
    this.borderGroup.add(leftBorder);

    const rightBorder = new THREE.Mesh(
      new THREE.PlaneGeometry(borderThickness, ARENA_HEIGHT + 1.2),
      borderMaterial.clone()
    );
    rightBorder.position.set(ARENA_WIDTH / 2, 0, 0.62);
    this.borderGroup.add(rightBorder);
    this.world.add(this.borderGroup);

    this.obstacleGroup = new THREE.Group();
    this.world.add(this.obstacleGroup);
    this.obstacleMeshes = new Map();

    this.paddleMaterial = [
      new THREE.MeshStandardMaterial({
        color: TEAM_META[0].color,
        roughness: 0.32,
        metalness: 0.22,
      }),
      new THREE.MeshStandardMaterial({
        color: TEAM_META[1].color,
        roughness: 0.32,
        metalness: 0.22,
      }),
    ];

    this.paddleGroups = [];
    for (let paddleIndex = 0; paddleIndex < 4; paddleIndex += 1) {
      const team = paddleIndex < 2 ? 0 : 1;
      const group = new THREE.Group();
      const segments = [];
      for (let seg = 0; seg < 3; seg += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(PADDLE_WIDTH, 1, 1.8),
          this.paddleMaterial[team].clone()
        );
        group.add(mesh);
        segments.push(mesh);
      }
      this.world.add(group);
      this.paddleGroups.push({ group, segments });
    }

    this.ballMeshes = new Map();
    this.ballMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.35,
      metalness: 0.1,
      emissive: "#f4e8d2",
      emissiveIntensity: 0.35,
    });

    this.projectileMeshes = new Map();

    this.powerupMesh = null;
    this.powerupMaterial = new THREE.MeshStandardMaterial({
      color: "#fff3a1",
      roughness: 0.2,
      metalness: 0.7,
      emissive: "#ffd34d",
      emissiveIntensity: 0.45,
    });

    this.shields = [
      new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, ARENA_HEIGHT - 3),
        new THREE.MeshBasicMaterial({
          color: TEAM_META[0].ui,
          transparent: true,
          opacity: 0.55,
        })
      ),
      new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, ARENA_HEIGHT - 3),
        new THREE.MeshBasicMaterial({
          color: TEAM_META[1].ui,
          transparent: true,
          opacity: 0.55,
        })
      ),
    ];
    this.shields[0].position.set(-ARENA_WIDTH / 2 + 0.72, 0, 0.3);
    this.shields[1].position.set(ARENA_WIDTH / 2 - 0.72, 0, 0.3);
    this.shields[1].rotation.y = Math.PI;
    this.world.add(this.shields[0], this.shields[1]);

    this.currentMap = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 360;
    this.renderer.setSize(width, height, false);

    const aspect = width / Math.max(height, 1);
    const halfArenaWidth = ARENA_WIDTH / 2 + 4;
    const halfArenaHeight = ARENA_HEIGHT / 2 + 5;
    const arenaAspect = halfArenaWidth / halfArenaHeight;

    if (aspect >= arenaAspect) {
      this.camera.top = halfArenaHeight;
      this.camera.bottom = -halfArenaHeight;
      this.camera.left = -halfArenaHeight * aspect;
      this.camera.right = halfArenaHeight * aspect;
    } else {
      this.camera.left = -halfArenaWidth;
      this.camera.right = halfArenaWidth;
      this.camera.top = halfArenaWidth / aspect;
      this.camera.bottom = -halfArenaWidth / aspect;
    }

    this.camera.near = 0.1;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
  }

  clearObstacles() {
    for (const mesh of this.obstacleMeshes.values()) {
      this.obstacleGroup.remove(mesh);
      disposeMesh(mesh);
    }
    this.obstacleMeshes.clear();
  }

  setMap(map) {
    if (!map) {
      return;
    }
    const isSameSeed = this.currentMap?.seed === map.seed;
    this.currentMap = map;

    if (isSameSeed) {
      return;
    }

    this.scene.background = new THREE.Color(map.biome.floorA);
    this.scene.fog = new THREE.Fog(map.biome.fog, 55, 140);
    this.floor.material.color.set(map.biome.floorB);
    this.clearObstacles();
  }
  createObstacleMesh(obstacle) {
    const shape = obstacle.shape ?? "rect";
    let geometry;
    if (shape === "circle") {
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 28);
      geometry.rotateX(Math.PI / 2);
    } else if (shape === "triangle") {
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 3);
      geometry.rotateX(Math.PI / 2);
    } else {
      geometry = new THREE.BoxGeometry(1, 1, 2.4);
    }

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: this.currentMap?.biome?.obstacle ?? "#8a6239",
        roughness: 0.48,
        metalness: 0.1,
        emissive: this.currentMap?.biome?.obstacle ?? "#8a6239",
        emissiveIntensity: 0.11,
        transparent: true,
      })
    );
    mesh.userData.shape = shape;
    mesh.userData.id = obstacle.id;
    this.obstacleGroup.add(mesh);
    return mesh;
  }

  syncObstacles(state) {
    const seen = new Set();
    for (const obstacle of state.map.obstacles ?? []) {
      const obstacleShape = obstacleRenderShape(obstacle, state.time, state.map);
      if (!obstacleShape) {
        continue;
      }
      const id = obstacle.id;
      let mesh = this.obstacleMeshes.get(id);
      if (!mesh || mesh.userData.shape !== obstacle.shape) {
        if (mesh) {
          this.obstacleGroup.remove(mesh);
          disposeMesh(mesh);
        }
        mesh = this.createObstacleMesh(obstacle);
        this.obstacleMeshes.set(id, mesh);
      }

      seen.add(id);
      const shape = mesh.userData.shape ?? "rect";
      mesh.position.set(obstacleShape.x, obstacleShape.y, 0.2);

      if (shape === "circle") {
        const diameter = obstacleShape.r * 2;
        mesh.scale.set(diameter, diameter, 1.8);
        mesh.rotation.z += 0.004;
      } else if (shape === "triangle") {
        const size = obstacleShape.r * 2;
        mesh.scale.set(size, size, 1.8);
        mesh.rotation.z =
          (obstacle.rot ?? 0) + Math.sin(state.time * 0.6 + obstacle.phase) * 0.08;
      } else {
        mesh.scale.set(obstacleShape.w, obstacleShape.h, 1);
        mesh.rotation.z = 0;
      }

      const alpha = clamp(obstacleShape.integrity * 1.2, 0.3, 1);
      mesh.material.opacity = alpha;
      mesh.material.emissiveIntensity = 0.06 + (1 - obstacleShape.integrity) * 0.2;
    }

    for (const [id, mesh] of this.obstacleMeshes) {
      if (seen.has(id)) {
        continue;
      }
      this.obstacleGroup.remove(mesh);
      disposeMesh(mesh);
      this.obstacleMeshes.delete(id);
    }
  }

  syncBalls(state) {
    const seen = new Set();
    for (const ball of state.balls) {
      let mesh = this.ballMeshes.get(ball.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(ball.radius, 18, 16),
          this.ballMaterial.clone()
        );
        this.world.add(mesh);
        this.ballMeshes.set(ball.id, mesh);
      }
      mesh.position.set(ball.x, ball.y, 1.25);
      mesh.rotation.x += 0.04;
      mesh.rotation.y += 0.03;
      seen.add(ball.id);
    }

    for (const [id, mesh] of this.ballMeshes) {
      if (seen.has(id)) {
        continue;
      }
      this.world.remove(mesh);
      disposeMesh(mesh);
      this.ballMeshes.delete(id);
    }
  }

  syncProjectiles(state) {
    const seen = new Set();
    for (const projectile of state.projectiles ?? []) {
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        const team = projectile.team ?? 0;
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1, 14, 12),
          new THREE.MeshStandardMaterial({
            color: team === 0 ? "#ff9a67" : "#79b6ff",
            roughness: 0.25,
            metalness: 0.18,
            emissive: team === 0 ? "#ff7b4d" : "#4f9eff",
            emissiveIntensity: 0.42,
          })
        );
        this.world.add(mesh);
        this.projectileMeshes.set(projectile.id, mesh);
      }
      mesh.position.set(projectile.x, projectile.y, 1.05);
      mesh.scale.setScalar(projectile.radius);
      mesh.rotation.x += 0.11;
      mesh.rotation.y += 0.07;
      seen.add(projectile.id);
    }

    for (const [id, mesh] of this.projectileMeshes) {
      if (seen.has(id)) {
        continue;
      }
      this.world.remove(mesh);
      disposeMesh(mesh);
      this.projectileMeshes.delete(id);
    }
  }

  syncPowerup(state) {
    if (!state.powerup) {
      if (this.powerupMesh) {
        this.world.remove(this.powerupMesh);
        disposeMesh(this.powerupMesh);
        this.powerupMesh = null;
      }
      return;
    }

    if (!this.powerupMesh) {
      this.powerupMesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 0),
        this.powerupMaterial.clone()
      );
      this.world.add(this.powerupMesh);
    }

    const typeColors = {
      paddle: "#ffd166",
      shield: "#7dd3ff",
      boost: "#ff7d5d",
      split: "#9ff793",
      weapon: "#ff3f4b",
      heal: "#64e79f",
      restore: "#e7f6ff",
      spawnObstacle: "#e6c2ff",
    };

    this.powerupMesh.position.set(state.powerup.x, state.powerup.y, 1.1);
    this.powerupMesh.scale.setScalar(state.powerup.radius * 0.66);
    this.powerupMesh.rotation.x += 0.018;
    this.powerupMesh.rotation.y += 0.026;
    this.powerupMesh.material.color.set(typeColors[state.powerup.type] ?? "#fff0a3");
    this.powerupMesh.material.emissive.set(typeColors[state.powerup.type] ?? "#fff0a3");
  }

  syncPaddles(state) {
    state.paddles.forEach((paddle, index) => {
      const pack = this.paddleGroups[index];
      if (!pack) {
        return;
      }
      const { group, segments } = pack;
      const respawning = paddle.respawnUntil > state.time;
      group.visible = !respawning || Math.floor(state.time * 10) % 2 === 0;
      group.position.set(paddle.x, paddle.y, 1);

      const segmentBaseHeight = paddle.height / 3;
      const maxHp = paddle.segmentMaxHp ?? 36;

      segments.forEach((segmentMesh, segIdx) => {
        const hp = paddle.segmentHp?.[segIdx] ?? maxHp;
        if (hp <= 0) {
          segmentMesh.visible = false;
          return;
        }
        segmentMesh.visible = true;
        const hpFactor = clamp(hp / maxHp, 0.18, 1);
        const segmentHeight = segmentBaseHeight * hpFactor;
        segmentMesh.scale.set(1, segmentHeight, 1);
        segmentMesh.position.set(
          0,
          -paddle.height / 2 + segmentBaseHeight * (segIdx + 0.5),
          0
        );
        segmentMesh.material.emissiveIntensity = (1 - hpFactor) * 0.35;
      });
    });
  }

  render(state) {
    if (!state) {
      return;
    }
    this.setMap(state.map);
    this.syncPaddles(state);
    this.syncObstacles(state);
    this.syncBalls(state);
    this.syncProjectiles(state);

    this.shields.forEach((mesh, team) => {
      const active = state.buffs[team].shieldUntil > state.time;
      mesh.visible = active;
      if (active) {
        mesh.material.opacity = 0.33 + Math.sin(state.time * 10) * 0.17;
      }
    });

    this.centerStripe.material.opacity = 0.22 + Math.sin(state.time * 1.8) * 0.08;
    this.borderGroup.children.forEach((border, idx) => {
      border.material.opacity = 0.68 + Math.sin(state.time * 2.2 + idx * 0.6) * 0.12;
    });

    this.syncPowerup(state);
    this.renderer.render(this.scene, this.camera);
  }
}
