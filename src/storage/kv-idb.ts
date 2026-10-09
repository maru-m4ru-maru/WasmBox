import { StorageError } from "./errors.ts";
import type { KVBackend, KVOp } from "./types.ts";

const STORE = "kv";

export interface IdbKVOptions {
  /**
   * 書き込みトランザクションの耐久性。
   * - instance（overlay）用: "strict"（flush の完了＝ディスクへの書き込み完了に近づける）
   * - baseCache 用: "relaxed"（再取得できるので速度優先）
   */
  durability?: "default" | "strict" | "relaxed";
  /** テストなどで IDBFactory を差し替えたいとき */
  factory?: IDBFactory;
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("IndexedDB から想定外の型の値が返りました");
}

/**
 * 構造化複製は「ビューが指す ArrayBuffer 全体」をコピーしてしまうため、
 * 大きなバッファの一部を指すビューは、ぴったりのサイズにコピーしてから渡す。
 */
function exact(value: Uint8Array): Uint8Array {
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value
    : value.slice();
}

export class IdbKV implements KVBackend {
  readonly #db: IDBDatabase;
  readonly #durability: "default" | "strict" | "relaxed";

  private constructor(db: IDBDatabase, durability: "default" | "strict" | "relaxed") {
    this.#db = db;
    this.#durability = durability;
  }

  static open(name: string, options: IdbKVOptions = {}): Promise<IdbKV> {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) {
      return Promise.reject(new StorageError("IndexedDB が利用できません"));
    }
    return new Promise((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(new IdbKV(req.result, options.durability ?? "default"));
      req.onerror = () =>
        reject(req.error ?? new StorageError(`IndexedDB "${name}" を開けませんでした`));
    });
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        try {
          resolve(toBytes(req.result));
        } catch (err) {
          reject(err);
        }
      };
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new StorageError("読み取りが中断されました"));
    });
  }

  keys(prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE, "readonly");
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      const req = tx.objectStore(STORE).getAllKeys(range);
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new StorageError("読み取りが中断されました"));
    });
  }

  batch(ops: readonly KVOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE, "readwrite", { durability: this.#durability });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new StorageError("書き込みに失敗しました"));
      tx.onabort = () => reject(tx.error ?? new StorageError("書き込みが中断されました"));
      try {
        const store = tx.objectStore(STORE);
        for (const op of ops) {
          if (op.type === "put") store.put(exact(op.value), op.key);
          else store.delete(op.key);
        }
      } catch (err) {
        reject(err);
        try {
          tx.abort();
        } catch {
          // すでに完了/中断している場合は無視
        }
      }
    });
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
