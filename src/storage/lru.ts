/**
 * バイト予算つきの LRU。件数ではなく合計バイト数で追い出す。
 * 予算より大きい値は保存しない。maxBytes = 0 ならキャッシュ無効。
 */
export class ByteLRU<K, V extends { readonly byteLength: number }> {
  readonly maxBytes: number;
  #map = new Map<K, V>();
  #bytes = 0;

  constructor(maxBytes: number) {
    if (!(maxBytes >= 0)) {
      throw new RangeError(`maxBytes は 0 以上である必要があります: ${maxBytes}`);
    }
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#map.size;
  }

  /** 使用順を更新せずに存在だけ調べる */
  has(key: K): boolean {
    return this.#map.has(key);
  }

  /** 取得すると「最近使った」扱いになる */
  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    if (value.byteLength > this.maxBytes) return;
    this.#map.set(key, value);
    this.#bytes += value.byteLength;
    while (this.#bytes > this.maxBytes) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    const value = this.#map.get(key);
    if (value === undefined) return false;
    this.#map.delete(key);
    this.#bytes -= value.byteLength;
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }
}
