import { FIRE_BINDINGS, KEY_BINDINGS } from "./constants.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function deadzone(value, threshold = 0.16) {
  if (Math.abs(value) < threshold) {
    return 0;
  }
  return value;
}

export class InputManager {
  constructor() {
    this.pressed = new Set();
    this.localSlots = [0];
    this.fireQueue = new Set();
    this.padFireHeldByLocalIndex = new Map();

    window.addEventListener("keydown", (event) => {
      if (!this.pressed.has(event.code)) {
        this.localSlots.forEach((slot) => {
          const bindings = FIRE_BINDINGS[slot] ?? [];
          if (bindings.includes(event.code)) {
            this.fireQueue.add(slot);
          }
        });
      }
      this.pressed.add(event.code);
    });

    window.addEventListener("keyup", (event) => {
      this.pressed.delete(event.code);
    });

    window.addEventListener("blur", () => {
      this.pressed.clear();
      this.fireQueue.clear();
      this.padFireHeldByLocalIndex.clear();
    });
  }

  setLocalSlots(slots) {
    this.localSlots = [...slots];
    this.padFireHeldByLocalIndex.clear();
  }

  sample() {
    const inputs = {};
    const gamepads = navigator.getGamepads
      ? Array.from(navigator.getGamepads()).filter(Boolean)
      : [];

    this.localSlots.forEach((slot, index) => {
      const binding = KEY_BINDINGS[slot];
      const keyboardAxis =
        (this.pressed.has(binding.up) ? 1 : 0) -
        (this.pressed.has(binding.down) ? 1 : 0);

      const pad = gamepads[index];
      const rawAxis = pad ? pad.axes[1] ?? pad.axes[3] ?? 0 : 0;
      const gamepadAxis = deadzone(-rawAxis);
      const axis =
        Math.abs(gamepadAxis) > Math.abs(keyboardAxis) ? gamepadAxis : keyboardAxis;
      const padFirePressed = Boolean(pad?.buttons?.[0]?.pressed);
      const wasHeld = this.padFireHeldByLocalIndex.get(index) ?? false;
      if (padFirePressed && !wasHeld) {
        this.fireQueue.add(slot);
      }
      this.padFireHeldByLocalIndex.set(index, padFirePressed);

      inputs[slot] = clamp(axis, -1, 1);
    });

    return inputs;
  }

  consumeFireEvents() {
    const fireSlots = [...this.fireQueue];
    this.fireQueue.clear();
    return fireSlots;
  }
}
