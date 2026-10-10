# Alpine root filesystem image

32-bit x86 Alpine with Node.js and Python is packaged into an ext4 image, split into content-addressed chunks, and served to the v86 BlockStore.

The external initrd now provides the `rdinit=/wasmbox-init` path. The actual direct-root handoff is being tested in v86 by GitHub Actions; Node.js and Python execution were already verified using the earlier chroot path.

## Build

Requirements: Docker with BuildKit and Node.js 22.18 or newer.

```sh
bash image/build.sh
```

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| ALPINE_VERSION | 3.21 | Alpine release |
| PACKAGES | nodejs python3 | Packages installed into the guest image |
| IMAGE_SIZE_MIB | 512 | Virtual disk size |
| CHUNK_SIZE | 262144 | Chunk size in bytes |

The build creates `image/out/rootfs.ext4` and `poc/image/manifest.json` plus `poc/image/chunks/`. It checks the filesystem with e2fsck after restoring the image from the chunk store.

## Run the browser PoC

1. Follow `poc/README.md` and place the v86 assets and disk-enabled kernel in `poc/vendor/`.
2. Run `npm run poc`.
3. Open http://127.0.0.1:8080/alpine.html.

Parameters: `?memory=512`, `?root=/dev/hda`, `?kernel=...`, `?cmdline=...`, and `?image=image`.

## Current kernel caveat

The `buildroot-bzimage68_v86.bin` kernel starts its built-in Buildroot environment (prompt `~% `) and tries to mount the v86 host 9p filesystem at `/mnt`. That initramfs has an init of its own, so the supplied `root=` parameter alone does not make Alpine become PID 1. The test mounts the ext4 disk at `/mnt/alpine`, mounts proc/sys/dev into it, then runs commands using `chroot`. This verifies that the Alpine userland and Node.js binary execute on v86's emulated x86 CPU, but not that a direct root switch works.

## Guest checks

The automated smoke test runs the following equivalents in the Alpine root:

```sh
cat /etc/alpine-release
node --version
node -e "console.log(1 + 1)"
python3 --version
free -m
time node -e "console.log(1)"
time python3 -c "print(1)"
```

Record the time until the guest shell appears, the downloaded chunk count and MiB shown in the status line, the command timings, and the detected disk name.

## Troubleshooting

| Symptom | Next check |
|---|---|
| Alpine ext4 won't mount | Try /dev/sda and /dev/hda; check /proc/partitions and dmesg |
| `chroot` says not found | Check that /mnt/alpine/bin/sh exists and the ext4 mount succeeded |
| Node reports Illegal instruction | Check /proc/cpuinfo; current guest advertises SSE2 but not SSE3 |
| Process is killed | Increase RAM with `?memory=512` |
| Status says the image belongs to another image | Reset the disk overlay before loading the new manifest |

## Design notes

- Packages are installed at image build time, not inside the guest.
- ext4 is created with `metadata_csum`, `64bit`, and `orphan_file` disabled for compatibility with the older kernel. The journal remains enabled.
- The default image is 512 MiB. Zero-filled chunks are not delivered, so unused disk space does not need to be downloaded.
- The BlockStore writes are periodically flushed, but guest filesystem write ordering is not guaranteed to match flush boundaries.


## Direct-root startup with external initrd

The selected kernel contains a Buildroot initramfs, whose embedded `/init` starts Buildroot rather than using `root=` to switch to Alpine. `tools/make-initrd.ts` creates a small uncompressed `newc` cpio archive with `/wasmbox-init` and minimal device nodes. `poc/alpine.ts` passes it to v86 and adds `rdinit=/wasmbox-init`.

The init script reads `root=` and `rootfstype=`, waits up to 15 seconds for the device, mounts ext4, checks `/sbin/init`, and calls `switch_root /newroot /sbin/init`. If that fails, it attempts `chroot` and leaves a rescue shell if necessary.

A successful direct-root boot must print `[wasmbox-init] ルート: /dev/sda（ext4）`. The live smoke test also verifies that `/proc/mounts` shows ext4 mounted at `/`, runs Node.js and Python, records `free -m`, and repeats the browser boot three times.

Use `?initrd=none` to disable the external initrd, `?initrd=...` to provide an explicit path, `?root=/dev/hda` for a different disk name, and `?memory=512` to increase guest RAM.

Troubleshooting: if Buildroot's `~%` prompt appears without a `[wasmbox-init]` line, check the initrd URL and the `rdinit=` command-line parameter. If the device is missing, inspect `/proc/partitions`; if mounting fails, inspect `dmesg | tail` and the ext4 feature flags.