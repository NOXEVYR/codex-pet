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

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const $ = (selector) => document.querySelector(selector);
const fileInput = $("#atlas-file");
const fileStatus = $("#file-status");
const stateSelect = $("#state-select");
const loopToggle = $("#loop-toggle");
const pixelToggle = $("#pixel-toggle");
const gazeToggle = $("#gaze-toggle");
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
const playbackScheduler = new PlaybackScheduler({
  getClocks: () => [hostClock, oldClock],
  now: () => performance.now(),
  setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeoutFn: (timer) => window.clearTimeout(timer),
  onFrame: (now) => updateControls(now),
});

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
  $("#play-button").disabled = Boolean(host.gaze);
  $("#previous-button").disabled = Boolean(host.gaze);
  $("#next-button").disabled = Boolean(host.gaze);
  $("#reset-button").disabled = Boolean(host.gaze);
  $("#clear-gaze-button").disabled = !gazeToggle.checked;
  loopToggle.disabled = Boolean(host.gaze);
  if (gazeToggle.checked) {
    $("#gaze-status").textContent = host.gaze
      ? `视线 ${host.gaze.angle}° · 覆盖动画`
      : pointerInside ? "指针跟随开启" : "指针跟随开启 · 在角色框内移动鼠标";
  } else {
    $("#gaze-status").textContent = "指针跟随关闭";
  }
}

function updateGazeAvailability() {
  const available = canUseGaze(hostClock.state, atlasFormat?.rows);
  if (!available) {
    gazeToggle.checked = false;
    if (hostClock.gaze) hostClock.clearGaze(performance.now());
  }
  gazeToggle.disabled = !available;
}

function stopGazeTracking(now) {
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
    hostClock.setGaze(angle, atlasFormat.rows, now);
    lastPointerAngle = cell.angle;
    updateControls(now);
    playbackScheduler.schedule();
  } catch (error) {
    gazeToggle.checked = false;
    hostClock.clearGaze(now);
    showFileStatus(error.message, "error");
    updateControls(now);
    playbackScheduler.schedule();
  }
}

function setState(state) {
  const now = performance.now();
  gazeToggle.checked = false;
  hostClock = new PlaybackClock({ state, profile: "hostDot", now, loop: loopToggle.checked });
  oldClock = state === "idle" ? new PlaybackClock({ state: "idle", profile: "oldPreview", now, loop: loopToggle.checked }) : null;
  updateGazeAvailability();
  updateStateLabels(state);
  updateControls(now);
  playbackScheduler.schedule();
}

function onPointerMove(event) {
  pointerInside = true;
  const bounds = $("#host-stage").getBoundingClientRect();
  lastPointerAngle = pointerAngleDegrees(event.clientX, event.clientY, bounds);
  if (gazeToggle.checked && atlasFormat) applyPointerGaze(lastPointerAngle);
}

function onPointerLeave() {
  pointerInside = false;
  if (hostClock?.gaze) hostClock.clearGaze(performance.now());
  updateControls();
  playbackScheduler.schedule();
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
    gazeToggle.checked = false;
    hostClock.restart(now, hostShouldRun);
    oldClock?.restart(now, oldShouldRun);
    updateGazeAvailability();
    showFileStatus(`已载入 ${format.version} 图集 · ${bitmap.width} × ${bitmap.height} · ${format.rows} 行；图像仅保留在当前页面内存中。播放从当前状态首帧开始。`, "success");
    updateControls(now);
    playbackScheduler.schedule();
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
  playbackScheduler.schedule();
});
$("#previous-button").addEventListener("click", () => {
  const now = performance.now();
  oldClock?.step(-1, now);
  hostClock.step(-1, now);
  updateControls(now);
  playbackScheduler.schedule();
});
$("#next-button").addEventListener("click", () => {
  const now = performance.now();
  oldClock?.step(1, now);
  hostClock.step(1, now);
  updateControls(now);
  playbackScheduler.schedule();
});
$("#reset-button").addEventListener("click", () => {
  const now = performance.now();
  hostClock.reset(now);
  oldClock?.reset(now);
  updateControls(now);
  playbackScheduler.schedule();
});
loopToggle.addEventListener("change", () => {
  const now = performance.now();
  hostClock.setLoop(loopToggle.checked, now);
  oldClock?.setLoop(loopToggle.checked, now);
  updateStateLabels(stateSelect.value);
  updateControls(now);
  playbackScheduler.schedule();
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
  playbackScheduler.schedule();
});
$("#clear-gaze-button").addEventListener("click", () => {
  const now = performance.now();
  gazeToggle.checked = false;
  stopGazeTracking(now);
  updateControls(now);
  playbackScheduler.schedule();
});
$("#idle-button").addEventListener("click", () => {
  gazeToggle.checked = false;
  stateSelect.value = "idle";
  loopToggle.checked = true;
  setState("idle");
});
$("#host-stage").addEventListener("pointermove", onPointerMove);
$("#host-stage").addEventListener("pointerenter", () => { pointerInside = true; });
$("#host-stage").addEventListener("pointerleave", onPointerLeave);
window.addEventListener("beforeunload", () => {
  playbackScheduler.cancel();
  atlasBitmap?.close();
}, { once: true });

updateGazeAvailability();
updateStateLabels("idle");
updateControls();
playbackScheduler.schedule();
function animate(now) {
  updateControls(now);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
