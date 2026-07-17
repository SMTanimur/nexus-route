#!/usr/bin/env node

/**
 * NexusGate CLI — starts the backend API + frontend dashboard.
 *
 * Usage:
 *   nexusgate                 Start both servers + open browser
 *   nexusgate start           Same as above
 *   nexusgate stop            Stop any running NexusGate processes
 *   nexusgate version         Print version
 *   nexusgate --port 5000     Use custom ports
 *   nexusgate --no-browser    Don't auto-open browser
 *
 * The CLI spawns two child processes:
 *   1. NestJS backend  (nexus-api/dist/main.js)  → port API_PORT (default 4444)
 *   2. Next.js server  (.next/standalone/server.js) → port WEB_PORT (default 4200)
 *
 * On Ctrl+C or process termination, both children are cleaned up.
 */

import { spawn, ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";

// In CJS (esbuild output), __dirname is available natively.
// In ESM (Bun), it's not — fall back to process.cwd().
const PKG_ROOT = typeof __dirname !== "undefined"
  ? resolve(__dirname, "..")
  : process.cwd();

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) env[key] = val;
    }
  } catch {
    // ignore
  }
  return env;
}

// ─── Colors (no dependency — raw ANSI) ────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function log(msg: string) {
  console.log(`${c.cyan}[nexusgate]${c.reset} ${msg}`);
}

function warn(msg: string) {
  console.warn(`${c.yellow}[nexusgate]${c.reset} ${msg}`);
}

function error(msg: string) {
  console.error(`${c.red}[nexusgate]${c.reset} ${msg}`);
}

// ─── Args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0] || "start";

// Parse flags
function getFlag(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const env = process.env[name.toUpperCase().replace(/-/g, "_")];
  return env || defaultValue;
}

const API_PORT = parseInt(getFlag("api-port", "4444")!, 10);
const WEB_PORT = parseInt(getFlag("port", "4200")!, 10);
const HOST = getFlag("host", "0.0.0.0")!;
const NO_BROWSER = args.includes("--no-browser");

// ─── Version ──────────────────────────────────────────────────
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

// ─── Open browser ─────────────────────────────────────────────
function openBrowser(url: string) {
  if (NO_BROWSER) return;
  try {
    const cmd =
      platform() === "win32" ? `start "" "${url}"` :
      platform() === "darwin" ? `open "${url}"` :
      `xdg-open "${url}"`;
    execSync(cmd, { stdio: "ignore" });
  } catch {
    // Browser open failed — not critical
  }
}

// ─── Start servers ────────────────────────────────────────────
let apiProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;
let isShuttingDown = false;

function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("Shutting down...");

  if (apiProcess && !apiProcess.killed) {
    log("Stopping API server...");
    try {
      if (platform() === "win32") {
        execSync(`taskkill /pid ${apiProcess.pid} /T /F`, { stdio: "ignore" });
      } else {
        apiProcess.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }

  if (webProcess && !webProcess.killed) {
    log("Stopping web server...");
    try {
      if (platform() === "win32") {
        execSync(`taskkill /pid ${webProcess.pid} /T /F`, { stdio: "ignore" });
      } else {
        webProcess.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }

  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

async function start() {
  const version = getVersion();

  console.log(`
${c.magenta}${c.bold}  ╔╗ ╔╗${c.reset}  ${c.bold}NexusGate v${version}${c.reset}
${c.magenta}${c.bold}  ║║ ║║${c.reset}  ${c.dim}The Intelligent AI Nexus${c.reset}
${c.magenta}${c.bold}  ║╚═╝║${c.reset}  ${c.dim}https://nexusgate.dev${c.reset}
${c.magenta}${c.bold}  ╚═══╝${c.reset}
`);

  // Resolve paths to built artifacts
  const apiEntry = join(PKG_ROOT, "nexus-api", "dist", "main.js");
  const webEntry = join(PKG_ROOT, ".next", "standalone", "server.js");

  if (!existsSync(apiEntry)) {
    error(`Backend not built. Expected: ${apiEntry}`);
    warn("Run: npm run build:api");
    process.exit(1);
  }

  if (!existsSync(webEntry)) {
    error(`Frontend not built. Expected: ${webEntry}`);
    warn("Run: npm run build:web");
    process.exit(1);
  }

  // 1. Start API server (NestJS)
  log(`Starting API server on ${c.bold}:${API_PORT}${c.reset}...`);
  // Load local .env and package .env if they exist
  const localEnv = loadEnvFile(join(process.cwd(), ".env"));
  const pkgEnv = loadEnvFile(join(PKG_ROOT, ".env"));

  // Merge default environment variables, loaded files, and process environment variables
  const apiEnv = {
    // Defaults for running out of the box
    MONGODB_URI: "mongodb+srv://Tanimur:Tani1234@cluster0.77x40ds.mongodb.net/nexusgate",
    JWT_ACCESS_SECRET: "sdgdsgdsgsdgsdg",
    JWT_REFRESH_SECRET: "sdgdsgsdgsd",
    ENCRYPTION_KEY: "68d1838634fa68b752df23d2427a199fa68b752df23d2427af4758d4cf7fbe2d",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "7d",
    
    // User configurations
    ...pkgEnv,
    ...localEnv,
    ...process.env,
    
    // Overrides
    PORT: String(API_PORT),
    HOST,
  };

  apiProcess = spawn("node", [apiEntry], {
    env: apiEnv,
    stdio: ["inherit", "pipe", "pipe"],
    cwd: join(PKG_ROOT, "nexus-api"),
  });

  apiProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`${c.dim}[api]${c.reset} ${line}`);
  });
  apiProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error(`${c.dim}[api]${c.reset} ${line}`);
  });

  apiProcess.on("exit", (code) => {
    if (!isShuttingDown && code !== 0) {
      error(`API server exited with code ${code}`);
    }
  });

  // Wait a moment for API to boot
  await new Promise((r) => setTimeout(r, 2000));

  // 2. Start web server (Next.js standalone)
  log(`Starting dashboard on ${c.bold}http://localhost:${WEB_PORT}${c.reset}...`);
  webProcess = spawn("node", [webEntry], {
    env: {
      ...process.env,
      PORT: String(WEB_PORT),
      HOSTNAME: HOST,
      NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
    },
    stdio: ["inherit", "pipe", "pipe"],
    cwd: PKG_ROOT,
  });

  webProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`${c.dim}[web]${c.reset} ${line}`);
  });
  webProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.error(`${c.dim}[web]${c.reset} ${line}`);
  });

  webProcess.on("exit", (code) => {
    if (!isShuttingDown && code !== 0) {
      error(`Web server exited with code ${code}`);
    }
  });

  // Wait for web server to be ready
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Print status + open browser
  console.log();
  log(`${c.green}✓${c.reset} NexusGate is running!`);
  console.log();
  console.log(`  ${c.bold}Dashboard:${c.reset}  ${c.cyan}http://localhost:${WEB_PORT}${c.reset}`);
  console.log(`  ${c.bold}API:${c.reset}         ${c.cyan}http://localhost:${API_PORT}/api${c.reset}`);
  console.log(`  ${c.bold}Swagger:${c.reset}     ${c.cyan}http://localhost:${API_PORT}/api/docs${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Press Ctrl+C to stop${c.reset}`);
  console.log();

  openBrowser(`http://localhost:${WEB_PORT}`);
}

// ─── Stop ─────────────────────────────────────────────────────
function stop() {
  log("Stopping NexusGate...");
  try {
    if (platform() === "win32") {
      // Kill processes on the API and web ports
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${API_PORT}.*LISTENING"') do taskkill /pid %a /T /F`,
        { stdio: "ignore", shell: "cmd.exe" },
      );
      execSync(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${WEB_PORT}.*LISTENING"') do taskkill /pid %a /T /F`,
        { stdio: "ignore", shell: "cmd.exe" },
      );
    } else {
      execSync(`lsof -ti:${API_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
      execSync(`lsof -ti:${WEB_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
    log("Stopped.");
  } catch {
    warn("Could not stop processes automatically.");
  }
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────
switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "version":
  case "-v":
  case "--version":
    console.log(`nexusgate v${getVersion()}`);
    break;
  case "help":
  case "-h":
  case "--help":
    console.log(`
${c.bold}NexusGate${c.reset} — The Intelligent AI Gateway

${c.bold}Usage:${c.reset}
  nexusgate                    Start API + dashboard servers
  nexusgate start              Same as above
  nexusgate stop               Stop running servers
  nexusgate version            Show version

${c.bold}Options:${c.reset}
  --port <number>              Web dashboard port (default: 4200)
  --api-port <number>          API server port (default: 4444)
  --host <addr>                Bind address (default: 0.0.0.0)
  --no-browser                 Don't auto-open browser

${c.bold}Examples:${c.reset}
  nexusgate                    Start everything on default ports
  nexusgate --port 3000        Use port 3000 for dashboard
  nexusgate --no-browser       Start without opening browser
`);
    break;
  default:
    error(`Unknown command: ${command}`);
    console.log("Run `nexusgate help` for usage.");
    process.exit(1);
}
