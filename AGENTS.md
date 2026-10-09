# AGENTS.md

AI コーディングエージェント（Codex、Copilot、Claude など）と人間の開発者が、同じ前提で作業するための共通ルール。

## プロジェクト

WasmBox は、ブラウザ内で Linux（エミュレータ上）を動かし、コマンドを実行できる仮想OS。
**設計と決定事項は [ARCHITECTURE.md](./ARCHITECTURE.md)。作業の前に必ず読むこと。**
今は M1（Storage層）が完了し、M2（v86 との接続 PoC）の段階。

## 変更のたびに実行するもの

```sh
npm run typecheck && npm test
```

どちらも通る状態でコミットする。ブラウザ側の確認には `npm run poc` と `poc/selftest.html`（`poc/README.md` 参照）を使う。

## コードの規約

- Node.js 22.18 以上で TypeScript を**そのまま実行**する（ビルド不要）。そのため **erasable な TypeScript だけ**を使う:
  `enum`、`namespace`、コンストラクタの引数プロパティ（`constructor(private x)`）は禁止。
- 型だけの import は `import type`。import のパスには `.ts` 拡張子を付ける。
- `strict` と `noUncheckedIndexedAccess` が有効。型エラーを `any` や `as` で黙らせない。
- 実行時の依存パッケージは増やさない（`dependencies` は空）。`devDependencies` を足すときは、理由をコミットメッセージか PR に書く。
- テストは `node:test`。`test/` に置き、`*.test.ts` とする。
- コメント・ドキュメント・エラーメッセージは日本語。識別子は英語。

## データを守る（最優先）

- 利用者が書いたデータ（overlay）を、黙って捨てない。失敗は握りつぶさず、呼び出し側に伝えるか `onError` へ流す。
- `src/storage/block-store.ts` の flush・ライトバック・競合まわりを変えるときは、**実装をわざと壊して、対応するテストが落ちること**を確認する
  （例: 「古い読み込み結果をキャッシュに入れない」チェックを外すと落ちるテストがある）。落ちないなら、テストが足りない。
- 公開インターフェース（`BlockStore`、`KVBackend`、`ChunkSource`、`Manifest`）を変えるときは、`ARCHITECTURE.md` の決定ログも更新する。

## 事実の扱い

- v86 や container2wasm など、外部ツールの挙動は、**確認したものと、していないものを区別して書く**。
  未確認は 🔬 を付け、断定しない。推測を、確認済みの事実のように書かない。
- 実行していないコードを「動作確認済み」と書かない。確認したのが「テスト」なのか「実ブラウザ」なのか「v86 と結合した状態」なのかを明記する。

## コミットしないもの

- `node_modules/`、`poc/dist/`、`poc/vendor/`（v86 の実体やカーネル）、ディスクイメージ、チャンクの出力。
