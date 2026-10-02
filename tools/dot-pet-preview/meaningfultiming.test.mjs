import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LoadGeneration,
  PlaybackClock,
  PlaybackScheduler,
  canUseGaze,
  getFrameCell,
  getGazeCell,
  pointerAngleDegrees,
  sequenceDuration,
  validateAtlasDimensions,
} from "./timing.mjs";

function createFakeTimeoutHost() {
  let now = 0;
  let nextId = 1;
  let maximumPending = 0;
  const pending = new Map();
  return {
    get now() { return now; },
    get pendingCount() { return pending.size; },
    get maximumPending() { return maximumPending; },
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, due: now + delay });
      maximumPending = Math.max(maximumPending, pending.size);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fireNext(at = null) {
      const [id, timer] = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
      if (id === undefined) throw new Error("No timeout is pending.");
      pending.delete(id);
      now = Math.max(now, at ?? timer.due);
      timer.callback();
      return timer.due;
    },
  };
}

test("uses exact boundaries and advances only one frame after a late callback", () => {
  const clock = new PlaybackClock({ state: "idle", now: 100 });
  assert.equal(clock.tick(1779).index, 0);
  assert.equal(clock.tick(1780).index, 1);
  assert.equal(clock.tick(1780).remainingMs, 660);
  assert.equal(clock.tick(2440).index, 2);

  const delayed = new PlaybackClock({ state: "idle", now: 0 });
  const lateSnapshot = delayed.tick(10000);
  assert.equal(lateSnapshot.index, 1);
  assert.equal(lateSnapshot.remainingMs, 660);
  assert.equal(delayed.tick(10659).index, 1);
  assert.equal(delayed.tick(10660).index, 2);
});

test("matches the nominal 6.6s host idle cycle and six 1.1s old-preview cycles", () => {
  assert.equal(sequenceDuration("idle", "hostDot"), 6600);
  assert.equal(sequenceDuration("idle", "oldPreview"), 1100);

  const host = new PlaybackClock({ state: "idle", profile: "hostDot" });
  let hostTime = 0;
  const hostIndices = [];
  for (const [index, duration] of host.durations.entries()) {
    hostTime += duration;
    hostIndices.push(host.tick(hostTime).index);
  }
  assert.deepEqual(hostIndices, [1, 2, 3, 4, 5, 0]);
  assert.equal(hostTime, 6600);

  const old = new PlaybackClock({ state: "idle", profile: "oldPreview" });
  let oldTime = 0;
  for (let cycle = 0; cycle < 6; cycle += 1) {
    for (const duration of old.durations) {
      oldTime += duration;
      old.tick(oldTime);
    }
    assert.equal(old.snapshot(oldTime).index, 0);
  }
  assert.equal(oldTime, 6600);
  assert.equal(old.snapshot(oldTime).remainingMs, 280);
});

test("keeps Dot work looping and uses callback time after a delayed frame", () => {
  const work = new PlaybackClock({ state: "work", now: 0 });
  assert.equal(work.loop, true);
  let time = 0;
  const indices = [];
  for (const duration of work.durations) {
    time += duration;
    indices.push(work.tick(time).index);
  }
  assert.deepEqual(indices, [1, 2, 3, 4, 5, 0]);
  assert.equal(time, 820);

  const delayed = new PlaybackClock({ state: "work", now: 0 });
  assert.equal(delayed.tick(10000).index, 1);
  assert.equal(delayed.tick(10119).index, 1);
  assert.equal(delayed.tick(10120).index, 2);
});

test("chains one timeout per callback and reaches the work loop boundary at 820ms", () => {
  const fake = createFakeTimeoutHost();
  const work = new PlaybackClock({ state: "work", now: 0 });
  const scheduler = new PlaybackScheduler({
    getClocks: () => [work],
    now: () => fake.now,
    setTimeoutFn: (callback, delay) => fake.setTimeout(callback, delay),
    clearTimeoutFn: (id) => fake.clearTimeout(id),
  });
  scheduler.schedule();
  assert.equal(fake.pendingCount, 1);

  for (let frame = 0; frame < work.durations.length; frame += 1) {
    fake.fireNext();
    assert.equal(fake.pendingCount, 1);
    assert.equal(work.index, (frame + 1) % work.durations.length);
  }
  assert.equal(fake.now, 820);
  assert.equal(fake.maximumPending, 1);

  fake.fireNext(10000);
  assert.equal(work.index, 1);
  assert.equal(work.snapshot(fake.now).remainingMs, 120);
  assert.equal(fake.pendingCount, 1);

  work.pause(fake.now);
  scheduler.schedule();
  assert.equal(fake.pendingCount, 0);
  work.resume(fake.now);
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(fake.pendingCount, 1);
  assert.equal(fake.maximumPending, 1);
  scheduler.cancel();
  assert.equal(fake.pendingCount, 0);
});

test("uses one shared timeout for idle and old-preview clocks at their nearest deadline", () => {
  const fake = createFakeTimeoutHost();
  const host = new PlaybackClock({ state: "idle", profile: "hostDot", now: 0 });
  const old = new PlaybackClock({ state: "idle", profile: "oldPreview", now: 0 });
  const scheduler = new PlaybackScheduler({
    getClocks: () => [host, old],
    now: () => fake.now,
    setTimeoutFn: (callback, delay) => fake.setTimeout(callback, delay),
    clearTimeoutFn: (id) => fake.clearTimeout(id),
  });
  scheduler.schedule();
  assert.equal(fake.pendingCount, 1);
  fake.fireNext();
  assert.equal(fake.now, 280);
  assert.equal(host.index, 0);
  assert.equal(old.index, 1);
  assert.equal(fake.pendingCount, 1);
  fake.fireNext(10000);
  assert.equal(host.index, 0);
  assert.equal(old.index, 2);
  assert.equal(fake.pendingCount, 1);
  fake.fireNext();
  assert.equal(host.index, 1);
  assert.equal(old.index, 2);
  assert.equal(fake.pendingCount, 1);
  assert.equal(fake.maximumPending, 1);
  scheduler.cancel();
  assert.equal(fake.pendingCount, 0);
});

test("gaze preempts idle and clearing it restarts a full first-frame dwell", () => {
  const clock = new PlaybackClock({ state: "idle", now: 0 });
  assert.equal(clock.tick(1000).remainingMs, 680);

  const right = clock.setGaze(90, 11, 1000);
  assert.equal(right.cell.row, 9);
  assert.equal(right.cell.column, 4);
  assert.equal(right.running, false);
  assert.equal(clock.tick(10000).gaze.angle, 90);

  const restarted = clock.clearGaze(10000);
  assert.equal(restarted.gaze, null);
  assert.equal(restarted.index, 0);
  assert.equal(restarted.running, true);
  assert.equal(restarted.durationMs, 1680);
  assert.equal(restarted.remainingMs, 1680);
  assert.equal(clock.tick(11679).index, 0);
  assert.equal(clock.tick(11680).index, 1);
});

test("clearing gaze preserves debugger pause but still restarts at idle frame zero", () => {
  const clock = new PlaybackClock({ state: "idle", now: 0 });
  clock.pause(500);
  clock.setGaze(180, 11, 500);
  const restarted = clock.clearGaze(9000);
  assert.equal(restarted.index, 0);
  assert.equal(restarted.running, false);
  assert.equal(restarted.remainingMs, 1680);
  assert.equal(clock.resume(9000).running, true);
  assert.equal(clock.tick(10679).index, 0);
  assert.equal(clock.tick(10680).index, 1);
  assert.throws(() => new PlaybackClock({ state: "work" }).setGaze(0, 11, 0), /只用于待机/);
});

test("finishing a single pass reports zero and continue restarts from frame zero", () => {
  const work = new PlaybackClock({ state: "work", now: 0, loop: false });
  let time = 0;
  for (const duration of work.durations.slice(0, -1)) {
    time += duration;
    work.tick(time);
  }
  assert.equal(time, 600);
  assert.equal(work.tick(time).index, 5);
  time += work.durations.at(-1);
  assert.equal(time, 820);
  const completed = work.tick(time);
  assert.equal(completed.index, 5);
  assert.equal(completed.running, false);
  assert.equal(completed.completed, true);
  assert.equal(completed.remainingMs, 0);
  assert.notEqual(completed.remainingMs, Number.POSITIVE_INFINITY);

  const restarted = work.resume(820);
  assert.equal(restarted.index, 0);
  assert.equal(restarted.running, true);
  assert.equal(restarted.remainingMs, 120);
  assert.equal(work.tick(939).index, 0);
  assert.equal(work.tick(940).index, 1);
});

test("changing loop mode restarts frame zero and preserves a manual pause", () => {
  const playing = new PlaybackClock({ state: "idle", now: 0 });
  assert.equal(playing.tick(1680).index, 1);
  playing.setLoop(false, 2000);
  assert.equal(playing.index, 0);
  assert.equal(playing.loop, false);
  assert.equal(playing.running, true);
  assert.equal(playing.snapshot(2000).remainingMs, 1680);

  const paused = new PlaybackClock({ state: "work", now: 0 });
  paused.pause(300);
  paused.setLoop(false, 900);
  assert.equal(paused.index, 0);
  assert.equal(paused.running, false);
  assert.equal(paused.snapshot(900).remainingMs, 120);
  assert.equal(paused.resume(900).running, true);
});

test("maps animation frames and sixteen static gaze directions to atlas cells", () => {
  assert.deepEqual(getFrameCell("work", 5, 11), { row: 7, column: 5, x: 960, y: 1456 });
  assert.deepEqual(getFrameCell("review", 0, 9), { row: 8, column: 0, x: 0, y: 1664 });
  assert.deepEqual(getGazeCell(0, 11), { angle: 0, directionIndex: 0, row: 9, column: 0, x: 0, y: 1872 });
  assert.deepEqual(getGazeCell(90, 11), { angle: 90, directionIndex: 4, row: 9, column: 4, x: 768, y: 1872 });
  assert.deepEqual(getGazeCell(180, 11), { angle: 180, directionIndex: 8, row: 10, column: 0, x: 0, y: 2080 });
  assert.deepEqual(getGazeCell(270, 11), { angle: 270, directionIndex: 12, row: 10, column: 4, x: 768, y: 2080 });
  assert.equal(getGazeCell(359, 11).angle, 0);
  assert.equal(pointerAngleDegrees(300, 200, { left: 100, top: 100, width: 200, height: 200 }), 90);
  assert.equal(pointerAngleDegrees(200, 300, { left: 100, top: 100, width: 200, height: 200 }), 180);
});

test("accepts supported atlas dimensions and rejects unavailable gaze/frames", () => {
  assert.equal(validateAtlasDimensions(1536, 1872).version, "v1");
  assert.equal(validateAtlasDimensions(1536, 2288).version, "v2");
  assert.equal(canUseGaze("idle", 11), true);
  assert.equal(canUseGaze("idle", 9), false);
  assert.equal(canUseGaze("work", 11), false);
  assert.equal(canUseGaze("right", 11), false);
  assert.throws(() => validateAtlasDimensions(1536, 2080), /必须是/);
  assert.throws(() => validateAtlasDimensions(192, 208), /必须是/);
  assert.throws(() => getFrameCell("failed", 8, 9), /帧号/);
  assert.throws(() => getFrameCell("work", 0, 7), /第 7 行/);
  assert.throws(() => getGazeCell(90, 9), /v2/);
  assert.throws(() => new PlaybackClock({ state: "jump", profile: "oldPreview" }), /没有 jump/);
  assert.throws(() => new PlaybackClock({ state: "work" }).setGaze(0, 11, 0), /只用于待机/);
});

test("new atlas selection invalidates all earlier decode completions, including before a rejection", () => {
  const generations = new LoadGeneration();
  const first = generations.begin();
  const second = generations.begin();
  assert.equal(generations.isCurrent(first), false);
  assert.equal(generations.isCurrent(second), true);

  const rejectedSelection = generations.begin();
  assert.equal(generations.isCurrent(second), false);
  assert.equal(generations.isCurrent(rejectedSelection), true);
});

test("keeps the inactive comparison placeholder available for non-idle states", async () => {
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /<div class="placeholder">/);
  const stageStyle = html.match(/\.pet-stage \{[^}]*\}/)?.[0];
  assert.ok(stageStyle);
  assert.match(stageStyle, /outline: 1px solid/);
  assert.doesNotMatch(stageStyle, /\bborder:/);
  assert.match(html, /\.pet-stage canvas \{[^}]*image-rendering: pixelated/);
});

test("keeps frame advancement out of the requestAnimationFrame paint loop", async () => {
  const viewer = await readFile(new URL("./viewer.mjs", import.meta.url), "utf8");
  const animateBody = viewer.match(/function animate\(now\)\s*\{([^}]*)\}/)?.[1];
  assert.ok(animateBody);
  assert.doesNotMatch(animateBody, /\.tick\(/);
  assert.match(viewer, /new PlaybackScheduler\(/);
});
