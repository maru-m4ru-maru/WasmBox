import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import {
  ChunkIntegrityError,
  ManifestMismatchError,
  StorageClosedError,
} from "../src/storage/errors.ts";
import {
  CountingSource,
  deferred,
  eventually,
  makeImage,
  newEnv,
  openStore,
  pseudoRandomBytes,
  sleep,
} from "./helpers.ts";

// 1000 バイト / チャンク 128 バイト = 8 チャンク（最後は 104 バイト）
const SIZE = 1000;
const CS = 128;

describe("読み取り", () => {
  it("任意の範囲の読み取りが元のイメージと一致する（チャンク境界・末尾の短いチャンクを含む）", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    const cases: Array<[number, number]> = [
      [0, 1000], [0, 1], [127, 2], [128, 128], [900, 100], [999, 1], [0, 0], [500, 300], [1000, 0],
    ];
    for (const [offset, length] of cases) {
      assert.deepEqual(await store.read(offset, length), image.bytes.slice(offset, offset + length));
    }
    const rnd = pseudoRandomBytes(400, 7);
    for (let i = 0; i < 200; i++) {
      const offset = ((rnd[2 * i] ?? 0) * 256 + (rnd[2 * i + 1] ?? 0)) % SIZE;
      const length = ((rnd[(2 * i + 1) % 400] ?? 0) * 3) % (SIZE - offset + 1);
      assert.deepEqual(await store.read(offset, length), image.bytes.slice(offset, offset + length));
    }
  });

  it("範囲外の読み取りは RangeError", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    await assert.rejects(store.read(990, 11), RangeError);
    await assert.rejects(store.read(-1, 1), RangeError);
    await assert.rejects(store.read(0.5, 1), RangeError);
  });

  it("触ったチャンクだけを取得する（遅延ストリーミング）", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.read(130, 10);
    assert.deepEqual(env.source.calls, [1]);
    await store.read(130, 10); // メモリキャッシュ
    assert.deepEqual(env.source.calls, [1]);
  });

  it("同じチャンクへの同時リクエストは 1 回の取得にまとまる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    env.source.delayMs = 10;
    const store = await openStore(image, env);
    await Promise.all(Array.from({ length: 10 }, () => store.read(0, 10)));
    assert.deepEqual(env.source.calls, [0]);
  });

  it("取得済みチャンクは baseCache に残り、別のストアは再取得しない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env1 = newEnv(image);
    const store1 = await openStore(image, env1);
    await store1.read(0, SIZE);
    assert.equal(env1.source.calls.length, 8);

    const env2 = { ...newEnv(image), baseCache: env1.baseCache };
    const store2 = await openStore(image, env2);
    assert.deepEqual(await store2.read(0, SIZE), image.bytes);
    assert.equal(env2.source.calls.length, 0);
    assert.equal(store2.stats().baseCacheHits, 8);
  });

  it("ゼロチャンク（null）はネットワークに取りに行かず、0 で埋めて返す", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS, zeroChunks: [2, 7] });
    const env = newEnv(image);
    const store = await openStore(image, env);
    assert.deepEqual(await store.read(0, SIZE), image.bytes);
    assert.deepEqual(env.source.calls.sort(), [0, 1, 3, 4, 5, 6]);
  });

  it("メモリキャッシュから追い出されても、再取得は baseCache から行われる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { memoryCacheBytes: CS });
    await store.read(0, 10);
    await store.read(CS, 10); // chunk 0 を追い出す
    await store.read(0, 10);
    assert.deepEqual(env.source.calls, [0, 1]);
    assert.equal(store.stats().baseCacheHits, 1);
  });

  it("同時取得数が maxConcurrentFetches を超えない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    env.source.delayMs = 5;
    const store = await openStore(image, env, { maxConcurrentFetches: 2 });
    assert.deepEqual(await store.read(0, SIZE), image.bytes);
    assert.equal(env.source.calls.length, 8);
    assert.ok(env.source.maxActive <= 2, `maxActive=${env.source.maxActive}`);
  });

  it("連続した読み取りを検出すると、続きのチャンクを先読みする", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { readaheadChunks: 2 });
    await store.read(0, 10);
    assert.deepEqual(env.source.calls, [0]); // 最初の読み取りでは先読みしない
    await store.read(CS, 10);
    await eventually(() => env.source.calls.length === 4);
    assert.deepEqual([...env.source.calls].sort(), [0, 1, 2, 3]);
  });
});

describe("整合性チェック", () => {
  it("ハッシュが一致しないチャンクは ChunkIntegrityError で、キャッシュにも入れない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    env.source.corrupt.add(1);
    const store = await openStore(image, env);
    await assert.rejects(store.read(CS, 1), ChunkIntegrityError);
    assert.equal((await env.baseCache.keys("h:")).length, 0);
  });

  it("verify: false なら検証しない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    env.source.corrupt.add(1);
    const store = await openStore(image, env, { verify: false });
    const got = await store.read(CS, 1);
    assert.equal(got[0], (image.bytes[CS] ?? 0) ^ 0xff);
  });

  it("取得失敗はそのまま伝わり、次の読み取りで再試行できる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    env.source.failTimes = 1;
    const store = await openStore(image, env);
    await assert.rejects(store.read(0, 10), /注入された取得失敗/);
    assert.deepEqual(await store.read(0, 10), image.bytes.slice(0, 10));
  });
});

describe("書き込み（overlay / Copy-on-Write）", () => {
  it("書いた内容は flush 前でも読める。チャンクをまたぐ部分書き込みも周囲を壊さない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    const patch = Uint8Array.from([1, 2, 3, 4]);
    await store.write(126, patch); // chunk 0 と 1 にまたがる
    const expected = image.bytes.slice();
    expected.set(patch, 126);
    assert.deepEqual(await store.read(0, SIZE), expected);
  });

  it("チャンク全体の上書きは、元の内容を取得しない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(CS, new Uint8Array(CS).fill(9));
    await store.write(7 * CS, new Uint8Array(SIZE - 7 * CS).fill(5)); // 末尾の短いチャンク
    assert.deepEqual(env.source.calls, []);
    assert.deepEqual(await store.read(CS, CS), new Uint8Array(CS).fill(9));
    assert.deepEqual(await store.read(7 * CS, SIZE - 7 * CS), new Uint8Array(SIZE - 7 * CS).fill(5));
  });

  it("同じチャンクへの小さな書き込みを繰り返しても内容が正しい", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    const expected = image.bytes.slice();
    for (let i = 0; i < 50; i++) {
      const patch = Uint8Array.from([i, i + 1, i + 2]);
      await store.write(i * 3, patch);
      expected.set(patch, i * 3);
    }
    assert.deepEqual(await store.read(0, SIZE), expected);
  });

  it("flush すると overlay に保存され、開き直しても残る。base は変更されない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(CS, new Uint8Array(CS).fill(9));
    await store.write(300, Uint8Array.from([42, 43]));
    await store.flush();
    assert.deepEqual(await env.instance.keys("o:"), ["o:1", "o:2"]);

    const env2 = { source: new CountingSource(image), baseCache: env.baseCache, instance: env.instance };
    const store2 = await openStore(image, env2);
    const expected = image.bytes.slice();
    expected.fill(9, CS, 2 * CS);
    expected.set([42, 43], 300);
    assert.deepEqual(await store2.read(0, SIZE), expected);
    assert.ok(!env2.source.calls.includes(1), "上書きしたチャンクは base から取得しない");
  });

  it("flush していない書き込みは、クラッシュ相当の開き直しで失われる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, Uint8Array.from([1, 2, 3]));
    // flush せずに、同じ instance を別ストアで開く
    const store2 = await openStore(image, { ...newEnv(image), baseCache: env.baseCache, instance: env.instance });
    assert.deepEqual(await store2.read(0, 3), image.bytes.slice(0, 3));
  });

  it("書き込みは直列化され、並行して発行しても失われない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    const expected = image.bytes.slice();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      const patch = new Uint8Array(5).fill(i + 1);
      expected.set(patch, i * 7);
      jobs.push(store.write(i * 7, patch));
    }
    await Promise.all(jobs);
    assert.deepEqual(await store.read(0, SIZE), expected);
  });
});

describe("ライトバックの挙動", () => {
  it("flush が失敗しても書き込みは失われず、再試行で保存できる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, Uint8Array.from([7, 7, 7]));
    env.instance.failBatches = 1;
    await assert.rejects(store.flush(), /注入された書き込み失敗/);
    assert.deepEqual(await store.read(0, 3), Uint8Array.from([7, 7, 7]));
    assert.equal(store.stats().flushErrors, 1);
    await store.flush();
    const store2 = await openStore(image, { ...newEnv(image), baseCache: env.baseCache, instance: env.instance });
    assert.deepEqual(await store2.read(0, 3), Uint8Array.from([7, 7, 7]));
  });

  it("flush 中に同じチャンクへ書いた内容も失われない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, new Uint8Array(CS).fill(1));
    env.instance.batchDelayMs = 30;
    const first = store.flush();
    await sleep(5); // flush が始まるのを待つ
    await store.write(0, Uint8Array.from([2, 2, 2])); // flush 中の追記
    assert.deepEqual(await store.read(0, 4), Uint8Array.from([2, 2, 2, 1]));
    await first;
    await store.flush();

    const store2 = await openStore(image, { ...newEnv(image), baseCache: env.baseCache, instance: env.instance });
    const got = await store2.read(0, CS);
    const expected = new Uint8Array(CS).fill(1);
    expected.set([2, 2, 2], 0);
    assert.deepEqual(got, expected);
  });

  it("flush が失敗した最中に書かれた新しい内容は、失敗後も新しい方が残る", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, new Uint8Array(CS).fill(1));
    env.instance.batchDelayMs = 30;
    env.instance.failBatches = 1;
    const failing = store.flush();
    const outcome = assert.rejects(failing, /注入された書き込み失敗/);
    await sleep(5);
    await store.write(0, Uint8Array.from([2, 2]));
    await outcome;
    const expected = new Uint8Array(CS).fill(1);
    expected.set([2, 2], 0);
    assert.deepEqual(await store.read(0, CS), expected);
    env.instance.batchDelayMs = 0;
    await store.flush();
    const store2 = await openStore(image, { ...newEnv(image), baseCache: env.baseCache, instance: env.instance });
    assert.deepEqual(await store2.read(0, CS), expected);
  });

  it("定期 flush が働く", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { flushIntervalMs: 10 });
    await store.write(0, Uint8Array.from([1]));
    await eventually(async () => (await env.instance.keys("o:")).length === 1);
    assert.equal(store.stats().pendingBytes, 0);
  });

  it("dirty 量がしきい値を超えるとバックグラウンドで flush される", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { flushThresholdBytes: 100 });
    await store.write(0, new Uint8Array(CS).fill(3));
    await eventually(async () => (await env.instance.keys("o:")).length === 1);
  });

  it("溜まりすぎると write() が flush の完了まで待つ（バックプレッシャ）", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { flushThresholdBytes: 1e9, maxDirtyBytes: 100 });
    await store.write(0, new Uint8Array(CS).fill(3));
    assert.deepEqual(await env.instance.keys("o:"), ["o:0"]);
  });

  it("バックグラウンド flush の失敗は onError に通知され、次の周期で再試行される", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const errors: unknown[] = [];
    const store = await openStore(image, env, { flushIntervalMs: 10, onError: (e) => errors.push(e) });
    await store.write(0, Uint8Array.from([1]));
    env.instance.failBatches = 1;
    await eventually(() => errors.length === 1);
    await eventually(async () => (await env.instance.keys("o:")).length === 1);
  });

  it("読み込み中にそのチャンクへ書き込まれても、古い内容がキャッシュに残らない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const gate = deferred();
    env.source.gate = gate.promise;
    const store = await openStore(image, env);

    const slowRead = store.read(0, 10); // base の取得で止まる
    await eventually(() => env.source.calls.length === 1);
    await store.write(0, new Uint8Array(CS).fill(7)); // 全面上書き
    await store.flush(); // 新しい内容がメモリキャッシュ（クリーン）に入る
    gate.resolve(); // ここで古い読み込みが完了する
    await slowRead;

    assert.deepEqual(await store.read(0, 10), new Uint8Array(10).fill(7));
  });
});

describe("インスタンスの管理", () => {
  it("別のイメージ用の overlay は ManifestMismatchError。resetInstance すれば開ける", async () => {
    const imageA = await makeImage({ size: SIZE, chunkSize: CS, imageId: "A", seed: 1 });
    const imageB = await makeImage({ size: SIZE, chunkSize: CS, imageId: "B", seed: 2 });
    const envA = newEnv(imageA);
    const storeA = await openStore(imageA, envA);
    await storeA.write(0, Uint8Array.from([1]));
    await storeA.close();

    const envB = { ...newEnv(imageB), instance: envA.instance };
    await assert.rejects(openStore(imageB, envB), ManifestMismatchError);

    await ChunkedBlockStore.resetInstance(envA.instance);
    assert.equal(envA.instance.entryCount, 0);
    const storeB = await openStore(imageB, envB);
    assert.deepEqual(await storeB.read(0, 8), imageB.bytes.slice(0, 8));
  });

  it("不正な manifest は開けない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const broken = { ...image.manifest, chunks: image.manifest.chunks.slice(1) };
    await assert.rejects(
      ChunkedBlockStore.open({ manifest: broken, source: env.source, baseCache: env.baseCache, instance: env.instance }),
      /chunks の数が合いません/,
    );
  });

  it("close() は未 flush の書き込みを保存し、以後の write は拒否する", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, Uint8Array.from([5, 6]));
    await store.close();
    assert.deepEqual(await env.instance.keys("o:"), ["o:0"]);
    await assert.rejects(store.write(0, Uint8Array.from([1])), StorageClosedError);
    await assert.rejects(store.read(0, 1), StorageClosedError);
    await store.close(); // 二重 close は問題ない
  });

  it("close() の flush が失敗したらストアは開いたままで、再試行できる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env);
    await store.write(0, Uint8Array.from([5, 6]));
    env.instance.failBatches = 1;
    await assert.rejects(store.close(), /注入された書き込み失敗/);
    await store.write(2, Uint8Array.from([7])); // まだ書ける
    await store.close();
    const store2 = await openStore(image, { ...newEnv(image), baseCache: env.baseCache, instance: env.instance });
    assert.deepEqual(await store2.read(0, 3), Uint8Array.from([5, 6, 7]));
  });
});
