import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

async function boot(root) {
  await page.goto(
    "http://127.0.0.1:8080/alpine.html?smoke=1&memory=256&root=" + encodeURIComponent(root),
    { waitUntil: "load" },
  );

  await page.waitForFunction(
    () => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.endsWith("# ") ||
        /VFS: Unable to mount root fs|No working init found|Kernel panic|Run \/sbin\/init failed/i.test(text);
    },
    null,
    { timeout: 90000 },
  ).catch(() => {});

  const terminal = await page.locator("#serial").inputValue();
  if (!terminal.endsWith("# ")) {
    return { ok: false, terminal };
  }

  await page.evaluate((text) => {
    const emulator = window.__wasmboxAlpineV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, "export PS1='__WASMBX_PROMPT__ '; echo __WASMBX_READY__\n");

  await page.waitForFunction(
    () => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.includes("__WASMBX_READY__") && text.endsWith("__WASMBX_PROMPT__ ");
    },
    null,
    { timeout: 15000 },
  );

  return { ok: true, terminal: await page.locator("#serial").inputValue() };
}

let bootResult = await boot("/dev/sda");
let rootUsed = "/dev/sda";
if (!bootResult.ok) {
  const firstFailure = bootResult.terminal;
  bootResult = await boot("/dev/hda");
  rootUsed = "/dev/hda";
  if (!bootResult.ok) {
    throw new Error(
      "Alpine が /dev/sda と /dev/hda のどちらでもシェルまで起動しませんでした。\n" +
      "root=/dev/sda:\n" + firstFailure.slice(-12000) +
      "\nroot=/dev/hda:\n" + bootResult.terminal.slice(-12000),
    );
  }
}

let commandId = 0;
async function run(label, command) {
  commandId += 1;
  const beginToken = "__WASMBX_BEGIN_" + commandId + "__";
  const endToken = "__WASMBX_END_" + commandId + "__";
  const input =
    "printf '\\n" + beginToken + "\\n'; " + command +
    "; code=$?; printf '\\n" + endToken + "%s\\n' \"$code\"";

  await page.evaluate((text) => {
    const emulator = window.__wasmboxAlpineV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, input + "\n");

  await page.waitForFunction(
    ({ begin, end }) => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.lastIndexOf(end) > text.lastIndexOf(begin) &&
        text.endsWith("__WASMBX_PROMPT__ ");
    },
    { begin: beginToken, end: endToken },
    { timeout: 60000 },
  );

  const terminal = await page.locator("#serial").inputValue();
  const begin = terminal.lastIndexOf(beginToken) + beginToken.length;
  const end = terminal.lastIndexOf(endToken);
  const exitCode = Number(terminal.slice(end + endToken.length).trim().split(/\r?\n/)[0]);
  const output = terminal.slice(begin, end).trim();

  console.log("=== " + label + " (exit " + exitCode + ") ===\n" + output);
  assert.equal(exitCode, 0, label + " failed:\n" + output);
  return output;
}

try {
  console.log("Guest root device: " + rootUsed);
  await run("Alpine release", "cat /etc/alpine-release");
  const nodeVersion = await run("Node.js version", "node --version");
  assert.match(nodeVersion, /v\d+\.\d+\.\d+/);
  const nodeOutput = await run("Node.js execution", 'node -e "console.log(1 + 1)"');
  assert.match(nodeOutput, /(?:^|\n)2(?:\n|$)/);
  const pythonVersion = await run("Python version", "python3 --version");
  assert.match(pythonVersion, /Python \d+\.\d+/);
  await run("Guest memory", "free -m");
  await run("Node.js startup time", 'time node -e "console.log(1)"');
  await run("Python startup time", 'time python3 -c "print(1)"');
  await run("Disk driver log", 'dmesg | grep -iE "sd[a-z]|hd[a-z]" | tail -20');
  assert.deepEqual(pageErrors, []);
  console.log("Alpine boot, Node.js execution, Python execution, memory report, and startup timing all passed.");
} finally {
  await browser.close();
}
