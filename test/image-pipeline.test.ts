import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chunkImageFile } from "../tools/chunk-image.ts";
import { parseExtSuperblock } from "../tools/inspect-image.ts";
import { pseudoRandomBytes } from "./helpers.ts";

const hasE2fsprogs = ["mke2fs", "e2fsck"].every(
  (command) => !spawnSync(command, ["-V"], { encoding: "utf8" }).error,
);
const skip = hasE2fsprogs ? false : "mke2fs / e2fsck（e2fsprogs）が無いためスキップ";

async function makeExt4(dir: string, extraFeatures = "^metadata_csum,^64bit,^orphan_file") {
  const root = join(dir, "rootfs");
  await mkdir(join(root, "etc"), { recursive: true });
  await mkdir(join(root, "usr", "lib"), { recursive: true });
  await writeFile(join(root, "etc", "hostname"), "wasmbox\n");
  await writeFile(join(root, "usr", "lib", "big.bin"), pseudoRandomBytes(1_500_000, 9));
  const image = join(dir, "rootfs.ext4");
  await writeFile(image, new Uint8Array(32 * 1024 * 1024));
  const result = spawnSync(
    "mke2fs",
    ["-t", "ext4", "-F", "-q", "-L", "wasmbox-root", "-b", "4096", "-m", "0", "-O", extraFeatures, "-d", root, image],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, "mke2fs が失敗: " + result.stderr);
  return image;
}

describe("イメージ作成パイプライン（mke2fs → チャンク分割 → 検査）", { skip }, () => {
  it("ext4 は分割・復元して e2fsck が通る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-img-"));
    try {
      const image = await makeExt4(dir);
      const out = join(dir, "out");
      await chunkImageFile(image, out, { chunkSize: 262144, imageId: "test-ext4" });
      const run = spawnSync("node", ["tools/inspect-image.ts", out, "--fsck"], { encoding: "utf8" });
      assert.equal(run.status, 0, "inspect が失敗:\n" + run.stdout + run.stderr);
      assert.match(run.stdout, /ラベル "wasmbox-root"/);
      assert.match(run.stdout, /e2fsck -fn で問題なし/);
      assert.doesNotMatch(run.stdout, /⚠️/, "古いカーネルで問題になる機能が有効になっています");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("スーパーブロックのラベルと機能フラグを解釈し、新しめの機能は警告する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-img-"));
    try {
      const { readFile } = await import("node:fs/promises");
      const plain = await readFile(await makeExt4(dir));
      const info = parseExtSuperblock(plain.subarray(1024, 2048));
      assert.equal(info.magicOk, true);
      assert.equal(info.label, "wasmbox-root");
      assert.equal(info.blockSize, 4096);
      assert.ok(info.features.includes("has_journal") && info.features.includes("extents"));
      assert.deepEqual(info.warnings, []);

      const dir2 = await mkdtemp(join(tmpdir(), "wasmbox-img-"));
      try {
        const modern = await readFile(await makeExt4(dir2, "metadata_csum,64bit,orphan_file"));
        const modernInfo = parseExtSuperblock(modern.subarray(1024, 2048));
        assert.equal(modernInfo.warnings.length, 3);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ext4 ではないイメージを拒否する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-img-"));
    try {
      const image = join(dir, "random.img");
      await writeFile(image, pseudoRandomBytes(1024 * 1024, 3));
      const out = join(dir, "out");
      await chunkImageFile(image, out, { chunkSize: 262144 });
      const run = spawnSync("node", ["tools/inspect-image.ts", out], { encoding: "utf8" });
      assert.equal(run.status, 1);
      assert.match(run.stdout, /スーパーブロックが見つかりません/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
