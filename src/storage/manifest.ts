import { ManifestError } from "./errors.ts";
import type { Manifest } from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export function chunkCount(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize);
}

/** index 番目のチャンクの実バイト数（最後だけ chunkSize より短いことがある） */
export function chunkLength(manifest: Manifest, index: number): number {
  return Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize);
}

/** 外から来た JSON を検証し、正規化したコピーを返す。 */
export function validateManifest(input: unknown): Manifest {
  if (typeof input !== "object" || input === null) {
    throw new ManifestError("manifest がオブジェクトではありません");
  }
  const m = input as Record<string, unknown>;
  if (m.version !== 1) {
    throw new ManifestError(`未対応の manifest version です: ${String(m.version)}`);
  }
  if (typeof m.imageId !== "string" || m.imageId.length === 0) {
    throw new ManifestError("imageId が空です");
  }
  const { size, chunkSize } = m;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new ManifestError("size は 0 以上の整数である必要があります");
  }
  if (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new ManifestError("chunkSize は 1 以上の整数である必要があります");
  }
  if (!Array.isArray(m.chunks)) {
    throw new ManifestError("chunks が配列ではありません");
  }
  const expected = chunkCount(size, chunkSize);
  if (m.chunks.length !== expected) {
    throw new ManifestError(
      `chunks の数が合いません（size と chunkSize からは ${expected} 個のはずが ${m.chunks.length} 個）`,
    );
  }
  const chunks: (string | null)[] = [];
  for (const [i, h] of m.chunks.entries()) {
    if (h === null) {
      chunks.push(null);
    } else if (typeof h === "string" && HEX64.test(h)) {
      chunks.push(h);
    } else {
      throw new ManifestError(`chunks[${i}] が SHA-256（hex 小文字 64 桁）でも null でもありません`);
    }
  }
  return { version: 1, imageId: m.imageId, size, chunkSize, chunks };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  // TypeScript のバージョンによって BufferSource への代入可否が変わるためキャストする
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** manifest の内容を一意に表すダイジェスト。overlay が対応するイメージかの判定に使う。 */
export async function manifestDigest(manifest: Manifest): Promise<string> {
  const canonical = JSON.stringify([
    manifest.version,
    manifest.imageId,
    manifest.size,
    manifest.chunkSize,
    manifest.chunks,
  ]);
  return sha256Hex(new TextEncoder().encode(canonical));
}
