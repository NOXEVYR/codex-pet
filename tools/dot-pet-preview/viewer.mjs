const {
  CELL_HEIGHT,
  CELL_WIDTH,
  LoadGeneration,
  PlaybackClock,
  PlaybackScheduler,
  canUseGaze,
  getGazeCell,
  pointerAngleDegrees,
  sequenceDuration,
  validateAtlasDimensions,
} = globalThis.DotPetTiming;
const { createDotModeController, resolveDotState } = globalThis.DotPetMode;

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const $ = (selector) => document.querySelector(selector);
const fileInput = $("#atlas-file");
const fileStatus = $("#file-status");
const stateSelect = $("#state-select");
const loopToggle = $("#loop-toggle");
const pixelToggle = $("#pixel-toggle");
const gazeToggle = $("#gaze-toggle");
const dotModeToggle = $("#dot-mode-toggle");
const dotContext = $("#dot-context");
const conversationActive = $("#conversation-active");
const motionToggle = $("#motion-toggle");
const hostCanvas = $("#host-canvas");
const oldCanvas = $("#old-canvas");
const hostContext = hostCanvas.getContext("2d", { alpha: true });
const oldContext = oldCanvas.getContext("2d", { alpha: true });

let atlasBitmap = null;
let atlasFormat = null;
const atlasLoadGeneration = new LoadGeneration();
let hostClock = new PlaybackClock({ state: "idle", profile: "hostDot", now: performance.now() });
let oldClock = new PlaybackClock({ state: "idle", profile: "oldPreview", now: performance.now() });
let lastPointerAngle = null;
let pointerInside = false;
let dotController = null;
let simulatedHidden = false;
let gazeRequested = false;
const playbackScheduler = new PlaybackScheduler({
  getClocks: () => [hostClock, oldClock],
  now: () => performance.now(),
  setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeoutFn: (timer) => window.clearTimeout(timer),
  onFrame: (now) => updateControls(now),
});

function reschedulePlayback() {
  if (dotController) dotController.reschedule();
  else playbackScheduler.schedule();
}

function dotContextValue() {
  return { identity: dotContext.value === "draft" ? "draft" : "identified", conversationStatus: dotContext.value, conversationActive: conversationActive.checked };
}

function createDotPlayback(now, shouldRun = true) {
  playbackScheduler.cancel();
  dotController?.destroy();
  dotController = null;
  loopToggle.checked = true;
  dotController = createDotModeController({
    now: () => performance.now(),
    setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeoutFn: (timer) => window.clearTimeout(timer),
    atlasRows: atlasFormat?.rows ?? 11,
    initialContext: dotContextValue(),
    motionEnabled: motionToggle.checked,
    getAdditionalClocks: () => oldClock ? [oldClock] : [],
    onFrame: (_snapshot, _reason, timestamp) => { if (dotController) updateControls(timestamp); },
  });
  hostClock = dotController.clock;
  if (!shouldRun && motionToggle.checked) hostClock.pause(now);
  if (!shouldRun || !motionToggle.checked) oldClock?.pause(now);
  if (simulatedHidden) dotController.setDocumentHidden(true);
  reschedulePlayback();
}

function applyDotContext() {
  const now = performance.now();
  const state = resolveDotState(dotContextValue());
  if (!dotController) {
    oldClock = state === "idle" ? new PlaybackClock({ state: "idle", profile: "oldPreview", now }) : null;
    createDotPlayback(now);
  } else {
    if (hostClock.state !== state) {
      gazeToggle.checked = false;
      oldClock = state === "idle" ? new PlaybackClock({ state: "idle", profile: "oldPreview", now }) : null;
      if (!motionToggle.checked) oldClock?.pause(now);
    }
    dotController.setContext(dotContextValue());
    hostClock = dotController.clock;
  }
  stateSelect.value = state;
  updateGazeAvailability();
  updateStateLabels(state);
  updateControls(now);
  reschedulePlayback();
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function showFileStatus(message, kind = "") {
  fileStatus.textContent = message;
  fileStatus.dataset.kind = kind;
}

function drawCell(context, canvas, cell) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!atlasBitmap || !cell) return;
  context.imageSmoothingEnabled = !pixelToggle.checked;
  context.drawImage(
    atlasBitmap,
    cell.x,
    cell.y,
    CELL_WIDTH,
    CELL_HEIGHT,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function setFrameReadout(element, snapshot) {
  if (!atlasFormat) {
    element.textContent = "请先载入图集";
    return;
  }
  if (snapshot.gaze) {
    element.innerHTML = `<strong>静态视线 ${snapshot.gaze.angle}°</strong> · 第 ${snapshot.gaze.row} 行 / 第 ${snapshot.gaze.column} 列<br>动画时序已暂停`;
    return;
  }
  if (snapshot.completed) {
    element.innerHTML = `<strong>第 ${snapshot.index + 1} / ${snapshot.frameCount} 帧</strong> · ${snapshot.durationMs} ms / 帧<br>单次播放已完成 · 继续将从首帧重播`;
    return;
  }
  const remaining = Math.ceil(snapshot.remainingMs ?? 0);
  const loopLabel = snapshot.loop ? "循环" : "单次";
  element.innerHTML = `<strong>第 ${snapshot.index + 1} / ${snapshot.frameCount} 帧</strong> · ${snapshot.durationMs} ms / 帧<br>${loopLabel} · 下帧还有 ${remaining} ms`;
}

function updateControls(now = performance.now()) {
  const host = hostClock.snapshot(now);
  drawCell(hostContext, hostCanvas, host.cell);
  setFrameReadout($("#host-readout"), host);

  const oldActive = host.state === "idle";
  $("#old-panel").classList.toggle("inactive", !oldActive);
  if (oldActive) {
    const old = oldClock.snapshot(now);
    drawCell(oldContext, oldCanvas, old.cell);
    setFrameReadout($("#old-readout"), old);
  } else {
    oldContext.clearRect(0, 0, oldCanvas.width, oldCanvas.height);
    $("#old-readout").textContent = "";
  }

  $("#play-button").textContent = host.gaze ? "视线覆盖中" : host.running ? "暂停" : "继续";
  if (host.completed) $("#play-button").textContent = "重播";
  $("#clear-gaze-button").disabled = !gazeToggle.checked;
  loopToggle.disabled = Boolean(host.gaze) || Boolean(dotController);
  const staticMode = dotController && !motionToggle.checked;
  for (const id of ["play-button", "previous-button", "next-button", "reset-button"]) $("#" + id).disabled = Boolean(host.gaze) || Boolean(staticMode);
  if (staticMode) $("#play-button").textContent = "静态首帧";
  dotContext.disabled = !dotModeToggle.checked;
  conversationActive.disabled = !dotModeToggle.checked;
  motionToggle.disabled = !dotModeToggle.checked;
  $("#blur-button").disabled = !dotModeToggle.checked;
  $("#hidden-button").disabled = !dotModeToggle.checked;
  $("#hidden-button").textContent = simulatedHidden ? "返回可见页面" : "模拟隐藏页面";
  const modeSnapshot = dotController?.snapshot();
  $("#dot-mode-status").textContent = !modeSnapshot ? "手动动作预览；会话状态与 10 秒注视规则未启用。"
    : !modeSnapshot.motionEnabled ? "动效关闭：显示当前状态首帧。"
    : modeSnapshot.gazeLeaseActive ? "注视有效期内：移出头像仍可更新方向，到期后恢复待机。"
    : modeSnapshot.pointerInside ? "注视已结束；先移出头像再移入可重新触发。"
    : simulatedHidden ? "已模拟隐藏取消注视；计时未暂停，真实后台节流需实机验证。"
    : "网页 Dot 模型：空闲待机，思考工作；注视约 10 秒。悬浮宠物的实际规则需单独核验。";
  if (gazeToggle.checked) {
    $("#gaze-status").textContent = host.gaze
      ? `视线 ${host.gaze.angle}° · 覆盖动画`
      : pointerInside ? "指针跟随开启" : "指针跟随开启 · 在角色框内移动鼠标";
  } else {
    $("#gaze-status").textContent = "指针跟随关闭";
  }
}

function updateGazeAvailability() {
  const available = canUseGaze(hostClock.state, atlasFormat?.rows) && (!dotController || motionToggle.checked);
  if (!available) {
    gazeToggle.checked = false;
    if (hostClock.gaze) hostClock.clearGaze(performance.now());
  }
  if (dotController) gazeToggle.checked = available && gazeRequested;
  gazeToggle.disabled = !available;
}

function stopGazeTracking(now) {
  if (dotController) dotController.cancelPointer({ resetInside: true });
  if (hostClock.gaze) hostClock.clearGaze(now);
  else if (hostClock.state === "idle") hostClock.restart(now, hostClock.running);
}

function updateStateLabels(state) {
  const isIdle = state === "idle";
  const isMain = state === "idle" || state === "work";
  const label = stateSelect.selectedOptions[0].textContent.split(" · ")[0];
  const timingMs = sequenceDuration(state, "hostDot");
  $("#host-title").textContent = `${isMain ? "Dot host" : "桌面端扩展"} · ${label}`;
  $("#host-subtitle").textContent = `${isMain ? "宿主节奏" : "桌面端动作参考"} · 原始 192 × 208 单元格`;
  $("#state-description").textContent = isMain
    ? `${label}循环 · Dot 主模式${state === "work" ? "（持续工作时重复）" : ""}`
    : `${label} · 桌面端扩展动作，按宿主参考时序循环`;
  const count = hostClock.durations.length;
  $("#state-tag").textContent = `${count} 帧${loopToggle.checked ? "循环" : "单次"}`;
  $("#host-cycle").textContent = seconds(timingMs);
  $("#old-cycle").textContent = isIdle ? seconds(sequenceDuration("idle", "oldPreview")) : "无旧版参考";
  if (isIdle) {
    $("#old-panel").querySelector("h3").textContent = "旧预览 · 待机";
    $("#old-panel").querySelector(".panel-subtitle").textContent = "旧预览待机节奏 · 6.0× 快于宿主";
  } else {
    $("#old-panel").querySelector("h3").textContent = "旧预览对照";
    $("#old-panel").querySelector(".panel-subtitle").textContent = "这个状态没有旧预览时序记录；参考见左侧宿主帧";
    $("#old-panel").querySelector(".placeholder").textContent = "没有旧版\n时序参考";
  }
}

function applyPointerGaze(angle, now = performance.now()) {
  if (!gazeToggle.checked || !atlasFormat || !canUseGaze(hostClock.state, atlasFormat.rows)) return;
  try {
    const cell = getGazeCell(angle, atlasFormat.rows);
    if (dotController) dotController.pointerMove({ angle, inInteractionPath: true, insideBounds: true });
    else hostClock.setGaze(angle, atlasFormat.rows, now);
    lastPointerAngle = cell.angle;
    updateControls(now);
    reschedulePlayback();
  } catch (error) {
    gazeToggle.checked = false;
    hostClock.clearGaze(now);
    showFileStatus(error.message, "error");
    updateControls(now);
    reschedulePlayback();
  }
}

function setState(state) {
  if (dotModeToggle.checked && ["idle", "work"].includes(state)) {
    dotContext.value = state === "work" ? "working" : "idle";
    applyDotContext();
    return;
  }
  if (dotController) {
    dotController.destroy();
    dotController = null;
    dotModeToggle.checked = false;
    simulatedHidden = false;
  }
  const now = performance.now();
  gazeRequested = false;
  gazeToggle.checked = false;
  hostClock = new PlaybackClock({ state, profile: "hostDot", now, loop: loopToggle.checked });
  oldClock = state === "idle" ? new PlaybackClock({ state: "idle", profile: "oldPreview", now, loop: loopToggle.checked }) : null;
  updateGazeAvailability();
  updateStateLabels(state);
  updateControls(now);
  reschedulePlayback();
}

function onPointerMove(event) {
  if (dotController) return;
  pointerInside = true;
  const bounds = $("#host-stage").getBoundingClientRect();
  lastPointerAngle = pointerAngleDegrees(event.clientX, event.clientY, bounds);
  if (gazeToggle.checked && atlasFormat) applyPointerGaze(lastPointerAngle);
}

function onPointerLeave() {
  if (dotController) return;
  pointerInside = false;
  if (hostClock?.gaze) hostClock.clearGaze(performance.now());
  updateControls();
  reschedulePlayback();
}

async function loadAtlas(file, generation) {
  if (!file || !atlasLoadGeneration.isCurrent(generation)) return;
  const extension = file.name.toLowerCase().split(".").pop();
  const allowedTypes = new Set(["image/png", "image/webp"]);
  if ((file.type && !allowedTypes.has(file.type)) || (!allowedTypes.has(file.type) && !["png", "webp"].includes(extension))) {
    showFileStatus("请选择 PNG 或 WebP 图集。", "error");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showFileStatus("文件超过 32 MiB；为保持预览器轻量，请先导出更小的图集文件。", "error");
    return;
  }

  showFileStatus("正在本机解码并检查尺寸…");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!atlasLoadGeneration.isCurrent(generation)) {
      bitmap.close();
      return;
    }
    const format = validateAtlasDimensions(bitmap.width, bitmap.height);
    const now = performance.now();
    const hostShouldRun = hostClock.restore?.running ?? hostClock.running;
    const oldShouldRun = oldClock?.running ?? false;
    if (atlasBitmap) atlasBitmap.close();
    atlasBitmap = bitmap;
    atlasFormat = format;
    pointerInside = false;
    gazeToggle.checked = false;
    oldClock?.restart(now, oldShouldRun);
    if (dotModeToggle.checked) createDotPlayback(now, hostShouldRun);
    else hostClock.restart(now, hostShouldRun);
    updateGazeAvailability();
    showFileStatus(`已载入 ${format.version} 图集 · ${bitmap.width} × ${bitmap.height} · ${format.rows} 行；图像仅保留在当前页面内存中。播放从当前状态首帧开始。`, "success");
    updateControls(now);
    reschedulePlayback();
  } catch (error) {
    bitmap?.close();
    if (atlasLoadGeneration.isCurrent(generation)) {
      showFileStatus(error instanceof RangeError ? error.message : "无法解码此图像，请确认文件是有效的 PNG 或 WebP。", "error");
    }
  }
}

fileInput.addEventListener("change", () => {
  const generation = atlasLoadGeneration.begin();
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void loadAtlas(file, generation);
});
stateSelect.addEventListener("change", () => setState(stateSelect.value));
$("#play-button").addEventListener("click", () => {
  const now = performance.now();
  const snapshot = hostClock.snapshot(now);
  if (snapshot.gaze) return;
  if (snapshot.running) {
    hostClock.pause(now);
    oldClock?.pause(now);
  } else {
    hostClock.resume(now);
    oldClock?.resume(now);
  }
  updateControls(now);
  reschedulePlayback();
});
$("#previous-button").addEventListener("click", () => {
  const now = performance.now();
  oldClock?.step(-1, now);
  hostClock.step(-1, now);
  updateControls(now);
  reschedulePlayback();
});
$("#next-button").addEventListener("click", () => {
  const now = performance.now();
  oldClock?.step(1, now);
  hostClock.step(1, now);
  updateControls(now);
  reschedulePlayback();
});
$("#reset-button").addEventListener("click", () => {
  const now = performance.now();
  hostClock.reset(now);
  oldClock?.reset(now);
  updateControls(now);
  reschedulePlayback();
});
loopToggle.addEventListener("change", () => {
  const now = performance.now();
  hostClock.setLoop(loopToggle.checked, now);
  oldClock?.setLoop(loopToggle.checked, now);
  updateStateLabels(stateSelect.value);
  updateControls(now);
  reschedulePlayback();
});
pixelToggle.addEventListener("change", () => {
  $("#host-stage").classList.toggle("smooth", !pixelToggle.checked);
  $("#old-stage").classList.toggle("smooth", !pixelToggle.checked);
  updateControls();
});
$("#size-select").addEventListener("change", (event) => {
  document.documentElement.style.setProperty("--preview-size", `${event.target.value}px`);
});
gazeToggle.addEventListener("change", () => {
  const now = performance.now();
  gazeRequested = gazeToggle.checked;
  if (gazeToggle.checked) {
    if (!atlasFormat || !canUseGaze(hostClock.state, atlasFormat.rows)) {
      gazeToggle.checked = false;
      showFileStatus("视线跟随仅支持 v2 图集的待机状态。", "error");
      return;
    }
    try {
      getGazeCell(0, atlasFormat.rows);
      if (lastPointerAngle !== null && pointerInside) applyPointerGaze(lastPointerAngle, now);
    } catch (error) {
      gazeToggle.checked = false;
      showFileStatus(error.message, "error");
    }
  } else {
    stopGazeTracking(now);
    showFileStatus(atlasFormat ? `${atlasFormat.version} 图集已载入；视线覆盖结束，待机从首帧重新开始。` : "尚未载入图集。预览器不会保存或上传所选文件。", atlasFormat ? "success" : "");
  }
  updateControls(now);
  reschedulePlayback();
});
$("#clear-gaze-button").addEventListener("click", () => {
  const now = performance.now();
  gazeRequested = false;
  gazeToggle.checked = false;
  stopGazeTracking(now);
  updateControls(now);
  reschedulePlayback();
});
$("#idle-button").addEventListener("click", () => {
  gazeRequested = false;
  gazeToggle.checked = false;
  stateSelect.value = "idle";
  loopToggle.checked = true;
  setState("idle");
  dotController?.cancelPointer({ resetInside: true });
  const now = performance.now();
  const running = !dotController || motionToggle.checked;
  hostClock.restart(now, running);
  oldClock?.restart(now, running);
  updateControls(now);
  reschedulePlayback();
});
$("#host-stage").addEventListener("pointermove", onPointerMove);
$("#host-stage").addEventListener("pointerenter", () => { pointerInside = true; });
$("#host-stage").addEventListener("pointerleave", onPointerLeave);
dotModeToggle.addEventListener("change", () => {
  gazeRequested = false;
  gazeToggle.checked = false;
  pointerInside = false;
  if (dotModeToggle.checked) {
    if (!["idle", "work"].includes(hostClock.state)) dotContext.value = "idle";
    applyDotContext();
  } else setState(hostClock.state);
});
dotContext.addEventListener("change", applyDotContext);
conversationActive.addEventListener("change", applyDotContext);
motionToggle.addEventListener("change", () => {
  if (!dotController) return;
  const now = performance.now();
  dotController.setMotionEnabled(motionToggle.checked);
  oldClock?.restart(now, motionToggle.checked);
  updateGazeAvailability();
  updateControls(now);
  reschedulePlayback();
});
window.addEventListener("pointermove", (event) => {
  if (!dotController || !atlasFormat || simulatedHidden) return;
  const stage = $("#host-stage");
  const bounds = stage.getBoundingClientRect();
  const inPath = event.composedPath().includes(stage);
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  pointerInside = inPath && inside;
  lastPointerAngle = pointerAngleDegrees(event.clientX, event.clientY, bounds);
  if (gazeToggle.checked) dotController.pointerMove({ angle: lastPointerAngle, inInteractionPath: inPath, insideBounds: inside, pointerType: event.pointerType, isPrimary: event.isPrimary });
}, true);
window.addEventListener("pointercancel", () => dotController?.cancelPointer());
window.addEventListener("blur", () => dotController?.blur());
document.addEventListener("visibilitychange", () => dotController?.setDocumentHidden(document.hidden));
$("#blur-button").addEventListener("click", () => { dotController?.blur(); updateControls(); });
$("#hidden-button").addEventListener("click", () => {
  simulatedHidden = !simulatedHidden;
  dotController?.setDocumentHidden(simulatedHidden);
  updateControls();
});
window.addEventListener("beforeunload", () => {
  playbackScheduler.cancel();
  dotController?.destroy();
  atlasBitmap?.close();
}, { once: true });

if (dotModeToggle.checked) applyDotContext();
updateGazeAvailability();
updateStateLabels("idle");
updateControls();
reschedulePlayback();
function animate(now) {
  updateControls(now);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
