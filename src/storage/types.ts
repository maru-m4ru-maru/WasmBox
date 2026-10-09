/**
 * Engine から見た「ディスク」。ブロックデバイスI/Oの受け口。
 *
 * - write() に渡したバッファは、返ってきた Promise が解決するまで変更しないこと。
 * - flush() が解決した時点で、それ以前に完了した write() はすべて永続化されている
 *   （ゲストの fsync / sync に対応させる）。
 */
export interface BlockStore {
  /** ディスクの総バイト数 */
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  write(offset: number, data: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type KVOp =
  | { type: "put"; key: string; value: Uint8Array }
  | { type: "delete"; key: string };

/**
 * 非同期のKVストア（値はバイト列）。IndexedDB などの裏側を差し替えるための境界。
 * batch() は原子的であること（全部成功するか、全部失敗するか）。
 */
export interface KVBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  /** prefix で始まるキーを昇順で返す */
  keys(prefix: string): Promise<string[]>;
  batch(ops: readonly KVOp[]): Promise<void>;
  close(): Promise<void>;
}

/** base イメージのチャンクを取得する元（HTTP など）。 */
export interface ChunkSource {
  /** hash は manifest 上の期待ハッシュ。取得したバイト列の検証は呼び出し側が行う。 */
  fetchChunk(index: number, hash: string): Promise<Uint8Array>;
}

export interface Manifest {
  version: 1;
  /** イメージの識別子（人間が読める名前） */
  imageId: string;
  /** イメージの総バイト数 */
  size: number;
  /** チャンクのバイト数（最後のチャンクだけ短くてよい） */
  chunkSize: number;
  /** チャンクごとの SHA-256（hex 小文字）。null はゼロ埋めチャンク（配信不要）。 */
  chunks: (string | null)[];
}
