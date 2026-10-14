<!-- Copyright (c) Microsoft Corporation. All rights reserved.
     Licensed under the MIT License. See License.txt in the project root. -->

# Build Ruby Studio on Linux x64

Run commands from this checkout. The scripts also work when invoked by an absolute path from another directory. They build the desktop app and the original Rust lexer worker; they do not install the app system-wide.

## First build

Install Node.js using the version in `.nvmrc` (currently 24.15.0), npm below version 12, stable Rust with Cargo, and Ruby 3.1 or newer. Ruby must provide JSON, RubyGems and OpenSSL. Node must stay in the major version specified by `.nvmrc`; the scripts check this before starting.

On Ubuntu 24.04, install the system prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config python3 python-is-python3 curl git \
  libx11-dev libx11-xcb-dev libxkbfile-dev libkrb5-dev libsecret-1-dev \
  libgtk-3-0 libgbm1 libnss3 libasound2t64 libxss1 xvfb xauth
```

Install the test gems using the Ruby that will run the checks:

```bash
ruby -S gem install minitest -v 5.25.5 --no-document
ruby -S gem install rspec -v 3.13.2 --no-document
```

Then build, check and archive with one command:

```bash
./scripts/build-ruby-studio.sh --setup --ci-toolchain --check --package
```

`--setup` runs `npm ci` against the checked-in lockfiles, including nested dependency installs. `--ci-toolchain` downloads the upstream VS Code Linux compiler, sysroots and Electron C++ libraries used to compile native npm dependencies. Downloads require network access. If this checkout already has working dependencies, omit both setup flags. The scripts discover a compatible sibling `../toolchain` installation when present, and otherwise use tools on `PATH`. They never change `CARGO_HOME` or `RUSTUP_HOME`.

Allow several gigabytes for dependencies, downloaded compilers, Electron and the app, plus sufficient RAM for the full VS Code bundle. Compilation uses the upstream build tasks and can take considerably longer on a fresh machine.

## Everyday commands

```bash
# Incremental desktop build using installed dependencies:
./scripts/build-ruby-studio.sh

# Core/build/extension type-checks, Rust tests and Ruby Studio unit/lexer tests:
./scripts/test-ruby-studio.sh --unit-only

# The same checks plus the real built desktop extension-host integration:
./scripts/test-ruby-studio.sh

# Run just desktop integration after mandatory type-checks/native compilation:
./scripts/test-ruby-studio.sh --integration-only

# Archive an existing app without rebuilding or claiming to test it:
./scripts/build-ruby-studio.sh --package-only

# Install locked dependencies separately:
./scripts/setup-ruby-studio.sh --ci-toolchain
```

Type-checking always precedes tests. The scripts run `compile-check-ts-native`, the build directory's `typecheck`, and `gulp compile-extensions`; they do not run `npm run compile`. Native validation includes Cargo tests, a release worker build, and parity tests against the original TypeScript lexer. Missing Ruby test gems cause a prerequisite error instead of silently skipped framework checks.

The app is written to `../VSCode-linux-x64` by the upstream package task. Launch `../VSCode-linux-x64/ruby-studio`. The package step verifies the extension entry point and executable native worker, then produces:

- `dist/ruby-studio/ruby-studio-linux-x64-VERSION-COMMIT.tar.gz`
- matching `.build-info.json` with build provenance and lockfile/worker hashes
- `dist/ruby-studio/SHA256SUMS`

Verify and extract the archive:

```bash
cd dist/ruby-studio
sha256sum --check SHA256SUMS
tar -xzf ruby-studio-linux-x64-*.tar.gz
./RubyStudio-linux-x64/ruby-studio
```

The archive contains the complete Linux desktop app and native lexer. It requires the usual Linux desktop runtime libraries; it is not a cross-platform installer. A build receipt records the checkout commit and whether local changes were present. Packaging an older app without a receipt uses `unverified` in the archive name and does not invent a build commit. Archive headers are normalized, but byte-for-byte reproducibility of the upstream bundle is not claimed.

## Logs, display and overrides

Every run prints its log directory under `.build/ruby-studio/logs/`. Compiler, bundle, test and packaging output remains there on failure. Desktop tests use a fresh temporary profile and workspace, copy Electron logs before cleanup, and save `native-integration-result.json`. A separate native UI check opens the dedicated settings window and saves `settings-window.json`. Both checks use the current `DISPLAY` or start `xvfb-run` automatically.

On Ubuntu 24.04, Chromium's namespace sandbox can be restricted by AppArmor. GitHub's disposable runner enables user namespaces with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, matching the upstream Linux test workflow. For a container that cannot support the sandbox, set `RUBY_STUDIO_TEST_NO_SANDBOX=1` only for the disposable test launch. Normal app launches keep the sandbox enabled.

Useful environment variables:

- `RUBY_STUDIO_TEST_RUBY`: absolute Ruby executable or wrapper path; paths containing spaces are supported. The same interpreter is used by runtime and debugger tests.
- `RUBY_STUDIO_NODE_BIN`: explicit Node/npm `bin` directory.
- `RUBY_STUDIO_TOOLCHAIN_DIR`: optional private toolchain root; defaults to `../toolchain`.
- `RUBY_STUDIO_USE_LOCAL_TOOLCHAIN=0`: use only tools from `PATH`, as CI does.
- `RUBY_STUDIO_LOG_DIR`: persistent log directory for a coordinated run.
- `RUBY_STUDIO_APP_DIR`: existing app directory for testing/packaging. Full builds always write the upstream `../VSCode-linux-x64` target.
- `RUBY_STUDIO_ARTIFACT_DIR`: archive destination; defaults to `dist/ruby-studio`.
- `CARGO_TARGET_DIR`: supported custom native build output directory.

If Ruby is supplied by a version manager, activate that environment before running the scripts. A wrapper can supply any required gem or shared-library environment.

## GitHub Actions

`.github/workflows/ruby-studio-linux.yml` runs on pushes, pull requests and manual dispatch. It installs the Node version from `.nvmrc`, Ruby test dependencies and the upstream native compiler; compiles before running unit, Rust, lexer-parity and Xvfb desktop tests; then archives only the successfully tested app. The distribution and logs are separate downloadable artifacts, retained for 14 days. Logs upload even when a build or test fails. Existing upstream workflows are preserved.

The workflow uses read-only repository permissions and commit-pinned actions. Action versions were checked against their primary release documentation on 2026-10-14: [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0), [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2), and [setup-ruby 1.327.0](https://github.com/ruby/setup-ruby/releases/tag/v1.327.0). The [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [artifact action documentation](https://github.com/actions/upload-artifact) describe the triggers and upload behavior used here.

After the workflow is committed and pushed to the fork, open its **Actions → Ruby Studio Linux x64** page to view results or use **Run workflow**. The scripts themselves do not push commits, publish releases or upload artifacts outside a workflow run.
