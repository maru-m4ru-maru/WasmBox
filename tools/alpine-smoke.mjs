import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const PROMPT = "__WASMBX_PROMPT__ ";
const CYCLES = 3;
const measurements = [];

async function sendCommand(command) {
  const previousPrompts = await page.evaluate((marker) => {
    const text = document.getElementById("serial")?.value ?? "";
    return text.split(marker).length - 1;
  }, PROMPT);

  await page.evaluate((text) => {
    const emulator = window.__wasmboxAlpineV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, command + "\n");

  await page.waitForFunction(
    ({ previous, marker }) => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.split(marker).length - 1 > previous && text.endsWith(marker);
    },
    { previous: previousPrompts, marker: PROMPT },
    { timeout: 60000 },
  );
  return page.locator("#serial").inputValue();
}

let commandId = 0;
async function run(label, command) {
  commandId += 1;
  const beginToken = "__WASMBX_BEGIN_" + commandId + "__";
  const endToken = "__WASMBX_END_" + commandId + "__";
  const wrapped =
    "printf '\\n" + beginToken + "\\n'; " + command +
    "; code=$?; printf '\\n" + endToken + "%s\\n' \"$code\"";
  await sendCommand(wrapped);

  const terminal = await page.locator("#serial").inputValue();
  const begin = terminal.lastIndexOf(beginToken) + beginToken.length;
  const end = terminal.lastIndexOf(endToken);
  const exitCode = Number(terminal.slice(end + endToken.length).trim().split(/\r?\n/)[0]);
  const output = terminal.slice(begin, end).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  console.log("=== " + label + " (exit " + exitCode + ") ===\n" + output);
  assert.equal(exitCode, 0, label + " failed:\n" + output);
  return output;
}

async function waitForDirectRoot(timeout) {
  await page.waitForFunction(() => {
    const terminal = document.getElementById("serial")?.value ?? "";
    const header = document.getElementById("boot-info")?.textContent ?? "";
    const failed = /Kernel panic|Unable to mount root fs|Run \/wasmbox-init as init process.*not found|initrd を取得できません/i.test(terminal + "\n" + header);
    const buildrootPrompt = terminal.includes("~% ");
    const directRootMarker = terminal.includes("[wasmbox-init] ルート:");
    const alpinePrompt = terminal.includes("wasmbox:~#") || terminal.endsWith("# ");
    return failed || buildrootPrompt || (header.includes("initrd あり") && (directRootMarker || alpinePrompt));
  }, null, { timeout });

  const header = await page.locator("#boot-info").textContent();
  const terminal = await page.locator("#serial").inputValue();
  assert.ok(header?.includes("initrd あり"), "外付け initrd が指定されていません: " + header);
  assert.ok(
    !terminal.includes("~% ") || terminal.includes("wasmbox:~#") || terminal.includes("[wasmbox-init] ルート:"),
    "Buildroot のシェルに留まっています。外付け initrd の rdinit が実行されていません:\n" + terminal.slice(-12000),
  );
  assert.ok(
    terminal.includes("[wasmbox-init] ルート:") || terminal.includes("wasmbox:~#") || terminal.endsWith("# "),
    "Alpine のシェルまたは initrd の起動ログに到達していません:\n" + terminal.slice(-12000),
  );

  const initMessage = terminal.match(/\[wasmbox-init\] ルート: \/dev\/(?:sda|hda)（ext4）/);
  console.log(initMessage ? "Initrd log: " + initMessage[0] : "Initrd log was not retained in textarea; direct-root state will be verified through /proc/mounts.");

  await page.evaluate((text) => {
    const emulator = window.__wasmboxAlpineV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, "export PS1='" + PROMPT + "'; echo __WASMBX_READY__\n");

  await page.waitForFunction(
    (marker) => {
      const terminal = document.getElementById("serial")?.value ?? "";
      return terminal.includes("__WASMBX_READY__") && terminal.endsWith(marker);
    },
    PROMPT,
    { timeout: 15000 },
  );

  return { header, terminal, elapsedMs: Date.now() - bootStartedAt };
}

let bootStartedAt = 0;
try {
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    bootStartedAt = Date.now();
    await page.goto(
      "http://127.0.0.1:8080/alpine.html?smoke=1&memory=256&cycle=" + cycle,
      { waitUntil: "load" },
    );
    const boot = await waitForDirectRoot(120000);
    console.log("=== Direct-root boot cycle " + cycle + " ===");
    console.log("Shell ready: " + (boot.elapsedMs / 1000).toFixed(2) + " s");
    console.log("Boot options: " + boot.header);

    const rootMount = await run("Root mount", "grep -E '^[^ ]+ / ext4 ' /proc/mounts");
    assert.match(rootMount, /^\/dev\/(?:sda|hda) \/ ext4/m, "Alpine ext4 is not the actual root filesystem");

    await run("Kernel command line", "cat /proc/cmdline");
    const release = await run("Alpine release", "cat /etc/alpine-release");
    assert.match(release, /^3\.21\./);
    const nodeVersion = await run("Node.js version", "node --version");
    assert.match(nodeVersion, /^v\d+\.\d+\.\d+/);
    const nodeOutput = await run("Node.js execution", 'node -e "console.log(1 + 1)"');
    assert.match(nodeOutput, /(?:^|\n)2(?:\n|$)/);
    const pythonVersion = await run("Python version", "python3 --version");
    assert.match(pythonVersion, /^Python \d+\.\d+/);
    const memory = await run("Free memory after switch_root", "free -m");
    const nodeTiming = await run("Node.js startup time", 'time node -e "console.log(1)"');
    const pythonTiming = await run("Python startup time", 'time python3 -c "print(1)"');

    const memoryLine = memory.split(/\r?\n/).find((line) => /^Mem:\s/.test(line));
    const memoryValues = memoryLine?.match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+){0,2}\s+(\d+)$/);
    measurements.push({
      cycle,
      shellReadySeconds: Number((boot.elapsedMs / 1000).toFixed(2)),
      memoryTotalMiB: memoryValues ? Number(memoryValues[1]) : null,
      memoryUsedMiB: memoryValues ? Number(memoryValues[2]) : null,
      memoryFreeMiB: memoryValues ? Number(memoryValues[3]) : null,
      nodeTiming: nodeTiming.match(/real\s+([^\r\n]+)/)?.[1] ?? "not parsed",
      pythonTiming: pythonTiming.match(/real\s+([^\r\n]+)/)?.[1] ?? "not parsed",
      nodeVersion: nodeVersion.trim(),
      pythonVersion: pythonVersion.trim(),
    });

    console.log(JSON.stringify(measurements.at(-1), null, 2));
    await page.locator("#flush").click();
    await page.waitForTimeout(250);
  }

  assert.deepEqual(pageErrors, []);
  console.log("=== Direct-root startup summary ===");
  console.log(JSON.stringify(measurements, null, 2));
  console.log("Three direct-root Alpine boots, Node.js, Python, and post-switch_root memory checks all passed.");
} catch (error) {
  const state = await page.evaluate(() => ({
    bootInfo: document.getElementById("boot-info")?.textContent,
    status: document.getElementById("status")?.textContent,
    serial: document.getElementById("serial")?.value.slice(-16000),
  })).catch(() => ({}));
  console.error(JSON.stringify({ error: String(error), pageErrors, state, measurements }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
