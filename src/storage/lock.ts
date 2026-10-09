import { InstanceLockedError, StorageError } from "./errors.ts";

/** navigator.locks のうち使う部分だけ（テストで差し替えやすくするため） */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/**
 * インスタンス（overlay）の書き込み権を取る。同じインスタンスを別のタブが使っていたら
 * InstanceLockedError。戻り値の関数を呼ぶと解放する（タブを閉じれば自動で解放される）。
 */
export function acquireInstanceLock(
  instanceId: string,
  locks: LockManagerLike | undefined = globalThis.navigator?.locks,
): Promise<() => void> {
  if (!locks) {
    return Promise.reject(new StorageError("Web Locks API が利用できません"));
  }
  return new Promise<() => void>((resolve, reject) => {
    locks
      .request(`wasmbox:instance:${instanceId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new InstanceLockedError(instanceId));
          return Promise.resolve();
        }
        // release() が呼ばれるまでロックを保持する
        return new Promise<void>((release) => {
          resolve(() => release());
        });
      })
      .catch(reject);
  });
}
