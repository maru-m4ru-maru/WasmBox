export interface FlushTarget {
  flush(): Promise<void>;
}

export interface AutoFlushOptions {
  /** `pagehide` を受け取る対象。既定は globalThis（addEventListener があれば）。 */
  pageTarget?: EventTarget;
  /** `visibilitychange` を受け取る対象。既定は globalThis.document。 */
  documentTarget?: EventTarget & { visibilityState?: string };
  onError?: (error: unknown) => void;
}

/**
 * タブが隠れたとき（visibilitychange → hidden）とページ離脱時（pagehide）に flush する。
 * 戻り値の関数で登録を解除できる。
 *
 * 注意:
 * - ページ離脱中の IndexedDB 書き込みは完了が保証されない（ベストエフォート）。
 *   本当に失いたくない書き込みは、ゲストの fsync → flush() の完了待ちで守ること。
 * - Worker 内では pagehide / visibilitychange が届かない。メインスレッド側でこの関数を使い、
 *   Worker へ「flush せよ」というメッセージを送る形にすること。
 */
export function installAutoFlush(target: FlushTarget, options: AutoFlushOptions = {}): () => void {
  const onError = options.onError ?? ((e) => console.error("[WasmBox] 離脱時の flush に失敗:", e));
  const fire = () => {
    target.flush().catch(onError);
  };

  const pageTarget =
    options.pageTarget ??
    (typeof globalThis.addEventListener === "function" ? globalThis : undefined);
  const documentTarget =
    options.documentTarget ??
    (globalThis as { document?: EventTarget & { visibilityState?: string } }).document;

  const onVisibility = () => {
    if (documentTarget?.visibilityState === "hidden") fire();
  };

  pageTarget?.addEventListener("pagehide", fire);
  documentTarget?.addEventListener("visibilitychange", onVisibility);
  return () => {
    pageTarget?.removeEventListener("pagehide", fire);
    documentTarget?.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * ブラウザにストレージの永続化を要求する（容量逼迫時の自動削除を避けるため）。
 * 許可されたら true。非対応・拒否なら false。
 */
export async function requestPersistentStorage(
  storage: { persist?: () => Promise<boolean> } | undefined = globalThis.navigator?.storage,
): Promise<boolean> {
  if (!storage?.persist) return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}
