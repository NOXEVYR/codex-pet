export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;
export const ATLAS_COLUMNS = 8;

export const ATLAS_FORMATS = Object.freeze([
  Object.freeze({ version: "v1", width: 1536, height: 1872, rows: 9 }),
  Object.freeze({ version: "v2", width: 1536, height: 2288, rows: 11 }),
]);

export const HOST_IDLE_MS = Object.freeze([1680, 660, 660, 840, 840, 1920]);
export const OLD_PREVIEW_IDLE_MS = Object.freeze([280, 110, 110, 140, 140, 320]);

// Rows and frame counts follow the Dot-compatible sprite sheet layout.
export const SEQUENCES = Object.freeze({
  idle: Object.freeze({ label: "待机", row: 0, durations: HOST_IDLE_MS, loop: true, dot: true }),
  right: Object.freeze({ label: "向右", row: 1, durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]), loop: true, dot: false }),
  left: Object.freeze({ label: "向左", row: 2, durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]), loop: true, dot: false }),
  waving: Object.freeze({ label: "挥手", row: 3, durations: Object.freeze([140, 140, 140, 280]), loop: true, dot: false }),
  jump: Object.freeze({ label: "跳跃", row: 4, durations: Object.freeze([140, 140, 140, 140, 280]), loop: true, dot: false }),
  failed: Object.freeze({ label: "失败", row: 5, durations: Object.freeze([140, 140, 140, 140, 140, 140, 140, 240]), loop: true, dot: false }),
  waiting: Object.freeze({ label: "等待", row: 6, durations: Object.freeze([150, 150, 150, 150, 150, 260]), loop: true, dot: false }),
  work: Object.freeze({ label: "工作中", row: 7, durations: Object.freeze([120, 120, 120, 120, 120, 220]), loop: true, dot: true }),
  review: Object.freeze({ label: "审阅", row: 8, durations: Object.freeze([150, 150, 150, 150, 150, 280]), loop: true, dot: false }),
});

const GAZE_ANGLES = Object.freeze(Array.from({ length: 16 }, (_, index) => index * 22.5));

export function validateAtlasDimensions(width, height) {
  const format = ATLAS_FORMATS.find((candidate) => candidate.width === width && candidate.height === height);
  if (!format) {
    throw new RangeError(`图集尺寸必须是 1536×1872（v1）或 1536×2288（v2）；当前为 ${width}×${height}。`);
  }
  return format;
}

export function getSequence(state) {
  const sequence = SEQUENCES[state];
  if (!sequence) throw new RangeError(`未知动画状态：${state}`);
  return sequence;
}

export function getDurations(state, profile = "hostDot") {
  const sequence = getSequence(state);
  if (profile === "hostDot") return sequence.durations;
  if (profile === "oldPreview" && state === "idle") return OLD_PREVIEW_IDLE_MS;
  throw new RangeError(`没有 ${state} 的 ${profile} 时序参考。`);
}

export function sequenceDuration(state, profile = "hostDot") {
  return getDurations(state, profile).reduce((sum, duration) => sum + duration, 0);
}

export function getFrameCell(state, frameIndex, atlasRows) {
  const sequence = getSequence(state);
  if (!Number.isInteger(atlasRows) || atlasRows < 1) throw new RangeError("图集行数无效。");
  if (sequence.row >= atlasRows) throw new RangeError(`${sequence.label} 需要第 ${sequence.row} 行；当前图集只有 ${atlasRows} 行。`);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= sequence.durations.length) {
    throw new RangeError(`${sequence.label} 的帧号必须在 0 到 ${sequence.durations.length - 1} 之间。`);
  }
  return Object.freeze({ row: sequence.row, column: frameIndex, x: frameIndex * CELL_WIDTH, y: sequence.row * CELL_HEIGHT });
}

export function getGazeCell(angleDegrees, atlasRows) {
  if (atlasRows < 11) throw new RangeError("视线方向格需要 v2 图集的第 9、10 行。");
  if (!Number.isFinite(angleDegrees)) throw new TypeError("方向角必须是有限数字。");
  const normalized = ((angleDegrees % 360) + 360) % 360;
  const directionIndex = Math.round(normalized / 22.5) % 16;
  const row = 9 + Math.floor(directionIndex / ATLAS_COLUMNS);
  const column = directionIndex % ATLAS_COLUMNS;
  return Object.freeze({
    angle: GAZE_ANGLES[directionIndex],
    directionIndex,
    row,
    column,
    x: column * CELL_WIDTH,
    y: row * CELL_HEIGHT,
  });
}

export function canUseGaze(state, atlasRows) {
  return state === "idle" && atlasRows === 11;
}

export function pointerAngleDegrees(clientX, clientY, bounds) {
  const dx = clientX - (bounds.left + bounds.width / 2);
  const dy = clientY - (bounds.top + bounds.height / 2);
  if (dx === 0 && dy === 0) return 0;
  const angle = Math.atan2(dx, -dy) * 180 / Math.PI;
  return (angle + 360) % 360;
}

export class LoadGeneration {
  constructor() {
    this.current = 0;
  }

  begin() {
    this.current += 1;
    return this.current;
  }

  isCurrent(generation) {
    return generation === this.current;
  }
}

/** Drives any number of playback clocks with one chained timeout. */
export class PlaybackScheduler {
  constructor({ getClocks, now, setTimeoutFn, clearTimeoutFn, onFrame = () => {} }) {
    this.getClocks = getClocks;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onFrame = onFrame;
    this.timer = null;
    this.generation = 0;
  }

  cancel() {
    this.generation += 1;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  schedule() {
    this.cancel();
    const now = this.now();
    const activeClocks = this.getClocks().filter((clock) => clock?.running && !clock.gaze);
    if (activeClocks.length === 0) return false;

    const earliestDeadline = Math.min(...activeClocks.map((clock) => clock.deadline));
    const dueClocks = activeClocks.filter((clock) => clock.deadline === earliestDeadline);
    const delay = Math.max(0, earliestDeadline - now);
    const scheduledGeneration = this.generation;
    this.timer = this.setTimeoutFn(() => {
      if (scheduledGeneration !== this.generation) return;
      this.timer = null;
      const callbackNow = this.now();
      for (const clock of dueClocks) {
        if (clock?.running && !clock.gaze && callbackNow >= clock.deadline) clock.tick(callbackNow);
      }
      this.onFrame(callbackNow);
      this.schedule();
    }, delay);
    return true;
  }
}

/**
 * A deterministic playback clock. Pass timestamps from any clock, including a
 * fake clock in tests. Like the host effect, a late callback advances once and
 * starts the next dwell at callback time rather than catching up missed frames.
 */
export class PlaybackClock {
  constructor({ state = "idle", profile = "hostDot", now = 0, loop } = {}) {
    this.setSequence(state, profile, now, loop);
  }

  setSequence(state, profile = "hostDot", now = 0, loop) {
    const sequence = getSequence(state);
    this.state = state;
    this.profile = profile;
    this.durations = getDurations(state, profile);
    this.loop = loop ?? sequence.loop;
    this.index = 0;
    this.running = true;
    this.deadline = now + this.durations[0];
    this.remaining = this.durations[0];
    this.gaze = null;
    this.restore = null;
    return this.snapshot(now);
  }

  tick(now) {
    if (!Number.isFinite(now)) throw new TypeError("时间戳必须是有限数字。");
    if (this.running && !this.gaze) {
      if (now >= this.deadline) {
        const nextIndex = this.index + 1;
        if (nextIndex >= this.durations.length) {
          if (!this.loop) {
            this.index = this.durations.length - 1;
            this.running = false;
            this.remaining = 0;
            this.deadline = Number.POSITIVE_INFINITY;
          } else {
            this.index = 0;
          }
        } else {
          this.index = nextIndex;
        }
        if (this.running) {
          this.remaining = this.durations[this.index];
          this.deadline = now + this.remaining;
        }
      }
      if (this.running) {
        this.remaining = Math.max(0, this.deadline - now);
      }
    }
    return this.snapshot(now);
  }

  pause(now) {
    this.tick(now);
    if (this.running && !this.gaze) {
      this.remaining = Math.max(0, this.deadline - now);
      this.running = false;
    }
    return this.snapshot(now);
  }

  resume(now) {
    if (!this.gaze && !this.running) {
      if (!this.loop && this.remaining <= 0) {
        this.index = 0;
        this.remaining = this.durations[0];
      }
      this.deadline = now + this.remaining;
      this.running = true;
    }
    return this.snapshot(now);
  }

  step(delta, now) {
    if (!Number.isInteger(delta) || delta === 0) throw new RangeError("逐帧步进值必须是非零整数。");
    this.tick(now);
    if (this.gaze) return this.snapshot(now);
    this.running = false;
    this.index = ((this.index + delta) % this.durations.length + this.durations.length) % this.durations.length;
    this.remaining = this.durations[this.index];
    this.deadline = Number.POSITIVE_INFINITY;
    return this.snapshot(now);
  }

  reset(now) {
    return this.restart(now, true);
  }

  restart(now, running = this.running) {
    this.index = 0;
    this.running = Boolean(running);
    this.remaining = this.durations[0];
    this.deadline = this.running ? now + this.remaining : Number.POSITIVE_INFINITY;
    this.gaze = null;
    this.restore = null;
    return this.snapshot(now);
  }

  setGaze(angleDegrees, atlasRows, now) {
    if (this.state !== "idle") throw new RangeError("视线覆盖只用于待机状态。");
    const cell = getGazeCell(angleDegrees, atlasRows);
    if (!this.gaze) {
      this.restore = { running: this.running };
    }
    this.gaze = cell;
    this.running = false;
    return this.snapshot(now);
  }

  clearGaze(now) {
    if (this.gaze) {
      this.gaze = null;
      this.index = 0;
      this.remaining = this.durations[0];
      this.running = this.restore?.running ?? true;
      this.deadline = this.running ? now + this.remaining : Number.POSITIVE_INFINITY;
      this.restore = null;
    }
    return this.snapshot(now);
  }

  setLoop(loop, now) {
    if (!Number.isFinite(now)) throw new TypeError("重启时间戳必须是有限数字。");
    const wasRunning = this.running;
    this.loop = Boolean(loop);
    this.restart(now, wasRunning);
    return this;
  }

  snapshot(now) {
    return Object.freeze({
      state: this.state,
      profile: this.profile,
      index: this.index,
      frameCount: this.durations.length,
      durationMs: this.gaze ? null : this.durations[this.index],
      remainingMs: this.gaze ? null : this.running ? Math.max(0, this.deadline - now) : this.remaining,
      running: this.running,
      completed: !this.running && !this.gaze && !this.loop && this.remaining === 0,
      loop: this.loop,
      gaze: this.gaze,
      cell: this.gaze ?? getFrameCell(this.state, this.index, 11),
    });
  }
}
