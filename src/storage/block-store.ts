import {
  ChunkIntegrityError,
  ManifestMismatchError,
  StorageClosedError,
  StorageError,
} from "./errors.ts";
import { ByteLRU } from "./lru.ts";
import {
  chunkCount,
  chunkLength,
  manifestDigest,
  sha256Hex,
  validateManifest,
} from "./manifest.ts";
import type { BlockStore, ChunkSource, KVBackend, KVOp, Manifest } from "./types.ts";

const MiB = 1024 * 1024;
const META_KEY = "m:instance";
const OVERLAY_PREFIX = "o:";
const baseKey = (hash: string) => `h:${hash}`;
const overlayKey = (index: number) => `${OVERLAY_PREFIX}${index}`;

export interface ChunkedBlockStoreOptions {
  manifest: Manifest;
  /** base チャンクの取得元（HTTP など） */
  source: ChunkSource;
  /**
   * 取得済み base チャンクの永続キャッシュ（ハッシュで引く内容アドレス方式）。
   * インスタンス間で共有してよい。
   */
  baseCache: KVBackend;
  /** このインスタンス専用の保存先。overlay（書き込み分）とメタ情報が入る。 */
  instance: KVBackend;
  /** メモリ上のクリーンなチャンクの予算（バイト）。既定 64 MiB。0 で無効。 */
  memoryCacheBytes?: number;
  /** 定期 flush の間隔（ms）。0 以下で無効。既定 3000。 */
  flushIntervalMs?: number;
  /** dirty 量がこれを超えたらバックグラウンドで flush する。既定 8 MiB。 */
  flushThresholdBytes?: number;
  /** dirty 量がこれを超えたら write() が flush 完了を待つ（バックプレッシャ）。既定 32 MiB。 */
  maxDirtyBytes?: number;
  /** シーケンシャルアクセス検出時に先読みするチャンク数。既定 2。0 で無効。 */
  readaheadChunks?: number;
  /** 同時に行うチャンク取得の最大数。既定 6。 */
  maxConcurrentFetches?: number;
  /** 取得したチャンクを SHA-256 で検証する。既定 true。 */
  verify?: boolean;
  /** バックグラウンド flush の失敗通知。既定は console.error。 */
  onError?: (error: unknown) => void;
}

export interface StoreStats {
  /** dirty / flush 中 / メモリキャッシュから返せた回数 */
  memoryHits: number;
  /** IndexedDB の base キャッシュから返せた回数 */
  baseCacheHits: number;
  overlayReads: number;
  networkFetches: number;
  bytesFetched: number;
  readaheadErrors: number;
  flushes: number;
  flushErrors: number;
  chunksFlushed: number;
  /** 現在 flush 待ちのバイト数（flush 中のぶんを含む） */
  pendingBytes: number;
  overlayChunks: number;
  lruBytes: number;
  lruChunks: number;
}

type State = "open" | "closing" | "closed";

export class ChunkedBlockStore implements BlockStore {
  readonly size: number;

  readonly #manifest: Manifest;
  readonly #chunkSize: number;
  readonly #chunkTotal: number;
  readonly #source: ChunkSource;
  readonly #baseCache: KVBackend;
  readonly #instance: KVBackend;
  readonly #lru: ByteLRU<number, Uint8Array>;
  readonly #overlay: Set<number>;

  readonly #flushIntervalMs: number;
  readonly #flushThresholdBytes: number;
  readonly #maxDirtyBytes: number;
  readonly #readahead: number;
  readonly #maxFetches: number;
  readonly #verify: boolean;
  readonly #onError: (error: unknown) => void;

  /** 書き込み済みだが未 flush のチャンク（このMapのバッファだけは in-place で更新してよい） */
  #dirty = new Map<number, Uint8Array>();
  #dirtyBytes = 0;
  /** flush 中のスナップショット。読み取りの参照先であり、絶対に書き換えない。 */
  #flushing = new Map<number, Uint8Array>();
  #flushingBytes = 0;

  /** チャンクごとの書き込み回数。遅れて届いた古い読み込み結果をキャッシュに入れないために使う。 */
  readonly #versions = new Map<number, number>();
  readonly #inflight = new Map<number, Promise<Uint8Array>>();

  #state: State = "open";
  #writeChain: Promise<void> = Promise.resolve();
  #flushChain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastReadChunk: number | undefined;

  #fetchActive = 0;
  readonly #fetchWaiters: Array<() => void> = [];

  readonly #stats = {
    memoryHits: 0,
    baseCacheHits: 0,
    overlayReads: 0,
    networkFetches: 0,
    bytesFetched: 0,
    readaheadErrors: 0,
    flushes: 0,
    flushErrors: 0,
    chunksFlushed: 0,
  };

  private constructor(
    manifest: Manifest,
    options: ChunkedBlockStoreOptions,
    overlay: Set<number>,
  ) {
    this.#manifest = manifest;
    this.size = manifest.size;
    this.#chunkSize = manifest.chunkSize;
    this.#chunkTotal = chunkCount(manifest.size, manifest.chunkSize);
    this.#source = options.source;
    this.#baseCache = options.baseCache;
    this.#instance = options.instance;
    this.#overlay = overlay;
    this.#lru = new ByteLRU(options.memoryCacheBytes ?? 64 * MiB);
    this.#flushIntervalMs = options.flushIntervalMs ?? 3000;
    this.#flushThresholdBytes = options.flushThresholdBytes ?? 8 * MiB;
    this.#maxDirtyBytes = options.maxDirtyBytes ?? 32 * MiB;
    this.#readahead = options.readaheadChunks ?? 2;
    this.#maxFetches = Math.max(1, options.maxConcurrentFetches ?? 6);
    this.#verify = options.verify ?? true;
    this.#onError =
      options.onError ?? ((e) => console.error("[WasmBox] バックグラウンド flush に失敗しました:", e));
  }

  /**
   * ストアを開く。instance に既存の overlay があれば引き継ぐ。
   * 別のイメージ用の overlay だった場合は ManifestMismatchError。
   * その場合は resetInstance() で overlay を捨てれば開ける。
   */
  static async open(options: ChunkedBlockStoreOptions): Promise<ChunkedBlockStore> {
    const manifest = validateManifest(options.manifest);
    const digest = await manifestDigest(manifest);
    const total = chunkCount(manifest.size, manifest.chunkSize);

    const metaBytes = await options.instance.get(META_KEY);
    if (metaBytes) {
      const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as {
        imageId?: string;
        digest?: string;
      };
      if (meta.digest !== digest) {
        throw new ManifestMismatchError(
          `このインスタンスは別のイメージ用です（保存済み: ${meta.imageId ?? "不明"}、指定: ${manifest.imageId}）。` +
            `ChunkedBlockStore.resetInstance() で overlay を破棄すると開けます`,
        );
      }
    } else {
      const orphan = await options.instance.keys(OVERLAY_PREFIX);
      if (orphan.length > 0) {
        throw new ManifestMismatchError(
          "メタ情報がないのに overlay が存在します。resetInstance() で破棄してください",
        );
      }
      const meta = JSON.stringify({ imageId: manifest.imageId, digest });
      await options.instance.batch([
        { type: "put", key: META_KEY, value: new TextEncoder().encode(meta) },
      ]);
    }

    const overlay = new Set<number>();
    for (const key of await options.instance.keys(OVERLAY_PREFIX)) {
      const index = Number(key.slice(OVERLAY_PREFIX.length));
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        throw new StorageError(`不正な overlay キーです: ${key}`);
      }
      overlay.add(index);
    }
    return new ChunkedBlockStore(manifest, options, overlay);
  }

  /** instance の overlay とメタ情報をすべて削除する（初期状態に戻す）。ストアを開く前に呼ぶこと。 */
  static async resetInstance(instance: KVBackend): Promise<void> {
    const keys = [META_KEY, ...(await instance.keys(OVERLAY_PREFIX))];
    await instance.batch(keys.map((key): KVOp => ({ type: "delete", key })));
  }

  // ---------------------------------------------------------------- 読み取り

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.#assertNotClosed();
    this.#checkRange(offset, length);
    const out = new Uint8Array(length);
    if (length === 0) return out;

    const cs = this.#chunkSize;
    const first = Math.floor(offset / cs);
    const last = Math.floor((offset + length - 1) / cs);
    const jobs: Promise<void>[] = [];
    for (let i = first; i <= last; i++) {
      jobs.push(
        this.#getChunk(i).then((chunk) => {
          const chunkStart = i * cs;
          const from = Math.max(offset, chunkStart);
          const to = Math.min(offset + length, chunkStart + chunk.byteLength);
          out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
        }),
      );
    }
    this.#noteRead(first, last);
    await Promise.all(jobs);
    return out;
  }

  #getChunk(index: number): Promise<Uint8Array> {
    const pending = this.#dirty.get(index) ?? this.#flushing.get(index);
    if (pending) {
      this.#stats.memoryHits++;
      return Promise.resolve(pending);
    }
    const cached = this.#lru.get(index);
    if (cached) {
      this.#stats.memoryHits++;
      return Promise.resolve(cached);
    }
    const existing = this.#inflight.get(index);
    if (existing) return existing;

    const version = this.#versions.get(index) ?? 0;
    const promise: Promise<Uint8Array> = this.#load(index)
      .then((chunk) => {
        // 読み込み中に書き込まれていたら、古い内容はキャッシュに入れない
        if (this.#state !== "closed" && (this.#versions.get(index) ?? 0) === version) {
          this.#lru.set(index, chunk);
        }
        return chunk;
      })
      .finally(() => {
        if (this.#inflight.get(index) === promise) this.#inflight.delete(index);
      });
    this.#inflight.set(index, promise);
    return promise;
  }

  async #load(index: number): Promise<Uint8Array> {
    if (this.#overlay.has(index)) {
      const bytes = await this.#instance.get(overlayKey(index));
      if (!bytes || bytes.byteLength !== chunkLength(this.#manifest, index)) {
        throw new StorageError(`overlay のチャンク ${index} が見つからないか、サイズが不正です`);
      }
      this.#stats.overlayReads++;
      return bytes;
    }
    return this.#loadBase(index);
  }

  async #loadBase(index: number): Promise<Uint8Array> {
    const hash = this.#manifest.chunks[index];
    const length = chunkLength(this.#manifest, index);
    if (hash === null || hash === undefined) return new Uint8Array(length);

    const cached = await this.#baseCache.get(baseKey(hash));
    if (cached && cached.byteLength === length) {
      this.#stats.baseCacheHits++;
      return cached;
    }

    const data = await this.#fetchLimited(index, hash);
    if (data.byteLength !== length) {
      throw new ChunkIntegrityError(
        index,
        hash,
        "-",
        `チャンク ${index} のサイズが想定と違います（期待 ${length}、実際 ${data.byteLength}）`,
      );
    }
    if (this.#verify) {
      const actual = await sha256Hex(data);
      if (actual !== hash) throw new ChunkIntegrityError(index, hash, actual);
    }
    try {
      await this.#baseCache.batch([{ type: "put", key: baseKey(hash), value: data }]);
    } catch {
      // キャッシュへの保存失敗は読み取りの失敗にしない（次回また取得すればよい）
    }
    return data;
  }

  async #fetchLimited(index: number, hash: string): Promise<Uint8Array> {
    if (this.#fetchActive < this.#maxFetches) {
      this.#fetchActive++;
    } else {
      await new Promise<void>((resolve) => this.#fetchWaiters.push(resolve));
      // 枠は release 側から引き継がれている
    }
    try {
      this.#stats.networkFetches++;
      const data = await this.#source.fetchChunk(index, hash);
      this.#stats.bytesFetched += data.byteLength;
      return data;
    } finally {
      const next = this.#fetchWaiters.shift();
      if (next) next();
      else this.#fetchActive--;
    }
  }

  /** 連続する読み取りを検出したら、続きのチャンクをバックグラウンドで先読みする */
  #noteRead(first: number, last: number): void {
    const previous = this.#lastReadChunk;
    this.#lastReadChunk = last;
    if (this.#readahead <= 0 || previous === undefined) return;
    if (first !== previous && first !== previous + 1) return;
    for (let k = 1; k <= this.#readahead; k++) {
      const index = last + k;
      if (index >= this.#chunkTotal) break;
      if (
        this.#dirty.has(index) ||
        this.#flushing.has(index) ||
        this.#lru.has(index) ||
        this.#inflight.has(index)
      ) {
        continue;
      }
      this.#getChunk(index).catch(() => {
        this.#stats.readaheadErrors++;
      });
    }
  }

  // ---------------------------------------------------------------- 書き込み

  write(offset: number, data: Uint8Array): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(new StorageClosedError("ストアは閉じられています"));
    }
    const task = this.#writeChain.then(() => this.#writeImpl(offset, data));
    this.#writeChain = task.catch(() => {});
    return task;
  }

  async #writeImpl(offset: number, data: Uint8Array): Promise<void> {
    this.#assertNotClosed();
    this.#checkRange(offset, data.byteLength);
    if (data.byteLength === 0) return;

    const cs = this.#chunkSize;
    const first = Math.floor(offset / cs);
    const last = Math.floor((offset + data.byteLength - 1) / cs);
    for (let i = first; i <= last; i++) {
      const chunkStart = i * cs;
      const length = chunkLength(this.#manifest, i);
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + data.byteLength, chunkStart + length);
      const part = data.subarray(from - offset, to - offset);

      let buf = this.#dirty.get(i);
      if (buf) {
        buf.set(part, from - chunkStart);
      } else {
        if (from === chunkStart && to === chunkStart + length) {
          buf = part.slice(); // 全面上書き: 元の内容を読む必要がない
        } else {
          buf = (await this.#getChunk(i)).slice();
          buf.set(part, from - chunkStart);
        }
        this.#dirty.set(i, buf);
        this.#dirtyBytes += buf.byteLength;
      }
      this.#versions.set(i, (this.#versions.get(i) ?? 0) + 1);
      this.#lru.delete(i);
    }

    if (this.#dirtyBytes >= this.#flushThresholdBytes) this.#backgroundFlush();
    else this.#scheduleFlush();

    if (this.#dirtyBytes + this.#flushingBytes >= this.#maxDirtyBytes) {
      await this.flush(); // バックプレッシャ: 溜まりすぎたら flush 完了まで待たせる
    }
  }

  // ---------------------------------------------------------------- flush

  /** それ以前に完了した write() をすべて IndexedDB に書き込んでから解決する。 */
  flush(): Promise<void> {
    const run = this.#flushChain.then(() => this.#flushOnce());
    this.#flushChain = run.catch(() => {});
    return run;
  }

  async #flushOnce(): Promise<void> {
    if (this.#dirty.size === 0) return;

    const snapshot = this.#dirty;
    this.#flushing = snapshot;
    this.#flushingBytes = this.#dirtyBytes;
    this.#dirty = new Map();
    this.#dirtyBytes = 0;

    const ops: KVOp[] = [];
    for (const [index, value] of snapshot) {
      ops.push({ type: "put", key: overlayKey(index), value });
    }

    try {
      await this.#instance.batch(ops);
    } catch (err) {
      // 失敗: スナップショットを dirty に戻す（flush 中に書かれた新しい内容があればそちらを優先）
      for (const [index, value] of snapshot) {
        if (!this.#dirty.has(index)) {
          this.#dirty.set(index, value);
          this.#dirtyBytes += value.byteLength;
        }
      }
      this.#flushing = new Map();
      this.#flushingBytes = 0;
      this.#stats.flushErrors++;
      throw err;
    }

    for (const [index, value] of snapshot) {
      this.#overlay.add(index);
      if (!this.#dirty.has(index) && this.#state !== "closed") this.#lru.set(index, value);
    }
    this.#flushing = new Map();
    this.#flushingBytes = 0;
    this.#stats.flushes++;
    this.#stats.chunksFlushed += snapshot.size;
  }

  #scheduleFlush(): void {
    if (this.#flushIntervalMs <= 0 || this.#timer !== undefined || this.#state === "closed") return;
    if (this.#dirty.size === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#backgroundFlush();
    }, this.#flushIntervalMs);
    // Node で、タイマーだけがプロセスを生かし続けないようにする
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  #backgroundFlush(): void {
    this.flush().catch((err) => {
      this.#onError(err);
      this.#scheduleFlush(); // dirty は残っているので、次の周期で再試行する
    });
  }

  // ---------------------------------------------------------------- 終了・状態

  /**
   * 未 flush の書き込みを flush してから閉じる。flush に失敗した場合は例外を投げ、
   * ストアは開いたままになる（呼び出し側で再試行できる）。
   * baseCache / instance のバックエンドは呼び出し側が閉じる。
   */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing"; // 新規の write を止める（キューにある書き込みは完了させる）
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    try {
      await this.#writeChain;
      await this.flush();
    } catch (err) {
      this.#state = "open";
      throw err;
    }
    this.#state = "closed";
    this.#lru.clear();
  }

  stats(): StoreStats {
    return {
      ...this.#stats,
      pendingBytes: this.#dirtyBytes + this.#flushingBytes,
      overlayChunks: this.#overlay.size,
      lruBytes: this.#lru.bytes,
      lruChunks: this.#lru.size,
    };
  }

  #assertNotClosed(): void {
    if (this.#state === "closed") throw new StorageClosedError("ストアは閉じられています");
  }

  #checkRange(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new RangeError(
        `範囲外のアクセスです（offset=${offset}, length=${length}, size=${this.size}）`,
      );
    }
  }
}
