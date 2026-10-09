import type { BlockStore } from "../storage/types.ts";

/**
 * v86 が hda などに受け付ける「loadable」の形。
 *
 * v86 の starter.js は、オプションで渡されたオブジェクトが get / set / load を持っていれば、
 * それをそのままディスクとして使う（URL や ArrayBuffer ではなく、自作の実装を渡せる）。
 * 起動時に `onload` を代入してから `load()` を呼び、`onload` が呼ばれた時点でディスクとして登録される。
 *
 * ※ 上記は v86 のソースの公開ミラーを読んで確認した挙動。最新版で変わっていないかは実機で要確認。
 */
export interface V86Loadable {
  byteLength: number;
  onload: ((event: object) => void) | undefined;
  onprogress: ((event: object) => void) | undefined;
  load(): void;
  get(start: number, length: number, callback: (data: Uint8Array) => void): void;
  set(start: number, data: Uint8Array, callback: () => void): void;
  get_buffer(callback: (buffer?: ArrayBuffer) => void): void;
  get_state(): unknown[];
  set_state(state: unknown[]): void;
}

export interface V86BlockDeviceOptions {
  /**
   * ディスクI/Oの失敗通知。
   * v86 のコールバックには失敗を伝える手段がないため、失敗するとゲストの該当I/Oは完了せず止まる。
   * UI 側で必ずこの通知を拾い、利用者に知らせること。既定は console.error。
   */
  onError?: (error: unknown) => void;
}

const SECTOR_SIZE = 512;

/**
 * BlockStore を v86 のディスクとして見せるアダプタ。
 *
 * - 読み書きの単位は v86 側が 256 バイトの倍数で要求してくる。BlockStore は任意の範囲を扱えるので変換は不要。
 * - set() に渡されたバッファは、v86 が呼び出し直後に再利用する可能性があるため、その場でコピーする。
 * - 書き込みを発行した後の読み取りは、その書き込みの完了を待ってから行う（読み書きの順序を保つ）。
 * - v86 のディスクにはゲストの fsync（FLUSH CACHE）を伝えるフックが見当たらないため、
 *   永続化は BlockStore の定期 flush と、ページ離脱時の flush（installAutoFlush）に頼る。
 */
export class V86BlockDevice implements V86Loadable {
  readonly byteLength: number;
  onload: ((event: object) => void) | undefined = undefined;
  onprogress: ((event: object) => void) | undefined = undefined;

  readonly #store: BlockStore;
  readonly #onError: (error: unknown) => void;
  /** 最後に発行した書き込み。失敗しても解決する（失敗は onError に流す）。 */
  #lastWrite: Promise<void> = Promise.resolve();

  constructor(store: BlockStore, options: V86BlockDeviceOptions = {}) {
    if (store.size === 0 || store.size % SECTOR_SIZE !== 0) {
      throw new RangeError(
        `ディスクのサイズは ${SECTOR_SIZE} バイトの倍数（かつ 0 より大きい）である必要があります: ${store.size}`,
      );
    }
    this.#store = store;
    this.byteLength = store.size;
    this.#onError =
      options.onError ?? ((e) => console.error("[WasmBox] ディスクI/Oに失敗しました（ゲストは該当I/Oで止まります）:", e));
  }

  load(): void {
    // BlockStore は開いた状態で渡されるので、読み込む物はない。すぐ「準備完了」を通知する。
    this.onload?.(Object.create(null));
  }

  get(start: number, length: number, callback: (data: Uint8Array) => void): void {
    this.#lastWrite
      .then(() => this.#store.read(start, length))
      .then(callback, (error) => this.#onError(error));
  }

  set(start: number, data: Uint8Array, callback: () => void): void {
    const copy = data.slice(); // v86 は set() の直後にバッファを再利用しうる
    const write = this.#store.write(start, copy);
    this.#lastWrite = write.catch(() => {});
    write.then(() => callback(), (error) => this.#onError(error));
  }

  get_buffer(callback: (buffer?: ArrayBuffer) => void): void {
    // v86 の非同期ディスクと同じく「全体は渡せない」ことを、引数なしの呼び出しで示す
    callback();
  }

  /**
   * v86 の save_state 用。ディスクの実体は IndexedDB にあり、スナップショットには含めない。
   * そのため save_state / restore_state は未対応（M6 で扱う）。
   * RAM だけを古い状態に戻すと、ディスクと食い違ってファイルシステムが壊れうる。
   */
  get_state(): unknown[] {
    return [];
  }

  set_state(_state: unknown[]): void {}

  /** 発行済みの書き込みをすべて待ってから IndexedDB へ flush する。installAutoFlush に渡せる。 */
  async flush(): Promise<void> {
    await this.#lastWrite;
    await this.#store.flush();
  }
}
