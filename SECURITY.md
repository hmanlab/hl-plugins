# Security

hl-plugins is an **installer**. Running `hl-plugins install <plugin>`
executes the shell commands defined in that plugin's `hl-plugins`
contract:

- `requires[].check` / `install` / `update` — usually a probe or
  `npm install -g <pkg>`
- `auth.check` / `login` / `verify` — used to authenticate the user
  with the plugin's backing service
- `postInstall[]` — smoke test after install

## Trust model

The contract is **code**. Review it before installing a plugin, the
same way you would review code before `npm install -g <pkg>`.

- The **curated first-party plugins** in this monorepo (e.g.
  `packages/plugin-mmx/`) are maintained by the repo owner. The
  install flow for these is reproducible and auditable.
- **Plugins installed from npm** as `@hmanlab/*` are **not vetted**
  by this repo. Inspect their `hl-plugins` field in their tarball
  (`npm view @hmanlab/<name> dist.tarball | xargs curl | tar -xO
  package/package.json`) before installing.

## What's hardened

- **API keys and other user-supplied values** are passed as separate
  argv elements to the plugin's CLI (since `0.1.3`), not interpolated
  into a shell string. The `sh -c` path is reserved for static
  contract commands with no user input.
- **Config merge is additive** — `hl-plugins install` never overwrites
  the user's other OpenCode plugins, MCP servers, or permission
  settings.
- **The CLI never writes API keys to disk** — credentials are stored
  by the plugin's own CLI (e.g. `mmx auth login`), not in
  `~/.opencode/config.json`.

## Reporting a vulnerability

Open a private security advisory at
https://github.com/hmanlab/hl-plugins/security/advisories/new, or
email the maintainer.
