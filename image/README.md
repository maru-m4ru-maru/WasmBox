# Alpine root filesystem image

32-bit x86 Alpine with Node.js and Python is packaged into an ext4 image, split into content-addressed chunks, and served to the v86 BlockStore.

The Docker image build and boot of this image under v86 have not yet been verified. The next check is actual boot and execution of Node.js inside the guest.

## Build

Requirements: Docker with BuildKit and Node.js 22.18 or newer.

Run:

\`\`\`sh
bash image/build.sh
\`\`\`

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| ALPINE_VERSION | 3.21 | Alpine release |
| PACKAGES | nodejs python3 | Packages installed into the guest image |
| IMAGE_SIZE_MIB | 512 | Virtual disk size |
| CHUNK_SIZE | 262144 | Chunk size in bytes |

Output:
- image/out/rootfs.ext4: complete disk image
- poc/image/manifest.json and poc/image/chunks/: chunks for browser delivery

The final inspection restores the image from its chunks and runs e2fsck to verify consistency.

## Boot

1. Follow the vendor setup steps in poc/README.md and put the v86 assets and disk-enabled kernel in poc/vendor/.
2. Build and serve the pages:

\`\`\`sh
npm run poc
\`\`\`

3. Open http://127.0.0.1:8080/alpine.html.

URL parameters:
- memory: guest RAM in MiB, default 256; for example ?memory=512
- root: root device, default /dev/sda; try ?root=/dev/hda if the kernel reports that device instead
- kernel: kernel path, default vendor/buildroot-bzimage.bin
- cmdline: the full kernel command line
- image: image directory relative to poc/, default image

## Guest checks

Run these commands in the serial shell:

\`\`\`sh
cat /etc/alpine-release
node --version
node -e "console.log(1 + 1)"
python3 --version
free -m
time node -e "console.log(1)"
time python3 -c "print(1)"
dmesg | grep -iE "sd[a-z]|hd[a-z]"
\`\`\`

Record the time until a shell appears, the downloaded chunk count and MiB shown in the status line, the execution times, and the detected disk name.

## Troubleshooting

| Symptom | Next check |
|---|---|
| VFS: Unable to mount root fs | Try ?root=/dev/hda; inspect the filesystem feature flags |
| No working init found | Check /sbin/init and try adding init=/bin/sh to the full cmdline |
| Shell does not appear | Check console=ttyS0 and the ttyS0 entry in image/inittab |
| node reports Illegal instruction | Check /proc/cpuinfo for SSE flags; the current v86 guest exposes SSE2 but not SSE3 |
| Process is killed | Increase RAM with ?memory=512 |
| Status says the image is for another image | Reset the disk overlay to clear writes associated with the previous manifest |

## Design notes

- Node.js and Python are installed at image build time, avoiding package downloads inside the guest.
- ext4 is created with metadata_csum, 64bit, and orphan_file disabled for compatibility with the older guest kernel; its journal remains enabled.
- The default image is 512 MiB. Zero-filled chunks are omitted from delivery, so unused disk space is not downloaded.
- Browser writes are persisted through BlockStore flushes. The guest filesystem's write ordering is not guaranteed to match flush boundaries, so the ext4 journal is retained for recovery.
