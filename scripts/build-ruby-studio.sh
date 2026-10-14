#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/ruby-studio-build.sh"

setup=0; check=0; package=0; package_only=0; ci_toolchain=0
for argument in "$@"; do
	case "$argument" in
		--setup) setup=1 ;;
		--check) check=1 ;;
		--package) package=1 ;;
		--package-only) package=1; package_only=1 ;;
		--ci-toolchain) ci_toolchain=1 ;;
		--help|-h)
			cat <<'HELP'
Usage: ./scripts/build-ruby-studio.sh [--setup] [--check] [--package]
       ./scripts/build-ruby-studio.sh --package-only

Build Linux x64 from any checkout path. Optional --setup installs locked npm
dependencies; --ci-toolchain also downloads the upstream Linux native toolchain.
--check runs typed unit/native tests and real app integration (Xvfb if needed).
--package creates dist/ruby-studio/*.tar.gz, build metadata and SHA256SUMS.
--package-only archives an already built app without compiling or testing it.
See BUILDING_RUBY_STUDIO.md for prerequisites, logs and environment overrides.
HELP
			exit 0 ;;
		*) ruby_studio_fail "Unknown option: $argument. Use --help." ;;
	esac
done
[[ "$package_only" == 0 || "$setup$check$ci_toolchain" == 000 ]] || ruby_studio_fail '--package-only cannot be combined with --setup, --check or --ci-toolchain.'
[[ "$ci_toolchain" == 0 || "$setup" == 1 ]] || ruby_studio_fail '--ci-toolchain requires --setup.'
if [[ "$package_only" == 1 ]]; then ruby_studio_environment no-rust; else ruby_studio_environment; fi
cd "$RUBY_STUDIO_SOURCE"
ruby_studio_logs
if [[ "$setup" == 1 ]]; then
	setup_args=(); if [[ "$ci_toolchain" == 1 ]]; then setup_args+=(--ci-toolchain); fi
	"$RUBY_STUDIO_SOURCE/scripts/setup-ruby-studio.sh" "${setup_args[@]}"
fi
if [[ "$package_only" == 0 ]]; then
	[[ "$RUBY_STUDIO_APP_DIR" == "$RUBY_STUDIO_PARENT/VSCode-linux-x64" ]] || ruby_studio_fail 'The upstream desktop build writes ../VSCode-linux-x64. RUBY_STUDIO_APP_DIR is an override for testing/packaging an existing app only.'
	ruby_studio_dependencies
	if [[ "$check" == 1 ]]; then ruby_studio_test_ruby; fi
	ruby_studio_compile
	ruby_studio_native
	ruby_studio_run copy-codicons npm run gulp copy-codicons
	ruby_studio_run bundle-extensions npm run gulp compile-non-native-extensions-build
	ruby_studio_run bundle-extension-media npm run gulp compile-extension-media-build
	ruby_studio_run bundle-desktop node build/next/index.ts bundle --out out-vscode --nls --target desktop
	ruby_studio_run package-desktop npm run gulp vscode-linux-x64-ci
	ruby_studio_run verify-desktop node scripts/lib/ruby-studio-artifact.mjs verify "$RUBY_STUDIO_APP_DIR"
	ruby_studio_run record-build node scripts/lib/ruby-studio-artifact.mjs record-build "$RUBY_STUDIO_APP_DIR"
	if [[ "$check" == 1 ]]; then "$RUBY_STUDIO_SOURCE/scripts/test-ruby-studio.sh"; fi
fi
if [[ "$package" == 1 ]]; then "$RUBY_STUDIO_SOURCE/scripts/package-ruby-studio.sh"; fi
printf '\nRuby Studio app: %s\nBuild logs: %s\n' "$RUBY_STUDIO_APP_DIR" "$RUBY_STUDIO_LOG_DIR"
