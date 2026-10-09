import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import { IdbKV } from "../src/storage/kv-idb.ts";
import { CountingSource, makeImage } from "./helpers.ts";

// fake-indexeddb が入っていない環境ではこのファイルのテストをスキップする。
// `npm install` 済みなら実行される。
let available = true;
try {
  await import("fake-indexeddb/auto");
} catch {
  available = false;
}
const skip = available ? false : "fake-indexeddb が未インストールのためスキップ（npm install で有効になります）";

let dbCounter = 0;
const dbName = () => `wasmbox-test-${Date.now()}-${dbCounter++}`;

describe("IdbKV", { skip }, () => {
  it("put / get / delete / keys が動く", async () => {
    const kv = await IdbKV.open(dbName());
    await kv.batch([
      { type: "put", key: "o:1", value: Uint8Array.from([1]) },
      { type: "put", key: "o:2", value: Uint8Array.from([2]) },
      { type: "put", key: "h:abc", value: Uint8Array.from([3]) },
    ]);
    assert.deepEqual(await kv.get("o:2"), Uint8Array.from([2]));
    assert.equal(await kv.get("nothing"), undefined);
    assert.deepEqual(await kv.keys("o:"), ["o:1", "o:2"]);
    await kv.batch([{ type: "delete", key: "o:1" }]);
    assert.deepEqual(await kv.keys("o:"), ["o:2"]);
    await kv.close();
  });

  it("閉じて開き直しても残る", async () => {
    const name = dbName();
    const kv1 = await IdbKV.open(name);
    await kv1.batch([{ type: "put", key: "k", value: Uint8Array.from([9, 9]) }]);
    await kv1.close();
    const kv2 = await IdbKV.open(name);
    assert.deepEqual(await kv2.get("k"), Uint8Array.from([9, 9]));
    await kv2.close();
  });

  it("大きなバッファの一部を指すビューを保存しても、その部分だけが保存される", async () => {
    const kv = await IdbKV.open(dbName());
    const big = new Uint8Array(1000).fill(1);
    big.set([7, 8, 9], 500);
    await kv.batch([{ type: "put", key: "k", value: big.subarray(500, 503) }]);
    assert.deepEqual(await kv.get("k"), Uint8Array.from([7, 8, 9]));
    await kv.close();
  });

  it("durability オプションを指定しても動く", async () => {
    const kv = await IdbKV.open(dbName(), { durability: "strict" });
    await kv.batch([{ type: "put", key: "k", value: Uint8Array.from([1]) }]);
    assert.deepEqual(await kv.get("k"), Uint8Array.from([1]));
    await kv.close();
  });

  it("ChunkedBlockStore を IndexedDB の上で動かせる（書き込み→flush→開き直し）", async () => {
    const image = await makeImage({ size: 1000, chunkSize: 128 });
    const baseCache = await IdbKV.open(dbName(), { durability: "relaxed" });
    const instanceName = dbName();
    const instance1 = await IdbKV.open(instanceName, { durability: "strict" });

    const store1 = await ChunkedBlockStore.open({
      manifest: image.manifest,
      source: new CountingSource(image),
      baseCache,
      instance: instance1,
      flushIntervalMs: 0,
      readaheadChunks: 0,
    });
    assert.deepEqual(await store1.read(0, 1000), image.bytes);
    await store1.write(130, Uint8Array.from([1, 2, 3]));
    await store1.close();
    await instance1.close();

    const instance2 = await IdbKV.open(instanceName, { durability: "strict" });
    const source2 = new CountingSource(image);
    const store2 = await ChunkedBlockStore.open({
      manifest: image.manifest,
      source: source2,
      baseCache,
      instance: instance2,
      flushIntervalMs: 0,
      readaheadChunks: 0,
    });
    const expected = image.bytes.slice();
    expected.set([1, 2, 3], 130);
    assert.deepEqual(await store2.read(0, 1000), expected);
    assert.equal(source2.calls.length, 0, "base は IndexedDB のキャッシュから、overlay は instance から読まれる");
    await store2.close();
  });
});
