#!/bin/bash
# builds everything that goes inside the scratch project:
#   an i486 musl cross toolchain, busybox, /init, and linux with the root filesystem linked in as an initramfs.
# output: out/kernel/vmlinux (+ System.map and the final .config)
#
#   ./build/build.sh [--install-deps]     on a debian / ubuntu machine, x86_64 or arm64
#   ./build/docker.sh                     anywhere docker runs
#
# WORK (default build/work) is where sources and objects go. it needs ~6 GB and a case sensitive filesystem.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
B=$ROOT/build
W=${WORK:-$B/work}
OUT=${OUT:-$ROOT/out/kernel}
J=${J:-$(nproc)}

KERNEL_TAG=v6.12.119
KERNEL_COMMIT=e2e4b92c2b2a3ae78423cb343951cb5d2241b405
BUSYBOX_VER=1.36.1
BUSYBOX_SHA256=b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314
MCM_COMMIT=5e8042e63de29f8473fc3b0b831a587ba284e1a8
GCC_VER=14.3.0; BINUTILS_VER=2.44; MUSL_VER=1.2.6

# the same metadata on every build: no host names, users or build times in the kernel banner or the file dates
export KBUILD_BUILD_USER=scratch KBUILD_BUILD_HOST=scratch KBUILD_BUILD_VERSION=1
export KBUILD_BUILD_TIMESTAMP="Wed Nov 25 12:00:00 UTC 2026"
export SOURCE_DATE_EPOCH=1795608000

if [ "${1:-}" = "--install-deps" ]; then
  SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends \
    build-essential g++ make patch wget ca-certificates git xz-utils bzip2 file flex bison bc perl rsync cpio >/dev/null
fi
for t in gcc g++ make patch wget git flex bison bc xz bzip2 perl; do
  command -v $t >/dev/null || { echo "missing: $t   (./build/build.sh --install-deps installs what is needed with apt)"; exit 1; }
done
mkdir -p "$W" "$OUT"
cd "$W"
export PATH=$W/toolchain/bin:$PATH
CROSS=i486-linux-musl-

echo "### toolchain (gcc $GCC_VER, binutils $BINUTILS_VER, musl $MUSL_VER)"
if [ ! -x toolchain/bin/${CROSS}gcc ]; then
  if [ ! -d mcm ]; then
    git init -q mcm
    git -C mcm fetch -q --depth 1 https://github.com/richfelker/musl-cross-make.git $MCM_COMMIT
    git -C mcm checkout -q FETCH_HEAD
  fi
  cat > mcm/config.mak <<EOC
TARGET = i486-linux-musl
OUTPUT = $W/toolchain
GCC_VER = $GCC_VER
BINUTILS_VER = $BINUTILS_VER
MUSL_VER = $MUSL_VER
GNU_SITE = https://ftp.gnu.org/gnu
COMMON_CONFIG += --disable-nls CFLAGS="-g0 -O2" CXXFLAGS="-g0 -O2" LDFLAGS="-s"
GCC_CONFIG += --enable-languages=c --disable-libquadmath --disable-decimal-float --disable-libitm --disable-fixed-point --disable-lto --disable-libsanitizer --disable-libgomp
GCC_CONFIG += --with-arch=i486 --with-tune=generic
EOC
  rm -rf mcm/sources/*.tmp
  ( cd mcm && make -j"$J" >"$W/toolchain-build.log" 2>&1 && make install >>"$W/toolchain-build.log" 2>&1 ) \
    || { echo "### toolchain build failed:"; tail -30 "$W/toolchain-build.log"; exit 1; }
fi
${CROSS}gcc --version | head -1

echo "### busybox $BUSYBOX_VER"
if [ ! -d busybox ]; then
  [ -f busybox.tar.bz2 ] || timeout 180 wget -q -O busybox.tar.bz2 https://busybox.net/downloads/busybox-$BUSYBOX_VER.tar.bz2 \
    || timeout 180 wget -q -O busybox.tar.bz2 http://archive.ubuntu.com/ubuntu/pool/main/b/busybox/busybox_$BUSYBOX_VER.orig.tar.bz2
  echo "$BUSYBOX_SHA256  busybox.tar.bz2" | sha256sum -c - >/dev/null
  tar xf busybox.tar.bz2 && mv busybox-$BUSYBOX_VER busybox
fi
(
  cd busybox
  make allnoconfig >/dev/null
  for s in $(cat "$B/busybox.want"); do sed -i "s/^# CONFIG_$s is not set\$/CONFIG_$s=y/" .config; done
  sed -i "s|^CONFIG_CROSS_COMPILER_PREFIX=.*|CONFIG_CROSS_COMPILER_PREFIX=\"$CROSS\"|" .config
  sed -i 's|^CONFIG_EXTRA_CFLAGS=.*|CONFIG_EXTRA_CFLAGS="-march=i486 -mtune=generic"|' .config
  sed -i 's/^CONFIG_SH_IS_NONE=y/# CONFIG_SH_IS_NONE is not set/' .config
  yes "" | make oldconfig >/dev/null 2>&1 || true
  missing=""; for s in $(cat "$B/busybox.want"); do grep -q "^CONFIG_$s=y" .config || missing="$missing $s"; done
  [ -z "$missing" ] || echo "busybox: these did not get switched on:$missing"
  make -j"$J" busybox busybox.links >"$W/busybox-build.log" 2>&1 || { echo "### busybox build failed:"; tail -30 "$W/busybox-build.log"; exit 1; }
)
ls -l busybox/busybox | awk '{print "busybox:", $5, "bytes"}'
# this has to run on a 486: nothing newer than that may have been emitted
if ${CROSS}objdump -d busybox/busybox | grep -E -q '\b(cmov[a-z]+|fcmov[a-z]+|fcomi|fucomi|rdtsc|cpuid|sysenter|movd|movq|cmpxchg8b)\b|xmm'; then
  echo "### post-486 instructions in busybox"; exit 1
fi

echo "### /init and the root filesystem"
mkdir -p rootfs
${CROSS}gcc -static -Os -march=i486 -s -o rootfs/init "$B/init.c"
{
  cat <<EOL
dir /dev 0755 0 0
nod /dev/console 0600 0 0 c 5 1
nod /dev/null 0666 0 0 c 1 3
nod /dev/ttyS0 0600 0 0 c 4 64
dir /bin 0755 0 0
dir /sbin 0755 0 0
dir /usr 0755 0 0
dir /usr/bin 0755 0 0
dir /usr/sbin 0755 0 0
dir /proc 0755 0 0
dir /sys 0755 0 0
dir /etc 0755 0 0
dir /root 0700 0 0
dir /tmp 1777 0 0
file /init $W/rootfs/init 0755 0 0
file /bin/busybox $W/busybox/busybox 0755 0 0
file /etc/motd $B/rootfs/motd 0644 0 0
file /etc/shrc $B/rootfs/shrc 0644 0 0
file /etc/passwd $B/rootfs/passwd 0644 0 0
file /etc/group $B/rootfs/group 0644 0 0
file /root/README $B/rootfs/readme 0644 0 0
EOL
  # one symlink per applet so /bin looks like a real system (the shell itself runs applets in-process)
  sed 's|.*/||' busybox/busybox.links | sort -u | while read -r a; do [ "$a" = busybox ] || echo "slink /bin/$a busybox 0777 0 0"; done
} > rootfs/initramfs.list
echo "initramfs: $(wc -l < rootfs/initramfs.list) entries"

echo "### linux $KERNEL_TAG"
if [ ! -d linux ]; then
  git -c advice.detachedHead=false clone -q --depth 1 --branch $KERNEL_TAG https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git linux
fi
[ "$(git -C linux rev-parse HEAD)" = "$KERNEL_COMMIT" ] || { echo "### linux tree is not at $KERNEL_COMMIT"; exit 1; }
KMAKE="make -C linux ARCH=i386 CROSS_COMPILE=$CROSS"
{ cat "$B/kernel.frag"; echo "CONFIG_INITRAMFS_SOURCE=\"$W/rootfs/initramfs.list\""; } > kernel.frag
$KMAKE tinyconfig >/dev/null
( cd linux && ARCH=i386 CROSS_COMPILE=$CROSS ./scripts/kconfig/merge_config.sh -m .config "$W/kernel.frag" >/dev/null )
$KMAKE olddefconfig >/dev/null
# anything in the fragment that did not stick is a mistake in the fragment
bad=0
while read -r l; do grep -qxF "$l" linux/.config || { echo "kernel config: not applied: $l"; bad=1; }; done < <(grep -E '^CONFIG_[A-Z0-9_]+=' kernel.frag)
while read -r s; do if grep -q "^$s=" linux/.config; then echo "kernel config: still set: $s"; bad=1; fi; done < <(sed -n 's/^# \(CONFIG_[A-Z0-9_]*\) is not set$/\1/p' kernel.frag)
[ $bad = 0 ] || exit 1
$KMAKE -j"$J" vmlinux >"$W/kernel-build.log" 2>&1 || { echo "### kernel build failed:"; grep -n -E "error|Error" "$W/kernel-build.log" | head -20; tail -15 "$W/kernel-build.log"; exit 1; }
${CROSS}size linux/vmlinux
cp linux/vmlinux linux/System.map "$OUT/"
cp linux/.config "$OUT/config"
( cd "$OUT" && sha256sum vmlinux )
echo "### done: $OUT/vmlinux"
