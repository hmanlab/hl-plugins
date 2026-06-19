# Refactor plans

Living documents for major refactors of the `hl-plugins` codebase. Each plan
follows the same shape: **why → target shape → phased migration → acceptance
criteria → risks → checklist**.

## Index

| Plan | Target | Status | Trigger |
|---|---|---|---|
| [multiplayer.md](./multiplayer.md) | `packages/plugin-multiplayer/` | Draft v1 | God file at 1,540 lines, Phase 03 will add ~2,000 more |

## When to add a new plan

- A single file in `src/` exceeds 300 lines and the work to split it is non-trivial.
- A module's mutable state is leaking into other modules (the `?step=${n}` re-import hack in `plugin-multiplayer/test/smoke.ts` is the canonical example).
- A new phase doc (`docs/development/<plugin>/phase-NN.md`) needs a folder structure that doesn't exist yet.
- The plugin contract (`docs/architecture.md` §"Plugin contract") needs to grow.

## When NOT to add a plan

- A bug fix that touches ≤ 2 files. Open an issue.
- A small refactor (< 100 lines moved, no behavior change) that fits in one PR. Just do it.
- A new feature. That's a phase doc, not a refactor plan.

## Convention

Every refactor plan must:
- name the file `docs/development/refactor/<topic>.md` (not `docs/refactor/`),
- include a **"Smoke test"** column in the phased migration table — every refactor must keep tests green at every step,
- include a **"Acceptance criteria"** section with a checkbox list (so a future agent can verify completion mechanically),
- cite the line numbers of the pain points in the existing source (so the reader can verify the diagnosis).
