import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V86BlockDevice } from "../src/engine/v86-block-device.ts";
import { makeImage, newEnv, openStore, sleep } from "./helpers.ts";
import type { TestImage } from "./helpers.ts";

const SECTOR = 512;
// 40960 バイト = 80 セクタ / チャンク 4096 バイト = 10 チャンク
const SIZE = 40960;
const CS = 4096;

const getAsync = (dev: V86BlockDevice, start: number, length: number) =>
  new Promise<Uint8Array>((resolve) => dev.get(start, length, resolve));
const setAsync = (dev: V86BlockDevice, start: number, data: Uint8Array) =>
  new Promise<void>((resolve) => dev.set(start, data, resolve));

async function setup(overrides: { onError?: (e: unknown) => void } = {}) {
  const image = await makeImage({ size: SIZE, chunkSize: CS });
  const env = newEnv(image);
  const store = await openStore(image, env);
  const device = new V86BlockDevice(store, overrides);
  return { image, env, store, device };
}

describe("V86BlockDevice: v86 の起動手順との適合", () => {
  it("v86 のディスク登録と IDE の同期キャッシュ確認に適合する", async () => {
    const { device } = await setup();
    for (const method of [device.get, device.set, device.load, device.get_from_cache]) assert.equal(typeof method, "function");
    assert.equal(device.get_from_cache(0, SECTOR), undefined);
    assert.throws(() => device.get_from_cache(SIZE, SECTOR), RangeError);

    // starter.js の cont() と同じ手順: onload を代入してから load() を呼ぶ
    let loaded: unknown;
    device.onload = (event) => {
      loaded = event;
    };
    device.load();
    assert.equal(typeof loaded, "object");
    assert.equal(device.byteLength, SIZE);
  });

  it("サイズがセクタ（512B）の倍数でない・0 のストアは拒否する", async () => {
    const odd = await makeImage({ size: 1000, chunkSize: 128 });
    await assert.rejects(
      async () => new V86BlockDevice(await openStore(odd, newEnv(odd))),
      RangeError,
    );
    const empty = await makeImage({ size: 0, chunkSize: 128 });
    await assert.rejects(
      async () => new V86BlockDevice(await openStore(empty, newEnv(empty))),
      RangeError,
    );
  });

  it("get_buffer は引数なしでコールバックし、get_state / set_state は例外を出さない", async () => {
    const { device } = await setup();
    let args: unknown[] | undefined;
    device.get_buffer((...a) => {
      args = a;
    });
    assert.deepEqual(args, []);
    assert.deepEqual(device.get_state(), []);
    device.set_state([]);
  });
});

describe("V86BlockDevice: 読み書き", () => {
  it("セクタ単位・256B単位の読み取りが元のイメージと一致する", async () => {
    const { image, device } = await setup();
    for (const [start, length] of [
      [0, SECTOR], [SECTOR, SECTOR], [SECTOR * 7, SECTOR * 2], [256, 256], [SIZE - SECTOR, SECTOR], [0, SIZE],
    ] as const) {
      assert.deepEqual(await getAsync(device, start, length), image.bytes.slice(start, start + length));
    }
  });

  it("書いた内容を読み戻せる。set のコールバック前に発行した get も、書き込み後の内容を返す", async () => {
    const { image, device } = await setup();
    const sector = new Uint8Array(SECTOR).fill(0xab);

    // set() のコールバックを待たずに get() を発行しても、順序が保たれる
    const written = setAsync(device, SECTOR * 10, sector);
    const readBack = getAsync(device, SECTOR * 10, SECTOR);
    await written;
    assert.deepEqual(await readBack, sector);

    // 周囲は元のまま
    assert.deepEqual(await getAsync(device, SECTOR * 9, SECTOR), image.bytes.slice(SECTOR * 9, SECTOR * 10));
    assert.deepEqual(await getAsync(device, SECTOR * 11, SECTOR), image.bytes.slice(SECTOR * 11, SECTOR * 12));
  });

  it("set() に渡したバッファを呼び出し直後に書き換えても、保存される内容は変わらない", async () => {
    const { device } = await setup();
    const buffer = new Uint8Array(SECTOR).fill(1);
    const done = setAsync(device, 0, buffer);
    buffer.fill(2); // v86 がバッファを再利用した状況
    await done;
    assert.deepEqual(await getAsync(device, 0, SECTOR), new Uint8Array(SECTOR).fill(1));
  });

  it("flush() は発行済みの書き込みを待ってから永続化する（開き直しても残る）", async () => {
    const { image, env, device } = await setup();
    const sector = new Uint8Array(SECTOR).fill(7);
    device.set(SECTOR * 3, sector, () => {}); // コールバックを待たずに flush する
    await device.flush();

    const store2 = await openStore(image, {
      ...newEnv(image),
      baseCache: env.baseCache,
      instance: env.instance,
    });
    const device2 = new V86BlockDevice(store2);
    assert.deepEqual(await getAsync(device2, SECTOR * 3, SECTOR), sector);
  });

  it("多数の書き込みを連続して発行しても、順序どおりに反映される", async () => {
    const { image, device } = await setup();
    const expected = image.bytes.slice();
    const done: Promise<void>[] = [];
    for (let round = 0; round < 3; round++) {
      for (let s = 0; s < 20; s++) {
        const data = new Uint8Array(SECTOR).fill(round * 20 + s + 1);
        expected.set(data, s * SECTOR);
        done.push(setAsync(device, s * SECTOR, data));
      }
    }
    await Promise.all(done);
    assert.deepEqual(await getAsync(device, 0, SIZE), expected);
  });
});

describe("V86BlockDevice: 失敗時の挙動", () => {
  it("読み取りに失敗したら onError に通知し、v86 のコールバックは呼ばない（ゲストのI/Oは止まる）", async () => {
    const errors: unknown[] = [];
    const { env, device } = await setup({ onError: (e) => errors.push(e) });
    env.source.failTimes = 1;
    let called = false;
    device.get(0, SECTOR, () => {
      called = true;
    });
    await sleep(30);
    assert.equal(called, false);
    assert.equal(errors.length, 1);
  });

  it("書き込みに失敗（範囲外）したら onError に通知し、コールバックは呼ばない", async () => {
    const errors: unknown[] = [];
    const { device } = await setup({ onError: (e) => errors.push(e) });
    let called = false;
    device.set(SIZE, new Uint8Array(SECTOR), () => {
      called = true;
    });
    await sleep(30);
    assert.equal(called, false);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof RangeError);
  });

  it("書き込みの失敗後も、後続の読み取りは止まらない", async () => {
    const { image, device } = await setup({ onError: () => {} });
    device.set(SIZE, new Uint8Array(SECTOR), () => {}); // 失敗する書き込み
    assert.deepEqual(await getAsync(device, 0, SECTOR), (image as TestImage).bytes.slice(0, SECTOR));
  });
});
