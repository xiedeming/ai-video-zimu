# Repository Guidelines

## Project Structure & Module Organization

Zimu Studio is an Electron, React, and TypeScript desktop app. Keep process boundaries explicit:

- `src/main/`: Electron main process, IPC handlers, model management, sidecars, and transcription/translation jobs.
- `src/preload/`: the typed, minimal `window.zimu` bridge. Do not expose Node APIs directly.
- `src/renderer/src/`: React UI, Zustand editor state, components, and Tailwind styles.
- `src/shared/`: Zod schemas, project types, subtitle utilities, and code shared across processes.
- `scripts/`: sidecar download and verification scripts.
- `resources/bin/`: FFmpeg, whisper.cpp, and llama.cpp binaries; large binaries are Git-ignored.
- `design-system/`: UI design guidance. Generated bundles go to `out/` and installers to `dist/`.

Place tests beside their implementation as `*.test.ts`.

## Build, Test, and Development Commands

- `npm install`: install locked dependencies from `package-lock.json`.
- `npm run dev`: launch Electron with Vite hot reload.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: run the Vitest suite once; use `npm run test:watch` while developing.
- `npm run build`: type-check, test, and create production Electron bundles.
- `npm run prepare:sidecars`: download required native tools; use `npm run verify:sidecars` before packaging.
- `npm run dist`: build and produce the Windows NSIS installer.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and no semicolons. Prefer named exports, `camelCase` functions/variables, `PascalCase` React components and types, and descriptive kebab-case modules such as `translation-client.ts`. Keep validation in shared Zod schemas and validate every IPC boundary. No formatter or linter is configured; `npm run typecheck` is mandatory.

## Testing Guidelines

Vitest runs in the Node environment and discovers `src/**/*.test.ts`. Cover success, cancellation, retry, malformed input, Unicode paths, CPU fallback, and security-sensitive redaction. Add regression tests for every bug fix. Run `npm run build` before submitting changes; there is no enforced coverage threshold yet.

## Commit & Pull Request Guidelines

This checkout contains no Git history, so no existing convention can be inferred. Use concise Conventional Commit subjects, for example `fix: deduplicate adjacent whisper segments`. Pull requests should explain user impact, implementation, and verification; link relevant issues and include screenshots for UI changes. Never commit models, API keys, generated output, or downloaded sidecar binaries.

## Security & Configuration

Preserve Electron sandboxing, context isolation, strict CSP, and the typed preload surface. Keep API keys in Electron `safeStorage`; never place secrets, media paths, or subtitle contents in logs or `.zimu` metadata.
