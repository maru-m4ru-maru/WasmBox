import { V86BlockDevice } from "../src/engine/v86-block-device.ts";
import {
  ChunkedBlockStore,
  HttpChunkSource,
  IdbKV,
  ManifestMismatchError,
  acquireInstanceLock,
  installAutoFlush,
  requestPersistentStorage,
  validateManifest,
} from "../src/storage/index.ts";

declare const V86: new (options: Record<string, unknown>) => unknown;

const MiB = 1024 * 1024;
const params = new URLSearchParams(location.search);
const memoryMiB = Number(params.get("memory") ?? "256");
const root = params.get("root") ?? "/dev/sda";
const kernel = params.get("kernel") ?? "vendor/buildroot-bzimage.bin";
const imageDir = (params.get("image") ?? "image").replace(/\/+$/, "");
const cmdlineParam = params.get("cmdline");
const initrdParam = params.get("initrd");

const $ = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error("#" + id + " がありません");
  return element;
};
const status = $("status");
const log = (message: string) => {
  status.textContent = message;
};

const INSTANCE_ID = "alpine";
const CACHE_DB = "wasmbox-alpine-cache";
const INSTANCE_DB = "wasmbox-alpine-instance";

let store: ChunkedBlockStore | undefined;
let device: V86BlockDevice | undefined;

async function resetDisk(): Promise<void> {
  if (!confirm("ディスクの書き込み内容をすべて捨てて、初期状態に戻します。よろしいですか？")) return;
  try {
    await store?.close();
    const instance = await IdbKV.open(INSTANCE_DB, { durability: "strict" });
    await ChunkedBlockStore.resetInstance(instance);
    await instance.close();
    location.reload();
  } catch (error) {
    log("⚠️ 初期化に失敗: " + String(error));
  }
}

async function main(): Promise<void> {
  $("reset").addEventListener("click", () => void resetDisk());
  $("flush").addEventListener("click", () => {
    if (!device) return;
    device.flush().then(
      () => log("flush 完了"),
      (error) => log("⚠️ flush に失敗: " + String(error)),
    );
  });

  if (!Number.isFinite(memoryMiB) || memoryMiB < 64 || memoryMiB > 2048) {
    log("memory は 64〜2048（MiB）で指定してください: " + String(params.get("memory")));
    return;
  }

  log("イメージの manifest を取得中…");
  const response = await fetch(imageDir + "/manifest.json", { cache: "no-store" });
  if (!response.ok) {
    log(
      imageDir + "/manifest.json を取得できません（HTTP " + response.status + "）。" +
      "先に bash image/build.sh でイメージを作ってください。",
    );
    return;
  }
  const manifest = validateManifest(await response.json());

  let initrd: { url: string } | undefined;
  if (initrdParam !== "none") {
    const initrdUrl = initrdParam ?? imageDir + "/initrd.cpio";
    const head = await fetch(initrdUrl, { method: "HEAD", cache: "no-store" }).catch(() => undefined);
    if (head?.ok) {
      initrd = { url: initrdUrl };
    } else if (initrdParam) {
      log("initrd を取得できません: " + initrdUrl + "（HTTP " + (head?.status ?? "接続失敗") + "）");
      return;
    }
  }

  const cmdline =
    cmdlineParam ??
    [
      initrd ? "rdinit=/wasmbox-init" : undefined,
      "root=" + root,
      "rootfstype=ext4 rw rootwait console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    ]
      .filter(Boolean)
      .join(" ");

  await requestPersistentStorage();
  let release: () => void;
  try {
    release = await acquireInstanceLock(INSTANCE_ID);
  } catch (error) {
    log("起動できません: " + (error instanceof Error ? error.message : String(error)));
    return;
  }
  window.addEventListener("pagehide", release);

  const baseCache = await IdbKV.open(CACHE_DB, { durability: "relaxed" });
  const instance = await IdbKV.open(INSTANCE_DB, { durability: "strict" });
  try {
    store = await ChunkedBlockStore.open({
      manifest,
      source: new HttpChunkSource({
        layout: {
          kind: "chunk-files",
          urlFor: (_index, hash) => imageDir + "/chunks/" + hash,
        },
      }),
      baseCache,
      instance,
      flushIntervalMs: 1000,
      memoryCacheBytes: 32 * MiB,
      onError: (error) => log("⚠️ flush に失敗: " + String(error)),
    });
  } catch (error) {
    if (error instanceof ManifestMismatchError) {
      log(error.message + "\n→ 「ディスクを初期化」を押すと、保存済みの書き込みを捨てて新しいイメージで開けます。");
      return;
    }
    throw error;
  }

  device = new V86BlockDevice(store, {
    onError: (error) => log("⚠️ ディスクI/Oに失敗（ゲストは止まります）: " + String(error)),
  });
  installAutoFlush(device);

  $("boot-info").textContent =
    "イメージ " + manifest.imageId +
    "（" + (manifest.size / MiB).toFixed(0) + " MiB）／ RAM " + memoryMiB + " MiB ／ " +
    (initrd ? "initrd あり（" + initrd.url + "）" : "initrd なし") + "\n" + cmdline;

  const emulator = new V86({
    wasm_path: "vendor/v86.wasm",
    bios: { url: "vendor/seabios.bin" },
    vga_bios: { url: "vendor/vgabios.bin" },
    bzimage: { url: kernel },
    ...(initrd ? { initrd } : {}),
    cmdline,
    hda: device,
    memory_size: memoryMiB * MiB,
    serial_console: { type: "textarea", container: $("serial") },
    disable_mouse: true,
    disable_keyboard: true,
    disable_speaker: true,
    autostart: true,
  });

  if (params.get("smoke") === "1") {
    (window as Window & { __wasmboxAlpineV86?: unknown }).__wasmboxAlpineV86 = emulator;
  }

  const activeStore = store;
  setInterval(() => {
    const stats = activeStore.stats();
    log(
      "取得 " + stats.networkFetches + " チャンク（" +
      (stats.bytesFetched / MiB).toFixed(1) + " MiB）｜ " +
      "キャッシュ命中 メモリ " + stats.memoryHits + " / IndexedDB " + stats.baseCacheHits + " ｜ " +
      "未保存 " + stats.pendingBytes + " B ｜ 保存済みチャンク " + stats.overlayChunks +
      " ｜ flush " + stats.flushes + " 回（失敗 " + stats.flushErrors + "）",
    );
  }, 1000);
}

main().catch((error) => log("起動に失敗: " + (error instanceof Error ? error.message : String(error))));
