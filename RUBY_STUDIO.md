# Ruby Studio fork

The bundled original Ruby implementation is in `extensions/ruby-studio`. Native workbench contributions are in `src/vs/workbench/contrib/rubyStudio`.

This fork builds native Windows x64, Linux x64, macOS Intel and Apple Silicon desktop apps and preserves the VS Code MIT license and dependency notices. It uses no third-party Ruby IDE engine. The Rust scanner is std-only; the Ruby debugger uses TracePoint/Socket/JSON; project test reporters integrate the installed Minitest or RSpec framework.

Build with `node scripts/ruby-studio.mjs build`; add `--setup --check --package` for dependency installation, validation and a downloadable archive. See [BUILDING_RUBY_STUDIO.md](BUILDING_RUBY_STUDIO.md) for clean-machine prerequisites and the GitHub Actions workflow. Use the Node version in `.nvmrc` and stable Rust. The Linux wrappers can also discover the private toolchain beside this checkout. Existing node_modules dependencies must be installed first using the upstream native build prerequisites. The product package is written beside the checkout to `VSCode-PLATFORM-ARCH`. GitHub Actions builds and tests all four targets and uploads archives, metadata and checksums.

After building, set `RUBY_STUDIO_RUBY` to the selected Ruby executable and run `node scripts/ruby-studio.mjs test`. The script checks compilation before tests, runs worker/model/runtime tests and then launches a disposable real extension-host integration workspace. It preserves the production user profile.

Workspace-level run configurations use `.ruby-studio/run-configurations.json`. Users can select a Ruby SDK in the status bar. Project execution is gated on workspace trust. Built-in support is available without installing an extension pack.

Current boundaries include general dynamic Ruby analysis/refactoring, full formatting, advanced Rails DSL intelligence, remote/container SDKs, non-SQLite databases and multi-thread/process or conditional-breakpoint debugging. The language status command reports analysis boundaries; native tests and research evidence are retained in the companion workspace.

## Configuration windows

The SDK toolbar/status button opens **Ruby SDK and Gems** in a separate native window. Choose or browse an interpreter, validate its actual Ruby version, and inspect its installed gems. Selection remains a draft until Apply or OK; failed validation leaves the window open and the saved SDK unchanged.

**Install Ruby** is available in the Command Palette, SDK/gems toolbar and native SDK settings window. The command loads a stable version catalog automatically; **Refresh Versions** reloads it. Ruby Studio's own installer verifies official download SHA-256 checksums and installs versions under `~/.ruby-studio/sdk/rubies/<version>`. Linux/macOS build official Ruby sources using the system compiler; Windows extracts architecture-matched official portable RubyInstaller packages using the bundled Rust worker; no setup program runs and existing Ruby installations, PATH and file associations are preserved. No version manager is required, and the system Ruby and global/project version-manager selections are preserved.

macOS/Linux require a C compiler, make, tar and development libraries for OpenSSL, libyaml, libffi and zlib. On macOS use Xcode Command Line Tools and Homebrew's OpenSSL/libyaml libraries; the installer detects standard Apple Silicon and Intel Homebrew library paths. Windows native C/C++ gems may require RubyInstaller's Development Kit separately. Validation checks the actual Ruby version and loads OpenSSL, YAML, zlib, Fiddle and RubyGems before a new SDK can be selected.

Installation streams a bounded log and supports **Stop Installation**. Closing the settings window cancels active downloads/builds and their descendants. Failed or cancelled app-owned partial installs are removed. Existing SDKs are validated and reused. Successful installation stages the interpreter path; **Apply** or **OK** activates it at the selected settings scope. Cancelling settings preserves a completed SDK and discards its staged selection.

**Settings** (Ctrl+Alt+S or the toolbar gear) opens the same searchable category window. User, workspace and project scopes are explicit. Ruby indentation is saved under `[ruby]`, so it affects Ruby editors consistently. Apply saves without closing; OK saves and closes; Cancel discards changes made since the last Apply. Escape clears search first. **All Editor Settings** opens the full inherited editor settings in a separate native window.

**Edit Run/Debug Configurations** opens a separate form with add/duplicate/remove, name/type/script/cwd, JSON argument arrays/environment and Bundler controls. Apply validates before saving `.ruby-studio/run-configurations.json` and updates the selected configuration. Invalid JSON and externally changed configuration documents remain unsaved.

These windows use the fork's native auxiliary editor-window mechanism. They reproduce selected configuration behaviors from static RubyMine evidence; they are modeless native windows, rather than RubyMine's IDE-modal JVM dialogs. Complete settings and RubyMine feature parity are not claimed.

## Project opening and creation

The native welcome dialog provides **New Project**, **Open**, and recent-project actions. **New Ruby Project** opens one native form for an empty project, with name, parent location, destination preview, SDK selection, Add SDK, Refresh and Install Ruby. Creation writes only scoped `.vscode/settings.json` metadata, including the selected interpreter and conventional test roots. It does not generate a Gemfile, test framework dependency or application skeleton. Existing nonempty directories offer Open Existing or Create Here; an existing Rails app is opened instead. Starter, gem and Rails generators remain separate templates.

Opening a local folder starts the shared project environment service. It reads project/version markers statically, preserves explicitly configured SDKs, reports mismatches, resolves Bundler and installed gem sources, and supplies those roots to the original analyzer. The gems tree browses dependency source directories in the editor. Version/lockfile/configuration changes outside the editor invalidate the environment; obsolete probes are cancelled and cannot publish a later result. Restricted workspaces retain static editing without executing Ruby or Bundler.

Project and library indexing report separate states and skipped roots. Library scanning defaults to 4,000 files and skips files larger than 512 KiB; use `rubyStudio.maxLibraryFiles` and Refresh Project Environment to control/retry scanning. Full RubyMine inference, exact visual parity, remote SDKs and every version-manager/Bundler configuration remain outside this milestone. Native project-window and extension-host tests are in `extensions/ruby-studio/test/project-window.cjs` and `project-integration.js`.
