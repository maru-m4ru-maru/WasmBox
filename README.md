# WasmBox

ブラウザ内で動く、WASM上の仮想Linux環境。設計は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

現在は **M1: Storage層**（ディスクイメージの遅延取得・書き込みの永続化）まで。Engine（エミュレータ）との接続は M2。

## セットアップ

```sh
npm install
npm test          # テスト実行
npm run typecheck # 型チェック
```

Node.js 22.18 以上が必要。TypeScript をそのまま実行するので、ビルド手順はない。

## 構成

| パス | 内容 |
|---|---|
| `src/storage/block-store.ts` | `ChunkedBlockStore` 本体。遅延取得、overlay（Copy-on-Write）、LRU、ライトバック |
| `src/storage/kv-idb.ts` | IndexedDB 版のKVバックエンド |
| `src/storage/kv-memory.ts` | メモリ版のKVバックエンド（テスト用） |
| `src/storage/http-source.ts` | HTTP からのチャンク取得（Range 方式 / チャンクファイル方式、再試行つき） |
| `src/storage/lifecycle.ts` | ページ離脱時の flush、ストレージ永続化の要求 |
| `src/storage/lock.ts` | Web Locks による複数タブの排他 |
| `tools/chunk-image.ts` | ディスクイメージを チャンク + manifest.json に分割する |

## 使い方

```ts
import {
  ChunkedBlockStore, HttpChunkSource, IdbKV,
  acquireInstanceLock, installAutoFlush, requestPersistentStorage,
} from "./src/storage/index.ts";

const manifest = await (await fetch("/image/manifest.json")).json();

await requestPersistentStorage();
const release = await acquireInstanceLock("default"); // 別タブが使用中なら InstanceLockedError

const store = await ChunkedBlockStore.open({
  manifest,
  source: new HttpChunkSource({
    layout: { kind: "chunk-files", urlFor: (_i, hash) => `/image/chunks/${hash}` },
  }),
  baseCache: await IdbKV.open("wasmbox-base-cache", { durability: "relaxed" }),
  instance: await IdbKV.open("wasmbox-instance-default", { durability: "strict" }),
});
installAutoFlush(store); // ※ Worker 内では pagehide が届かない。メインスレッド側で使うこと

await store.read(0, 512);
await store.write(0, new Uint8Array([1, 2, 3]));
await store.flush(); // ゲストの fsync に対応させる
```

イメージの分割:

```sh
node tools/chunk-image.ts rootfs.img out/ --chunk-size=262144 --image-id=alpine-base
# → out/manifest.json と out/chunks/<sha256>
```

## 検証状況

- ✅ メモリ上のKVでの動作: 45テスト通過。競合まわり（flush 中の追記、読み込み中の書き込み、flush 失敗後の復元）は、実装をわざと壊してテストが落ちることも確認済み。
- ⚠️ **IndexedDB 版は未実行。** 型チェックは通るが、実行テスト（`test/idb.test.ts`）は `fake-indexeddb` が必要で、作成時の環境では動かせなかった。`npm install` 後の `npm test` で実行される。**実ブラウザでの動作も未確認。**
- ⚠️ 性能（レイテンシ、チャンクサイズ 256 KiB の妥当性）は未計測。

## 未実装・今後

- base キャッシュの容量逼迫時の退避（ARCHITECTURE.md 4.5）
- Engine との接続（M2）。`BlockStore` を、エミュレータのブロックデバイスにつなぐ
- チャンクの圧縮配信
