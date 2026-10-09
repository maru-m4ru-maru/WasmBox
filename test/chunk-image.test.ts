import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chunkImageFile } from "../tools/chunk-image.ts";
import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import { MemoryKV } from "../src/storage/kv-memory.ts";
import { validateManifest } from "../src/storage/manifest.ts";
import type { ChunkSource } from "../src/storage/types.ts";
import { pseudoRandomBytes } from "./helpers.ts";

describe("tools/chunk-image", () => {
  it("分割したチャンクとmanifestから、元のイメージを正確に復元できる（ゼロ・重複チャンク込み）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wasmbox-"));
    try {
      const chunkSize = 64;
      const image = pseudoRandomBytes(64 * 6 + 20, 5); // 7 チャンク（最後は 20 バイト）
      image.fill(0, 64, 128); // chunk 1: ゼロ
      image.copyWithin(64 * 4, 0, 64); // chunk 4 を chunk 0 と同じ内容にする（重複）
      const imagePath = join(dir, "disk.img");
      await writeFile(imagePath, image);

      const out = join(dir, "out");
      const manifest = await chunkImageFile(imagePath, out, { chunkSize, imageId: "disk" });

      assert.equal(manifest.chunks[1], null);
      assert.equal(manifest.chunks[0], manifest.chunks[4]);
      const files = await readdir(join(out, "chunks"));
      assert.equal(files.length, 5, "7 チャンク − ゼロ 1 − 重複 1 = 5 ファイル");
      assert.deepEqual(validateManifest(JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))), manifest);

      const source: ChunkSource = {
        fetchChunk: async (_i, hash) => new Uint8Array(await readFile(join(out, "chunks", hash))),
      };
      const store = await ChunkedBlockStore.open({
        manifest,
        source,
        baseCache: new MemoryKV(),
        instance: new MemoryKV(),
        flushIntervalMs: 0,
      });
      assert.deepEqual(await store.read(0, image.byteLength), image);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
