# M2 PoC: v86 + BlockStore

v86 のディスク（hda）に、WasmBox の `BlockStore`（IndexedDB に永続化）を接続して Linux を起動する。

> **確認状況**
> - ✅ v86 実ブラウザ上で、BlockStore の書き込み・flush・再読み込み後の読み戻しを確認済み。
> - ✅ Alpine 3.21 の ext4 から Node.js 22 と Python 3.12 を実行する経路を確認済み。
> - ⚠️ 外付け initrd による Alpine 直接ルート起動は、GitHub Actions の実ブラウザテストで検証中。

## 0. まず自己診断（v86 不要）

```sh
npm install
npm run poc          # ビルドして http://127.0.0.1:8080/ で配信
```

1. <http://127.0.0.1:8080/selftest.html?phase=write> を開く → すべて ✅ になることを確認
2. ブラウザを（できれば完全に）閉じて開き直し、<http://127.0.0.1:8080/selftest.html?phase=verify> を開く
   → 書き込んだ内容が残っていて、すべて ✅ になれば OK

これが ❌ なら、v86 以前に Storage 層がそのブラウザで動いていません。内容を教えてください。

## 1. v86 とディスク対応カーネルを `poc/vendor/` に置く

PoC は以下のファイルを `poc/vendor/` に必要とします。

| ファイル | 入手 |
|---|---|
| `libv86.js`, `v86.wasm` | `npm install v86@0.5` で入る `node_modules/v86/build/` 内 |
| `seabios.bin`, `vgabios.bin` | v86 の `bios/`。下のコマンドでは公式リポジトリから取得 |
| `buildroot-bzimage.bin` | [chschnell/v86-buildroot v1.0.2](https://github.com/chschnell/v86-buildroot/releases/tag/v1.0.2) のディスク対応カーネル |

`buildroot-bzimage68.bin` など、シリアル端末向けのサンプルカーネルでは、v86 自体が起動してもゲスト内に `/dev/sda` / `/dev/hda` が現れない場合があります。ディスク疎通テストには、ATA / ATA_PIIX とブロックデバイスを有効にした v86-buildroot カーネルを使ってください。これは GitHub Actions の実ブラウザテストで確認した構成です。

次のコマンドで配置できます（`poc/vendor/` はコミットしないでください）。

```sh
npm install v86@0.5
mkdir -p poc/vendor
cp node_modules/v86/build/libv86.js poc/vendor/libv86.js
cp node_modules/v86/build/v86.wasm poc/vendor/v86.wasm
curl -fL https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin -o poc/vendor/seabios.bin
curl -fL https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin -o poc/vendor/vgabios.bin
curl -fL https://github.com/chschnell/v86-buildroot/releases/download/v1.0.2/v86-buildroot-1.0.2.tar.bz2 -o /tmp/v86-buildroot.tar.bz2
tar -xjf /tmp/v86-buildroot.tar.bz2 -C /tmp buildroot-bzimage68_v86.bin
mv /tmp/buildroot-bzimage68_v86.bin poc/vendor/buildroot-bzimage.bin
```

- v86 の `build/` 内のファイル名は配布版によって異なることがあります。必要なら `find node_modules/v86 \( -name '*.wasm' -o -name 'libv86*' -o -name 'seabios.bin' -o -name 'vgabios.bin' \)` で確認してください。
- `libv86.js` が無く `libv86.mjs` だけの場合は、`poc/index.html` の読み込み方法を ES モジュールに変更する必要があります（グローバルの `V86` がなくなるため）。
- `poc/vendor/` は `.gitignore` 済みです。v86・BIOS・カーネルの実体はコミットしないでください。

## 2. Alpine ルートを起動して Node.js を確認する

`bash image/build.sh` で Alpine ext4 と `initrd.cpio` を作ってから `npm run poc` を実行し、`alpine.html` を開きます。`[wasmbox-init] ルート: /dev/sda（ext4）` が出て、`/proc/mounts` で `/` が ext4 になれば直接ルート起動です。詳細は `image/README.md` を参照してください。

```sh
node --version
node -e "console.log(1 + 1)"
python3 --version
free -m
```

## 3. ブロックデバイス単体の疎通確認（initrd を使わない場合）

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
| 起動直後に `get_and_cache is not a function` / `get_from_cache is not a function` | アダプタに v86 が呼ぶメソッドが足りない。v86 master の `starter.js`（起動前に `get_and_cache(0, 512)`）と `ide.js`（`get_from_cache(0, 512)`）が要求する。`src/engine/v86-block-device.ts` を確認 |
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
