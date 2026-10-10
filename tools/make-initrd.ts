/**
 * ディスクのルート（ext4）へ切り替えるための、外付け initrd を作る。
 *
 *   node tools/make-initrd.ts <出力ファイル>
 *
 * 中身は /wasmbox-init と、最小のディレクトリ・デバイスノードだけ。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCpio } from "./cpio.ts";

const INIT_PATH = fileURLToPath(new URL("../image/initrd/wasmbox-init", import.meta.url));

export async function makeWasmboxInitrd(): Promise<Uint8Array> {
  const script = await readFile(INIT_PATH, "utf8");
  return buildCpio([
    { type: "dir", path: "dev" },
    { type: "chardev", path: "dev/console", major: 5, minor: 1, mode: 0o600 },
    { type: "chardev", path: "dev/null", major: 1, minor: 3, mode: 0o666 },
    { type: "dir", path: "proc" },
    { type: "dir", path: "sys" },
    { type: "dir", path: "newroot" },
    { type: "file", path: "wasmbox-init", data: script, mode: 0o755 },
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.argv[2];
  if (!out) {
    console.error("使い方: node tools/make-initrd.ts <出力ファイル>");
    process.exitCode = 1;
  } else {
    const archive = await makeWasmboxInitrd();
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, archive);
    console.log("initrd を作成: " + out + "（" + archive.byteLength + " バイト）");
  }
}
