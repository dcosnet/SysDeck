# Software Bill of Materials (SBOM)

## Document Metadata

- Project name: Frosty Deno
- Project version: 0.9.0
- Description: Deno 2 + TypeScript LLM gateway with a same-origin React control
  plane and PostgreSQL-backed durable state.
- SBOM timestamp: 2026-07-30T07:45:15.267Z
- Author/tool: GitHub Copilot (GPT-5.4) using the checked-in manifests and
  lockfile only.
- Format: CycloneDX JSON 1.5 plus this human-readable summary.
- Lifecycle phase: source / pre-build

## Component Inventory

### Application

| Component   | Version | Type        | Ecosystem   | PURL                          | License    | Direct/Transitive | Scope    |
| ----------- | ------- | ----------- | ----------- | ----------------------------- | ---------- | ----------------- | -------- |
| frosty-deno | 0.9.0   | application | Application | pkg:generic/frosty-deno@0.9.0 | Apache-2.0 | Direct            | required |

### JSR

| Component        | Version | Type    | Ecosystem | PURL                             | License     | Direct/Transitive | Scope    |
| ---------------- | ------- | ------- | --------- | -------------------------------- | ----------- | ----------------- | -------- |
| @std/assert      | 1.0.19  | library | JSR       | pkg:jsr/%40std/assert@1.0.19     | NOASSERTION | Direct            | dev      |
| @std/http        | 1.1.2   | library | JSR       | pkg:jsr/%40std/http@1.1.2        | NOASSERTION | Direct            | required |
| @std/path        | 1.1.6   | library | JSR       | pkg:jsr/%40std/path@1.1.6        | NOASSERTION | Direct            | required |
| @std/cli         | 1.0.32  | library | JSR       | pkg:jsr/%40std/cli@1.0.32        | NOASSERTION | Transitive        | required |
| @std/encoding    | 1.0.11  | library | JSR       | pkg:jsr/%40std/encoding@1.0.11   | NOASSERTION | Transitive        | required |
| @std/fmt         | 1.0.10  | library | JSR       | pkg:jsr/%40std/fmt@1.0.10        | NOASSERTION | Transitive        | required |
| @std/fs          | 1.0.24  | library | JSR       | pkg:jsr/%40std/fs@1.0.24         | NOASSERTION | Transitive        | required |
| @std/html        | 1.0.7   | library | JSR       | pkg:jsr/%40std/html@1.0.7        | NOASSERTION | Transitive        | required |
| @std/internal    | 1.0.14  | library | JSR       | pkg:jsr/%40std/internal@1.0.14   | NOASSERTION | Transitive        | required |
| @std/media-types | 1.1.0   | library | JSR       | pkg:jsr/%40std/media-types@1.1.0 | NOASSERTION | Transitive        | required |
| @std/net         | 1.0.6   | library | JSR       | pkg:jsr/%40std/net@1.0.6         | NOASSERTION | Transitive        | required |
| @std/streams     | 1.1.1   | library | JSR       | pkg:jsr/%40std/streams@1.1.1     | NOASSERTION | Transitive        | required |

### npm

| Component                                | Version | Type    | Ecosystem | PURL                                                     | License     | Direct/Transitive | Scope    |
| ---------------------------------------- | ------- | ------- | --------- | -------------------------------------------------------- | ----------- | ----------------- | -------- |
| @playwright/test                         | ^1.45.0 | library | npm       | pkg:npm/%40playwright/test@%5E1.45.0                     | NOASSERTION | Direct            | dev      |
| @tailwindcss/vite                        | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/vite@4.3.3                        | NOASSERTION | Direct            | dev      |
| @testing-library/jest-dom                | 7.0.0   | library | npm       | pkg:npm/%40testing-library/jest-dom@7.0.0                | NOASSERTION | Direct            | dev      |
| @testing-library/react                   | 16.3.2  | library | npm       | pkg:npm/%40testing-library/react@16.3.2                  | NOASSERTION | Direct            | dev      |
| @testing-library/user-event              | 14.6.1  | library | npm       | pkg:npm/%40testing-library/user-event@14.6.1             | NOASSERTION | Direct            | dev      |
| @types/react                             | 19.2.17 | library | npm       | pkg:npm/%40types/react@19.2.17                           | NOASSERTION | Direct            | dev      |
| @types/react-dom                         | 19.2.3  | library | npm       | pkg:npm/%40types/react-dom@19.2.3                        | NOASSERTION | Direct            | dev      |
| @vitejs/plugin-react                     | 6.0.4   | library | npm       | pkg:npm/%40vitejs/plugin-react@6.0.4                     | NOASSERTION | Direct            | dev      |
| clsx                                     | 2.1.1   | library | npm       | pkg:npm/clsx@2.1.1                                       | NOASSERTION | Direct            | required |
| jsdom                                    | 29.1.1  | library | npm       | pkg:npm/jsdom@29.1.1                                     | NOASSERTION | Direct            | dev      |
| lucide-react                             | 1.25.0  | library | npm       | pkg:npm/lucide-react@1.25.0                              | NOASSERTION | Direct            | required |
| postgres                                 | 3.4.9   | library | npm       | pkg:npm/postgres@3.4.9                                   | NOASSERTION | Direct            | required |
| react                                    | 19.2.8  | library | npm       | pkg:npm/react@19.2.8                                     | NOASSERTION | Direct            | required |
| react-dom                                | 19.2.8  | library | npm       | pkg:npm/react-dom@19.2.8                                 | NOASSERTION | Direct            | required |
| tailwind-merge                           | 3.6.0   | library | npm       | pkg:npm/tailwind-merge@3.6.0                             | NOASSERTION | Direct            | required |
| tailwindcss                              | 4.3.3   | library | npm       | pkg:npm/tailwindcss@4.3.3                                | NOASSERTION | Direct            | dev      |
| typescript                               | 7.0.2   | library | npm       | pkg:npm/typescript@7.0.2                                 | NOASSERTION | Direct            | dev      |
| vite                                     | 8.1.5   | library | npm       | pkg:npm/vite@8.1.5                                       | NOASSERTION | Direct            | dev      |
| vitest                                   | 4.1.10  | library | npm       | pkg:npm/vitest@4.1.10                                    | NOASSERTION | Direct            | dev      |
| zod                                      | 4.4.3   | library | npm       | pkg:npm/zod@4.4.3                                        | NOASSERTION | Direct            | required |
| @adobe/css-tools                         | 4.5.0   | library | npm       | pkg:npm/%40adobe/css-tools@4.5.0                         | NOASSERTION | Transitive        | dev      |
| @asamuzakjp/css-color                    | 5.1.11  | library | npm       | pkg:npm/%40asamuzakjp/css-color@5.1.11                   | NOASSERTION | Transitive        | dev      |
| @asamuzakjp/dom-selector                 | 7.1.1   | library | npm       | pkg:npm/%40asamuzakjp/dom-selector@7.1.1                 | NOASSERTION | Transitive        | dev      |
| @asamuzakjp/generational-cache           | 1.0.1   | library | npm       | pkg:npm/%40asamuzakjp/generational-cache@1.0.1           | NOASSERTION | Transitive        | dev      |
| @asamuzakjp/nwsapi                       | 2.3.9   | library | npm       | pkg:npm/%40asamuzakjp/nwsapi@2.3.9                       | NOASSERTION | Transitive        | dev      |
| @babel/code-frame                        | 7.29.7  | library | npm       | pkg:npm/%40babel/code-frame@7.29.7                       | NOASSERTION | Transitive        | dev      |
| @babel/helper-validator-identifier       | 7.29.7  | library | npm       | pkg:npm/%40babel/helper-validator-identifier@7.29.7      | NOASSERTION | Transitive        | dev      |
| @babel/runtime                           | 7.29.7  | library | npm       | pkg:npm/%40babel/runtime@7.29.7                          | NOASSERTION | Transitive        | dev      |
| @bramus/specificity                      | 2.4.2   | library | npm       | pkg:npm/%40bramus/specificity@2.4.2                      | NOASSERTION | Transitive        | dev      |
| @csstools/color-helpers                  | 6.1.0   | library | npm       | pkg:npm/%40csstools/color-helpers@6.1.0                  | NOASSERTION | Transitive        | dev      |
| @csstools/css-calc                       | 3.3.0   | library | npm       | pkg:npm/%40csstools/css-calc@3.3.0                       | NOASSERTION | Transitive        | dev      |
| @csstools/css-color-parser               | 4.1.10  | library | npm       | pkg:npm/%40csstools/css-color-parser@4.1.10              | NOASSERTION | Transitive        | dev      |
| @csstools/css-parser-algorithms          | 4.0.0   | library | npm       | pkg:npm/%40csstools/css-parser-algorithms@4.0.0          | NOASSERTION | Transitive        | dev      |
| @csstools/css-syntax-patches-for-csstree | 1.1.7   | library | npm       | pkg:npm/%40csstools/css-syntax-patches-for-csstree@1.1.7 | NOASSERTION | Transitive        | dev      |
| @csstools/css-tokenizer                  | 4.0.0   | library | npm       | pkg:npm/%40csstools/css-tokenizer@4.0.0                  | NOASSERTION | Transitive        | dev      |
| @emnapi/core                             | 1.11.1  | library | npm       | pkg:npm/%40emnapi/core@1.11.1                            | NOASSERTION | Transitive        | dev      |
| @emnapi/runtime                          | 1.11.1  | library | npm       | pkg:npm/%40emnapi/runtime@1.11.1                         | NOASSERTION | Transitive        | dev      |
| @emnapi/wasi-threads                     | 1.2.2   | library | npm       | pkg:npm/%40emnapi/wasi-threads@1.2.2                     | NOASSERTION | Transitive        | dev      |
| @exodus/bytes                            | 1.15.1  | library | npm       | pkg:npm/%40exodus/bytes@1.15.1                           | NOASSERTION | Transitive        | dev      |
| @jridgewell/gen-mapping                  | 0.3.13  | library | npm       | pkg:npm/%40jridgewell/gen-mapping@0.3.13                 | NOASSERTION | Transitive        | dev      |
| @jridgewell/remapping                    | 2.3.5   | library | npm       | pkg:npm/%40jridgewell/remapping@2.3.5                    | NOASSERTION | Transitive        | dev      |
| @jridgewell/resolve-uri                  | 3.1.2   | library | npm       | pkg:npm/%40jridgewell/resolve-uri@3.1.2                  | NOASSERTION | Transitive        | dev      |
| @jridgewell/sourcemap-codec              | 1.5.5   | library | npm       | pkg:npm/%40jridgewell/sourcemap-codec@1.5.5              | NOASSERTION | Transitive        | dev      |
| @jridgewell/trace-mapping                | 0.3.31  | library | npm       | pkg:npm/%40jridgewell/trace-mapping@0.3.31               | NOASSERTION | Transitive        | dev      |
| @napi-rs/wasm-runtime                    | 1.1.6   | library | npm       | pkg:npm/%40napi-rs/wasm-runtime@1.1.6                    | NOASSERTION | Transitive        | dev      |
| @oxc-project/types                       | 0.139.0 | library | npm       | pkg:npm/%40oxc-project/types@0.139.0                     | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-android-arm64          | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-android-arm64@1.1.5          | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-darwin-arm64           | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-darwin-arm64@1.1.5           | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-darwin-x64             | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-darwin-x64@1.1.5             | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-freebsd-x64            | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-freebsd-x64@1.1.5            | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-arm-gnueabihf    | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-arm-gnueabihf@1.1.5    | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-arm64-gnu        | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-arm64-gnu@1.1.5        | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-arm64-musl       | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-arm64-musl@1.1.5       | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-ppc64-gnu        | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-ppc64-gnu@1.1.5        | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-s390x-gnu        | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-s390x-gnu@1.1.5        | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-x64-gnu          | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-x64-gnu@1.1.5          | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-linux-x64-musl         | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-linux-x64-musl@1.1.5         | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-openharmony-arm64      | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-openharmony-arm64@1.1.5      | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-wasm32-wasi            | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-wasm32-wasi@1.1.5            | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-win32-arm64-msvc       | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-win32-arm64-msvc@1.1.5       | NOASSERTION | Transitive        | dev      |
| @rolldown/binding-win32-x64-msvc         | 1.1.5   | library | npm       | pkg:npm/%40rolldown/binding-win32-x64-msvc@1.1.5         | NOASSERTION | Transitive        | dev      |
| @rolldown/pluginutils                    | 1.0.1   | library | npm       | pkg:npm/%40rolldown/pluginutils@1.0.1                    | NOASSERTION | Transitive        | dev      |
| @standard-schema/spec                    | 1.1.0   | library | npm       | pkg:npm/%40standard-schema/spec@1.1.0                    | NOASSERTION | Transitive        | dev      |
| @tailwindcss/node                        | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/node@4.3.3                        | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide                       | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide@4.3.3                       | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-android-arm64         | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-android-arm64@4.3.3         | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-darwin-arm64          | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-darwin-arm64@4.3.3          | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-darwin-x64            | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-darwin-x64@4.3.3            | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-freebsd-x64           | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-freebsd-x64@4.3.3           | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-linux-arm-gnueabihf   | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-linux-arm-gnueabihf@4.3.3   | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-linux-arm64-gnu       | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-linux-arm64-gnu@4.3.3       | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-linux-arm64-musl      | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-linux-arm64-musl@4.3.3      | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-linux-x64-gnu         | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-linux-x64-gnu@4.3.3         | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-linux-x64-musl        | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-linux-x64-musl@4.3.3        | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-wasm32-wasi           | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-wasm32-wasi@4.3.3           | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-win32-arm64-msvc      | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-win32-arm64-msvc@4.3.3      | NOASSERTION | Transitive        | dev      |
| @tailwindcss/oxide-win32-x64-msvc        | 4.3.3   | library | npm       | pkg:npm/%40tailwindcss/oxide-win32-x64-msvc@4.3.3        | NOASSERTION | Transitive        | dev      |
| @testing-library/dom                     | 10.4.1  | library | npm       | pkg:npm/%40testing-library/dom@10.4.1                    | NOASSERTION | Transitive        | dev      |
| @tybys/wasm-util                         | 0.10.3  | library | npm       | pkg:npm/%40tybys/wasm-util@0.10.3                        | NOASSERTION | Transitive        | dev      |
| @types/aria-query                        | 5.0.4   | library | npm       | pkg:npm/%40types/aria-query@5.0.4                        | NOASSERTION | Transitive        | dev      |
| @types/chai                              | 5.2.3   | library | npm       | pkg:npm/%40types/chai@5.2.3                              | NOASSERTION | Transitive        | dev      |
| @types/deep-eql                          | 4.0.2   | library | npm       | pkg:npm/%40types/deep-eql@4.0.2                          | NOASSERTION | Transitive        | dev      |
| @types/estree                            | 1.0.9   | library | npm       | pkg:npm/%40types/estree@1.0.9                            | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-aix-ppc64         | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-aix-ppc64@7.0.2         | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-darwin-arm64      | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-darwin-arm64@7.0.2      | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-darwin-x64        | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-darwin-x64@7.0.2        | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-freebsd-arm64     | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-freebsd-arm64@7.0.2     | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-freebsd-x64       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-freebsd-x64@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-arm         | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-arm@7.0.2         | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-arm64       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-arm64@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-loong64     | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-loong64@7.0.2     | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-mips64el    | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-mips64el@7.0.2    | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-ppc64       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-ppc64@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-riscv64     | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-riscv64@7.0.2     | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-s390x       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-s390x@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-linux-x64         | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-linux-x64@7.0.2         | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-netbsd-arm64      | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-netbsd-arm64@7.0.2      | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-netbsd-x64        | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-netbsd-x64@7.0.2        | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-openbsd-arm64     | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-openbsd-arm64@7.0.2     | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-openbsd-x64       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-openbsd-x64@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-sunos-x64         | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-sunos-x64@7.0.2         | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-win32-arm64       | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-win32-arm64@7.0.2       | NOASSERTION | Transitive        | dev      |
| @typescript/typescript-win32-x64         | 7.0.2   | library | npm       | pkg:npm/%40typescript/typescript-win32-x64@7.0.2         | NOASSERTION | Transitive        | dev      |
| @vitest/expect                           | 4.1.10  | library | npm       | pkg:npm/%40vitest/expect@4.1.10                          | NOASSERTION | Transitive        | dev      |
| @vitest/mocker                           | 4.1.10  | library | npm       | pkg:npm/%40vitest/mocker@4.1.10                          | NOASSERTION | Transitive        | dev      |
| @vitest/pretty-format                    | 4.1.10  | library | npm       | pkg:npm/%40vitest/pretty-format@4.1.10                   | NOASSERTION | Transitive        | dev      |
| @vitest/runner                           | 4.1.10  | library | npm       | pkg:npm/%40vitest/runner@4.1.10                          | NOASSERTION | Transitive        | dev      |
| @vitest/snapshot                         | 4.1.10  | library | npm       | pkg:npm/%40vitest/snapshot@4.1.10                        | NOASSERTION | Transitive        | dev      |
| @vitest/spy                              | 4.1.10  | library | npm       | pkg:npm/%40vitest/spy@4.1.10                             | NOASSERTION | Transitive        | dev      |
| @vitest/utils                            | 4.1.10  | library | npm       | pkg:npm/%40vitest/utils@4.1.10                           | NOASSERTION | Transitive        | dev      |
| ansi-regex                               | 5.0.1   | library | npm       | pkg:npm/ansi-regex@5.0.1                                 | NOASSERTION | Transitive        | dev      |
| ansi-styles                              | 5.2.0   | library | npm       | pkg:npm/ansi-styles@5.2.0                                | NOASSERTION | Transitive        | dev      |
| aria-query                               | 5.3.0   | library | npm       | pkg:npm/aria-query@5.3.0                                 | NOASSERTION | Transitive        | dev      |
| assertion-error                          | 2.0.1   | library | npm       | pkg:npm/assertion-error@2.0.1                            | NOASSERTION | Transitive        | dev      |
| bidi-js                                  | 1.0.3   | library | npm       | pkg:npm/bidi-js@1.0.3                                    | NOASSERTION | Transitive        | dev      |
| chai                                     | 6.2.2   | library | npm       | pkg:npm/chai@6.2.2                                       | NOASSERTION | Transitive        | dev      |
| convert-source-map                       | 2.0.0   | library | npm       | pkg:npm/convert-source-map@2.0.0                         | NOASSERTION | Transitive        | dev      |
| css-tree                                 | 3.2.1   | library | npm       | pkg:npm/css-tree@3.2.1                                   | NOASSERTION | Transitive        | dev      |
| css.escape                               | 1.5.1   | library | npm       | pkg:npm/css.escape@1.5.1                                 | NOASSERTION | Transitive        | dev      |
| csstype                                  | 3.2.3   | library | npm       | pkg:npm/csstype@3.2.3                                    | NOASSERTION | Transitive        | dev      |
| data-urls                                | 7.0.0   | library | npm       | pkg:npm/data-urls@7.0.0                                  | NOASSERTION | Transitive        | dev      |
| decimal.js                               | 10.6.0  | library | npm       | pkg:npm/decimal.js@10.6.0                                | NOASSERTION | Transitive        | dev      |
| dequal                                   | 2.0.3   | library | npm       | pkg:npm/dequal@2.0.3                                     | NOASSERTION | Transitive        | dev      |
| detect-libc                              | 2.1.2   | library | npm       | pkg:npm/detect-libc@2.1.2                                | NOASSERTION | Transitive        | dev      |
| dom-accessibility-api                    | 0.5.16  | library | npm       | pkg:npm/dom-accessibility-api@0.5.16                     | NOASSERTION | Transitive        | dev      |
| dom-accessibility-api                    | 0.6.3   | library | npm       | pkg:npm/dom-accessibility-api@0.6.3                      | NOASSERTION | Transitive        | dev      |
| enhanced-resolve                         | 5.24.3  | library | npm       | pkg:npm/enhanced-resolve@5.24.3                          | NOASSERTION | Transitive        | dev      |
| entities                                 | 8.0.0   | library | npm       | pkg:npm/entities@8.0.0                                   | NOASSERTION | Transitive        | dev      |
| es-module-lexer                          | 2.3.1   | library | npm       | pkg:npm/es-module-lexer@2.3.1                            | NOASSERTION | Transitive        | dev      |
| estree-walker                            | 3.0.3   | library | npm       | pkg:npm/estree-walker@3.0.3                              | NOASSERTION | Transitive        | dev      |
| expect-type                              | 1.4.0   | library | npm       | pkg:npm/expect-type@1.4.0                                | NOASSERTION | Transitive        | dev      |
| fdir                                     | 6.5.0   | library | npm       | pkg:npm/fdir@6.5.0                                       | NOASSERTION | Transitive        | dev      |
| fsevents                                 | 2.3.3   | library | npm       | pkg:npm/fsevents@2.3.3                                   | NOASSERTION | Transitive        | dev      |
| graceful-fs                              | 4.2.11  | library | npm       | pkg:npm/graceful-fs@4.2.11                               | NOASSERTION | Transitive        | dev      |
| html-encoding-sniffer                    | 6.0.0   | library | npm       | pkg:npm/html-encoding-sniffer@6.0.0                      | NOASSERTION | Transitive        | dev      |
| indent-string                            | 4.0.0   | library | npm       | pkg:npm/indent-string@4.0.0                              | NOASSERTION | Transitive        | dev      |
| is-potential-custom-element-name         | 1.0.1   | library | npm       | pkg:npm/is-potential-custom-element-name@1.0.1           | NOASSERTION | Transitive        | dev      |
| jiti                                     | 2.7.0   | library | npm       | pkg:npm/jiti@2.7.0                                       | NOASSERTION | Transitive        | dev      |
| js-tokens                                | 4.0.0   | library | npm       | pkg:npm/js-tokens@4.0.0                                  | NOASSERTION | Transitive        | dev      |
| lightningcss                             | 1.32.0  | library | npm       | pkg:npm/lightningcss@1.32.0                              | NOASSERTION | Transitive        | dev      |
| lightningcss-android-arm64               | 1.32.0  | library | npm       | pkg:npm/lightningcss-android-arm64@1.32.0                | NOASSERTION | Transitive        | dev      |
| lightningcss-darwin-arm64                | 1.32.0  | library | npm       | pkg:npm/lightningcss-darwin-arm64@1.32.0                 | NOASSERTION | Transitive        | dev      |
| lightningcss-darwin-x64                  | 1.32.0  | library | npm       | pkg:npm/lightningcss-darwin-x64@1.32.0                   | NOASSERTION | Transitive        | dev      |
| lightningcss-freebsd-x64                 | 1.32.0  | library | npm       | pkg:npm/lightningcss-freebsd-x64@1.32.0                  | NOASSERTION | Transitive        | dev      |
| lightningcss-linux-arm-gnueabihf         | 1.32.0  | library | npm       | pkg:npm/lightningcss-linux-arm-gnueabihf@1.32.0          | NOASSERTION | Transitive        | dev      |
| lightningcss-linux-arm64-gnu             | 1.32.0  | library | npm       | pkg:npm/lightningcss-linux-arm64-gnu@1.32.0              | NOASSERTION | Transitive        | dev      |
| lightningcss-linux-arm64-musl            | 1.32.0  | library | npm       | pkg:npm/lightningcss-linux-arm64-musl@1.32.0             | NOASSERTION | Transitive        | dev      |
| lightningcss-linux-x64-gnu               | 1.32.0  | library | npm       | pkg:npm/lightningcss-linux-x64-gnu@1.32.0                | NOASSERTION | Transitive        | dev      |
| lightningcss-linux-x64-musl              | 1.32.0  | library | npm       | pkg:npm/lightningcss-linux-x64-musl@1.32.0               | NOASSERTION | Transitive        | dev      |
| lightningcss-win32-arm64-msvc            | 1.32.0  | library | npm       | pkg:npm/lightningcss-win32-arm64-msvc@1.32.0             | NOASSERTION | Transitive        | dev      |
| lightningcss-win32-x64-msvc              | 1.32.0  | library | npm       | pkg:npm/lightningcss-win32-x64-msvc@1.32.0               | NOASSERTION | Transitive        | dev      |
| lru-cache                                | 11.5.2  | library | npm       | pkg:npm/lru-cache@11.5.2                                 | NOASSERTION | Transitive        | dev      |
| lz-string                                | 1.5.0   | library | npm       | pkg:npm/lz-string@1.5.0                                  | NOASSERTION | Transitive        | dev      |
| magic-string                             | 0.30.21 | library | npm       | pkg:npm/magic-string@0.30.21                             | NOASSERTION | Transitive        | dev      |
| mdn-data                                 | 2.27.1  | library | npm       | pkg:npm/mdn-data@2.27.1                                  | NOASSERTION | Transitive        | dev      |
| min-indent                               | 1.0.1   | library | npm       | pkg:npm/min-indent@1.0.1                                 | NOASSERTION | Transitive        | dev      |
| nanoid                                   | 3.3.16  | library | npm       | pkg:npm/nanoid@3.3.16                                    | NOASSERTION | Transitive        | dev      |
| obug                                     | 2.1.4   | library | npm       | pkg:npm/obug@2.1.4                                       | NOASSERTION | Transitive        | dev      |
| parse5                                   | 8.0.1   | library | npm       | pkg:npm/parse5@8.0.1                                     | NOASSERTION | Transitive        | dev      |
| pathe                                    | 2.0.3   | library | npm       | pkg:npm/pathe@2.0.3                                      | NOASSERTION | Transitive        | dev      |
| picocolors                               | 1.1.1   | library | npm       | pkg:npm/picocolors@1.1.1                                 | NOASSERTION | Transitive        | dev      |
| picomatch                                | 4.0.5   | library | npm       | pkg:npm/picomatch@4.0.5                                  | NOASSERTION | Transitive        | dev      |
| postcss                                  | 8.5.22  | library | npm       | pkg:npm/postcss@8.5.22                                   | NOASSERTION | Transitive        | dev      |
| pretty-format                            | 27.5.1  | library | npm       | pkg:npm/pretty-format@27.5.1                             | NOASSERTION | Transitive        | dev      |
| punycode                                 | 2.3.1   | library | npm       | pkg:npm/punycode@2.3.1                                   | NOASSERTION | Transitive        | dev      |
| react-is                                 | 17.0.2  | library | npm       | pkg:npm/react-is@17.0.2                                  | NOASSERTION | Transitive        | dev      |
| redent                                   | 3.0.0   | library | npm       | pkg:npm/redent@3.0.0                                     | NOASSERTION | Transitive        | dev      |
| require-from-string                      | 2.0.2   | library | npm       | pkg:npm/require-from-string@2.0.2                        | NOASSERTION | Transitive        | dev      |
| rolldown                                 | 1.1.5   | library | npm       | pkg:npm/rolldown@1.1.5                                   | NOASSERTION | Transitive        | dev      |
| saxes                                    | 6.0.0   | library | npm       | pkg:npm/saxes@6.0.0                                      | NOASSERTION | Transitive        | dev      |
| scheduler                                | 0.27.0  | library | npm       | pkg:npm/scheduler@0.27.0                                 | NOASSERTION | Transitive        | required |
| siginfo                                  | 2.0.0   | library | npm       | pkg:npm/siginfo@2.0.0                                    | NOASSERTION | Transitive        | dev      |
| source-map-js                            | 1.2.1   | library | npm       | pkg:npm/source-map-js@1.2.1                              | NOASSERTION | Transitive        | dev      |
| stackback                                | 0.0.2   | library | npm       | pkg:npm/stackback@0.0.2                                  | NOASSERTION | Transitive        | dev      |
| std-env                                  | 4.2.0   | library | npm       | pkg:npm/std-env@4.2.0                                    | NOASSERTION | Transitive        | dev      |
| strip-indent                             | 3.0.0   | library | npm       | pkg:npm/strip-indent@3.0.0                               | NOASSERTION | Transitive        | dev      |
| symbol-tree                              | 3.2.4   | library | npm       | pkg:npm/symbol-tree@3.2.4                                | NOASSERTION | Transitive        | dev      |
| tapable                                  | 2.3.3   | library | npm       | pkg:npm/tapable@2.3.3                                    | NOASSERTION | Transitive        | dev      |
| tinybench                                | 2.9.0   | library | npm       | pkg:npm/tinybench@2.9.0                                  | NOASSERTION | Transitive        | dev      |
| tinyexec                                 | 1.2.4   | library | npm       | pkg:npm/tinyexec@1.2.4                                   | NOASSERTION | Transitive        | dev      |
| tinyglobby                               | 0.2.17  | library | npm       | pkg:npm/tinyglobby@0.2.17                                | NOASSERTION | Transitive        | dev      |
| tinyrainbow                              | 3.1.0   | library | npm       | pkg:npm/tinyrainbow@3.1.0                                | NOASSERTION | Transitive        | dev      |
| tldts                                    | 7.4.9   | library | npm       | pkg:npm/tldts@7.4.9                                      | NOASSERTION | Transitive        | dev      |
| tldts-core                               | 7.4.9   | library | npm       | pkg:npm/tldts-core@7.4.9                                 | NOASSERTION | Transitive        | dev      |
| tough-cookie                             | 6.0.2   | library | npm       | pkg:npm/tough-cookie@6.0.2                               | NOASSERTION | Transitive        | dev      |
| tr46                                     | 6.0.0   | library | npm       | pkg:npm/tr46@6.0.0                                       | NOASSERTION | Transitive        | dev      |
| tslib                                    | 2.8.1   | library | npm       | pkg:npm/tslib@2.8.1                                      | NOASSERTION | Transitive        | dev      |
| undici                                   | 7.28.0  | library | npm       | pkg:npm/undici@7.28.0                                    | NOASSERTION | Transitive        | dev      |
| w3c-xmlserializer                        | 5.0.0   | library | npm       | pkg:npm/w3c-xmlserializer@5.0.0                          | NOASSERTION | Transitive        | dev      |
| webidl-conversions                       | 8.0.1   | library | npm       | pkg:npm/webidl-conversions@8.0.1                         | NOASSERTION | Transitive        | dev      |
| whatwg-mimetype                          | 5.0.0   | library | npm       | pkg:npm/whatwg-mimetype@5.0.0                            | NOASSERTION | Transitive        | dev      |
| whatwg-url                               | 16.0.1  | library | npm       | pkg:npm/whatwg-url@16.0.1                                | NOASSERTION | Transitive        | dev      |
| why-is-node-running                      | 2.3.0   | library | npm       | pkg:npm/why-is-node-running@2.3.0                        | NOASSERTION | Transitive        | dev      |
| xml-name-validator                       | 5.0.0   | library | npm       | pkg:npm/xml-name-validator@5.0.0                         | NOASSERTION | Transitive        | dev      |
| xmlchars                                 | 2.2.0   | library | npm       | pkg:npm/xmlchars@2.2.0                                   | NOASSERTION | Transitive        | dev      |

### Docker

| Component                            | Version                      | Type      | Ecosystem | PURL                                                    | License     | Direct/Transitive | Scope    |
| ------------------------------------ | ---------------------------- | --------- | --------- | ------------------------------------------------------- | ----------- | ----------------- | -------- |
| curlimages/curl                      | 8.11.1                       | container | Docker    | pkg:docker/curlimages/curl@8.11.1                       | NOASSERTION | Direct            | required |
| denoland/deno                        | 2.9.3                        | container | Docker    | pkg:docker/denoland/deno@2.9.3                          | NOASSERTION | Direct            | required |
| denoland/deno                        | alpine-2.9.3                 | container | Docker    | pkg:docker/denoland/deno@alpine-2.9.3                   | NOASSERTION | Direct            | required |
| edoburu/pgbouncer                    | v1.24.1-p1                   | container | Docker    | pkg:docker/edoburu/pgbouncer@v1.24.1-p1                 | NOASSERTION | Direct            | required |
| grafana/grafana                      | 11.1.0                       | container | Docker    | pkg:docker/grafana/grafana@11.1.0                       | NOASSERTION | Direct            | required |
| grafana/tempo                        | 2.9.0                        | container | Docker    | pkg:docker/grafana/tempo@2.9.0                          | NOASSERTION | Direct            | required |
| minio/mc                             | RELEASE.2025-08-13T08-35-41Z | container | Docker    | pkg:docker/minio/mc@RELEASE.2025-08-13T08-35-41Z        | NOASSERTION | Direct            | required |
| minio/minio                          | RELEASE.2025-09-07T16-13-09Z | container | Docker    | pkg:docker/minio/minio@RELEASE.2025-09-07T16-13-09Z     | NOASSERTION | Direct            | required |
| otel/opentelemetry-collector-contrib | 0.109.0                      | container | Docker    | pkg:docker/otel/opentelemetry-collector-contrib@0.109.0 | NOASSERTION | Direct            | required |
| pgvector/pgvector                    | 0.8.5-pg18                   | container | Docker    | pkg:docker/pgvector/pgvector@0.8.5-pg18                 | NOASSERTION | Direct            | required |
| prom/prometheus                      | v2.53.0                      | container | Docker    | pkg:docker/prom/prometheus@v2.53.0                      | NOASSERTION | Direct            | required |

## License Summary

| License     | Count | Review Note                                                          |
| ----------- | ----- | -------------------------------------------------------------------- |
| Apache-2.0  | 1     | Repository root license.                                             |
| NOASSERTION | 218   | License could not be derived from checked-in manifests or lockfiles. |

## Dependency Relationships

- Direct required components: 20
- Direct development components: 14
- Transitive components: 184
- Locked JSR components from deno.lock: 12
- Locked npm components from deno.lock: 194
- Browser harness note: tests/browser declares `@playwright/test` in
  package.json but does not ship its own lockfile, so the SBOM records the
  declared range rather than an exact resolved version.

## Known Vulnerabilities

Vulnerability scanning was not performed as part of this documentation pass.
Recommended follow-up commands:

- `deno run -A scripts/generate_sbom.ts`
- `osv-scanner --lockfile=deno.lock`
- `npm audit --prefix tests/browser`
- `trivy fs .`
- `docker scout cves denoland/deno:alpine-2.9.3`

## Generation and Maintenance

- Regenerate the machine-readable and human-readable SBOM with
  `deno run -A scripts/generate_sbom.ts`.
- Regenerate on every dependency change and every release candidate or release
  cut.
- Add the SBOM generation command and the vulnerability scans above to CI if the
  repository later adopts automation.
