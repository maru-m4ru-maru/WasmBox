/**
 * ディスクイメージを「チャンクファイル群 + manifest.json」に分割する。
 *
 *   node tools/chunk-image.ts <イメージファイル> <出力ディレクトリ> [--chunk-size=262144] [--image-id=名前]
 *
 * 出力:
 *   <out>/manifest.json
 *   <out>/chunks/<sha256>      … 内容が同じチャンクは1ファイルに重複排除される
 *
 * 全部ゼロのチャンクはファイルを作らず、manifest 上は null になる。
 */
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../src/storage/types.ts";

export interface ChunkImageOptions {
  chunkSize?: number;
  imageId?: string;
}

export async function chunkImageFile(
  imagePath: string,
  outDir: string,
  options: ChunkImageOptions = {},
): Promise<Manifest> {
  const chunkSize = options.chunkSize ?? 256 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunk-size が不正です: ${chunkSize}`);
  }
  const file = await open(imagePath, "r");
  try {
    const { size } = await file.stat();
    await mkdir(join(outDir, "chunks"), { recursive: true });

    const chunks: (string | null)[] = [];
    const written = new Set<string>();
    const buffer = Buffer.alloc(chunkSize);
    for (let position = 0; position < size; position += chunkSize) {
      const length = Math.min(chunkSize, size - position);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error(`読み取りが途中で終わりました（位置 ${position}）`);
      const view = buffer.subarray(0, length);

      if (view.every((b) => b === 0)) {
        chunks.push(null);
        continue;
      }
      const hash = createHash("sha256").update(view).digest("hex");
      chunks.push(hash);
      if (!written.has(hash)) {
        await writeFile(join(outDir, "chunks", hash), view);
        written.add(hash);
      }
    }

    const manifest: Manifest = {
      version: 1,
      imageId: options.imageId ?? basename(imagePath),
      size,
      chunkSize,
      chunks,
    };
    await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  } finally {
    await file.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const [imagePath, outDir] = positional;
  if (!imagePath || !outDir) {
    console.error(
      "使い方: node tools/chunk-image.ts <イメージファイル> <出力ディレクトリ> [--chunk-size=262144] [--image-id=名前]",
    );
    process.exitCode = 1;
    return;
  }
  const chunkSizeFlag = flag("chunk-size");
  const options: ChunkImageOptions = {};
  if (chunkSizeFlag !== undefined) options.chunkSize = Number(chunkSizeFlag);
  const imageIdFlag = flag("image-id");
  if (imageIdFlag !== undefined) options.imageId = imageIdFlag;

  const manifest = await chunkImageFile(imagePath, outDir, options);
  const real = manifest.chunks.filter((c) => c !== null);
  console.log(
    `完了: ${manifest.size} バイト → ${manifest.chunks.length} チャンク ` +
      `（ゼロ ${manifest.chunks.length - real.length}、ユニーク ${new Set(real).size}）`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2));
}
