import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import { chunkLength, validateManifest } from "../src/storage/manifest.ts";
import type { ChunkSource, KVBackend } from "../src/storage/types.ts";

const nullKV: KVBackend = {
  get: async () => undefined,
  keys: async () => [],
  batch: async () => {},
  close: async () => {},
};

export interface Ext4Info {
  magicOk: boolean;
  label: string;
  blockSize: number;
  blocks: number;
  clean: boolean;
  features: string[];
  warnings: string[];
}

export function parseExtSuperblock(sb: Uint8Array): Ext4Info {
  if (sb.byteLength < 1024) {
    throw new Error("スーパーブロックは 1024 バイト必要です");
  }

  const view = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  const magicOk = view.getUint16(0x38, true) === 0xef53;
  const compat = view.getUint32(0x5c, true);
  const incompat = view.getUint32(0x60, true);
  const roCompat = view.getUint32(0x64, true);
  const features: string[] = [];
  const warnings: string[] = [];

  if (compat & 0x4) features.push("has_journal");
  if (incompat & 0x2) features.push("filetype");
  if (incompat & 0x40) features.push("extents");
  if (roCompat & 0x8) features.push("huge_file");
  if (incompat & 0x200) features.push("flex_bg");
  if (incompat & 0x80) {
    features.push("64bit");
    warnings.push("64bit が有効です。古いカーネルでは mount できない可能性があります");
  }
  if (roCompat & 0x400) {
    features.push("metadata_csum");
    warnings.push("metadata_csum が有効です。カーネルに crc32c が無いと mount できません");
  }
  if (compat & 0x1000) {
    features.push("orphan_file");
    warnings.push("orphan_file が有効です。Linux 6.5 より古いカーネルでは mount できません");
  }

  const rawLabel = sb.subarray(0x78, 0x88);
  const end = rawLabel.indexOf(0);
  return {
    magicOk,
    label: new TextDecoder().decode(end === -1 ? rawLabel : rawLabel.subarray(0, end)),
    blockSize: 1024 << view.getUint32(0x18, true),
    blocks: view.getUint32(0x4, true),
    clean: (view.getUint16(0x3a, true) & 1) === 1,
    features,
    warnings,
  };
}

async function main(argv: string[]): Promise<number> {
  const dir = argv.find((arg) => !arg.startsWith("--"));
  const fsck = argv.includes("--fsck");
  if (!dir) {
    console.error("使い方: node tools/inspect-image.ts <ディレクトリ> [--fsck]");
    return 1;
  }

  const manifest = validateManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  const source: ChunkSource = {
    fetchChunk: async (_index, hash) => new Uint8Array(await readFile(join(dir, "chunks", hash))),
  };

  const zero = manifest.chunks.filter((hash) => hash === null).length;
  const unique = new Set(manifest.chunks.filter((hash): hash is string => hash !== null));
  const seen = new Set<string>();
  let downloadable = 0;

  manifest.chunks.forEach((hash, index) => {
    if (hash !== null && !seen.has(hash)) {
      seen.add(hash);
      downloadable += chunkLength(manifest, index);
    }
  });

  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log("イメージ: " + manifest.imageId);
  console.log("  サイズ " + mib(manifest.size) + " MiB / チャンク " + manifest.chunks.length + " 個（" + manifest.chunkSize + " バイト）");
  console.log("  ゼロ " + zero + " 個（配信不要）/ ユニーク " + unique.size + " 個 / 全部取得した場合のダウンロード " + mib(downloadable) + " MiB");

  const store = await ChunkedBlockStore.open({
    manifest,
    source,
    baseCache: nullKV,
    instance: nullKV,
    flushIntervalMs: 0,
    readaheadChunks: 0,
    memoryCacheBytes: 16 * 1024 * 1024,
  });

  let failed = false;
  if (manifest.size % 512 !== 0) {
    console.log("❌ サイズが 512 バイトの倍数ではありません（v86 のディスクとして使えません）");
    failed = true;
  }

  const info = parseExtSuperblock(await store.read(1024, 1024));
  if (!info.magicOk) {
    console.log("❌ ext2/3/4 のスーパーブロックが見つかりません（マジックナンバーが違います）");
    failed = true;
  } else {
    console.log("ext4: ラベル \"" + info.label + "\" / ブロック " + info.blockSize + " バイト × " + info.blocks + " / 状態 " + (info.clean ? "clean" : "not clean"));
    console.log("  機能: " + info.features.join(", "));
    for (const warning of info.warnings) console.log("  ⚠️ " + warning);
  }

  if (fsck && !failed) {
    const temp = await mkdtemp(join(tmpdir(), "wasmbox-inspect-"));
    const imagePath = join(temp, "restored.img");
    try {
      const output = await open(imagePath, "w");
      const step = 4 * 1024 * 1024;
      for (let position = 0; position < manifest.size; position += step) {
        const data = await store.read(position, Math.min(step, manifest.size - position));
        await output.write(data, 0, data.byteLength, position);
      }
      await output.close();

      const result = spawnSync("e2fsck", ["-fn", imagePath], { encoding: "utf8" });
      if (result.error) {
        console.log("(e2fsck を実行できないためスキップ: " + result.error.message + ")");
      } else if (result.status === 0) {
        console.log("✅ 復元したイメージは e2fsck -fn で問題なし（分割 → 復元の往復も正しい）");
      } else {
        console.log("❌ e2fsck が問題を報告しました（終了コード " + result.status + "）\n" + result.stdout + result.stderr);
        failed = true;
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  await store.close();
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
