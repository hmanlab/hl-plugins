#!/usr/bin/env node
// CLI entry point. Built artifact at packages/plugin-memo/dist/cli.js is what
// `pnpm install` actually puts on PATH (see package.json bin field).
//
// Source CLI is in src/cli/main.ts; this file is the install path shim
// so the CLI works even before the build step.

import { run } from "../dist/cli.js"
// Commander expects [executable, script-path, ...args]. Under node this is
// already the shape. Under bun, argv[0] is the bun binary and argv[1] is the
// script — also already correct. So we just pass argv through.
run(process.argv)
