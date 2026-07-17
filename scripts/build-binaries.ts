/**
 * Build standalone binaries using Bun's --compile feature.
 *
 * Produces platform-specific executables that don't require Node.js or Bun
 * to be installed on the target machine.
 *
 * Usage:
 *   bun scripts/build-binaries.ts           Build for current platform
 *   bun scripts/build-binaries.ts --all     Cross-compile for all platforms
 */

import { mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "bin");

interface Target {
  name: string;
  bunTarget: string;
  ext: string;
}

const TARGETS: Target[] = [
  { name: "nexusgate-windows-x64", bunTarget: "bun-windows-x64", ext: ".exe" },
  { name: "nexusgate-linux-x64", bunTarget: "bun-linux-x64", ext: "" },
  { name: "nexusgate-darwin-arm64", bunTarget: "bun-darwin-arm64", ext: "" },
];

function buildBinary(target: Target) {
  const outFile = join(OUT_DIR, target.name + target.ext);
  console.log(`\n📦 Building ${target.name}...`);

  try {
    execSync(
      `bun build --compile --minify --target=${target.bunTarget} cli/index.ts --outfile "${outFile}"`,
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );
    console.log(`✅ Built: ${outFile}`);
  } catch (err) {
    console.error(`❌ Failed to build ${target.name}:`, err);
  }
}

// Ensure output dir
mkdirSync(OUT_DIR, { recursive: true });

// Check if CLI source exists
const cliEntry = join(ROOT, "cli", "index.ts");
if (!existsSync(cliEntry)) {
  console.error("❌ CLI entry point not found:", cliEntry);
  process.exit(1);
}

const buildAll = process.argv.includes("--all");

if (buildAll) {
  console.log("🏗  Building binaries for all platforms...");
  for (const target of TARGETS) {
    buildBinary(target);
  }
  console.log(`\n✅ All binaries built in ${OUT_DIR}/`);
} else {
  // Build for current platform only
  const current =
    process.platform === "win32"
      ? TARGETS[0]
      : process.platform === "darwin"
      ? TARGETS[2]
      : TARGETS[1];

  console.log(`🏗  Building for current platform (${current.name})...`);
  buildBinary(current);
  console.log(`\n✅ Binary built at ${OUT_DIR}/${current.name}${current.ext}`);
}
