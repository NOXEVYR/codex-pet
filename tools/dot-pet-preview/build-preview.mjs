import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const indexPath = join(directory, "index.html");
const [html, timingModule, viewerModule] = await Promise.all([
  readFile(indexPath, "utf8"),
  readFile(join(directory, "timing.mjs"), "utf8"),
  readFile(join(directory, "viewer.mjs"), "utf8"),
]);

const startMarker = "<!-- PREVIEW-APP-START -->";
const endMarker = "<!-- PREVIEW-APP-END -->";
if (!html.includes(startMarker) || !html.includes(endMarker)) {
  throw new Error("index.html is missing the inline preview markers.");
}

const browserTiming = timingModule.replace(/^export\s+/gm, "");
if (/^\s*export\s/m.test(browserTiming)) throw new Error("A timing module export was not bundled.");
if (!viewerModule.includes("globalThis.DotPetTiming")) throw new Error("viewer.mjs must use the shared timing API.");

const inlineApp = `(() => {\n  (() => {\n${browserTiming}\n\n    globalThis.DotPetTiming = {\n      CELL_HEIGHT, CELL_WIDTH, LoadGeneration, PlaybackClock, PlaybackScheduler,\n      canUseGaze, getGazeCell, pointerAngleDegrees, sequenceDuration, validateAtlasDimensions,\n    };\n  })();\n\n${viewerModule}\n})();`;
const block = `${startMarker}\n  <script>\n${inlineApp}\n  </script>\n  ${endMarker}`;
const markerBlock = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);
const builtHtml = html.replace(markerBlock, block);
await writeFile(indexPath, builtHtml, "utf8");
console.log("Built standalone offline index.html with inlined timing and viewer code.");
