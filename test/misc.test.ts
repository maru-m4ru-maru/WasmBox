import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChunkFetchError, InstanceLockedError } from "../src/storage/errors.ts";
import { HttpChunkSource } from "../src/storage/http-source.ts";
import { installAutoFlush, requestPersistentStorage } from "../src/storage/lifecycle.ts";
import { acquireInstanceLock } from "../src/storage/lock.ts";
import type { LockManagerLike } from "../src/storage/lock.ts";
import { ByteLRU } from "../src/storage/lru.ts";
import { pseudoRandomBytes } from "./helpers.ts";

const bytes = (n: number) => new Uint8Array(n);

describe("ByteLRU", () => {
  it("バイト予算を超えたら古いものから追い出す", () => {
    const lru = new ByteLRU<string, Uint8Array>(10);
    lru.set("a", bytes(4));
    lru.set("b", bytes(4));
    lru.set("c", bytes(4)); // a が追い出される
    assert.equal(lru.has("a"), false);
    assert.equal(lru.has("b"), true);
    assert.equal(lru.bytes, 8);
  });

  it("get すると最近使った扱いになる", () => {
    const lru = new ByteLRU<string, Uint8Array>(10);
    lru.set("a", bytes(4));
    lru.set("b", bytes(4));
    lru.get("a");
    lru.set("c", bytes(4)); // b が追い出される
    assert.equal(lru.has("a"), true);
    assert.equal(lru.has("b"), false);
  });

  it("予算より大きい値は保存せず、同じキーの古い値も消える", () => {
    const lru = new ByteLRU<string, Uint8Array>(10);
    lru.set("a", bytes(4));
    lru.set("a", bytes(11));
    assert.equal(lru.has("a"), false);
    assert.equal(lru.bytes, 0);
  });

  it("上書き・削除でバイト数が正しく変わる。maxBytes=0 は無効", () => {
    const lru = new ByteLRU<string, Uint8Array>(10);
    lru.set("a", bytes(4));
    lru.set("a", bytes(6));
    assert.equal(lru.bytes, 6);
    lru.delete("a");
    assert.equal(lru.bytes, 0);
    const off = new ByteLRU<string, Uint8Array>(0);
    off.set("x", bytes(1));
    assert.equal(off.size, 0);
  });
});

function rangeFetch(image: Uint8Array, log: string[]): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    log.push(range ?? "none");
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!m) return new Response(image.slice(), { status: 200 });
    return new Response(image.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  }) as typeof fetch;
}

describe("HttpChunkSource", () => {
  const image = pseudoRandomBytes(1000, 3);

  it("range 方式: Range ヘッダでチャンクを部分取得する（末尾の短いチャンクも）", async () => {
    const log: string[] = [];
    const source = new HttpChunkSource({
      layout: { kind: "range", url: "https://example.test/img", chunkSize: 128, size: 1000 },
      fetch: rangeFetch(image, log),
    });
    assert.deepEqual(await source.fetchChunk(1, "x"), image.slice(128, 256));
    assert.deepEqual(await source.fetchChunk(7, "x"), image.slice(896, 1000));
    assert.deepEqual(log, ["bytes=128-255", "bytes=896-999"]);
  });

  it("range 方式: サーバーが Range を無視（200）したら、再試行せずエラー", async () => {
    let calls = 0;
    const source = new HttpChunkSource({
      layout: { kind: "range", url: "https://example.test/img", chunkSize: 128, size: 1000 },
      fetch: (async () => {
        calls++;
        return new Response(image.slice(), { status: 200 });
      }) as typeof fetch,
    });
    await assert.rejects(source.fetchChunk(0, "x"), ChunkFetchError);
    assert.equal(calls, 1);
  });

  it("chunk-files 方式: urlFor で組み立てた URL から取得する", async () => {
    const urls: string[] = [];
    const source = new HttpChunkSource({
      layout: { kind: "chunk-files", urlFor: (i, h) => `https://example.test/chunks/${h}?i=${i}` },
      fetch: (async (url: unknown) => {
        urls.push(String(url));
        return new Response(image.slice(0, 10), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(await source.fetchChunk(3, "abc"), image.slice(0, 10));
    assert.deepEqual(urls, ["https://example.test/chunks/abc?i=3"]);
  });

  it("5xx とネットワークエラーは再試行し、4xx は再試行しない", async () => {
    let calls = 0;
    const flaky = new HttpChunkSource({
      layout: { kind: "chunk-files", urlFor: () => "https://example.test/c" },
      retryDelayMs: 1,
      fetch: (async () => {
        calls++;
        if (calls === 1) throw new TypeError("network down");
        if (calls === 2) return new Response("", { status: 503 });
        return new Response(image.slice(0, 4), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(await flaky.fetchChunk(0, "x"), image.slice(0, 4));
    assert.equal(calls, 3);

    let notFoundCalls = 0;
    const missing = new HttpChunkSource({
      layout: { kind: "chunk-files", urlFor: () => "https://example.test/c" },
      retryDelayMs: 1,
      fetch: (async () => {
        notFoundCalls++;
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });
    await assert.rejects(missing.fetchChunk(0, "x"), (e: unknown) => e instanceof ChunkFetchError && e.status === 404);
    assert.equal(notFoundCalls, 1);
  });

  it("再試行回数を使い切ったら最後のエラーを投げる", async () => {
    let calls = 0;
    const source = new HttpChunkSource({
      layout: { kind: "chunk-files", urlFor: () => "https://example.test/c" },
      retries: 2,
      retryDelayMs: 1,
      fetch: (async () => {
        calls++;
        return new Response("", { status: 500 });
      }) as typeof fetch,
    });
    await assert.rejects(source.fetchChunk(0, "x"), ChunkFetchError);
    assert.equal(calls, 3);
  });
});

describe("installAutoFlush", () => {
  it("pagehide と、hidden になったときの visibilitychange で flush する。解除もできる", async () => {
    let flushes = 0;
    const pageTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const uninstall = installAutoFlush(
      { flush: async () => void flushes++ },
      { pageTarget, documentTarget },
    );

    pageTarget.dispatchEvent(new Event("pagehide"));
    assert.equal(flushes, 1);

    documentTarget.dispatchEvent(new Event("visibilitychange")); // visible のときは何もしない
    assert.equal(flushes, 1);
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    assert.equal(flushes, 2);

    uninstall();
    pageTarget.dispatchEvent(new Event("pagehide"));
    assert.equal(flushes, 2);
  });

  it("flush の失敗は onError に渡される", async () => {
    const errors: unknown[] = [];
    const pageTarget = new EventTarget();
    installAutoFlush(
      { flush: async () => Promise.reject(new Error("boom")) },
      { pageTarget, documentTarget: new EventTarget(), onError: (e) => errors.push(e) },
    );
    pageTarget.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(errors.length, 1);
  });
});

describe("requestPersistentStorage", () => {
  it("許可・拒否・非対応・例外を boolean にまとめる", async () => {
    assert.equal(await requestPersistentStorage({ persist: async () => true }), true);
    assert.equal(await requestPersistentStorage({ persist: async () => false }), false);
    assert.equal(await requestPersistentStorage({}), false);
    assert.equal(await requestPersistentStorage(undefined), false);
    assert.equal(
      await requestPersistentStorage({ persist: async () => Promise.reject(new Error("x")) }),
      false,
    );
  });
});

/** Web Locks の ifAvailable 挙動だけを再現した偽物 */
function fakeLocks(): LockManagerLike {
  const held = new Set<string>();
  return {
    async request(name, options, callback) {
      if (options.ifAvailable && held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

describe("acquireInstanceLock", () => {
  it("同じインスタンスは同時に1つだけ。解放すれば再取得できる", async () => {
    const locks = fakeLocks();
    const release = await acquireInstanceLock("default", locks);
    await assert.rejects(acquireInstanceLock("default", locks), InstanceLockedError);

    const other = await acquireInstanceLock("other", locks); // 別インスタンスは取れる
    other();

    release();
    await new Promise((r) => setTimeout(r, 5));
    const again = await acquireInstanceLock("default", locks);
    again();
  });

  it("Web Locks が使えない環境ではエラー", async () => {
    await assert.rejects(acquireInstanceLock("default", undefined), /Web Locks/);
  });
});
