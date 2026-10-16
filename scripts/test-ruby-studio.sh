#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/ruby-studio-build.sh"

unit_only=0; integration_only=0
for argument in "$@"; do
	case "$argument" in
		--unit-only) unit_only=1 ;;
		--integration-only) integration_only=1 ;;
		--help|-h)
			printf 'Usage: ./scripts/test-ruby-studio.sh [--unit-only | --integration-only]\nAlways type-checks core/build/extensions first. Full mode runs native/unit tests and the built desktop extension-host integration. Uses xvfb-run when DISPLAY is unset.\nSee BUILDING_RUBY_STUDIO.md for prerequisites and logs.\n'
			exit 0 ;;
		*) ruby_studio_fail "Unknown option: $argument. Use --help." ;;
	esac
done
[[ "$unit_only$integration_only" != 11 ]] || ruby_studio_fail '--unit-only and --integration-only are mutually exclusive.'
ruby_studio_environment
cd "$RUBY_STUDIO_SOURCE"
ruby_studio_logs
ruby_studio_dependencies
ruby_studio_test_ruby
ruby_studio_compile
ruby_studio_native
if [[ "$integration_only" == 0 ]]; then
	ruby_studio_run check-native cargo check --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
	ruby_studio_run test-native cargo test --locked --manifest-path extensions/ruby-studio/native/Cargo.toml
	ruby_studio_run test-unit node --test --test-reporter=tap extensions/ruby-studio/test/*.test.js extensions/ruby-studio/native/tests/parity.test.js scripts/lib/ruby-studio-*.test.mjs
fi
if [[ "$unit_only" == 1 ]]; then printf '\nRuby Studio unit/native validation passed. Logs: %s\n' "$RUBY_STUDIO_LOG_DIR"; exit 0; fi
ruby_studio_run verify-integration-app node scripts/lib/ruby-studio-artifact.mjs verify "$RUBY_STUDIO_APP_DIR"
RUBY_STUDIO_QA="$(mktemp -d "${TMPDIR:-/tmp}/ruby-studio-check.XXXXXX")"
cleanup() {
	local status=$?
	if [[ -d "$RUBY_STUDIO_QA/profile/logs" ]]; then cp -a "$RUBY_STUDIO_QA/profile/logs" "$RUBY_STUDIO_LOG_DIR/electron-logs"; fi
	rm -rf -- "$RUBY_STUDIO_QA"
	exit "$status"
}
trap cleanup EXIT
mkdir -p "$RUBY_STUDIO_QA/workspace"
export RUBY_STUDIO_INTEGRATION_RESULT="${RUBY_STUDIO_INTEGRATION_RESULT:-$RUBY_STUDIO_LOG_DIR/native-integration-result.json}"
# A matching installed sandbox helper can support local Chromium builds without root.
if [[ -u /usr/share/code/chrome-sandbox ]] && cmp -s "$RUBY_STUDIO_APP_DIR/chrome-sandbox" /usr/share/code/chrome-sandbox; then
	export CHROME_DEVEL_SANDBOX=/usr/share/code/chrome-sandbox
fi
application="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1])).applicationName" "$RUBY_STUDIO_APP_DIR/resources/app/product.json")"
launcher=()
if [[ -z "${DISPLAY:-}" ]]; then ruby_studio_require xvfb-run 'Install xvfb and xauth, or run from an X11 desktop.'; launcher=(xvfb-run -a -s '-screen 0 1280x1024x24'); fi
sandbox=()
if [[ "${RUBY_STUDIO_TEST_NO_SANDBOX:-0}" == 1 ]]; then sandbox=(--no-sandbox); fi
ruby_studio_run test-integration "${launcher[@]}" "$RUBY_STUDIO_APP_DIR/$application" "${sandbox[@]}" --ozone-platform=x11 --disable-gpu --disable-workspace-trust --user-data-dir="$RUBY_STUDIO_QA/profile" --extensions-dir="$RUBY_STUDIO_QA/extensions" --extensionDevelopmentPath="$RUBY_STUDIO_APP_DIR/resources/app/extensions/ruby-studio" --extensionTestsPath="$RUBY_STUDIO_SOURCE/extensions/ruby-studio/test/integration.js" "$RUBY_STUDIO_QA/workspace"
ruby_studio_result "$RUBY_STUDIO_INTEGRATION_RESULT"
export RUBY_STUDIO_APP="$RUBY_STUDIO_APP_DIR/$application"
export RUBY_STUDIO_SETTINGS_RESULT="$RUBY_STUDIO_LOG_DIR/settings-window.json"
export RUBY_STUDIO_SETTINGS_LOG="$RUBY_STUDIO_LOG_DIR/settings-window-electron.log"
ruby_studio_run test-settings-window "${launcher[@]}" node extensions/ruby-studio/test/settings-window.cjs
ruby_studio_result "$RUBY_STUDIO_SETTINGS_RESULT"
printf '\nRuby Studio validation passed. Logs: %s\n' "$RUBY_STUDIO_LOG_DIR"
