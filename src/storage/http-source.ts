import { ChunkFetchError } from "./errors.ts";
import type { ChunkSource } from "./types.ts";

export type HttpLayout =
  /** チャンクごとに別ファイルとして配信（例: /chunks/<hash>）。静的ホストで最も扱いやすい。 */
  | { kind: "chunk-files"; urlFor: (index: number, hash: string) => string }
  /** 1つのイメージファイルを HTTP Range で部分取得する。サーバーが Range 対応である必要がある。 */
  | { kind: "range"; url: string; chunkSize: number; size: number };

export interface HttpChunkSourceOptions {
  layout: HttpLayout;
  /** 既定は globalThis.fetch */
  fetch?: typeof fetch;
  /** 再試行回数（初回を除く）。既定 2 */
  retries?: number;
  /** 再試行の待ち時間の基準（ms）。2倍ずつ増える。既定 200 */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpChunkSource implements ChunkSource {
  readonly #layout: HttpLayout;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #retryDelayMs: number;

  constructor(options: HttpChunkSourceOptions) {
    this.#layout = options.layout;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#retries = options.retries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 200;
  }

  async fetchChunk(index: number, hash: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#fetchOnce(index, hash);
      } catch (err) {
        const retryable = err instanceof ChunkFetchError ? err.retryable : false;
        if (!retryable || attempt >= this.#retries) throw err;
        await sleep(this.#retryDelayMs * 2 ** attempt);
      }
    }
  }

  async #fetchOnce(index: number, hash: string): Promise<Uint8Array> {
    const layout = this.#layout;
    let url: string;
    const headers: Record<string, string> = {};
    let expectedLength: number | undefined;

    if (layout.kind === "chunk-files") {
      url = layout.urlFor(index, hash);
    } else {
      const start = index * layout.chunkSize;
      const end = Math.min(start + layout.chunkSize, layout.size);
      url = layout.url;
      headers.Range = `bytes=${start}-${end - 1}`;
      expectedLength = end - start;
    }

    let res: Response;
    try {
      res = await this.#fetch(url, { headers });
    } catch (cause) {
      throw new ChunkFetchError(`チャンク ${index} の取得でネットワークエラー`, {
        retryable: true,
        cause,
      });
    }

    const retryableStatus = res.status >= 500 || res.status === 429 || res.status === 408;
    if (layout.kind === "range") {
      if (res.status === 200) {
        throw new ChunkFetchError(
          `サーバーが Range を無視して全体を返しました（チャンク ${index}）。Range 対応のホストを使うか、chunk-files 方式にしてください`,
          { status: 200, retryable: false },
        );
      }
      if (res.status !== 206) {
        throw new ChunkFetchError(`チャンク ${index} の取得に失敗（HTTP ${res.status}）`, {
          status: res.status,
          retryable: retryableStatus,
        });
      }
    } else if (!res.ok) {
      throw new ChunkFetchError(`チャンク ${index} の取得に失敗（HTTP ${res.status}）`, {
        status: res.status,
        retryable: retryableStatus,
      });
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (cause) {
      throw new ChunkFetchError(`チャンク ${index} の受信中にエラー`, { retryable: true, cause });
    }
    if (expectedLength !== undefined && body.byteLength !== expectedLength) {
      throw new ChunkFetchError(
        `チャンク ${index} のサイズが想定と違います（期待 ${expectedLength}、実際 ${body.byteLength}）`,
        { retryable: true },
      );
    }
    return body;
  }
}
