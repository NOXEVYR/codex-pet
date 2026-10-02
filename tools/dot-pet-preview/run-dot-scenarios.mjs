import { performance } from "node:perf_hooks";
import { createDotModeController } from "./dot-mode.mjs";
import { PlaybackClock } from "./timing.mjs";

const HOUR_MS = 60 * 60 * 1_000;
const SIMULATED_DURATION_MS = 8 * HOUR_MS;

class VirtualHost {
  time = 0;
  nextId = 1;
  timers = new Map();
  maxPending = 0;
  scheduled = 0;
  cleared = 0;
  fired = 0;

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { id, callback, at: this.time + Math.max(0, delay) });
    this.scheduled += 1;
    this.maxPending = Math.max(this.maxPending, this.timers.size);
    return id;
  };

  clearTimeout = (id) => {
    if (this.timers.delete(id)) this.cleared += 1;
  };

  advanceBy(duration) {
    const target = this.time + duration;
    let iterations = 0;
    while (true) {
      let next = null;
      for (const timer of this.timers.values()) {
        if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
      }
      if (!next || next.at > target) break;
      if (++iterations > 2_000_000) throw new Error("virtual host timer runaway");
      this.time = next.at;
      this.timers.delete(next.id);
      this.fired += 1;
      next.callback();
    }
    this.time = target;
  }
}

const wallStart = performance.now();
const host = new VirtualHost();
const assertions = { passed: 0, failed: 0 };
const failures = [];
const callbacksByState = { idle: 0, work: 0 };
let animationCallbacks = 0;
let progressAdvances = 0;
let maxProgressStagnationMs = 0;
let previousAnimationAt = null;
let previousFrame = null;

const controller = createDotModeController({
  now: host.now,
  setTimeoutFn: host.setTimeout,
  clearTimeoutFn: host.clearTimeout,
  onFrame(snapshot, reason, timestamp) {
    if (reason !== "animation") return;
    animationCallbacks += 1;
    callbacksByState[snapshot.state] += 1;
    if (previousAnimationAt !== null) {
      maxProgressStagnationMs = Math.max(maxProgressStagnationMs, timestamp - previousAnimationAt);
    }
    if (!previousFrame || snapshot.state !== previousFrame.state || snapshot.index !== previousFrame.index) {
      progressAdvances += 1;
    }
    previousFrame = snapshot;
    previousAnimationAt = timestamp;
  },
});

function check(name, predicate, detail = "") {
  if (predicate) {
    assertions.passed += 1;
  } else {
    assertions.failed += 1;
    failures.push({ name, detail });
  }
}

const segments = [
  { name: "idle", durationMs: HOUR_MS },
  { name: "working", durationMs: 2 * HOUR_MS, context: { conversationStatus: "working" } },
  { name: "sleeping-active", durationMs: HOUR_MS, context: { conversationStatus: "sleeping", conversationActive: true } },
  { name: "sleeping-inactive", durationMs: HOUR_MS, context: { conversationStatus: "sleeping", conversationActive: false } },
  { name: "idle-resumed", durationMs: 3 * HOUR_MS, context: { conversationStatus: "idle" } },
];

for (const segment of segments) {
  const before = controller.snapshot();
  const after = segment.context ? controller.setContext(segment.context) : before;
  const expectedState = segment.name === "working" || segment.name === "sleeping-active" ? "work" : "idle";
  check(`${segment.name}: selected state`, after.state === expectedState);
  if (after.state !== before.state) {
    check(`${segment.name}: frame zero after transition`, after.index === 0);
  } else {
    check(`${segment.name}: unchanged selection preserves phase`, after.index === before.index);
  }
  host.advanceBy(segment.durationMs);
  check(`${segment.name}: playback timer remains chained`, host.timers.size === 1, `pending=${host.timers.size}`);
}

check("simulation elapsed exactly eight virtual hours", host.now() === SIMULATED_DURATION_MS, `elapsed=${host.now()}`);
check("both Dot states advanced frames", callbacksByState.idle > 0 && callbacksByState.work > 0, JSON.stringify(callbacksByState));
check("all delivered animation callbacks made frame progress", progressAdvances === animationCallbacks, `advances=${progressAdvances}; callbacks=${animationCallbacks}`);
check("ordinary playback never exceeded one pending timer", host.maxPending === 1, `max=${host.maxPending}`);
check("callback progress gap matches a single host frame dwell", maxProgressStagnationMs <= 1_920, `maxGap=${maxProgressStagnationMs}`);

controller.destroy();
check("destroy released the remaining timer", host.timers.size === 0, `pending=${host.timers.size}`);

// Exercise timer coexistence: a gaze lease suppresses the host clock, while
// an injected old-preview clock keeps the shared animation scheduler alive.
const interactionHost = new VirtualHost();
const oldPreviewClock = new PlaybackClock({ state: "idle", profile: "oldPreview", now: 0 });
const interactionController = createDotModeController({
  now: interactionHost.now,
  setTimeoutFn: interactionHost.setTimeout,
  clearTimeoutFn: interactionHost.clearTimeout,
  getAdditionalClocks: () => [oldPreviewClock],
});

interactionHost.advanceBy(100);
interactionController.pointerMove({ angle: 0, inInteractionPath: true, insideBounds: true });
check("interleaved: gaze starts while animation timer continues", interactionController.snapshot().gaze !== null && interactionHost.timers.size === 2, `pending=${interactionHost.timers.size}`);
interactionHost.advanceBy(200);
interactionController.pointerLeave();
interactionController.pointerMove({ angle: 180, inInteractionPath: false, insideBounds: false });
check("interleaved: outside movement updates held gaze", interactionController.snapshot().gaze?.angle === 180);

interactionHost.advanceBy(1_000);
interactionController.setContext({ conversationStatus: "working" });
check("interleaved: switching to work clears lease and gaze", interactionController.snapshot().state === "work" && interactionController.snapshot().gaze === null && !interactionController.snapshot().gazeLeaseActive);
interactionHost.advanceBy(2_500);
interactionController.setContext({ conversationStatus: "sleeping", conversationActive: true });
check("interleaved: active sleeping retains work state", interactionController.snapshot().state === "work");
interactionController.setContext({ conversationStatus: "sleeping", conversationActive: false });
check("interleaved: inactive sleeping returns to idle frame zero", interactionController.snapshot().state === "idle" && interactionController.snapshot().index === 0);

interactionController.pointerMove({ angle: 270, inInteractionPath: true, insideBounds: true });
interactionHost.advanceBy(2_000);
interactionController.setMotionEnabled(false);
check("interleaved: gate-off cancels gaze and resets tracker", interactionController.snapshot().gaze === null && !interactionController.snapshot().pointerInside);
interactionController.setMotionEnabled(true);
interactionController.pointerMove({ angle: 45, inInteractionPath: true, insideBounds: true });
check("interleaved: gate-on permits a fresh lease", interactionController.snapshot().gaze?.angle === 45 && interactionController.snapshot().gazeLeaseActive);
interactionController.cancelPointer();
check("interleaved: pointercancel clears gaze without resetting inside", interactionController.snapshot().gaze === null && interactionController.snapshot().pointerInside);
interactionController.pointerMove({ angle: 90, inInteractionPath: true, insideBounds: true });
check("interleaved: pointercancel requires a new tracker entry", interactionController.snapshot().gaze === null && !interactionController.snapshot().gazeLeaseActive);
interactionController.pointerLeave();
interactionController.pointerMove({ angle: 90, inInteractionPath: true, insideBounds: true });
check("interleaved: leave then entry creates a fresh lease", interactionController.snapshot().gaze?.angle === 90 && interactionController.snapshot().gazeLeaseActive);
check("interleaved: lease plus old-preview animation peaks at two timers", interactionHost.maxPending === 2, `max=${interactionHost.maxPending}`);
interactionHost.advanceBy(600);
interactionController.destroy();
check("interleaved: destroy clears both timer classes", interactionHost.timers.size === 0, `pending=${interactionHost.timers.size}`);

const report = {
  schema: "dot-mode-simulation/v1",
  classification: "simulated-preview-model; not host end-to-end evidence",
  result: assertions.failed === 0 ? "passed" : "failed",
  simulatedDurationMs: host.now(),
  wallClockDurationMs: Number((performance.now() - wallStart).toFixed(3)),
  assertions,
  failures,
  segments,
  additionalScenarios: [{
    name: "interleaved-gaze-state-switches",
    simulatedDurationMs: interactionHost.now(),
    maxConcurrentTimers: interactionHost.maxPending,
    result: interactionHost.timers.size === 0 ? "passed" : "failed",
  }],
  metrics: {
    timerCallbacksFired: host.fired,
    timersScheduled: host.scheduled,
    timersCleared: host.cleared,
    maxConcurrentTimers: host.maxPending,
    animationCallbacks,
    frameProgressAdvances: progressAdvances,
    maximumProgressStagnationMs: maxProgressStagnationMs,
    callbacksByState,
    pendingTimersAtEnd: host.timers.size,
    interleavedScenario: {
      timerCallbacksFired: interactionHost.fired,
      timersScheduled: interactionHost.scheduled,
      timersCleared: interactionHost.cleared,
      maxConcurrentTimers: interactionHost.maxPending,
      pendingTimersAtEnd: interactionHost.timers.size,
    },
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (assertions.failed > 0) process.exitCode = 1;
