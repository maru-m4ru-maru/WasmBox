# M2 PoC: v86 + BlockStore

v86 のディスク（hda）に、WasmBox の `BlockStore`（IndexedDB に永続化）を接続して Linux を起動する。

> ⚠️ **この PoC は、v86 の実物がない環境で書かれたため、まだ一度も v86 と一緒に動かしていません。**
> 動作確認済みなのは、`BlockStore` と v86 用アダプタ単体（テストと、実ブラウザでの自己診断）までです。
> うまく動かなければ、先に「トラブルシュート」を見てください。結果を共有してもらえれば、一緒に直します。

## 0. まず自己診断（v86 不要）

```sh
npm install
npm run poc          # ビルドして http://127.0.0.1:8080/ で配信
```

1. <http://127.0.0.1:8080/selftest.html?phase=write> を開く → すべて ✅ になることを確認
2. ブラウザを（できれば完全に）閉じて開き直し、<http://127.0.0.1:8080/selftest.html?phase=verify> を開く
   → 書き込んだ内容が残っていて、すべて ✅ になれば OK

これが ❌ なら、v86 以前に Storage 層がそのブラウザで動いていません。内容を教えてください。

## 1. v86 のファイルを `poc/vendor/` に置く

| ファイル | 入手 |
|---|---|
| `libv86.js`, `v86.wasm` | `npm install v86` で入る `build/` 内、または v86 のリポジトリでビルド |
| `seabios.bin`, `vgabios.bin` | 同上（パッケージ内の `bios/` など） |
| `buildroot-bzimage.bin` | `wget https://k.copy.sh/buildroot-bzimage.bin` |

- パッケージ内の場所は版によって違うかもしれません。次のコマンドで探せます。
  ```sh
  find node_modules/v86 \( -name '*.wasm' -o -name 'libv86*' -o -name 'seabios.bin' -o -name 'vgabios.bin' \)
  ```
- `libv86.js` が無く `libv86.mjs` だけの場合は、`poc/index.html` の `<script src="vendor/libv86.js">` を
  ES モジュールの import に変える必要があります（グローバルの `V86` が無くなるため）。
- `poc/vendor/` はコミットしないでください（`.gitignore` 済み）。

## 2. 起動して、ディスクの疎通を確認する

`npm run poc` のあと、<http://127.0.0.1:8080/> を開きます。起動には 10〜30 秒ほどかかることがあります。
シリアルコンソール（黒い欄）をクリックしてから入力します。

```sh
# ① ゲストにディスクが見えているか（sda か hda のどちらか）
ls /dev/sd* /dev/hd* 2>/dev/null

# ② ディスクのセクタ10に文字列を書く（sda の場合）
echo hello-wasmbox | dd of=/dev/sda bs=512 seek=10 count=1 conv=sync
sync
```

画面下のステータス行で「保存済みチャンク」が 1 以上になれば、IndexedDB に書かれています
（定期 flush は 1 秒間隔。待てなければ「今すぐ flush」）。

```sh
# ③ ページを再読み込みして、起動後に読み戻す
dd if=/dev/sda bs=512 skip=10 count=1 2>/dev/null | head -c 14
# → hello-wasmbox と表示されれば成功
```

これは **ファイルシステムを使わない、ブロックデバイス単体の確認**です（busybox の `dd` だけで済むため）。
成功したら次は、ディスクに ext2/ext4 を作って（または rootfs を入れて）起動する段階に進みます。

## トラブルシュート

| 症状 | 考えられる原因 |
|---|---|
| コンソールに `Ignored file` と出る | v86 がアダプタをディスクと認識していない。v86 の版が違い、`get/set/load` を持つオブジェクトを受け付けなくなっている可能性。`src/browser/starter.js` の `add_file` を確認 |
| `/dev/sd*` も `/dev/hd*` も無い | そのカーネルに IDE/ATA ドライバが入っていない。別のカーネルを使う |
| 起動途中や dd で止まる | ステータス行に `⚠️ ディスクI/Oに失敗` が出ていないか確認（v86 のコールバックには失敗を伝える手段がなく、失敗するとゲストの該当 I/O は止まります） |
| 起動しない | F12 のコンソールを確認。`poc/main.ts` の V86 オプション（`wasm_path`、`bzimage`、`cmdline` など）は未検証 |
| 「別のタブで使用中」 | 同じインスタンスを別タブが使っている（Web Locks による排他） |

## 既知の制約

- **ゲストの `sync` / fsync は、IndexedDB への flush に直結していません。** v86 のディスクのインターフェースに、
  それを伝える手段が見当たらないためです（`get` / `set` のみ。IDE デバイス側の挙動は未確認）。
  代わりに、定期 flush（この PoC では 1 秒）と、タブを隠す / 閉じるときの flush に頼っています。
  電源断に相当する「タブの強制終了」では、直近 1 秒ぶんが失われる可能性があります。
- v86 の `save_state` / `restore_state` は未対応です。ディスクの実体は IndexedDB にあり、スナップショットに含まれないため、
  RAM だけを古い状態に戻すとファイルシステムが壊れえます（M6 で扱う）。
- ディスクは、まっさらな 64 MiB（全チャンクがゼロ埋め）です。実イメージは `tools/chunk-image.ts` で分割して使います。
