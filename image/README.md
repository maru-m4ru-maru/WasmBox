# Alpine root filesystem image

32-bit x86 Alpine with Node.js and Python is packaged into an ext4 image, split into content-addressed chunks, and served to the v86 BlockStore.

The first actual v86 test found that the selected disk-enabled Buildroot kernel boots its own built-in initramfs and shell instead of switching directly to the external disk when given `root=/dev/sda` or `root=/dev/hda`. The automated test therefore mounts the Alpine ext4 image from the Buildroot shell and runs Alpine programs inside `chroot`. Direct boot into Alpine's init remains unverified.

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
