/** 零依赖静态扫描：未定义引用回归 + 关键 DOM 契约（53 个 id 存在且唯一）。
 *  阈值一致性断言在 S1 的 T-UX-17 追加，本文件不预置占位跳过。 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "frontend", "js");
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (entry.endsWith(".js")) {
      files.push(full);
    }
  }
}

walk(target);

const pattern = /(^|[^\w$.])void\s+([A-Za-z_$][\w$]*)\s*;/;
let hits = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (pattern.test(line)) {
      hits += 1;
      process.stderr.write(`${path.relative(root, file)}:${index + 1}: ${line.trim()}\n`);
    }
  });
}

const REQUIRED_IDS = [
  "startup-banner",
  "startup-title",
  "startup-checks",
  "startup-retry",
  "startup-enter",
  "python-chip",
  "version-chip",
  "mode-chip",
  "run-state-chip",
  "course-panel",
  "course-content",
  "prediction-box",
  "prediction-label",
  "prediction-input",
  "prediction-submit",
  "prediction-feedback",
  "toolbox",
  "toolbox-list",
  "block-canvas",
  "canvas-empty",
  "canvas-title",
  "a11y-mirror",
  "code-preview-text",
  "run-button",
  "stop-button",
  "reset-button",
  "run-hint",
  "stage-actor",
  "object-meta",
  "result-content",
  "prediction-compare",
  "compare-prediction",
  "compare-actual",
  "compare-match",
  "live-output",
  "tutor-message",
  "tutor-detail",
  "tutor-input",
  "tutor-submit",
  "tutor-mode-badge",
  "summary-panel",
  "summary-content",
  "summary-variant",
  "summary-skipped",
  "summary-finish",
  "toast",
  "save-project",
  "open-project",
  "project-file",
  "summary-open",
  "confirm-dialog",
  "confirm-title",
  "confirm-text",
];

const html = readFileSync(path.join(root, "frontend", "index.html"), "utf-8");
const idPattern = /\sid\s*=\s*"([^"]+)"/g;
const idCounts = new Map();
let match = idPattern.exec(html);
while (match) {
  idCounts.set(match[1], (idCounts.get(match[1]) || 0) + 1);
  match = idPattern.exec(html);
}

for (const id of REQUIRED_IDS) {
  const count = idCounts.get(id) || 0;
  if (count === 0) {
    hits += 1;
    process.stderr.write(`frontend/index.html: missing required id "${id}"\n`);
  } else if (count > 1) {
    hits += 1;
    process.stderr.write(`frontend/index.html: duplicated id "${id}" (${count})\n`);
  }
}

for (const [id, count] of idCounts) {
  if (count > 1) {
    hits += 1;
    process.stderr.write(`frontend/index.html: duplicated id "${id}" (${count})\n`);
  }
}

if (hits > 0) {
  process.stderr.write(`JS-STATIC-CHECK FAILED: ${hits} hit(s)\n`);
  process.exitCode = 1;
} else {
  console.log("JS-STATIC-CHECK PASSED");
}