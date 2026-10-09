# WasmBox

ブラウザ内で動く、WASM上の仮想Linux環境。設計は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

現在は **M1: Storage層**（ディスクイメージの遅延取得・書き込みの永続化）が完了し、**M2: v86 との接続 PoC** に着手したところ。
AI エージェントや共同開発者向けのルールは [AGENTS.md](./AGENTS.md)。

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
| `src/engine/v86-block-device.ts` | `BlockStore` を v86 のディスク（hda）として見せるアダプタ |
| `poc/` | M2 の PoC（v86 に接続して起動するページ）と、v86 不要のブラウザ自己診断。手順は [poc/README.md](./poc/README.md) |
| `tools/chunk-image.ts` | ディスクイメージを チャンク + manifest.json に分割する |
| `tools/serve.ts` | 開発用の静的サーバー（依存なし） |

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

何を・どこまで確認したかを区別して書く（詳しい方針は [AGENTS.md](./AGENTS.md)）。

- ✅ **ユニットテスト**（`npm test`）: メモリ上のKVと `fake-indexeddb` の両方で通過。競合まわり（flush 中の追記、読み込み中の書き込み、
  flush 失敗後の復元）と、アダプタのコピー・順序保証は、実装をわざと壊すとテストが落ちることも確認済み。
- ✅ **実ブラウザ**: Chromium 141（ヘッドレス、Playwright）で `poc/selftest.html` が成功。IndexedDB への書き込みと flush、
  **ブラウザを完全に閉じて開き直したあとの読み出し**、HTTP からのチャンク取得（実 `fetch` + 実 SHA-256 検証）、IndexedDB キャッシュからの再読み込み
  （再起動後はネットワークへのリクエストが 0 回）を確認した。空のプロファイルでは失敗することも確認済み。
- ⚠️ **Firefox / Safari は未確認。** `poc/selftest.html` で、各ブラウザの結果を確かめられる。
- ⚠️ **v86 との結合は未実行。** アダプタは、v86 の呼び出し規約を模したテストで確認したのみ。実際の起動確認は `poc/README.md` の手順で。
- ⚠️ 性能（レイテンシ、チャンクサイズ 256 KiB の妥当性）は未計測。

## 未実装・今後

- base キャッシュの容量逼迫時の退避（ARCHITECTURE.md 4.5）
- v86 との結合確認、Node.js が動くかの確認（M2。`poc/README.md`）
- ゲストの fsync を flush につなぐ手段の調査（v86 では見当たらない）
- v86 の `save_state` / `restore_state` への対応（M6）
- チャンクの圧縮配信
