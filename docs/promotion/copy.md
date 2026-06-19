# Promotion copy

All marketing copy for the `hl-plugins` v0.2.0 release, image-generation
focus. Tweak tone per surface; the core claim is the same: *one command
adds multimodal generation to OpenCode, no tab switching*.

> **Canonical install:**
> `npm install -g @hmanlab/hl-plugins` then `hl-plugins install mmx`
> (one-shot `npx -y @hmanlab/hl-plugins install mmx` also works for the
> install step alone).

---

## Discord (post-install)

Final, approved. Use this verbatim in OpenCode / MiniMax / dev Discords.

```
tl;dr: install once, generate image / video / music / speech without leaving
your OpenCode chat.

`npm install -g @hmanlab/hl-plugins` → `hl-plugins install mmx` → `mmx auth login --api-key sk-...` → restart opencode.

then just ask:

> draw a cyberpunk cat with neon sunglasses, 16:9 cinematic

file lands in `~/Desktop/mmx-output/`. you never left the chat. same flow for
video (Hailuo-2.3), music (music-2.6), speech (speech-2.8-hd), search,
vision, and quota.

key stays in mmx-cli local config. never in chat, never in git. idempotent
install. one-command uninstall.

repo: https://github.com/hmanlab/hl-plugins
npm: https://www.npmjs.com/package/@hmanlab/hl-plugins

MIT, open source, no telemetry. what other plugins should i wrap next?
```

---

## X / Twitter

### Single tweet (≤280 chars)

```
one command. image / video / music / speech in your OpenCode chat. no tab switching.

`npm i -g @hmanlab/hl-plugins` → `hl-plugins install mmx` → ask "draw a cyberpunk cat"

github.com/hmanlab/hl-plugins
```

### 5-post thread

**1/** I kept alt-tabbing from OpenCode to generate images. So I built hl-plugins — one command to wrap MiniMax's mmx-cli into your coding agent. Built for Token Plan users.

**2/** setup (~30s):
```
npm install -g @hmanlab/hl-plugins
hl-plugins install mmx
mmx auth login --api-key sk-...
```
restart opencode. key stays in mmx-cli local config. never in chat, never in git.

**3/** then in chat:
```
> draw a cyberpunk cat with neon sunglasses, 16:9 cinematic
```
file lands in `~/Desktop/mmx-output/`. you never left the chat.

**4/** also wraps video (Hailuo-2.3), music (music-2.6), speech (speech-2.8-hd), search, vision, and quota. same tool loop as your file edits.

**5/** open source, MIT, no telemetry. idempotent install, one-command uninstall.
github.com/hmanlab/hl-plugins
npm: npmjs.com/package/@hmanlab/hl-plugins

what other plugins should i wrap next?

### Hook variants (swap into post 1)

- "I kept alt-tabbing from OpenCode to generate images." — first-person pain
- `"draw a cyberpunk cat" — and your OpenCode session generates it.` — demo-first
- "Multimodal coding agents shouldn't make you tab-switch." — opinionated

---

## LinkedIn / blog intro

> **Built something for the MiniMax Token Plan folks in the OpenCode crowd.**
>
> `hl-plugins` is a one-command installer for curated OpenCode plugins. The first one wraps `mmx-cli` so you can generate **images, video, music, and speech** directly from inside your OpenCode chat session — no tab switching, no copy-pasting prompts.
>
> The pitch is simple: describe what you want in chat, the LLM calls the tool, the file lands in `~/Desktop/mmx-output/`. You keep coding. The agent iterates with you the same way it iterates on your code — *"make the cat orange"*, *"16:9 instead of 1:1"*, *"regenerate, seed 7"* — all in the same tool loop.
>
> Setup:
> ```
> npm install -g @hmanlab/hl-plugins
> hl-plugins install mmx
> mmx auth login --api-key sk-...
> ```
>
> Built for people who already have a MiniMax Token Plan and don't want their agent workflow to live in 4 different tabs.
>
> Open source, MIT, no telemetry. Repo: github.com/hmanlab/hl-plugins

---

## GitHub Release notes (for v0.2.0 tag)

```
hl-plugins v0.2.0 — first curated plugin (mmx) for OpenCode

One command to add image, video, music, and speech generation to your
OpenCode coding agent. Built for MiniMax Token Plan users.

What's in this release:
- @hl-plugins/mmx plugin — wraps mmx-cli (image, video, music, speech,
  search, vision, quota)
- `hl-plugins install / uninstall / list / status / update` CLI
- Idempotent install: re-run safely, never overwrites your other plugins
- No telemetry. MIT license.

Install:
  npm install -g @hmanlab/hl-plugins
  hl-plugins install mmx

Docs: github.com/hmanlab/hl-plugins#readme
```

---

## README hero block (drop-in)

> ### One command. Multimodal in your coding agent.
>
> Built for MiniMax Token Plan users. Generate images, video, music, and speech without leaving your OpenCode chat.
>
> ```
> npm install -g @hmanlab/hl-plugins
> hl-plugins install mmx
> ```
>
> Then in chat: `> draw a cyberpunk cat with neon sunglasses, 16:9 cinematic`
> → image lands at `~/Desktop/mmx-output/`. You never left the chat.

---

## Reply templates

### "is this safe?"

```
short answer: yes, but read the contract before installing — same trust
model as `npm install -g <pkg>`.

the install flow:
- copies plugin files to `~/.opencode/plugin/`
- merges into `~/.opencode/config.json` (additive only — never overwrites
  your other plugins/MCP)
- shells out to commands defined in the plugin's `package.json` (see
  `hl-plugins.requires` + `hl-plugins.auth` fields)

api keys are NEVER stored in chat or git. they go into mmx-cli's own
local config via `mmx auth login`.

SECURITY.md in the repo has the full breakdown: https://github.com/hmanlab/hl-plugins/blob/main/SECURITY.md
```

### "does it work with mmx 1.x?"

```
yes — the plugin shells out to `mmx` CLI on your PATH, so it tracks
whatever mmx-cli version you have installed (`npm install -g mmx-cli`).

if you hit a 401 after auth, the region auto-detect failed. set it
manually: `mmx config set --key region --value global` (or `cn`).
```

### "what about X / Y plugin?"

```
hl-plugins is plugin-agnostic by design. adding a new one is just
dropping a `packages/plugin-<name>/` folder with the right contract —
no CLI changes.

docs/adding-a-plugin.md walks through it. PRs welcome.

also: what would *you* want next? image gen is the headline but the
plumbing works for any CLI tool with a stable contract.
```

---

## Pinned-tweet variant (your best tweet, on profile top)

```
one command. image / video / music / speech generation in your OpenCode
chat. no tab switching.

`npm install -g @hmanlab/hl-plugins` → `hl-plugins install mmx` → ask "draw a cyberpunk cat" → file lands in
`~/Desktop/mmx-output/`.

open source, MIT, no telemetry. opencode + MiniMax Token Plan.

github.com/hmanlab/hl-plugins
```

---

## Channel-specific hashtags / handles (use sparingly)

| Channel | Add |
|---|---|
| X | `@MiniMaxAI` (if account exists), no hashtags — dev tools + hashtags = noise |
| LinkedIn | none |
| Discord | no @-mentions unless posting in `#general` of an OpenCode/MiniMax server |
| Reddit | r/LocalLLaMA, r/AI_Agents — title-only teaser, link in body |
| HackerNews | "Show HN: hl-plugins — multimodal in your coding agent" |
