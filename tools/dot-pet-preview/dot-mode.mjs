import {
  PlaybackClock,
  PlaybackScheduler,
  canUseGaze,
} from "./timing.mjs";

export const DOT_GAZE_LEASE_MS = 10_000;

/**
 * Resolve the two states selected by the installed Dot host.
 * Draft identities stay idle. An identified working conversation is work;
 * sleeping is work only while that conversation is active.
 */
export function resolveDotState({
  identity = "identified",
  conversationStatus = "idle",
  conversationActive = false,
} = {}) {
  if (identity === "draft") return "idle";
  if (conversationStatus === "working") return "work";
  if (conversationStatus === "sleeping" && conversationActive) return "work";
  return "idle";
}

/**
 * A deterministic model of Dot's state, gaze lease and chained playback.
 * The host supplies its time and timeout functions so the same implementation
 * can run against a browser or a virtual clock.
 */
export function createDotModeController({
  now,
  setTimeoutFn,
  clearTimeoutFn,
  onFrame = () => {},
  getAdditionalClocks = () => [],
  atlasRows = 11,
  profile = "hostDot",
  initialContext = {},
  motionEnabled = true,
} = {}) {
  if (typeof now !== "function" || typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Dot 状态控制器需要注入 now、setTimeoutFn 和 clearTimeoutFn。");
  }
  if (typeof getAdditionalClocks !== "function") {
    throw new TypeError("getAdditionalClocks 必须是函数。");
  }

  let context = { ...initialContext };
  let state = resolveDotState(context);
  let motionGate = Boolean(motionEnabled);
  let pointerInside = false;
  let gazeLeaseTimer = null;
  let gazeLeaseGeneration = 0;
  let destroyed = false;

  const clock = new PlaybackClock({ state, profile, now: now() });
  if (!motionGate) clock.pause(now());

  const snapshot = () => Object.freeze({
    ...clock.snapshot(now()),
    state,
    motionEnabled: motionGate,
    pointerInside,
    gazeLeaseActive: gazeLeaseTimer !== null,
    destroyed,
  });

  const emit = (reason, timestamp = now()) => {
    if (!destroyed) onFrame(snapshot(), reason, timestamp);
  };

  const scheduler = new PlaybackScheduler({
    getClocks: () => [clock, ...(getAdditionalClocks() ?? [])],
    now,
    setTimeoutFn,
    clearTimeoutFn,
    onFrame: (timestamp) => emit("animation", timestamp),
  });

  const schedule = () => {
    if (!destroyed) scheduler.schedule();
  };

  const clearLeaseTimer = () => {
    gazeLeaseGeneration += 1;
    if (gazeLeaseTimer !== null) {
      clearTimeoutFn(gazeLeaseTimer);
      gazeLeaseTimer = null;
    }
  };

  const cancelGaze = (reason, {
    resetInside = false,
    schedulePlayback = true,
    emitChange = true,
  } = {}) => {
    clearLeaseTimer();
    if (resetInside) pointerInside = false;
    const hadGaze = Boolean(clock.gaze);
    if (hadGaze) clock.clearGaze(now());
    if (hadGaze && schedulePlayback) schedule();
    if (hadGaze && emitChange) emit(reason);
    return hadGaze;
  };

  const armGazeLease = () => {
    clearLeaseTimer();
    const generation = gazeLeaseGeneration;
    gazeLeaseTimer = setTimeoutFn(() => {
      if (destroyed || generation !== gazeLeaseGeneration) return;
      gazeLeaseTimer = null;
      gazeLeaseGeneration += 1;
      // The host's lease expiry clears gaze but leaves its internal `inside`
      // bit untouched. A fresh outside -> inside transition is needed to rearm.
      cancelGaze("gaze-lease-expired", { schedulePlayback: true });
    }, DOT_GAZE_LEASE_MS);
  };

  const applyGaze = (angle) => {
    if (!motionGate || !canUseGaze(state, atlasRows) || gazeLeaseTimer === null) return false;
    clock.setGaze(angle, atlasRows, now());
    schedule();
    emit("gaze-move");
    return true;
  };

  schedule();
  emit("initial");

  return Object.freeze({
    get clock() {
      return clock;
    },

    setContext(nextContext = {}) {
      if (destroyed) return snapshot();
      context = { ...context, ...nextContext };
      const nextState = resolveDotState(context);
      if (nextState === state) return snapshot();

      cancelGaze("state-change", { resetInside: true, schedulePlayback: false, emitChange: false });
      state = nextState;
      clock.setSequence(state, profile, now());
      if (!motionGate) clock.pause(now());
      schedule();
      emit("state-change");
      return snapshot();
    },

    setMotionEnabled(enabled) {
      if (destroyed) return snapshot();
      const nextEnabled = Boolean(enabled);
      if (nextEnabled === motionGate) return snapshot();
      motionGate = nextEnabled;
      if (!motionGate) {
        cancelGaze("motion-gate-off", { resetInside: true, schedulePlayback: false, emitChange: false });
        clock.restart(now(), true);
        clock.pause(now());
      } else {
        // OKa is torn down and recreated with a fresh `inside=false` closure
        // when XKa's interaction gate changes.
        pointerInside = false;
        // The host effect restarts the selected sequence at its first frame.
        clock.restart(now(), true);
      }
      schedule();
      emit("motion-gate-change");
      return snapshot();
    },

    /**
     * Mirror the captured host pointermove handler. `inside` is computed by
     * the caller from both composed-path membership and target bounds. Once a
     * lease exists, any primary non-touch page movement may update the gaze.
     */
    pointerMove({
      angle,
      inInteractionPath = true,
      insideBounds = true,
      pointerType = "mouse",
      isPrimary = true,
    } = {}) {
      if (destroyed || !isPrimary || pointerType === "touch" || !Number.isFinite(angle)) return snapshot();
      // The host does not install the pointer tracker while gaze is unavailable.
      if (!motionGate || !canUseGaze(state, atlasRows)) return snapshot();
      const inside = Boolean(inInteractionPath && insideBounds);
      const entered = inside && !pointerInside;
      pointerInside = inside;

      if (entered) armGazeLease();
      if (gazeLeaseTimer !== null) applyGaze(angle);
      return snapshot();
    },

    /** A pointerleave only drops the inside bit; it does not end the lease. */
    pointerLeave() {
      if (destroyed) return snapshot();
      pointerInside = false;
      return snapshot();
    },

    /** Explicit pointercancel used when the UI turns off pointer tracking. */
    cancelPointer({ resetInside = false } = {}) {
      if (destroyed) return snapshot();
      clearLeaseTimer();
      if (resetInside) pointerInside = false;
      clock.clearGaze(now());
      schedule();
      emit("pointer-cancel");
      return snapshot();
    },

    blur() {
      if (destroyed) return snapshot();
      cancelGaze("blur");
      return snapshot();
    },

    setDocumentHidden(hidden) {
      if (destroyed) return snapshot();
      if (hidden) cancelGaze("document-hidden");
      // Hidden state does not pause animation. Ordinary chained timeouts are
      // left to host/browser throttling and each late callback advances once.
      return snapshot();
    },

    snapshot,

    /** Rebuild the shared chained timeout after an external clock changes. */
    reschedule() {
      schedule();
      return snapshot();
    },

    destroy() {
      if (destroyed) return;
      cancelGaze("destroy", { schedulePlayback: false });
      scheduler.cancel();
      destroyed = true;
    },
  });
}
