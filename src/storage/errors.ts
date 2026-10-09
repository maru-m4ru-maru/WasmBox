export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ManifestError extends StorageError {}

/** 既存のインスタンス（overlay）が、いま渡された manifest と別のイメージ用だった。 */
export class ManifestMismatchError extends StorageError {}

export class ChunkIntegrityError extends StorageError {
  readonly index: number;
  readonly expected: string;
  readonly actual: string;

  constructor(index: number, expected: string, actual: string, detail?: string) {
    super(
      detail ??
        `チャンク ${index} のハッシュが一致しません（期待 ${expected.slice(0, 12)}…、実際 ${actual.slice(0, 12)}…）`,
    );
    this.index = index;
    this.expected = expected;
    this.actual = actual;
  }
}

export class ChunkFetchError extends StorageError {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    info: { status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.status = info.status;
    this.retryable = info.retryable;
  }
}

export class InstanceLockedError extends StorageError {
  readonly instanceId: string;

  constructor(instanceId: string) {
    super(`インスタンス "${instanceId}" は別のタブ（または別のWorker）で使用中です`);
    this.instanceId = instanceId;
  }
}

export class StorageClosedError extends StorageError {}
