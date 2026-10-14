#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.

# Shared by the Linux x64 build, setup and validation entry points.
RUBY_STUDIO_SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RUBY_STUDIO_PARENT="$(dirname -- "$RUBY_STUDIO_SOURCE")"

ruby_studio_fail() { printf 'Ruby Studio: %s\n' "$*" >&2; exit 1; }
ruby_studio_require() { command -v -- "$1" >/dev/null 2>&1 || ruby_studio_fail "Missing $1. $2"; }

ruby_studio_node_compatible() {
	command -v node >/dev/null 2>&1 && node -e '
		const fs = require("node:fs");
		const required = fs.readFileSync(process.argv[1], "utf8").trim().split(".").map(Number);
		const actual = process.versions.node.split(".").map(Number);
		process.exit(actual[0] === required[0] && (actual[1] > required[1] || actual[1] === required[1] && actual[2] >= required[2]) ? 0 : 1);
	' "$RUBY_STUDIO_SOURCE/.nvmrc" >/dev/null 2>&1
}

ruby_studio_environment() {
	local want_rust="${1:-yes}"
	[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || ruby_studio_fail 'These entry points build Linux x64. Use the upstream platform tasks for other targets.'
	local toolchain="${RUBY_STUDIO_TOOLCHAIN_DIR:-$RUBY_STUDIO_PARENT/toolchain}"
	local required; required="$(tr -d '[:space:]' < "$RUBY_STUDIO_SOURCE/.nvmrc")"
	if [[ -n "${RUBY_STUDIO_NODE_BIN:-}" ]]; then
		[[ -x "$RUBY_STUDIO_NODE_BIN/node" ]] || ruby_studio_fail "No node executable in RUBY_STUDIO_NODE_BIN=$RUBY_STUDIO_NODE_BIN"
		export PATH="$RUBY_STUDIO_NODE_BIN:$PATH"
	elif [[ "${RUBY_STUDIO_USE_LOCAL_TOOLCHAIN:-1}" != 0 ]] && ! ruby_studio_node_compatible && [[ -x "$toolchain/node-v$required-linux-x64/bin/node" ]]; then
		export PATH="$toolchain/node-v$required-linux-x64/bin:$PATH"
	fi
	ruby_studio_node_compatible || ruby_studio_fail "Use Node.js $required or newer in the same major version (see .nvmrc). Install it with nvm install, or set RUBY_STUDIO_NODE_BIN to its bin directory."
	ruby_studio_require npm 'Install the npm shipped with Node.js.'
	[[ "$(npm --version | cut -d. -f1)" -lt 12 ]] || ruby_studio_fail 'This checkout requires npm below version 12; use the npm bundled with the Node.js version in .nvmrc.'
	# Use actual private toolchain executables, never redirect a caller's Cargo/Rustup homes.
	if [[ "$want_rust" == yes && "${RUBY_STUDIO_USE_LOCAL_TOOLCHAIN:-1}" != 0 ]] && ! (command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1 && cargo --version >/dev/null 2>&1 && rustc --version >/dev/null 2>&1); then
		local rust_bin="$toolchain/rust/toolchains/stable-x86_64-unknown-linux-gnu/bin"
		if [[ -x "$rust_bin/cargo" && -x "$rust_bin/rustc" ]]; then export PATH="$rust_bin:$PATH"; fi
	fi
	if [[ "$want_rust" == yes ]]; then
		ruby_studio_require cargo 'Install the Rust toolchain from https://rustup.rs/ and add its bin directory to PATH.'
		ruby_studio_require rustc 'Install a working stable Rust toolchain.'
		cargo --version >/dev/null 2>&1 && rustc --version >/dev/null 2>&1 || ruby_studio_fail 'Cargo/Rust are on PATH but cannot run. Check rustup show and your selected toolchain.'
	fi
	RUBY_STUDIO_APP_DIR="${RUBY_STUDIO_APP_DIR:-$RUBY_STUDIO_PARENT/VSCode-linux-x64}"
	RUBY_STUDIO_APP_DIR="$(node -p 'require("node:path").resolve(process.argv[1])' "$RUBY_STUDIO_APP_DIR")"
	export RUBY_STUDIO_APP_DIR
	export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}"
	export ELECTRON_SKIP_BINARY_DOWNLOAD="${ELECTRON_SKIP_BINARY_DOWNLOAD:-1}"
}

ruby_studio_logs() {
	RUBY_STUDIO_LOG_DIR="${RUBY_STUDIO_LOG_DIR:-$RUBY_STUDIO_SOURCE/.build/ruby-studio/logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
	mkdir -p -- "$RUBY_STUDIO_LOG_DIR"
	RUBY_STUDIO_LOG_DIR="$(cd -- "$RUBY_STUDIO_LOG_DIR" && pwd)"
	export RUBY_STUDIO_LOG_DIR
	printf 'Ruby Studio logs: %s\n' "$RUBY_STUDIO_LOG_DIR"
	{ node --version; npm --version; if command -v cargo >/dev/null 2>&1; then cargo --version || true; fi; if command -v rustc >/dev/null 2>&1; then rustc --version || true; fi; git rev-parse HEAD; } > "$RUBY_STUDIO_LOG_DIR/environment.txt"
}

ruby_studio_run() {
	local name="$1"; shift
	printf '\nRuby Studio: %s\n' "$name"
	"$@" 2>&1 | tee "$RUBY_STUDIO_LOG_DIR/$name.log"
}

ruby_studio_dependencies() {
	[[ -x "$RUBY_STUDIO_SOURCE/node_modules/.bin/tsgo" && -d "$RUBY_STUDIO_SOURCE/build/node_modules" ]] || ruby_studio_fail 'Dependencies are missing. Run ./scripts/setup-ruby-studio.sh, or build with --setup.'
}

ruby_studio_compile() {
	ruby_studio_run typecheck-core npm run compile-check-ts-native
	(cd "$RUBY_STUDIO_SOURCE/build" && ruby_studio_run typecheck-build npm run typecheck)
	ruby_studio_run compile-extensions npm run gulp compile-extensions
}

ruby_studio_native() {
	ruby_studio_run build-native cargo build --release --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
	local target="${CARGO_TARGET_DIR:-$RUBY_STUDIO_SOURCE/extensions/ruby-studio/native/target}"
	[[ "$target" == /* ]] || target="$RUBY_STUDIO_SOURCE/$target"
	RUBY_STUDIO_NATIVE_LEXER="$target/release/ruby-studio-lexer"
	[[ -x "$RUBY_STUDIO_NATIVE_LEXER" ]] || ruby_studio_fail "Native worker not produced at $RUBY_STUDIO_NATIVE_LEXER. Remove custom CARGO_BUILD_TARGET for this native Linux x64 build."
	export RUBY_STUDIO_NATIVE_LEXER
	mkdir -p extensions/ruby-studio/native/bin/linux-x64
	install -m 755 "$RUBY_STUDIO_NATIVE_LEXER" extensions/ruby-studio/native/bin/linux-x64/ruby-studio-lexer
}

ruby_studio_test_ruby() {
	local ruby="${RUBY_STUDIO_TEST_RUBY:-${RUBY_STUDIO_RUBY:-ruby}}"
	ruby_studio_require "$ruby" 'Install Ruby 3.1 or newer, or set RUBY_STUDIO_TEST_RUBY to an executable Ruby/wrapper path.'
	RUBY_STUDIO_TEST_RUBY="$(command -v -- "$ruby")"
	export RUBY_STUDIO_TEST_RUBY RUBY_STUDIO_RUBY="$RUBY_STUDIO_TEST_RUBY"
	"$RUBY_STUDIO_TEST_RUBY" -rjson -ropenssl -rrubygems -e 'abort "Ruby 3.1 or newer is required" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.1")' || ruby_studio_fail 'Ruby must provide JSON, OpenSSL and RubyGems.'
	"$RUBY_STUDIO_TEST_RUBY" -rminitest -rrspec/core -e 'puts "Ruby #{RUBY_VERSION}; Minitest #{Minitest::VERSION}; RSpec #{RSpec::Core::Version::STRING}"' || ruby_studio_fail 'Test gems are missing. Install minitest 5.25.5 and rspec 3.13.2 for the selected Ruby (see BUILDING_RUBY_STUDIO.md). Tests are not silently skipped.'
}

ruby_studio_result() {
	node -e 'const fs = require("node:fs"); const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (result.success !== true || !result.checks?.length || result.checks.some(check => check.status !== "passed")) { throw new Error("Integration result did not report success"); } console.log(`${result.checks.length} checks passed: ${result.suite}`);' "$1"
}
