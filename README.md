# Ruby Studio

**Ruby Studio** is an open-source, extensible integrated development environment (IDE) designed for Ruby and Ruby on Rails development.

Built on the open-source foundation of Visual Studio Code (Code - OSS), Ruby Studio aims to provide a powerful development experience with a focus on code navigation, project understanding, debugging, and developer productivity.

## Overview

Ruby Studio combines the flexibility and extensibility of a modern code editor with tools tailored for Ruby development.

The project aims to provide a comprehensive environment for working with Ruby applications, including large Ruby on Rails codebases.

### Key Features

Ruby Studio is being developed with a focus on:

- **Ruby Development** — An IDE experience tailored for Ruby and Ruby on Rails.
- **Code Navigation** — Tools for exploring classes, modules, methods, and project structure.
- **Code Intelligence** — Improved code understanding and navigation across Ruby projects.
- **Integrated Development Tools** — Terminal, debugging, source control, and workspace management.
- **Extensibility** — Support for compatible extensions through the VS Code extension architecture.
- **Cross-Platform Support** — Development targeting Linux, Windows, and macOS.

Some Ruby-specific capabilities are under active development and may not yet be available in released builds.

## Getting Started

### Prerequisites

To build Ruby Studio from source, you will need:

- Git
- Node.js and npm
- Yarn
- Platform-specific build dependencies

Exact dependency versions depend on the underlying Code - OSS version.

### Clone the Repository

```bash
git clone https://github.com/wolwire/ruby-studio.git
cd ruby-studio
```

### Development

Ruby Studio is based on the Code - OSS architecture.

Development and build instructions will be documented as the project evolves.

## Project Structure

Ruby Studio builds upon the modular architecture of Code - OSS.

The repository includes:

- `src/` — Core editor and workbench implementation.
- `extensions/` — Built-in extensions and language support.
- `resources/` — Application resources and branding.
- `build/` — Build and packaging infrastructure.
- `test/` — Automated testing infrastructure.

Additional components may be introduced to support Ruby-specific functionality.

## Contributing

Contributions, bug reports, and feature suggestions are welcome.

If you would like to contribute:

1. Fork the repository.
2. Create a branch for your changes.
3. Implement and test your changes.
4. Submit a pull request describing your contribution.

Please ensure that changes follow the existing code conventions and include appropriate tests where applicable.

## Issues and Feedback

For bug reports, feature requests, and technical discussions, please use the project's GitHub repository.

- [Report a Bug](https://github.com/wolwire/ruby-studio/issues)
- [Request a Feature](https://github.com/wolwire/ruby-studio/issues)
- [View Source Code](https://github.com/wolwire/ruby-studio)

## Development Status

Ruby Studio is under active development.

The project is evolving toward a Ruby-focused IDE with improved navigation, code intelligence, and development workflows.

Features, APIs, and build processes may change as development progresses.

## Acknowledgments

Ruby Studio is built upon [Visual Studio Code - Open Source (Code - OSS)](https://github.com/microsoft/vscode), originally developed by Microsoft and its open-source contributors.

We acknowledge and appreciate the work of the Code - OSS community and the maintainers of the open-source libraries and tools used by this project.

Ruby Studio is an independent project and is not affiliated with, endorsed by, or sponsored by Microsoft.

## License

Ruby Studio is based on Code - OSS, which is licensed under the MIT License.

The original Code - OSS source code includes the following copyright notice:

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License.

See [LICENSE.txt](LICENSE.txt) for the applicable license terms.

Third-party components may be subject to additional licenses and attribution requirements.
