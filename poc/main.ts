/**
 * M2 PoC: v86 のディスク（hda）に WasmBox の BlockStore を接続して Linux を起動する。
 *
 * ゴール（poc/README.md の手順で確認する）:
 *   1. ブラウザで Linux が起動し、シリアルコンソールでコマンドを打てる
 *   2. ディスクに書いた内容が、ページを再読み込みしても残っている
 *
 * ⚠️ このファイルは v86 の実物がない環境で書かれており、未実行。
 *    v86 のオプション名は、v86 のソース（starter.js）と examples を参照して書いている。
 *    動かなければ、まずこのファイルの V86 オプションを疑うこと。
 */
import { V86BlockDevice } from "../src/engine/v86-block-device.ts";
import {
  ChunkedBlockStore,
  IdbKV,
  acquireInstanceLock,
  installAutoFlush,
  requestPersistentStorage,
} from "../src/storage/index.ts";
import type { ChunkSource, Manifest } from "../src/storage/index.ts";

/** libv86.js（<script> で読み込む）が定義するグローバル */
declare const V86: new (options: Record<string, unknown>) => unknown;

const MiB = 1024 * 1024;
const INSTANCE_ID = "poc";
const DISK_SIZE = 64 * MiB;
const CHUNK_SIZE = 256 * 1024;

const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el;
};
const status = $("status");
const log = (message: string) => {
  status.textContent = message;
};

/**
 * まっさらな 64 MiB のディスク。全チャンクが null（ゼロ埋め）なので、ネットワークからは何も取得しない。
 * 実イメージを使うときは、tools/chunk-image.ts で作った manifest.json と HttpChunkSource に差し替える。
 */
function blankManifest(): Manifest {
  return {
    version: 1,
    imageId: "blank-64MiB",
    size: DISK_SIZE,
    chunkSize: CHUNK_SIZE,
    chunks: Array.from({ length: DISK_SIZE / CHUNK_SIZE }, () => null),
  };
}

const noSource: ChunkSource = {
  fetchChunk: async () => {
    throw new Error("blank ディスクではチャンク取得は起きないはずです");
  },
};

async function main(): Promise<void> {
  log("準備中…");
  await requestPersistentStorage();

  let release: () => void;
  try {
    release = await acquireInstanceLock(INSTANCE_ID);
  } catch (error) {
    log(`起動できません: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  window.addEventListener("pagehide", release);

  const baseCache = await IdbKV.open("wasmbox-poc-cache", { durability: "relaxed" });
  const instance = await IdbKV.open("wasmbox-poc-instance", { durability: "strict" });
  const store = await ChunkedBlockStore.open({
    manifest: blankManifest(),
    source: noSource,
    baseCache,
    instance,
    // v86 のディスクにはゲストの fsync を伝えるフックが見当たらないため、定期 flush を短めにする
    flushIntervalMs: 1000,
    memoryCacheBytes: 32 * MiB,
    onError: (e) => log(`⚠️ flush に失敗: ${String(e)}`),
  });

  const device = new V86BlockDevice(store, {
    onError: (e) => log(`⚠️ ディスクI/Oに失敗（ゲストは止まります）: ${String(e)}`),
  });
  installAutoFlush(device);

  new V86({
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/seabios.bin" },
    vga_bios: { url: "vendor/vgabios.bin" },
    bzimage: { url: "vendor/buildroot-bzimage.bin" },
    cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
    hda: device, // get / set / load を持つオブジェクトは、そのままディスクとして使われる
    memory_size: 128 * MiB,
    serial_container: $("serial"),
    disable_mouse: true,
    disable_keyboard: true,
    disable_speaker: true,
    autostart: true,
  });

  $("flush").addEventListener("click", () => {
    device.flush().then(
      () => log("flush 完了"),
      (e) => log(`⚠️ flush に失敗: ${String(e)}`),
    );
  });

  $("reset").addEventListener("click", async () => {
    if (!confirm("ディスクの書き込み内容をすべて捨てて、初期状態に戻します。よろしいですか？")) return;
    try {
      await store.close();
      await ChunkedBlockStore.resetInstance(instance);
      location.reload();
    } catch (error) {
      log(`⚠️ 初期化に失敗: ${String(error)}`);
    }
  });

  setInterval(() => {
    const s = store.stats();
    log(
      `ディスク ${DISK_SIZE / MiB} MiB ｜ 未保存 ${s.pendingBytes} B ｜ 保存済みチャンク ${s.overlayChunks} ｜ ` +
        `flush ${s.flushes} 回（失敗 ${s.flushErrors}） ｜ キャッシュ ${(s.lruBytes / MiB).toFixed(1)} MiB`,
    );
  }, 1000);
}

main().catch((error) => log(`起動に失敗: ${error instanceof Error ? error.message : String(error)}`));
