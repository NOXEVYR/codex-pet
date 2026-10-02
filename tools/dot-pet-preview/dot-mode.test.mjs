import test from "node:test";
import assert from "node:assert/strict";
import { createDotModeController, DOT_GAZE_LEASE_MS } from "./dot-mode.mjs";
import { PlaybackClock } from "./timing.mjs";

class FakeHost {
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
    this.timers.set(id, { id, callback, at: this.time + Math.max(0, delay), delay });
    this.scheduled += 1;
    this.maxPending = Math.max(this.maxPending, this.timers.size);
    return id;
  };

  clearTimeout = (id) => {
    if (this.timers.delete(id)) this.cleared += 1;
  };

  get pending() {
    return [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id);
  }

  advanceBy(duration) {
    const target = this.time + duration;
    let executions = 0;
    while (true) {
      const next = this.pending[0];
      if (!next || next.at > target) break;
      if (++executions > 1_000_000) throw new Error("fake host timer runaway");
      this.time = next.at;
      this.timers.delete(next.id);
      this.fired += 1;
      next.callback();
    }
    this.time = target;
  }

  jumpTo(timestamp) {
    if (timestamp < this.time) throw new RangeError("fake host time cannot move backward");
    this.time = timestamp;
  }

  fireNextAtCurrentTime() {
    const next = this.pending[0];
    if (!next) throw new Error("no timer to fire");
    this.timers.delete(next.id);
    this.fired += 1;
    next.callback();
    return next;
  }
}

function makeController(host, options = {}) {
  return createDotModeController({
    now: host.now,
    setTimeoutFn: host.setTimeout,
    clearTimeoutFn: host.clearTimeout,
    ...options,
  });
}

function enterPet(controller, angle = 90) {
  return controller.pointerMove({ angle, inInteractionPath: true, insideBounds: true });
}

test("Dot state selector maps draft/inactive/sleeping/working to idle or work", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  assert.equal(controller.snapshot().state, "idle");
  assert.equal(controller.setContext({ identity: "draft", conversationStatus: "working" }).state, "idle");
  assert.equal(controller.setContext({ identity: "identified", conversationStatus: "sleeping", conversationActive: false }).state, "idle");
  assert.equal(controller.setContext({ conversationStatus: "sleeping", conversationActive: true }).state, "work");
  assert.equal(controller.setContext({ conversationStatus: "working", conversationActive: false }).state, "work");
  controller.destroy();
  assert.equal(host.timers.size, 0);
});

test("repeated state changes restart frame zero and replace old animation timeouts", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  for (const context of [
    { conversationStatus: "working" },
    { conversationStatus: "sleeping", conversationActive: true },
    { conversationStatus: "sleeping", conversationActive: false },
    { identity: "draft", conversationStatus: "working" },
    { identity: "identified", conversationStatus: "working" },
    { conversationStatus: "idle" },
  ]) {
    const before = host.pending.map(({ id }) => id);
    const oldState = controller.snapshot().state;
    const snapshot = controller.setContext(context);
    assert.equal(snapshot.index, 0, "state effects start the new row on frame zero");
    assert.equal(host.timers.size, 1, "one chained playback timeout remains");
    if (snapshot.state !== oldState) {
      assert.notDeepEqual(host.pending.map(({ id }) => id), before, "a state transition replaces the preceding timeout");
    } else {
      assert.deepEqual(host.pending.map(({ id }) => id), before, "an unchanged selected state keeps its timeout");
    }
  }
  assert.equal(host.maxPending, 1);
  controller.destroy();
});

test("gaze holds an idle direction, then work state clears it and starts work frame zero", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  const gaze = enterPet(controller, 90);
  assert.equal(gaze.gaze.directionIndex, 4);
  assert.equal(gaze.gaze.row, 9);
  assert.equal(gaze.running, false);
  assert.equal(host.timers.size, 1, "gaze owns its lease timeout while animation is suppressed");

  const work = controller.setContext({ conversationStatus: "working" });
  assert.equal(work.state, "work");
  assert.equal(work.gaze, null);
  assert.equal(work.index, 0);
  assert.equal(work.cell.row, 7);
  assert.equal(host.timers.size, 1, "state change removes the gaze lease and schedules work playback");
  controller.destroy();
});

test("gaze lease lasts ten seconds, outside movement updates it, and inside movement does not extend it", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  enterPet(controller, 0);
  const firstLease = host.pending[0];
  assert.equal(firstLease.delay, DOT_GAZE_LEASE_MS);
  assert.equal(firstLease.at, DOT_GAZE_LEASE_MS);

  host.advanceBy(4_000);
  enterPet(controller, 45);
  assert.equal(host.pending[0].id, firstLease.id, "continuous inside movement retains the original deadline");

  host.advanceBy(2_000);
  controller.pointerLeave();
  const pageMove = controller.pointerMove({
    angle: 180,
    inInteractionPath: false,
    insideBounds: false,
  });
  assert.equal(pageMove.gaze.angle, 180, "page movement may update gaze while a lease is active");
  assert.equal(host.pending[0].id, firstLease.id, "leaving does not cancel or restart the lease");

  host.advanceBy(4_000);
  assert.equal(controller.snapshot().gaze, null, "the lease expires at its original deadline");
  assert.equal(controller.snapshot().pointerInside, false);
  controller.destroy();
});

test("lease expiry while still inside needs an outside-to-inside transition to rearm", () => {
  const host = new FakeHost();
  const emitted = [];
  const controller = makeController(host, {
    onFrame: (snapshot, reason) => emitted.push({ snapshot, reason }),
  });
  enterPet(controller, 10);
  host.advanceBy(DOT_GAZE_LEASE_MS);
  assert.equal(controller.snapshot().pointerInside, true);
  assert.equal(controller.snapshot().gaze, null);
  assert.ok(emitted.some(({ reason, snapshot }) => reason === "gaze-lease-expired" && snapshot.gaze === null));
  assert.equal(host.pending.length, 1, "only idle playback remains after lease expiry");

  host.advanceBy(100);
  enterPet(controller, 30);
  assert.equal(controller.snapshot().gaze, null, "movement while still inside cannot rearm an expired lease");
  controller.pointerLeave();
  const reentered = enterPet(controller, 90);
  assert.equal(reentered.gaze.angle, 90);
  assert.equal(reentered.gazeLeaseActive, true);
  controller.destroy();
});

test("blur and document-hidden cancel gaze without pausing chained animation", () => {
  const host = new FakeHost();
  const emittedReasons = [];
  const controller = makeController(host, {
    onFrame: (_snapshot, reason) => emittedReasons.push(reason),
  });
  enterPet(controller, 225);
  assert.equal(controller.snapshot().gaze !== null, true);
  controller.blur();
  assert.ok(emittedReasons.includes("blur"), "blur cancellation still emits its render update");
  assert.equal(controller.snapshot().gaze, null);
  assert.equal(controller.snapshot().pointerInside, true, "blur does not rewrite the tracker's inside bit");
  assert.equal(host.pending.length, 1);
  assert.equal(host.pending[0].delay, 1_680);

  controller.pointerLeave();
  enterPet(controller, 180);
  controller.setDocumentHidden(true);
  assert.ok(emittedReasons.includes("document-hidden"), "hidden cancellation still emits its render update");
  assert.equal(controller.snapshot().gaze, null);
  assert.equal(controller.snapshot().gazeLeaseActive, false);
  assert.equal(host.pending.length, 1, "hidden gaze cancellation restarts ordinary animation");
  assert.equal(controller.snapshot().pointerInside, true);

  const dueBeforeVisible = host.pending[0].at;
  controller.setDocumentHidden(false);
  assert.equal(host.pending[0].at, dueBeforeVisible, "visibility does not pause or rebuild animation timers");
  controller.destroy();
});

test("state and motion-gate transactions emit only their final consistent snapshot", () => {
  const host = new FakeHost();
  let oldPreviewReference = {};
  let inspectRemovedPreview = false;
  let expectedTransition;
  const transitionCallbacks = [];
  const controller = makeController(host, {
    onFrame(snapshot, reason) {
      if (!inspectRemovedPreview) return;
      transitionCallbacks.push({ snapshot, reason });
      // Simulates updateControls after UI integration has already removed its
      // old-preview clock. It must never receive the pre-transition idle state.
      assert.equal(oldPreviewReference, null);
      assert.equal(snapshot.state, expectedTransition.state);
      assert.equal(snapshot.motionEnabled, expectedTransition.motionEnabled);
      assert.equal(snapshot.gaze, null);
      assert.equal(snapshot.gazeLeaseActive, false);
      assert.equal(snapshot.cell.row, expectedTransition.row);
      assert.equal(snapshot.running, expectedTransition.running);
    },
  });

  enterPet(controller, 90);
  assert.ok(controller.snapshot().gaze);
  oldPreviewReference = null;
  expectedTransition = { state: "work", motionEnabled: true, row: 7, running: true };
  inspectRemovedPreview = true;
  const work = controller.setContext({ conversationStatus: "working" });
  inspectRemovedPreview = false;
  assert.equal(work.state, "work");
  assert.equal(transitionCallbacks.length, 1, "the switch emits one atomic state update");
  assert.equal(transitionCallbacks[0].reason, "state-change");
  assert.equal(transitionCallbacks[0].snapshot.cell.row, 7);

  oldPreviewReference = {};
  controller.setContext({ conversationStatus: "idle" });
  enterPet(controller, 45);
  transitionCallbacks.length = 0;
  expectedTransition = { state: "idle", motionEnabled: false, row: 0, running: false };
  oldPreviewReference = null;
  inspectRemovedPreview = true;
  const gated = controller.setMotionEnabled(false);
  inspectRemovedPreview = false;
  assert.equal(gated.motionEnabled, false);
  assert.equal(gated.state, "idle");
  assert.equal(gated.gaze, null);
  assert.equal(gated.gazeLeaseActive, false);
  assert.equal(gated.index, 0);
  assert.equal(gated.running, false);
  assert.equal(transitionCallbacks.length, 1, "gate cleanup emits only the final static snapshot");
  assert.equal(transitionCallbacks[0].reason, "motion-gate-change");
  assert.equal(transitionCallbacks[0].snapshot.cell.row, 0);
  controller.destroy();
});

test("late callbacks advance exactly one frame and schedule from callback time", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  const initial = host.pending[0];
  assert.equal(initial.delay, 1_680);

  host.jumpTo(100_000);
  host.fireNextAtCurrentTime();
  assert.equal(controller.snapshot().index, 1, "late delivery advances once without time-based catch-up");
  assert.equal(controller.snapshot().remainingMs, 660);
  assert.equal(host.pending[0].at, 100_660, "the following dwell begins at callback time");
  controller.destroy();
});

test("motion gate freezes the current state's first frame and reopens from that frame", () => {
  const host = new FakeHost();
  const controller = makeController(host, { motionEnabled: false });
  assert.equal(controller.snapshot().cell.row, 0);
  assert.equal(host.timers.size, 0);

  controller.setContext({ conversationStatus: "working" });
  assert.equal(controller.snapshot().state, "work");
  assert.equal(controller.snapshot().cell.row, 7);
  assert.equal(controller.snapshot().index, 0);
  assert.equal(host.timers.size, 0);

  host.advanceBy(4_000);
  controller.setMotionEnabled(true);
  assert.equal(controller.snapshot().index, 0);
  assert.equal(controller.snapshot().remainingMs, 120);
  assert.equal(host.pending.length, 1);
  controller.setMotionEnabled(false);
  assert.equal(controller.snapshot().cell.row, 7);
  assert.equal(controller.snapshot().index, 0);
  assert.equal(host.timers.size, 0);
  controller.destroy();
});

test("motion gate recreates pointer tracking with inside=false", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  enterPet(controller, 15);
  assert.equal(controller.snapshot().pointerInside, true);
  assert.ok(controller.snapshot().gaze);

  controller.setMotionEnabled(false);
  assert.equal(controller.snapshot().pointerInside, false, "gate cleanup resets the tracker closure state");
  assert.equal(controller.snapshot().gaze, null);
  assert.equal(host.timers.size, 0);
  controller.pointerMove({ angle: 60, inInteractionPath: true, insideBounds: true });
  assert.equal(controller.snapshot().pointerInside, false, "the disabled tracker ignores pointer movement");

  controller.setMotionEnabled(true);
  assert.equal(controller.snapshot().pointerInside, false, "a recreated tracker starts outside");
  assert.equal(controller.snapshot().gaze, null);
  assert.equal(host.timers.size, 1, "only the restarted animation is scheduled");
  const freshEntry = enterPet(controller, 120);
  assert.equal(freshEntry.pointerInside, true);
  assert.equal(freshEntry.gaze.angle, 112.5);
  assert.equal(freshEntry.gazeLeaseActive, true);
  controller.destroy();
});

test("explicit pointercancel clears gaze and lease, with optional inside reset", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  enterPet(controller, 0);
  controller.cancelPointer();
  assert.equal(controller.snapshot().gaze, null);
  assert.equal(controller.snapshot().gazeLeaseActive, false);
  assert.equal(controller.snapshot().pointerInside, true, "default cancellation preserves tracker inside state");
  assert.equal(host.timers.size, 1, "idle playback resumes with a fresh first-frame timer");

  controller.cancelPointer({ resetInside: true });
  assert.equal(controller.snapshot().pointerInside, false);
  assert.equal(host.timers.size, 1);
  controller.destroy();
});

test("controller exposes its host clock and schedules an injected preview clock", () => {
  const host = new FakeHost();
  const oldPreviewClock = new PlaybackClock({ state: "idle", profile: "oldPreview", now: 0 });
  const controller = makeController(host, {
    getAdditionalClocks: () => [oldPreviewClock],
  });
  assert.equal(controller.clock.state, "idle");
  assert.equal(host.pending[0].delay, 280, "the shared timer uses the earliest injected clock");

  host.advanceBy(280);
  assert.equal(oldPreviewClock.index, 1);
  assert.equal(controller.clock.index, 0);
  oldPreviewClock.pause(host.now());
  controller.reschedule();
  assert.equal(host.pending[0].delay, 1_400, "reschedule observes external clock changes and remaining dwell");
  controller.destroy();
  assert.equal(host.timers.size, 0);
});

test("destroy is idempotent and leaves no animation or gaze timers", () => {
  const host = new FakeHost();
  const controller = makeController(host);
  enterPet(controller);
  assert.equal(host.timers.size, 1);
  controller.destroy();
  controller.destroy();
  assert.equal(host.timers.size, 0);
  assert.equal(controller.snapshot().destroyed, true);
  assert.equal(controller.setContext({ conversationStatus: "working" }).state, "idle");
});
