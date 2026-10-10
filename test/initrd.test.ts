import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCpio, parseCpio } from "../tools/cpio.ts";
import { makeWasmboxInitrd } from "../tools/make-initrd.ts";

const INIT_SCRIPT = fileURLToPath(new URL("../image/initrd/wasmbox-init", import.meta.url));
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const commandExists = (cmd: string, args: string[] = ["--version"]) => !spawnSync(cmd, args).error;
const blockDevice = "/dev/loop0";
const hasBlockDevice = await stat(blockDevice).then((s) => s.isBlockDevice(), () => false);

describe("cpio（newc 形式）の書き出し", () => {
  it("種類ごとのモード・中身・デバイス番号が、読み戻して一致する", () => {
    const archive = buildCpio([
      { type: "dir", path: "dev" },
      { type: "chardev", path: "dev/console", major: 5, minor: 1, mode: 0o600 },
      { type: "file", path: "/bin/hello", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
      { type: "symlink", path: "bin/sh", target: "busybox" },
      { type: "file", path: "empty", data: new Uint8Array(0) },
    ]);
    const entries = parseCpio(archive);
    assert.deepEqual(entries.map((entry) => entry.name), ["dev", "dev/console", "bin/hello", "bin/sh", "empty"]);
    const [dir, console_, hello, link, empty] = entries;
    assert.equal(dir!.mode, S_IFDIR | 0o755);
    assert.equal(console_!.mode, S_IFCHR | 0o600);
    assert.deepEqual([console_!.rdevMajor, console_!.rdevMinor], [5, 1]);
    assert.equal(hello!.mode, S_IFREG | 0o755);
    assert.equal(new TextDecoder().decode(hello!.data), "#!/bin/sh\necho hi\n");
    assert.equal(link!.mode & S_IFMT, S_IFLNK);
    assert.equal(new TextDecoder().decode(link!.data), "busybox");
    assert.equal(empty!.data.byteLength, 0);
  });

  it("ファイル名とデータ長の4バイト境界パディングが正しい", () => {
    for (const nameLength of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const dataLength of [0, 1, 2, 3, 4, 5, 7, 8, 9]) {
        const name = "a".repeat(nameLength);
        const data = Uint8Array.from({ length: dataLength }, (_, index) => index + 1);
        const archive = buildCpio([
          { type: "file", path: name, data },
          { type: "file", path: "z", data: Uint8Array.from([9, 9, 9]) },
        ]);
        assert.equal(archive.byteLength % 4, 0);
        const [first, second] = parseCpio(archive);
        assert.equal(first!.name, name);
        assert.deepEqual(first!.data, data, "name=" + nameLength + " data=" + dataLength);
        assert.deepEqual(second!.data, Uint8Array.from([9, 9, 9]));
      }
    }
  });

  it("UTF-8パスを保持し、同じ入力から同じアーカイブを生成する", () => {
    const entries = [{ type: "file", path: "メモ/テスト.txt", data: "こんにちは" }] as const;
    const archive = buildCpio(entries);
    assert.deepEqual(buildCpio(entries), archive);
    const [entry] = parseCpio(archive);
    assert.equal(entry!.name, "メモ/テスト.txt");
    assert.equal(new TextDecoder().decode(entry!.data), "こんにちは");
  });

  it("不正なパスを拒否する", () => {
    for (const path of ["", "/", "a/../b", "a//b", "./a", ".."]) {
      assert.throws(() => buildCpio([{ type: "dir", path }]), RangeError, path);
    }
  });

  it("newcマジック、ヘッダーサイズ、TRAILER!!!を正しく配置する", () => {
    const archive = buildCpio([{ type: "file", path: "x", data: "y" }]);
    assert.equal(new TextDecoder().decode(archive.subarray(0, 6)), "070701");
    const trailerAt = 112 + 4;
    assert.equal(new TextDecoder().decode(archive.subarray(trailerAt, trailerAt + 6)), "070701");
    assert.equal(new TextDecoder().decode(archive.subarray(trailerAt + 110, trailerAt + 120)), "TRAILER!!!");
  });

  it("fileコマンドがcpioアーカイブと認識する", { skip: commandExists("file") ? false : "fileコマンドがありません" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-cpio-"));
    try {
      const path = join(dir, "t.cpio");
      await writeFile(path, buildCpio([{ type: "file", path: "x", data: "y" }]));
      const output = spawnSync("file", ["-b", path], { encoding: "utf8" }).stdout;
      assert.match(output, /cpio archive \(SVR4 with no CRC\)/, output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("WasmBoxの外付けinitrd", () => {
  it("initスクリプトの実行権限と最小のデバイスノードがある", async () => {
    const entries = parseCpio(await makeWasmboxInitrd());
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const init = byName.get("wasmbox-init");
    assert.ok(init);
    assert.equal(init.mode, S_IFREG | 0o755);
    assert.equal(new TextDecoder().decode(init.data), await readFile(INIT_SCRIPT, "utf8"));
    const consoleNode = byName.get("dev/console");
    assert.equal(consoleNode?.mode, S_IFCHR | 0o600);
    assert.deepEqual([consoleNode?.rdevMajor, consoleNode?.rdevMinor], [5, 1]);
    assert.deepEqual([byName.get("dev/null")?.rdevMajor, byName.get("dev/null")?.rdevMinor], [1, 3]);
    for (const dir of ["dev", "proc", "sys", "newroot"]) assert.equal(byName.get(dir)!.mode, S_IFDIR | 0o755);
  });

  it("initrdは16KiB未満", async () => {
    assert.ok((await makeWasmboxInitrd()).byteLength < 16 * 1024);
  });
});

describe("/wasmbox-initスクリプト", () => {
  const sh = commandExists("dash", ["-c", "exit 0"]) ? "dash" : "sh";

  it("POSIX shとして構文が正しい", () => {
    const result = spawnSync(sh, ["-n", INIT_SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  async function runScript(opts: {
    cmdline: string;
    failMount?: boolean;
    switchRootFails?: boolean;
    withInit?: boolean;
  }) {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-init-"));
    try {
      const stubs = join(dir, "stubs");
      const newroot = join(dir, "newroot");
      const log = join(dir, "log");
      await mkdir(stubs);
      await mkdir(join(newroot, "sbin"), { recursive: true });
      if (opts.withInit ?? true) {
        await writeFile(join(newroot, "sbin", "init"), "#!/bin/sh\n");
        await chmod(join(newroot, "sbin", "init"), 0o755);
      }
      await writeFile(join(dir, "cmdline"), opts.cmdline);
      const stub = async (name: string, body: string) => {
        await writeFile(join(stubs, name), "#!/bin/sh\necho \"" + name + " $*\" >> \"$WASMBOX_TEST_LOG\"\n" + body + "\n");
        await chmod(join(stubs, name), 0o755);
      };
      await stub("mount", opts.failMount ? 'case "$*" in *ext4*) exit 1;; esac; exit 0' : "exit 0");
      await stub("umount", "exit 0");
      await stub("sleep", "exit 0");
      await stub("switch_root", opts.switchRootFails ? "exit 1" : "kill -9 $PPID");
      await stub("chroot", "exit 0");
      const result = spawnSync(sh, [INIT_SCRIPT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: stubs + ":/usr/bin:/bin",
          WASMBOX_CMDLINE_FILE: join(dir, "cmdline"),
          WASMBOX_NEWROOT: newroot,
          WASMBOX_TEST_LOG: log,
        },
      });
      const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
      return { ...result, calls, newroot };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("正常系でルートをマウントしswitch_rootする", { skip: hasBlockDevice ? false : blockDevice + " がありません" }, async () => {
    const result = await runScript({ cmdline: "console=ttyS0 root=" + blockDevice + " rootfstype=ext4 rw rdinit=/wasmbox-init" });
    assert.equal(result.signal, "SIGKILL");
    assert.deepEqual(result.calls, [
      "mount -t proc proc /proc",
      "mount -t sysfs sysfs /sys",
      "mount -t devtmpfs devtmpfs /dev",
      "mount -t ext4 -o rw " + blockDevice + " " + result.newroot,
      "umount /proc",
      "umount /sys",
      "umount /dev",
      "switch_root " + result.newroot + " /sbin/init",
    ]);
    assert.doesNotMatch(result.stdout, /失敗|見つかりません/);
  });

  it("rootfstypeを読み取りマウントに適用する", { skip: hasBlockDevice ? false : blockDevice + " がありません" }, async () => {
    const result = await runScript({ cmdline: "root=" + blockDevice + " rootfstype=ext2" });
    assert.ok(result.calls.some((call) => call.startsWith("mount -t ext2 -o rw " + blockDevice)), result.calls.join("\n"));
  });

  it("switch_root失敗時にchrootを使う", { skip: hasBlockDevice ? false : blockDevice + " がありません" }, async () => {
    const result = await runScript({ cmdline: "root=" + blockDevice, switchRootFails: true });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /chrootで代用/);
    assert.equal(result.calls.at(-1), "chroot " + result.newroot + " /sbin/init");
  });

  it("ルートのマウント失敗時はシェルを残す", { skip: hasBlockDevice ? false : blockDevice + " がありません" }, async () => {
    const result = await runScript({ cmdline: "root=" + blockDevice, failMount: true });
    assert.match(result.stdout, /マウントできません/);
    assert.match(result.stdout, /シェルを起動します/);
    assert.ok(!result.calls.some((call) => call.startsWith("switch_root")));
  });

  it("/sbin/initが無いルートではシェルを残す", { skip: hasBlockDevice ? false : blockDevice + " がありません" }, async () => {
    const result = await runScript({ cmdline: "root=" + blockDevice, withInit: false });
    assert.match(result.stdout, /sbin\/initがありません/);
    assert.ok(!result.calls.some((call) => call.startsWith("switch_root")));
  });

  it("デバイスが現れない場合は15回待ってシェルを残す", async () => {
    const result = await runScript({ cmdline: "root=/dev/wasmbox-no-such-device" });
    assert.match(result.stdout, /見つかりません/);
    assert.equal(result.calls.filter((call) => call === "sleep 1").length, 15);
    assert.ok(!result.calls.some((call) => call.startsWith("switch_root")));
  });

  it("root=無しは/dev/sdaを既定にする", async () => {
    const result = await runScript({ cmdline: "console=ttyS0 rw" });
    assert.match(result.stdout, /ルート: \/dev\/sda（ext4）/);
  });
});
