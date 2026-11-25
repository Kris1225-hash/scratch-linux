#!/bin/bash
# the same build in a throwaway ubuntu container. sources and objects live in a docker volume (the linux tree
# needs a case sensitive filesystem, which a folder shared from macOS is not); only out/kernel comes back.
#   ./build/docker.sh            (docker volume rm scratch-linux-work   to start over from nothing)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec docker run --rm -v "$ROOT":/src -v scratch-linux-work:/work -e WORK=/work ${J:+-e J="$J"} -w /src ubuntu:24.04 ./build/build.sh --install-deps
