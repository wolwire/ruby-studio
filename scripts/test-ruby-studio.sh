#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
RUBY_STUDIO_SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUBY_STUDIO_PARENT="$(dirname "$RUBY_STUDIO_SOURCE")"
export PATH="$RUBY_STUDIO_PARENT/toolchain/node-v24.15.0-linux-x64/bin:$RUBY_STUDIO_PARENT/toolchain/cargo/bin:$PATH"
export RUSTUP_HOME="$RUBY_STUDIO_PARENT/toolchain/rust"
export CARGO_HOME="$RUBY_STUDIO_PARENT/toolchain/cargo"
export RUBY_STUDIO_TEST_RUBY="${RUBY_STUDIO_TEST_RUBY:-${RUBY_STUDIO_RUBY:-ruby}}"
export RUBY_STUDIO_RUBY="${RUBY_STUDIO_RUBY:-$RUBY_STUDIO_TEST_RUBY}"
cd "$RUBY_STUDIO_SOURCE"
npm run compile-check-ts-native
(cd build && npm run typecheck)
npm run gulp compile-extensions
cargo check --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
cargo test --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
node --test extensions/ruby-studio/test/*.test.js extensions/ruby-studio/native/tests/parity.test.js
RUBY_STUDIO_QA=$(mktemp -d "${TMPDIR:-/tmp}/ruby-studio-check.XXXXXX")
trap 'rm -rf -- "$RUBY_STUDIO_QA"' EXIT
mkdir -p "$RUBY_STUDIO_QA/workspace"
RUBY_STUDIO_APP="$RUBY_STUDIO_PARENT/VSCode-linux-x64"
if [[ -u /usr/share/code/chrome-sandbox ]] && cmp -s "$RUBY_STUDIO_APP/chrome-sandbox" /usr/share/code/chrome-sandbox; then
  export CHROME_DEVEL_SANDBOX=/usr/share/code/chrome-sandbox
fi
export RUBY_STUDIO_INTEGRATION_RESULT="${RUBY_STUDIO_INTEGRATION_RESULT:-$RUBY_STUDIO_PARENT/native-integration-result.json}"
"$RUBY_STUDIO_APP/ruby-studio" --ozone-platform=x11 --disable-gpu --disable-workspace-trust --user-data-dir="$RUBY_STUDIO_QA/profile" --extensions-dir="$RUBY_STUDIO_QA/extensions" --extensionDevelopmentPath="$RUBY_STUDIO_APP/resources/app/extensions/ruby-studio" --extensionTestsPath="$RUBY_STUDIO_SOURCE/extensions/ruby-studio/test/integration.js" "$RUBY_STUDIO_QA/workspace"
