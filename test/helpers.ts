import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import type { ChunkedBlockStoreOptions } from "../src/storage/block-store.ts";
import { MemoryKV } from "../src/storage/kv-memory.ts";
import { sha256Hex } from "../src/storage/manifest.ts";
import type { ChunkSource, KVOp, Manifest } from "../src/storage/types.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 条件が満たされるまで待つ（タイムアウトで例外） */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("eventually: タイムアウト");
    await sleep(5);
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 再現性のある疑似乱数バイト列（xorshift32） */
export function pseudoRandomBytes(size: number, seed = 1): Uint8Array {
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

export interface TestImage {
  bytes: Uint8Array;
  manifest: Manifest;
  chunkData: Map<string, Uint8Array>;
}

export async function makeImage(opts: {
  size: number;
  chunkSize: number;
  zeroChunks?: number[];
  imageId?: string;
  seed?: number;
}): Promise<TestImage> {
  const bytes = pseudoRandomBytes(opts.size, opts.seed ?? 1);
  const total = Math.ceil(opts.size / opts.chunkSize);
  const zero = new Set(opts.zeroChunks ?? []);
  const chunks: (string | null)[] = [];
  const chunkData = new Map<string, Uint8Array>();
  for (let i = 0; i < total; i++) {
    const start = i * opts.chunkSize;
    const end = Math.min(start + opts.chunkSize, opts.size);
    if (zero.has(i)) {
      bytes.fill(0, start, end);
      chunks.push(null);
      continue;
    }
    const slice = bytes.slice(start, end);
    const hash = await sha256Hex(slice);
    chunks.push(hash);
    chunkData.set(hash, slice);
  }
  return {
    bytes,
    manifest: {
      version: 1,
      imageId: opts.imageId ?? "test-image",
      size: opts.size,
      chunkSize: opts.chunkSize,
      chunks,
    },
    chunkData,
  };
}

/** 取得されたチャンク番号を記録するソース。遅延・失敗・破損・一時停止を注入できる。 */
export class CountingSource implements ChunkSource {
  calls: number[] = [];
  active = 0;
  maxActive = 0;
  delayMs = 0;
  gate: Promise<void> | undefined;
  corrupt = new Set<number>();
  failTimes = 0;
  readonly #image: TestImage;

  constructor(image: TestImage) {
    this.#image = image;
  }

  async fetchChunk(index: number, hash: string): Promise<Uint8Array> {
    this.calls.push(index);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.gate) await this.gate;
      if (this.delayMs > 0) await sleep(this.delayMs);
      if (this.failTimes > 0) {
        this.failTimes--;
        throw new Error("注入された取得失敗");
      }
      const data = this.#image.chunkData.get(hash);
      if (!data) throw new Error(`未知のハッシュ: ${hash}`);
      const copy = data.slice();
      if (this.corrupt.has(index)) copy[0] = (copy[0] ?? 0) ^ 0xff;
      return copy;
    } finally {
      this.active--;
    }
  }
}

/** batch に遅延・失敗を注入できる MemoryKV */
export class TestKV extends MemoryKV {
  batchDelayMs = 0;
  failBatches = 0;
  batchCalls = 0;

  override async batch(ops: readonly KVOp[]): Promise<void> {
    this.batchCalls++;
    if (this.batchDelayMs > 0) await sleep(this.batchDelayMs);
    if (this.failBatches > 0) {
      this.failBatches--;
      throw new Error("注入された書き込み失敗");
    }
    return super.batch(ops);
  }
}

export interface Env {
  source: CountingSource;
  baseCache: TestKV;
  instance: TestKV;
}

export function newEnv(image: TestImage): Env {
  return { source: new CountingSource(image), baseCache: new TestKV(), instance: new TestKV() };
}

/** テストでは既定で定期 flush と先読みを切り、必要なテストだけ有効にする。 */
export function openStore(
  image: TestImage,
  env: Env,
  overrides: Partial<ChunkedBlockStoreOptions> = {},
): Promise<ChunkedBlockStore> {
  return ChunkedBlockStore.open({
    manifest: image.manifest,
    source: env.source,
    baseCache: env.baseCache,
    instance: env.instance,
    flushIntervalMs: 0,
    readaheadChunks: 0,
    ...overrides,
  });
}
