import type { BlockStore } from "../storage/types.ts";

/**
 * v86 が hda などに受け付ける「loadable」の形。
 *
 * v86 の starter.js は、オプションで渡されたオブジェクトが get / set / load を持っていれば、
 * それをそのままディスクとして使う（URL や ArrayBuffer ではなく、自作の実装を渡せる）。
 * 起動時に `onload` を代入してから `load()` を呼び、`onload` が呼ばれた時点でディスクとして登録される。
 *
 * v86 の master（2026-10-09 時点）のソースで確認した、ディスクに求められるメソッド:
 * - get / set / load : starter.js の add_file が判定し、読み書きに使う
 * - get_and_cache(start, len, callback) : starter.js の done() が、v86 の起動前に (0, 512) で呼ぶ
 *   （IDE がディスクのジオメトリを MBR から計算するため）。無いと起動処理が止まる。
 * - get_from_cache(start, len) : ide.js の get_disk_geometry が (0, 512) で同期的に呼ぶ。
 *   返せなければ undefined にする（v86 はディスクサイズからジオメトリを推定する）。
 * - byteLength、get_buffer、get_state / set_state
 *
 * ※ IDE の残りの実装（FLUSH CACHE の扱いなど）は未確認。v86 を更新したら、ide.js が this.buffer に
 *   呼ぶメソッドを grep し直すこと（例: grep -o "buffer\\.[a-z_]*\\(" src/ide.js | sort | uniq -c）。
 */
export interface V86Loadable {
  byteLength: number;
  onload: ((event: object) => void) | undefined;
  onprogress: ((event: object) => void) | undefined;
  load(): void;
  get_and_cache(start: number, length: number, callback: (data: Uint8Array) => void): void;
  get_from_cache(start: number, length: number): Uint8Array | undefined;
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
  /** 先頭セクタ（MBR）のキャッシュ。IDE のジオメトリ計算が同期で読むために保持する。 */
  #firstSector: Uint8Array | undefined = undefined;
  /** 先頭セクタへの書き込み回数。読み込み中に書かれたら、古い内容をキャッシュしないために使う。 */
  #firstSectorWrites = 0;

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
    if (start < SECTOR_SIZE) {
      this.#firstSector = undefined; // 先頭セクタが変わるので、保持していた MBR は古くなる
      this.#firstSectorWrites++;
    }
    const write = this.#store.write(start, copy);
    this.#lastWrite = write.catch(() => {});
    write.then(() => callback(), (error) => this.#onError(error));
  }

  /**
   * v86 の起動前に starter.js が get_and_cache(0, 512, callback) を呼ぶ。
   * 読んだ先頭セクタを保持し、get_from_cache で同期的に返せるようにする。
   */
  get_and_cache(start: number, length: number, callback: (data: Uint8Array) => void): void {
    const writesBefore = this.#firstSectorWrites;
    this.get(start, length, (data) => {
      // 読み込み中に先頭セクタが書き換えられていたら、古い内容は保持しない
      if (start === 0 && data.byteLength >= SECTOR_SIZE && writesBefore === this.#firstSectorWrites) {
        this.#firstSector = data.slice(0, SECTOR_SIZE);
      }
      callback(data);
    });
  }

  /**
   * v86 の ide.js が、ジオメトリ計算のために get_from_cache(0, 512) を同期的に呼ぶ。
   * 保持している先頭セクタの範囲に収まる要求だけ返し、それ以外は undefined。
   * undefined を返しても、v86 はディスクサイズからジオメトリを推定して続行する。
   */
  get_from_cache(start: number, length: number): Uint8Array | undefined {
    const sector = this.#firstSector;
    if (!sector || start < 0 || length < 0 || start + length > SECTOR_SIZE) return undefined;
    return sector.slice(start, start + length);
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
