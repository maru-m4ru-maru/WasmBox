import type { KVBackend, KVOp } from "./types.ts";

/**
 * メモリ上のKV。IndexedDB と同じく、保存時・取得時にバイト列をコピーする
 * （呼び出し側がバッファを共有してしまうバグをテストで拾うため）。
 */
export class MemoryKV implements KVBackend {
  #map = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    await Promise.resolve();
    return this.#map.get(key)?.slice();
  }

  async keys(prefix: string): Promise<string[]> {
    await Promise.resolve();
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async batch(ops: readonly KVOp[]): Promise<void> {
    await Promise.resolve();
    // 先にコピーを作ってから反映する（途中で例外が出ても半端に書かない）
    const staged = ops.map((op) =>
      op.type === "put" ? { ...op, value: op.value.slice() } : op,
    );
    for (const op of staged) {
      if (op.type === "put") this.#map.set(op.key, op.value);
      else this.#map.delete(op.key);
    }
  }

  async close(): Promise<void> {}

  /** テスト用: 保存されているエントリ数 */
  get entryCount(): number {
    return this.#map.size;
  }
}
