/** 零依赖静态扫描：禁止 `void <identifier>;` 形式的未定义引用回归。 */
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

if (hits > 0) {
  process.stderr.write(`JS-STATIC-CHECK FAILED: ${hits} hit(s)\n`);
  process.exitCode = 1;
} else {
  console.log("JS-STATIC-CHECK PASSED");
}