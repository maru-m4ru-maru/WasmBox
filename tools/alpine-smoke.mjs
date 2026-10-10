import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const PROMPT = "__WASMBX_PROMPT__ ";

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
      const count = text.split(marker).length - 1;
      return count > previous && text.endsWith(marker);
    },
    { previous: previousPrompts, marker: PROMPT },
    { timeout: 60000 },
  );

  return page.locator("#serial").inputValue();
}

async function prepareGuestShell() {
  await page.goto(
    "http://127.0.0.1:8080/alpine.html?smoke=1&memory=256",
    { waitUntil: "load" },
  );

  await page.waitForFunction(
    () => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.endsWith("~% ") || text.endsWith("# ") ||
        /Kernel panic|Unable to mount root fs|No working init found/i.test(text);
    },
    null,
    { timeout: 90000 },
  );

  const initial = await page.locator("#serial").inputValue();
  if (!initial.endsWith("~% ") && !initial.endsWith("# ")) {
    throw new Error("ゲストのシェルが表示されませんでした。\n" + initial.slice(-12000));
  }

  await page.evaluate((text) => {
    const emulator = window.__wasmboxAlpineV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, "export PS1='" + PROMPT + "'; echo __WASMBX_READY__\n");

  await page.waitForFunction(
    (marker) => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.includes("__WASMBX_READY__") && text.endsWith(marker);
    },
    PROMPT,
    { timeout: 15000 },
  );
}

try {
  await prepareGuestShell();

  const diagnostics = await sendCommand(
    "echo __WASMBX_PARTITIONS__; cat /proc/partitions; " +
    "echo __WASMBX_BLOCKS__; ls /sys/block; " +
    "echo __WASMBX_DEVICES__; ls -l /dev | grep -E ' (sd|hd)[a-z]'; " +
    "echo __WASMBX_DIAG_END__",
  );

  const partitions = [
    ...diagnostics.matchAll(/^[ \t]*(\d+)[ \t]+(\d+)[ \t]+\d+[ \t]+((?:sd|hd)[a-z]+)[ \t]*$/gm),
  ].map((match) => ({ major: match[1], minor: match[2], name: match[3] }));

  console.log("=== Guest block device diagnostics ===\n" +
    diagnostics.slice(Math.max(0, diagnostics.lastIndexOf("__WASMBX_PARTITIONS__")), diagnostics.lastIndexOf("__WASMBX_DIAG_END__") + "__WASMBX_DIAG_END__".length));

  for (const disk of partitions) {
    await sendCommand(
      "mknod /dev/" + disk.name + " b " + disk.major + " " + disk.minor + " 2>/dev/null || true",
    );
  }

  const mountResult = await sendCommand(
    "mkdir -p /mnt/alpine && " +
    "for d in /dev/sda /dev/hda; do " +
    "if [ -b \"$d\" ]; then " +
    "mount -t ext4 \"$d\" /mnt/alpine 2>&1 && " +
    "test -f /mnt/alpine/etc/alpine-release && " +
    "echo __WASMBX_ROOT_MOUNTED__$d && break; " +
    "fi; done; " +
    "test -f /mnt/alpine/etc/alpine-release && cat /mnt/alpine/etc/alpine-release",
  );

  const mountedMatch = mountResult.match(/__WASMBX_ROOT_MOUNTED__(\/dev\/(?:sd|hd)[a-z]+)/);
  if (!mountedMatch) {
    throw new Error(
      "Alpine の ext4 ルートFSをマウントできませんでした。\n" +
      mountResult.slice(-10000) +
      "\nパーティション: " + JSON.stringify(partitions),
    );
  }

  const rootDevice = mountedMatch[1];
  console.log("Alpine root filesystem mounted from " + rootDevice);

  const prep = await sendCommand(
    "mkdir -p /mnt/alpine/proc /mnt/alpine/sys /mnt/alpine/dev; " +
    "mount -t proc proc /mnt/alpine/proc 2>&1 || true; " +
    "mount -t sysfs sysfs /mnt/alpine/sys 2>&1 || true; " +
    "mount -o bind /dev /mnt/alpine/dev 2>&1 || true; " +
    "test -x /mnt/alpine/bin/sh && test -x /mnt/alpine/usr/bin/node && echo __WASMBX_ROOT_READY__",
  );
  assert.ok(prep.includes("__WASMBX_ROOT_READY__"), "Alpine root filesystem is incomplete:\n" + prep.slice(-5000));

  let commandId = 0;
  async function run(label, command) {
    commandId += 1;
    const beginToken = "__WASMBX_BEGIN_" + commandId + "__";
    const endToken = "__WASMBX_END_" + commandId + "__";
    const input =
      "printf '\\n" + beginToken + "\\n'; " + command +
      "; code=$?; printf '\\n" + endToken + "%s\\n' \"$code\"";

    await sendCommand(input);

    const terminal = await page.locator("#serial").inputValue();
    const begin = terminal.lastIndexOf(beginToken) + beginToken.length;
    const end = terminal.lastIndexOf(endToken);
    const exitCode = Number(terminal.slice(end + endToken.length).trim().split(/\r?\n/)[0]);
    const output = terminal.slice(begin, end).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();

    console.log("=== " + label + " (exit " + exitCode + ") ===\n" + output);
    assert.equal(exitCode, 0, label + " failed:\n" + output);
    return output;
  }

  const chroot = (command) => "chroot /mnt/alpine /bin/sh -c " + "'" + command.replaceAll("'", "'\\''") + "'";

  await run("Alpine release", chroot("cat /etc/alpine-release"));
  const nodeVersion = await run("Node.js version", chroot("node --version"));
  assert.match(nodeVersion, /v\d+\.\d+\.\d+/);
  const nodeOutput = await run("Node.js execution", chroot('node -e "console.log(1 + 1)"'));
  assert.match(nodeOutput, /(?:^|\n)2(?:\n|$)/);
  const pythonVersion = await run("Python version", chroot("python3 --version"));
  assert.match(pythonVersion, /Python \d+\.\d+/);
  await run("Guest memory", chroot("free -m"));
  await run("Node.js startup time", "time " + chroot('node -e "console.log(1)"'));
  await run("Python startup time", "time " + chroot('python3 -c "print(1)"'));
  await run("Disk driver log", 'dmesg | grep -iE "sd[a-z]|hd[a-z]" | tail -20');

  assert.deepEqual(pageErrors, []);
  console.log("Alpine root mount, Node.js execution, Python execution, memory report, and startup timing all passed.");
} finally {
  await browser.close();
}
