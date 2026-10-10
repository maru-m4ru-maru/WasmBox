/**
 * newc 形式の cpio アーカイブを書き出す最小の実装（Linux の initramfs / initrd 用）。
 *
 * - ヘッダは magic "070701" と 13 個の 8 桁 16 進数（計 110 バイト）
 * - 名前とデータの後ろは 4 バイト境界までパディング
 * - 最後に TRAILER!!! エントリを置く
 * - mtime は 0 固定で再現可能なアーカイブを作る
 */

export type CpioEntry =
  | { type: "dir"; path: string; mode?: number }
  | { type: "file"; path: string; data: Uint8Array | string; mode?: number }
  | { type: "symlink"; path: string; target: string; mode?: number }
  | { type: "chardev"; path: string; major: number; minor: number; mode?: number };

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const HEADER_SIZE = 110;
const encoder = new TextEncoder();

function hex8(value: number, what: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(what + " は 0〜0xffffffff の整数である必要があります: " + value);
  }
  return value.toString(16).padStart(8, "0");
}

const padding = (length: number) => (4 - (length % 4)) % 4;

function normalizePath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (normalized === "" || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new RangeError('cpio に入れるパスが不正です: "' + path + '"');
  }
  return normalized;
}

export function buildCpio(entries: readonly CpioEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let inode = 1;

  const push = (
    name: string,
    mode: number,
    data: Uint8Array,
    nlink: number,
    rdev: { major: number; minor: number } = { major: 0, minor: 0 },
  ) => {
    const nameBytes = encoder.encode(name + "\0");
    const fields: Array<[number, string]> = [
      [inode++, "ino"],
      [mode, "mode"],
      [0, "uid"],
      [0, "gid"],
      [nlink, "nlink"],
      [0, "mtime"],
      [data.byteLength, "filesize"],
      [0, "devmajor"],
      [0, "devminor"],
      [rdev.major, "rdevmajor"],
      [rdev.minor, "rdevminor"],
      [nameBytes.byteLength, "namesize"],
      [0, "check"],
    ];
    const header = "070701" + fields.map(([value, what]) => hex8(value, what)).join("");
    parts.push(encoder.encode(header), nameBytes, new Uint8Array(padding(HEADER_SIZE + nameBytes.byteLength)));
    parts.push(data, new Uint8Array(padding(data.byteLength)));
  };

  for (const entry of entries) {
    const name = normalizePath(entry.path);
    switch (entry.type) {
      case "dir":
        push(name, S_IFDIR | ((entry.mode ?? 0o755) & 0o7777), new Uint8Array(0), 2);
        break;
      case "file": {
        const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
        push(name, S_IFREG | ((entry.mode ?? 0o644) & 0o7777), data, 1);
        break;
      }
      case "symlink":
        push(name, S_IFLNK | ((entry.mode ?? 0o777) & 0o7777), encoder.encode(entry.target), 1);
        break;
      case "chardev":
        push(name, S_IFCHR | ((entry.mode ?? 0o600) & 0o7777), new Uint8Array(0), 1, {
          major: entry.major,
          minor: entry.minor,
        });
        break;
    }
  }
  push("TRAILER!!!", 0, new Uint8Array(0), 1);

  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export interface ParsedCpioEntry {
  name: string;
  mode: number;
  nlink: number;
  rdevMajor: number;
  rdevMinor: number;
  data: Uint8Array;
}

export function parseCpio(archive: Uint8Array): ParsedCpioEntry[] {
  const decoder = new TextDecoder();
  const entries: ParsedCpioEntry[] = [];
  let pos = 0;
  for (;;) {
    if (pos + HEADER_SIZE > archive.byteLength) throw new Error("TRAILER!!! の前でアーカイブが終わりました");
    const magic = decoder.decode(archive.subarray(pos, pos + 6));
    if (magic !== "070701") throw new Error("マジックが不正です（位置 " + pos + "）: " + JSON.stringify(magic));
    const field = (index: number) => {
      const text = decoder.decode(archive.subarray(pos + 6 + index * 8, pos + 14 + index * 8));
      if (!/^[0-9a-f]{8}$/.test(text)) throw new Error("フィールド " + index + " が 8 桁の 16 進数ではありません: " + JSON.stringify(text));
      return parseInt(text, 16);
    };
    const mode = field(1);
    const nlink = field(4);
    const filesize = field(6);
    const rdevMajor = field(9);
    const rdevMinor = field(10);
    const namesize = field(11);
    if (namesize < 1) throw new Error("namesize が不正です");

    const nameStart = pos + HEADER_SIZE;
    if (nameStart + namesize > archive.byteLength || archive[nameStart + namesize - 1] !== 0) {
      throw new Error("ファイル名が NUL で終わっていません");
    }
    const name = decoder.decode(archive.subarray(nameStart, nameStart + namesize - 1));

    const dataStart = nameStart + namesize + padding(HEADER_SIZE + namesize);
    if (dataStart + filesize > archive.byteLength) throw new Error("ファイルの中身がアーカイブの長さを超えています");
    const data = archive.slice(dataStart, dataStart + filesize);
    pos = dataStart + filesize + padding(filesize);

    if (name === "TRAILER!!!") {
      if (pos !== archive.byteLength) throw new Error("TRAILER!!! の後に余分なデータがあります（" + (archive.byteLength - pos) + " バイト）");
      return entries;
    }
    entries.push({ name, mode, nlink, rdevMajor, rdevMinor, data });
  }
}
