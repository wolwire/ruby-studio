<!-- Copyright (c) Microsoft Corporation. All rights reserved.
     Licensed under the MIT License. See License.txt in the project root. -->

# Build Ruby Studio on Windows, Linux and macOS

Run commands from this checkout. The scripts also work when invoked by an absolute path from another directory. They build the desktop app and the original Rust lexer worker; they do not install the app system-wide.

## Cross-platform entry point

Build each package on a matching native host. The supported targets are Linux x64, Windows x64, macOS Intel x64 and macOS Apple Silicon arm64. Windows ARM and Linux ARM are not enabled in this pipeline.

From a checkout with Node, npm and Rust on PATH:

```sh
node scripts/ruby-studio.mjs setup
node scripts/ruby-studio.mjs build
node scripts/ruby-studio.mjs test
node scripts/ruby-studio.mjs package
# Or, after satisfying prerequisites:
node scripts/ruby-studio.mjs build --setup --check --package
```

On Linux, add `--ci-toolchain` to setup (or to build with `--setup`) to download the upstream compiler/sysroots. The portable entry point delegates Linux to the existing Bash scripts. Windows/macOS use native commands without requiring Bash locally. Builds use the checkout's `.nvmrc`; Node and the host architecture must match the target.

On Windows, install Visual Studio 2022 with Desktop development with C++, the v143 toolset, x64/x86 Spectre-mitigated libraries, C++ ATL/MFC Spectre libraries, a Windows SDK, Python and Git. Add the SDK's x64 `signtool.exe` directory and 7-Zip's `7z.exe` to PATH. `vs2022_install` can select a custom Visual Studio installation. The setup command patches Electron/V8 headers before root dependencies are installed, as the upstream Windows workflow requires. Use RubyInstaller Ruby 3.3 with its Devkit and the test gems below. GitHub's Windows runner supplies these native prerequisites.

On macOS, install Xcode command-line tools (`xcode-select --install`), Python with setuptools, Git, Rust, Node and Ruby. Activate the Intel or Apple Silicon versions matching your machine. The script supplies the upstream `kerberos_use_rtld=false` build definition. macOS archives use `ditto` to preserve `.app` framework links and executable modes.

Outputs are `../VSCode-linux-x64/ruby-studio`, `../VSCode-win32-x64/Ruby Studio.exe`, and `../VSCode-darwin-{x64,arm64}/Ruby Studio.app`. Archives in `dist/ruby-studio` are Linux `.tar.gz`, Windows portable `.zip`, and separate Intel/Apple Silicon macOS `.zip` bundles. Each includes build metadata and SHA-256 checksums. These are development distributions: the pipeline does not provide Windows Authenticode signing, Apple Developer signing/notarization, DMG or EXE installers. OS download security prompts can apply. Ruby itself and project gems are selected/installed separately; they are not bundled with the IDE.

## Linux first build

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
- `RUBY_STUDIO_APP_DIR`: existing app directory for testing/packaging. Full builds always write the upstream `../VSCode-PLATFORM-ARCH` target (on macOS pass its containing directory, or a `.app` path only for testing/packaging).
- `RUBY_STUDIO_ARTIFACT_DIR`: archive destination; defaults to `dist/ruby-studio`.
- `CARGO_TARGET_DIR`: supported custom native build output directory.

If Ruby is supplied by a version manager, activate that environment before running the scripts. A wrapper can supply any required gem or shared-library environment.

## GitHub Actions

`.github/workflows/ruby-studio-build.yml` (**Ruby Studio Desktop**) runs on pushes, pull requests and manual dispatch with four independent native runner jobs: Ubuntu 24.04 x64, Windows Server 2022 x64, macOS 15 Intel and macOS 15 Apple Silicon. A failed job does not cancel the other platforms. It installs the Node version from `.nvmrc`, Ruby test dependencies and the upstream native compiler; compiles before running unit, Rust, lexer-parity and Xvfb desktop tests; then archives only the successfully tested app for each platform. All platforms run the extension-host integration and dedicated native settings-window tests; the existing Linux `/proc` process-group assertion is explicitly Linux-only. The distribution and logs are separate, platform-named downloadable artifacts, retained for 14 days. Artifact names include the full checkout SHA and archive names include its abbreviated build receipt SHA. Logs upload even when a build or test fails, with separate names for each run attempt. Rerunning a job replaces only that platform's successfully tested distribution. Windows setup retries the observed npm subprocess native error `0xC0000409` up to three times while preserving failed-attempt logs; other dependency/compiler errors stop immediately. Existing upstream workflows are preserved. Checkout leaves the inherited Copilot simulation SQLite caches as LFS pointers; those caches are not part of this desktop build or its test suite.

The workflow uses read-only repository permissions and commit-pinned actions. Action versions were checked against their primary release documentation on 2026-10-14: [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0), [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2), and [setup-ruby 1.327.0](https://github.com/ruby/setup-ruby/releases/tag/v1.327.0). The [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [artifact action documentation](https://github.com/actions/upload-artifact) describe the triggers and upload behavior used here.

After the workflow is committed and pushed to the fork, open its **Actions → Ruby Studio Desktop** page to view results or use **Run workflow**. The scripts themselves do not push commits, publish releases or upload artifacts outside a workflow run.

## Publish a GitHub Release manually

The **Ruby Studio Publish** workflow promotes the exact packages from a completed **Ruby Studio Desktop** build. It does not rebuild them. The selected run must succeed for all four platforms, come from this repository through a push or manual build, and still have its distribution artifacts available. If the 14-day artifacts have expired, run a new desktop build first.

After this workflow is merged into the default branch:

1. Open **Actions → Ruby Studio Publish → Run workflow**.
2. Enter the successful desktop **build run ID** (the number at the end of its Actions run URL) and a new **tag**, such as `v0.1.0`.
3. Choose **draft**, **prerelease**, **release** or **verify-only**, then run it. Draft is the default. Verify-only downloads and checks everything without creating a tag or release. Release publishes a stable release and marks it latest; prerelease publishes without marking it latest.

The GitHub CLI equivalent is:

```bash
gh workflow run ruby-studio-publish.yml --ref ruby-studio \
  -f build_run_id=YOUR_SUCCESSFUL_RUN_ID -f tag=v0.1.0 -f mode=draft
```

Publication uses the built-in `GITHUB_TOKEN` with Actions read and repository contents write permissions. No personal access token is needed. Inputs are passed as environment variables and quoted arguments. The publisher checks the source SHA, clean build receipts, app version agreement, all four platform artifacts, filenames and SHA-256 hashes before creating a release. It refuses existing tags/releases and never replaces assets or moves tags. PR/fork build artifacts are not eligible.

Each release contains four platform archives, four `.build-info.json` files, a combined `SHA256SUMS`, and `release-manifest.json` recording the source commit and build evidence URL. A release tag labels this tested build; it does not rewrite the app's embedded upstream version. The publisher stages the upload in a draft, verifies uploaded asset sizes and available GitHub digests, and publishes as its final operation. If upload verification fails, inspect the remaining draft before retrying. Code signing and notarization are not added by publication.

For a local read-only verification using an authenticated `gh` installation:

```bash
node scripts/publish-ruby-studio.mjs --repo wolwire/ruby-studio \
  --run-id YOUR_SUCCESSFUL_RUN_ID --tag v0.1.0 --mode verify-only
```
