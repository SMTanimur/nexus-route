#!/usr/bin/env node

/**
 * NexusGate CLI — starts the backend API + frontend dashboard.
 *
 * Usage:
 *   nexusgate                         Start both servers + open browser
 *   nexusgate start                   Same as above
 *   nexusgate init                    Override built-in config (use your own MongoDB)
 *   nexusgate cloud-connect <url>     Connect to a hosted NexusGate cloud instance
 *   nexusgate cloud-connect <url> -k <key>   Connect with a registration key
 *   nexusgate stop                    Stop any running NexusGate processes
 *   nexusgate version                 Print version
 *   nexusgate --port 5000             Use custom ports
 *   nexusgate --no-browser            Don't auto-open browser
 *
 * Database modes (priority order — highest wins):
 *   1. OS environment variables (MONGODB_URI etc.)
 *   2. ~/.nexusgate/config.env  (written by `nexusgate init`)
 *   3. ~/.nexusgate/cloud.token (written by `nexusgate cloud-connect`)
 *   4. Built-in defaults baked into the backend binary (zero-config out of the box)
 */

import { spawn, ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, homedir } from "node:os";
import { createInterface } from "node:readline";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";

const PKG_ROOT = typeof __dirname !== "undefined"
  ? resolve(__dirname, "..")
  : process.cwd();

// ─── Config paths (home dir — never in project repo) ──────────
const CONFIG_DIR = join(homedir(), ".nexusgate");
const CONFIG_FILE = join(CONFIG_DIR, "config.env");       // written by `nexusgate init`
const CLOUD_TOKEN_FILE = join(CONFIG_DIR, "cloud.token"); // written by `nexusgate cloud-connect`
const CLOUD_META_FILE = join(CONFIG_DIR, "cloud.json");   // cloud server metadata

// ─── Colors ───────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function log(msg: string)  { console.log(`${c.cyan}[nexusgate]${c.reset} ${msg}`); }
function warn(msg: string) { console.warn(`${c.yellow}[nexusgate]${c.reset} ${msg}`); }
function error(msg: string){ console.error(`${c.red}[nexusgate]${c.reset} ${msg}`); }
function info(msg: string) { console.log(`${c.blue}[nexusgate]${c.reset} ${msg}`); }

// ─── Args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0] || "start";

function getFlag(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const shortIdx = args.indexOf(`-${name[0]}`);
  if (shortIdx !== -1 && args[shortIdx + 1]) return args[shortIdx + 1];
  const env = process.env[name.toUpperCase().replace(/-/g, "_")];
  return env || defaultValue;
}

const API_PORT  = parseInt(getFlag("api-port", "4444")!, 10);
const WEB_PORT  = parseInt(getFlag("port", "4200")!, 10);
const HOST      = getFlag("host", "0.0.0.0")!;
const NO_BROWSER = args.includes("--no-browser");

// ─── Version ──────────────────────────────────────────────────
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    return pkg.version || "1.0.0";
  } catch { return "1.0.0"; }
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
  } catch { /* not critical */ }
}

// ─── Crypto helpers ───────────────────────────────────────────
function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/** AES-256-GCM key derived from machine identity — tokens are machine-bound. */
function getMachineKey(): Buffer {
  const seed = `${process.env.COMPUTERNAME || process.env.HOSTNAME || "host"}-${process.env.USERNAME || process.env.USER || "user"}-nexusgate`;
  const buf = Buffer.alloc(32);
  Buffer.from(seed).copy(buf);
  return buf;
}

function encryptToken(plaintext: string): string {
  const key = getMachineKey();
  const iv  = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

function decryptToken(token: string): string | null {
  try {
    const key = getMachineKey();
    const buf = Buffer.from(token, "base64url");
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final("utf8");
  } catch { return null; }
}

// ─── HTTP helpers ─────────────────────────────────────────────
function httpGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

function httpPost(url: string, payload: any, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(payload);
    const lib    = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith("https") ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── .env file helpers ────────────────────────────────────────
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
      let val   = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) env[key] = val;
    }
  } catch { /* ignore */ }
  return env;
}

function saveEnvFile(filePath: string, values: Record<string, string>) {
  const lines = [
    "# NexusGate Configuration — generated by 'nexusgate init'",
    "# Lives in your home directory — NEVER committed to git.",
    "# To reconfigure: nexusgate init --force",
    "",
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── Prompt helper ────────────────────────────────────────────
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => { rl.question(question, (a) => { rl.close(); res(a.trim()); }); });
}

// ─── Init wizard (bring your own MongoDB) ─────────────────────
async function init(force = false) {
  console.log(`\n${c.magenta}${c.bold}NexusGate v${getVersion()} — Custom Database Setup${c.reset}\n`);
  console.log(`${c.dim}Use this if you want NexusGate to connect to your own MongoDB instead of the built-in database.${c.reset}\n`);

  if (existsSync(CONFIG_FILE) && !force) {
    const existing = loadEnvFile(CONFIG_FILE);
    if (existing.MONGODB_URI) {
      warn(`Config already exists at: ${c.bold}${CONFIG_FILE}${c.reset}`);
      warn("Run with --force to overwrite:  nexusgate init --force");
      return;
    }
  }

  console.log(`${c.dim}Config will be saved to: ${c.reset}${c.bold}${CONFIG_FILE}${c.reset}`);
  console.log(`${c.dim}(Home directory — never in your project repo)${c.reset}\n`);

  const mongoUri = await prompt(
    `${c.bold}Your MongoDB URI${c.reset} ${c.dim}(e.g. mongodb+srv://user:pass@cluster.mongodb.net/nexusgate)${c.reset}\n> `
  );

  if (!mongoUri || !mongoUri.startsWith("mongodb")) {
    error("Invalid MongoDB URI. Setup aborted.");
    process.exit(1);
  }

  const jwtAccessSecret  = generateSecret(32);
  const jwtRefreshSecret = generateSecret(32);
  const encryptionKey    = generateSecret(32);

  console.log(`\n${c.green}✓${c.reset} Cryptographically secure secrets generated.`);

  ensureConfigDir();
  saveEnvFile(CONFIG_FILE, {
    MONGODB_URI:        mongoUri,
    JWT_ACCESS_SECRET:  jwtAccessSecret,
    JWT_REFRESH_SECRET: jwtRefreshSecret,
    ENCRYPTION_KEY:     encryptionKey,
    JWT_ACCESS_TTL:     "15m",
    JWT_REFRESH_TTL:    "7d",
  });

  console.log(`\n${c.green}${c.bold}✓ Done!${c.reset}`);
  console.log(`  Config saved: ${c.cyan}${CONFIG_FILE}${c.reset}`);
  console.log(`\n${c.dim}Run nexusgate to start.${c.reset}\n`);
}

// ─── Cloud Connect (use a hosted NexusGate server) ────────────
async function cloudConnect(serverUrl: string, registrationKey?: string) {
  const cleanUrl = serverUrl.replace(/\/$/, "");
  console.log(`\n${c.magenta}${c.bold}NexusGate — Cloud Connect${c.reset}`);
  console.log(`${c.dim}Connecting to: ${c.reset}${c.cyan}${cleanUrl}${c.reset}\n`);

  info("Checking server connectivity...");
  let serverMeta: any;
  try {
    const res = await httpGet(`${cleanUrl}/api/v1/health`);
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}`);
    serverMeta = res.body;
    console.log(`  ${c.green}✓${c.reset} Server reachable — NexusGate v${serverMeta?.version || "?"}`);
  } catch (err: any) {
    error(`Cannot reach server: ${err.message}`);
    warn("Make sure the server URL is correct and the API is running.");
    process.exit(1);
  }

  const key = registrationKey || await prompt(
    `${c.bold}Registration Key${c.reset} ${c.dim}(provided by your NexusGate administrator)${c.reset}\n> `
  );

  if (!key) { error("Registration key is required."); process.exit(1); }

  info("Provisioning tenant credentials...");
  let provisionData: any;
  try {
    const res = await httpPost(`${cleanUrl}/api/v1/gateway/provision`, {
      registrationKey: key,
      clientPlatform:  platform(),
    });

    if (res.status === 401 || res.status === 403) {
      error("Invalid or expired registration key."); process.exit(1);
    }
    if (res.status !== 200 && res.status !== 201) {
      error(`Provisioning failed: ${res.body?.message || `HTTP ${res.status}`}`); process.exit(1);
    }
    provisionData = res.body;
  } catch (err: any) {
    error(`Provisioning request failed: ${err.message}`); process.exit(1);
  }

  // Validate required fields in response
  for (const field of ["mongoUri", "jwtAccessSecret", "jwtRefreshSecret", "encryptionKey"]) {
    if (!provisionData[field]) {
      error(`Server response missing field: ${field}`); process.exit(1);
    }
  }

  console.log(`  ${c.green}✓${c.reset} Tenant provisioned: ${provisionData.tenantId || "shared"}`);

  // Encrypt the whole config with a machine-bound AES-256-GCM key.
  // Raw MongoDB URI is NEVER stored in plaintext on disk.
  const encryptedToken = encryptToken(JSON.stringify({
    MONGODB_URI:        provisionData.mongoUri,
    JWT_ACCESS_SECRET:  provisionData.jwtAccessSecret,
    JWT_REFRESH_SECRET: provisionData.jwtRefreshSecret,
    ENCRYPTION_KEY:     provisionData.encryptionKey,
    JWT_ACCESS_TTL:     provisionData.jwtAccessTtl  || "15m",
    JWT_REFRESH_TTL:    provisionData.jwtRefreshTtl || "7d",
    TENANT_ID:          provisionData.tenantId       || "",
  }));

  ensureConfigDir();
  writeFileSync(CLOUD_TOKEN_FILE, encryptedToken, "utf8");
  writeFileSync(CLOUD_META_FILE, JSON.stringify({
    serverUrl:   cleanUrl,
    tenantId:    provisionData.tenantId || "shared",
    connectedAt: new Date().toISOString(),
    version:     serverMeta?.version,
  }, null, 2), "utf8");

  console.log(`\n${c.green}${c.bold}✓ Cloud connection established!${c.reset}`);
  console.log(`  Token: ${c.cyan}${CLOUD_TOKEN_FILE}${c.reset} ${c.dim}(AES-256-GCM encrypted)${c.reset}`);
  console.log(`\n${c.dim}Run nexusgate to start.${c.reset}\n`);
}

// ─── Load runtime env (cloud token → init config → nothing) ───
function loadRuntimeEnv(): Record<string, string | undefined> {
  // Priority 1: cloud-connect token (encrypted)
  if (existsSync(CLOUD_TOKEN_FILE)) {
    const enc       = readFileSync(CLOUD_TOKEN_FILE, "utf8").trim();
    const decrypted = decryptToken(enc);
    if (!decrypted) {
      error("Failed to decrypt cloud config. Token may have been moved from another machine.");
      warn("Re-run: nexusgate cloud-connect <url>");
      process.exit(1);
    }
    try   { return JSON.parse(decrypted) as Record<string, string>; }
    catch { error("Corrupted cloud config token."); process.exit(1); }
  }

  // Priority 2: nexusgate init config
  if (existsSync(CONFIG_FILE)) {
    return loadEnvFile(CONFIG_FILE);
  }

  // Priority 3: nothing — backend will use its built-in defaults
  return {};
}

// ─── Process management ───────────────────────────────────────
let apiProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;
let isShuttingDown = false;

function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("Shutting down...");
  for (const proc of [apiProcess, webProcess]) {
    if (proc && !proc.killed) {
      try {
        platform() === "win32"
          ? execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" })
          : proc.kill("SIGTERM");
      } catch { /* ignore */ }
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT",  cleanup);
process.on("SIGTERM", cleanup);
process.on("exit",    cleanup);

// ─── Start servers ────────────────────────────────────────────
async function start() {
  const version = getVersion();
  console.log(`
${c.magenta}${c.bold}  ╔╗ ╔╗${c.reset}  ${c.bold}NexusGate v${version}${c.reset}
${c.magenta}${c.bold}  ║║ ║║${c.reset}  ${c.dim}The Intelligent AI Nexus${c.reset}
${c.magenta}${c.bold}  ║╚═╝║${c.reset}  ${c.dim}https://nexusgate.dev${c.reset}
${c.magenta}${c.bold}  ╚═══╝${c.reset}
`);

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

  // ─── Resolve active mode ─────────────────────────────────────
  if (existsSync(CLOUD_TOKEN_FILE)) {
    const meta = existsSync(CLOUD_META_FILE)
      ? JSON.parse(readFileSync(CLOUD_META_FILE, "utf8"))
      : {};
    info(`Mode: ${c.green}${c.bold}Cloud${c.reset} — ${c.cyan}${meta.serverUrl || "remote server"}${c.reset}`);
  } else if (existsSync(CONFIG_FILE)) {
    info(`Mode: ${c.yellow}${c.bold}Custom DB${c.reset} — Using ~/.nexusgate/config.env`);
  } else {
    info(`Mode: ${c.cyan}${c.bold}Built-in${c.reset} — Using default database (zero-config)`);
  }

  // ─── Build env for API process ────────────────────────────────
  // Priority (lowest → highest): built-in defaults → cloud/init config → project .env → OS env
  const runtimeSecrets = loadRuntimeEnv();
  const localEnv       = loadEnvFile(join(process.cwd(), ".env"));
  const pkgEnv         = loadEnvFile(join(PKG_ROOT, ".env"));

  const apiEnv: Record<string, string | undefined> = {
    ...runtimeSecrets,   // cloud-connect or nexusgate init secrets
    ...pkgEnv,           // project-level .env (optional override)
    ...localEnv,         // cwd .env (optional override)
    ...process.env,      // OS env vars (highest priority)
    PORT: String(API_PORT),
    HOST,
  };
  // Note: if no MONGODB_URI is set here, the NestJS backend uses its built-in
  // default from config/defaults.ts — no error, zero-config just works.

  // ─── Start API server (NestJS) ────────────────────────────────
  log(`Starting API server on ${c.bold}:${API_PORT}${c.reset}...`);

  apiProcess = spawn("node", [apiEntry], {
    env:   apiEnv,
    stdio: ["inherit", "pipe", "pipe"],
    cwd:   join(PKG_ROOT, "nexus-api"),
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
    if (!isShuttingDown && code !== 0) error(`API server exited with code ${code}`);
  });

  await new Promise((r) => setTimeout(r, 2000));

  // ─── Start web server (Next.js standalone) ────────────────────
  log(`Starting dashboard on ${c.bold}http://localhost:${WEB_PORT}${c.reset}...`);

  webProcess = spawn("node", [webEntry], {
    env: {
      ...process.env,
      PORT:                  String(WEB_PORT),
      HOSTNAME:              HOST,
      NEXT_PUBLIC_API_URL:   `http://localhost:${API_PORT}`,
    },
    stdio: ["inherit", "pipe", "pipe"],
    cwd:   PKG_ROOT,
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
    if (!isShuttingDown && code !== 0) error(`Web server exited with code ${code}`);
  });

  await new Promise((r) => setTimeout(r, 1500));

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
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${API_PORT}.*LISTENING"') do taskkill /pid %a /T /F`, { stdio: "ignore", shell: "cmd.exe" });
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${WEB_PORT}.*LISTENING"') do taskkill /pid %a /T /F`, { stdio: "ignore", shell: "cmd.exe" });
    } else {
      execSync(`lsof -ti:${API_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
      execSync(`lsof -ti:${WEB_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: "ignore" });
    }
    log("Stopped.");
  } catch { warn("Could not stop processes automatically."); }
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────
switch (command) {
  case "init":
    init(args.includes("--force"));
    break;

  case "cloud-connect":
  case "connect": {
    const serverUrl = args[1];
    if (!serverUrl || serverUrl.startsWith("-")) {
      error("Usage: nexusgate cloud-connect <server-url> [-k <registration-key>]");
      process.exit(1);
    }
    cloudConnect(serverUrl, getFlag("k") || getFlag("key"));
    break;
  }

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
  nexusgate                              Start (zero-config, uses built-in database)
  nexusgate init                         Use your own MongoDB database
  nexusgate init --force                 Overwrite existing config
  nexusgate cloud-connect <url>          Connect to a hosted NexusGate server
  nexusgate cloud-connect <url> -k <k>  Connect with a registration key
  nexusgate start                        Same as 'nexusgate'
  nexusgate stop                         Stop running servers
  nexusgate version                      Show version

${c.bold}Options:${c.reset}
  --port <number>        Web dashboard port  (default: 4200)
  --api-port <number>    API server port     (default: 4444)
  --host <addr>          Bind address        (default: 0.0.0.0)
  --no-browser           Don't auto-open browser

${c.bold}Database mode (priority order):${c.reset}
  1. OS environment variables      (MONGODB_URI, JWT_ACCESS_SECRET, ...)
  2. ~/.nexusgate/config.env       (written by 'nexusgate init')
  3. ~/.nexusgate/cloud.token      (written by 'nexusgate cloud-connect')
  4. Built-in defaults             (zero-config, works out of the box)

${c.bold}Cloud token security:${c.reset}
  cloud.token is AES-256-GCM encrypted with a machine-bound key.
  MongoDB URI is NEVER stored in plaintext — only decrypted in memory.

${c.bold}Examples:${c.reset}
  nexusgate                                    Zero-config start
  nexusgate init                               Use your own MongoDB
  nexusgate cloud-connect https://ng.myco.com  Connect to hosted server
  nexusgate --port 3000 --no-browser           Custom port, no browser
`);
    break;

  default:
    error(`Unknown command: ${command}`);
    console.log("Run `nexusgate help` for usage.");
    process.exit(1);
}
