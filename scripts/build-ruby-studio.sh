#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
RUBY_STUDIO_SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUBY_STUDIO_NODE="$(dirname "$RUBY_STUDIO_SOURCE")/toolchain/node-v24.15.0-linux-x64/bin"
if [[ -x "$RUBY_STUDIO_NODE/node" ]]; then export PATH="$RUBY_STUDIO_NODE:$PATH"; fi
export RUSTUP_HOME="$(dirname "$RUBY_STUDIO_SOURCE")/toolchain/rust"
export CARGO_HOME="$(dirname "$RUBY_STUDIO_SOURCE")/toolchain/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
cd "$RUBY_STUDIO_SOURCE"
cargo build --release --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
mkdir -p extensions/ruby-studio/native/bin/linux-x64
cp extensions/ruby-studio/native/target/release/ruby-studio-lexer extensions/ruby-studio/native/bin/linux-x64/ruby-studio-lexer
npm run compile-check-ts-native
(cd build && npm run typecheck)
npm run gulp compile-extensions
npm run gulp copy-codicons
npm run gulp compile-non-native-extensions-build
npm run gulp compile-extension-media-build
node build/next/index.ts bundle --out out-vscode --nls --target desktop
npm run gulp vscode-linux-x64-ci
