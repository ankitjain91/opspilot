# Lens Killer

A high-performance, beautiful Kubernetes IDE built with Tauri, React, and TypeScript. Designed to be a faster, cleaner alternative to existing tools.

![License](https://img.shields.io/badge/license-BSL%201.1-blue)

## Features

-   🚀 **Blazing Fast**: Built with Rust and Tauri for native performance.
-   ✨ **Modern UI**: Sleek, dark-themed interface with smooth animations.
-   ☸️ **Kubernetes Native**: Full management of Pods, Deployments, Services, and more.
-   📊 **Visual Topology**: Interactive graph view of your cluster resources.
-   🐚 **Integrated Terminal**: Direct shell access to your pods.

## Installation

### Download Binaries
Go to the [Releases](https://github.com/ankitjain91/lens-killer/releases) page to download the latest installer for your OS:
-   **macOS**: Download the `.dmg` file.
-   **Windows**: Download the `.exe` or `.msi` file.

### Build from Source

**Prerequisites:**
-   [Node.js](https://nodejs.org/) (v18+)
-   [Rust](https://www.rust-lang.org/tools/install) (latest stable)
-   [pnpm](https://pnpm.io/) (recommended) or npm/yarn

**Steps:**
1.  Clone the repository:
    ```bash
    git clone https://github.com/ankitjain91/lens-killer.git
    cd lens-killer
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run in development mode:
    ```bash
    npm run tauri dev
    ```

## Building for Production

To build the application for your local OS:

```bash
npm run tauri build
```

The artifacts will be located in `src-tauri/target/release/bundle/`.

## License

This project is licensed under the **Business Source License 1.1 (BSL)**.

-   **Non-Commercial Use**: You are free to copy, modify, and use the code for non-production or personal use.
-   **Commercial Use**: Production use requires a commercial license. Please contact the author for details.
-   **Open Source Conversion**: The code will convert to the **Apache License, Version 2.0** on **2029-12-02**.

See the [LICENSE](LICENSE) file for full details.
