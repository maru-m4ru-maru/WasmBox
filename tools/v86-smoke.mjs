import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];

page.on("pageerror", (error) => pageErrors.push(error.message));

async function sendCommand(command) {
  const previousPrompts = await page.evaluate(() => {
    const text = document.getElementById("serial")?.value ?? "";
    return (text.match(/~% /g) ?? []).length;
  });

  await page.evaluate((text) => {
    const emulator = window.__wasmboxV86;
    if (!emulator || typeof emulator.serial0_send !== "function") {
      throw new Error("v86 のシリアル送信APIを取得できません");
    }
    emulator.serial0_send(text);
  }, command + "\n");

  await page.waitForFunction(
    (previous) => {
      const text = document.getElementById("serial")?.value ?? "";
      const promptCount = (text.match(/~% /g) ?? []).length;
      return promptCount > previous && text.endsWith("~% ");
    },
    previousPrompts,
    { timeout: 60000 },
  );

  return page.locator("#serial").inputValue();
}

try {
  await page.goto("http://127.0.0.1:8080/?smoke=1", { waitUntil: "load" });

  await page.waitForFunction(
    () =>
      document.getElementById("serial")?.value.includes("~% ") === true &&
      typeof window.__wasmboxV86?.serial0_send === "function",
    null,
    { timeout: 120000 },
  );

  const diagnostics = await sendCommand(
    "echo __FILESYSTEMS__; cat /proc/filesystems 2>&1; " +
      "echo __SSE__; grep -o 'sse[0-9_]*' /proc/cpuinfo | sort -u; " +
      "echo __MEMORY__; free -m 2>&1; " +
      "echo __FORMAT_TOOLS__; which mke2fs mkfs.ext2 mkfs.ext4 2>&1; " +
      "echo __DIAGNOSTICS_DONE__; " +
      "echo SYS_BLOCK; ls /sys/block 2>&1; echo PARTITIONS; cat /proc/partitions; " +
      "echo DISK_NODES; ls -l /dev 2>&1 | grep -E ' (sd|hd|vd)[a-z]'; " +
      "echo DRIVER_LOG; dmesg 2>&1 | grep -iE 'ata|ide|disk|scsi|virtio' | tail -20",
  );

  const reportStart = diagnostics.lastIndexOf("__FILESYSTEMS__");
  const reportEnd = diagnostics.indexOf("__DIAGNOSTICS_DONE__", reportStart);
  if (reportStart >= 0 && reportEnd >= 0) {
    console.log(
      "=== Guest capability diagnostics ===\n" +
        diagnostics.slice(reportStart, reportEnd + "__DIAGNOSTICS_DONE__".length),
    );
  } else {
    console.log("=== Guest capability diagnostics ===\n" + diagnostics.slice(-9000));
  }

  const partitions = [
    ...diagnostics.matchAll(/^[ \t]*(\d+)[ \t]+(\d+)[ \t]+\d+[ \t]+((?:sd|hd)[a-z]+)[ \t]*$/gm),
  ].map((match) => ({ major: match[1], minor: match[2], name: match[3] }));

  for (const disk of partitions) {
    await sendCommand(`mknod /dev/${disk.name} b ${disk.major} ${disk.minor} 2>/dev/null || true`);
  }

  const scan = await sendCommand(
    'for d in /dev/sda /dev/hda; do if [ -b "$d" ]; then echo __WASMBX_DISK__$d; break; fi; done',
  );
  const terminal = await page.locator("#serial").inputValue();
  const disk = terminal.match(/__WASMBX_DISK__(\/dev\/(?:sd|hd)a)/)?.[1];

  if (!disk) {
    throw new Error(
      `v86は起動しましたが、ディスクデバイスが見つかりません。\nパーティション表:\n${partitions.map((p) => `${p.major} ${p.minor} ${p.name}`).join("\n") || "(sd*/hd* なし)"}\n診断出力:\n${diagnostics.slice(-6000)}\nスキャン出力:\n${scan.slice(-2000)}`,
    );
  }

  await sendCommand(`echo hello-wasmbox | dd of=${disk} bs=512 seek=10 count=1 conv=sync 2>&1; sync`);

  await page.locator("#flush").click();
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent?.includes("flush 完了") === true,
    null,
    { timeout: 5000 },
  );

  await page.reload({ waitUntil: "load" });

  await page.waitForFunction(
    () =>
      document.getElementById("serial")?.value.includes("~% ") === true &&
      typeof window.__wasmboxV86?.serial0_send === "function",
    null,
    { timeout: 120000 },
  );

  const restored = await sendCommand(
    `dd if=${disk} bs=512 skip=10 count=1 2>/dev/null | head -c 14`,
  );
  assert.ok(
    restored.includes("hello-wasmbox"),
    `再読み込み後のディスクデータが一致しません。出力末尾:\n${restored.slice(-4000)}`,
  );
  assert.deepEqual(pageErrors, []);
  console.log("v86 boot, guest capability diagnostics, block-device detection, dd write, flush, reload, and dd read all passed.");
} catch (error) {
  const state = await page.evaluate(() => ({
    status: document.getElementById("status")?.textContent,
    serial: document.getElementById("serial")?.value.slice(-6000),
  })).catch(() => ({}));
  console.error(JSON.stringify({ error: String(error), pageErrors, state }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
