#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/ruby-studio-build.sh"

ci_toolchain=0
for argument in "$@"; do
	case "$argument" in
		--ci-toolchain) ci_toolchain=1 ;;
		--help|-h)
			printf 'Usage: ./scripts/setup-ruby-studio.sh [--ci-toolchain]\nInstall locked npm dependencies. --ci-toolchain also downloads the upstream Linux compiler/sysroots.\nSee BUILDING_RUBY_STUDIO.md for OS packages and Ruby test gems.\n'
			exit 0 ;;
		*) ruby_studio_fail "Unknown option: $argument. Use --help." ;;
	esac
done
ruby_studio_environment
cd "$RUBY_STUDIO_SOURCE"
ruby_studio_logs
for tool in git python3 make gcc g++ pkg-config curl; do ruby_studio_require "$tool" 'Install the build prerequisites listed in BUILDING_RUBY_STUDIO.md.'; done
pkg-config --exists x11 xkbfile krb5 || ruby_studio_fail 'Native headers are missing. On Ubuntu install build-essential pkg-config libx11-dev libx11-xcb-dev libxkbfile-dev libkrb5-dev libsecret-1-dev (see BUILDING_RUBY_STUDIO.md).'
[[ -f package-lock.json && -f build/package-lock.json ]] || ruby_studio_fail 'The root and build package-lock.json files are required for npm ci.'

# Upstream preinstall/toolchain scripts require the build dependencies first.
(cd build && ruby_studio_run setup-build npm ci --no-audit --no-fund)
if [[ "$ci_toolchain" == 1 ]]; then
	ruby_studio_require python 'Install python-is-python3 for the upstream Chromium compiler downloader.'
	export VSCODE_ARCH=x64 npm_config_arch=x64
	# Keep downloaded paths/flags inside this process and the root npm installation.
	source "$RUBY_STUDIO_SOURCE/build/azure-pipelines/linux/setup-env.sh" > >(tee "$RUBY_STUDIO_LOG_DIR/setup-toolchain.log") 2>&1
fi
# npm_command=ci also keeps every nested postinstall dependency install locked.
ruby_studio_run setup-workspace env npm_command=ci VSCODE_FORCE_INSTALL=1 npm ci --no-audit --no-fund
printf '\nLocked dependencies installed. Build with ./scripts/build-ruby-studio.sh\n'
