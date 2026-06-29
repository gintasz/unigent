#!/usr/bin/env bash
set -euo pipefail

# Useful before triggering release: if the release workflow config and auth are
# valid, this catches fresh-Linux install/build/test failures before the workflow
# spends time reaching its publish path. It does not prove release-only steps
# such as changesets/action behavior, npm publishing, provenance, or permissions.

usage() {
  cat <<'EOF'
Usage: scripts/ci-docker.sh [--docs] [--image IMAGE] [--platform PLATFORM]

Runs the repository gate from a fresh /tmp checkout inside Docker.
Useful before release for catching fresh-Linux install/build/test failures.
It does not prove release-only publish steps.

Options:
  --docs         Also build the standalone docs-website package.
  --image IMAGE Docker image to use. Defaults to node:24-bookworm.
  --platform P  Docker platform to use, e.g. linux/amd64. Defaults to native.
  -h, --help    Show this help.
EOF
}

repo_root="$(git rev-parse --show-toplevel)"
image="node:24-bookworm"
platform=""
run_docs=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docs)
      run_docs=true
      shift
      ;;
    --image)
      if [ "$#" -lt 2 ]; then
        echo "error: --image requires a value" >&2
        exit 2
      fi
      image="$2"
      shift 2
      ;;
    --platform)
      if [ "$#" -lt 2 ]; then
        echo "error: --platform requires a value" >&2
        exit 2
      fi
      platform="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

docker_platform_args=()
case "$platform" in
  "")
    docker_arch="$(docker info --format "{{.Architecture}}")"
    case "$docker_arch" in
      aarch64 | arm64)
        docker_platform_args=(--platform "linux/arm64")
        ;;
      x86_64 | amd64)
        docker_platform_args=(--platform "linux/amd64")
        ;;
      *)
        echo "error: unsupported Docker architecture: $docker_arch" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    docker_platform_args=(--platform "$platform")
    ;;
esac

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/microfoom-ci-docker.XXXXXX")"
workdir="$tmp_root/repo"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

mkdir -p "$workdir"

cd "$repo_root"
git ls-files --cached --others --exclude-standard -z \
  | tar --null -T - -cf - \
  | tar -xf - -C "$workdir"

git -C "$workdir" init -q

docker_command='
set -euo pipefail
corepack enable
pnpm install --frozen-lockfile
pnpm run check
if [ "${RUN_DOCS}" = "true" ]; then
  cd docs-website
  pnpm install --frozen-lockfile --ignore-workspace
  pnpm run build
fi
'

docker run --rm \
  "${docker_platform_args[@]}" \
  -e CI=1 \
  -e RUN_DOCS="$run_docs" \
  -v "$workdir:/repo" \
  -w /repo \
  "$image" \
  bash -lc "$docker_command"
