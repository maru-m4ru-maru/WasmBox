/**
 * ブラウザ自己診断。v86 がなくても、Storage 層とアダプタが「そのブラウザで」動くかを確かめる。
 *
 * 使い方:
 *   1) ?phase=write … 読み書き → flush（IndexedDB を初期化してから開始）
 *   2) ページを再読み込みして ?phase=verify … 閉じて開き直したあとも内容が残っているか
 *
 * 結果は画面に表示され、window.__selftest にも入る（自動テスト用）。
 */
import { V86BlockDevice } from "../src/engine/v86-block-device.ts";
import { ChunkedBlockStore, HttpChunkSource, IdbKV, sha256Hex } from "../src/storage/index.ts";
import type { ChunkSource, Manifest } from "../src/storage/index.ts";

const SECTOR = 512;
const CHUNK = 4096;
const SIZE = 64 * 1024; // 16 チャンク
const CACHE_DB = "wasmbox-selftest-cache";
const INSTANCE_DB = "wasmbox-selftest-instance";

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}

/** 再現性のある疑似乱数（xorshift32） */
function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function buildImage(): Promise<{ bytes: Uint8Array; manifest: Manifest; chunks: Map<string, Uint8Array> }> {
  const bytes = pseudoRandomBytes(SIZE, 12345);
  const hashes: string[] = [];
  const chunks = new Map<string, Uint8Array>();
  for (let i = 0; i < SIZE / CHUNK; i++) {
    const slice = bytes.slice(i * CHUNK, (i + 1) * CHUNK);
    const hash = await sha256Hex(slice);
    hashes.push(hash);
    chunks.set(hash, slice);
  }
  return {
    bytes,
    manifest: { version: 1, imageId: "selftest", size: SIZE, chunkSize: CHUNK, chunks: hashes },
    chunks,
  };
}

const getAsync = (dev: V86BlockDevice, start: number, length: number) =>
  new Promise<Uint8Array>((resolve) => dev.get(start, length, resolve));
const setAsync = (dev: V86BlockDevice, start: number, data: Uint8Array) =>
  new Promise<void>((resolve) => dev.set(start, data, resolve));

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`${name} の削除がブロックされました（他のタブで開いていませんか）`));
  });
}

/** HTTP から1つ目のチャンクを取る場合に使う（?http=... を渡したときだけ） */
function makeSource(chunks: Map<string, Uint8Array>, counter: { calls: number }): ChunkSource {
  const httpBase = new URLSearchParams(location.search).get("http");
  if (httpBase) {
    const http = new HttpChunkSource({
      layout: { kind: "chunk-files", urlFor: (_i, hash) => `${httpBase}/chunks/${hash}` },
    });
    return {
      fetchChunk: (i, h) => {
        counter.calls++;
        return http.fetchChunk(i, h);
      },
    };
  }
  return {
    fetchChunk: async (_i, hash) => {
      counter.calls++;
      const data = chunks.get(hash);
      if (!data) throw new Error("未知のチャンク");
      return data.slice();
    },
  };
}

async function environment(): Promise<void> {
  await check("環境: IndexedDB が使える", () => assert(typeof indexedDB !== "undefined", "indexedDB がありません"));
  await check("環境: crypto.subtle が使える（HTTPS または localhost が必要）", () =>
    assert(typeof crypto?.subtle?.digest === "function", "crypto.subtle がありません"));
  await check("環境: Web Locks が使える", () => assert(typeof navigator.locks?.request === "function", "navigator.locks がありません"));
  await check("環境: storage.persist() が使える（情報のみ）", async () => {
    const persisted = await navigator.storage?.persisted?.();
    results.push({ name: `  (参考) 永続化の状態: ${String(persisted)}`, ok: true });
  });
}

async function phaseWrite(): Promise<void> {
  const image = await buildImage();
  const counter = { calls: 0 };
  await deleteDatabase(CACHE_DB);
  await deleteDatabase(INSTANCE_DB);

  const baseCache = await IdbKV.open(CACHE_DB, { durability: "relaxed" });
  const instance = await IdbKV.open(INSTANCE_DB, { durability: "strict" });
  const store = await ChunkedBlockStore.open({
    manifest: image.manifest,
    source: makeSource(image.chunks, counter),
    baseCache,
    instance,
    flushIntervalMs: 0,
    readaheadChunks: 0,
  });
  const device = new V86BlockDevice(store);

  await check("write: 最初のチャンクを読むと元のイメージと一致する", async () => {
    const got = await getAsync(device, 0, CHUNK);
    assert(equal(got, image.bytes.slice(0, CHUNK)), "内容が一致しません");
    assert(counter.calls === 1, `取得回数が想定外: ${counter.calls}`);
  });

  await check("write: 書き込まないチャンク（セクタ40付近）も読め、取得してキャッシュされる", async () => {
    const before = counter.calls;
    const got = await getAsync(device, SECTOR * 40, SECTOR);
    assert(equal(got, image.bytes.slice(SECTOR * 40, SECTOR * 41)), "内容が一致しません");
    assert(counter.calls === before + 1, "取得されませんでした");
  });

  await check("write: セクタ10・11に書き込み、読み戻せる", async () => {
    await setAsync(device, SECTOR * 10, new Uint8Array(SECTOR).fill(0xa5));
    await setAsync(device, SECTOR * 11, new Uint8Array(SECTOR).fill(0x5a));
    assert(equal(await getAsync(device, SECTOR * 10, SECTOR), new Uint8Array(SECTOR).fill(0xa5)), "セクタ10が違います");
    assert(equal(await getAsync(device, SECTOR * 11, SECTOR), new Uint8Array(SECTOR).fill(0x5a)), "セクタ11が違います");
  });

  await check("write: チャンクをまたぐ書き込み（セクタ7〜8）ができる", async () => {
    await setAsync(device, SECTOR * 7, new Uint8Array(SECTOR * 2).fill(0x33));
    assert(equal(await getAsync(device, SECTOR * 7, SECTOR * 2), new Uint8Array(SECTOR * 2).fill(0x33)), "内容が違います");
  });

  await check("write: flush が成功し、overlay が IndexedDB に保存される", async () => {
    await device.flush();
    const keys = await instance.keys("o:");
    assert(keys.length >= 1, `overlay が保存されていません: ${JSON.stringify(keys)}`);
  });

  await check("write: close できる", async () => {
    await store.close();
    await baseCache.close();
    await instance.close();
  });
}

async function phaseVerify(): Promise<void> {
  const image = await buildImage();
  const counter = { calls: 0 };
  const baseCache = await IdbKV.open(CACHE_DB, { durability: "relaxed" });
  const instance = await IdbKV.open(INSTANCE_DB, { durability: "strict" });
  const store = await ChunkedBlockStore.open({
    manifest: image.manifest,
    source: makeSource(image.chunks, counter),
    baseCache,
    instance,
    flushIntervalMs: 0,
    readaheadChunks: 0,
  });
  const device = new V86BlockDevice(store);

  await check("verify: 再読み込み後も、書き込んだセクタ10・11が残っている", async () => {
    assert(equal(await getAsync(device, SECTOR * 10, SECTOR), new Uint8Array(SECTOR).fill(0xa5)), "セクタ10が失われました");
    assert(equal(await getAsync(device, SECTOR * 11, SECTOR), new Uint8Array(SECTOR).fill(0x5a)), "セクタ11が失われました");
  });

  await check("verify: チャンクをまたいだ書き込み（セクタ7〜8）が残っている", async () => {
    assert(equal(await getAsync(device, SECTOR * 7, SECTOR * 2), new Uint8Array(SECTOR * 2).fill(0x33)), "内容が失われました");
  });

  await check("verify: 書き込んでいない部分は、元のイメージのまま", async () => {
    const got = await getAsync(device, SECTOR * 12, SECTOR * 4);
    assert(equal(got, image.bytes.slice(SECTOR * 12, SECTOR * 16)), "元の内容と違います");
  });

  await check("verify: 書き込んでいないチャンクは元のまま読め、ネットワークに取りに行かず IndexedDB のキャッシュから読まれる", async () => {
    const got = await getAsync(device, SECTOR * 40, SECTOR);
    assert(equal(got, image.bytes.slice(SECTOR * 40, SECTOR * 41)), "元の内容と違います");
    assert(counter.calls === 0, `ソースが ${counter.calls} 回呼ばれました（キャッシュが効いていません）`);
    assert(store.stats().baseCacheHits === 1, `baseCache から読まれていません（hits=${store.stats().baseCacheHits}）`);
  });

  await store.close();
}

function render(): void {
  const ok = results.every((r) => r.ok);
  const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? `\n     → ${r.detail}` : ""}`);
  const out = document.getElementById("out");
  if (out) out.textContent = `${ok ? "すべて成功" : "失敗があります"}\n\n${lines.join("\n")}`;
  (window as unknown as { __selftest: unknown }).__selftest = { done: true, ok, results };
}

const phase = new URLSearchParams(location.search).get("phase") ?? "write";
(async () => {
  await environment();
  if (phase === "verify") await phaseVerify();
  else await phaseWrite();
})()
  .catch((error) => {
    results.push({ name: "予期しない例外", ok: false, detail: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  })
  .finally(render);
