# Triage bot (`@hmanlab` mention on new issues)

When someone opens a new issue on `hmanlab/hl-plugins` whose **title or body
contains `@hmanlab`**, a workflow runs an LLM agent that:

1. Reads the issue
2. Scans the repo for relevant files (ripgrep on keywords from the issue,
   plus always include `AGENTS.md`, `README.md`, `package.json`,
   `tsconfig.base.json`)
3. Drafts a triage response in the
   [AGENTS.md issue body format](../architecture.md) — Summary, Repro,
   Root cause, Impact, Proposed fix, Behavior after, Alternatives, Affected
   files, Version
4. Posts it as a comment on the issue

The workflow file is `.github/workflows/hmanlab-triage.yml`. The script is
`scripts/triage/issue-triage.ts` and runs via `tsx` (already a root
devDep).

## Required setup (one-time)

In **Settings → Secrets and variables → Actions** for the repo:

| Type | Name | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| **Secret** | `LLM_API_KEY` | yes | — | API key for whatever provider you point at |
| Variable | `OPENAI_BASE_URL` | no | `https://api.minimax.io/v1` | Any OpenAI-compatible base URL |
| Variable | `OPENAI_MODEL` | no | `MiniMax-M3` | Any model id the endpoint understands |

The workflow uses the [`openai` JS SDK](https://www.npmjs.com/package/openai)
purely as a transport — it speaks the OpenAI chat-completions protocol that
MiniMax, GLM, Kimi, DeepSeek, OpenRouter, and raw OpenAI all implement. Swap
providers by changing the two variables above; no code change needed.

## Swapping providers

| Provider | `OPENAI_BASE_URL` | `OPENAI_MODEL` |
| --- | --- | --- |
| **MiniMax (default)** | `https://api.minimax.io/v1` | `MiniMax-M3` |
| GLM (Zhipu) | `https://open.bigmodel.cn/api/paas/v4/` | `glm-4.5` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` | `moonshot-v1-128k` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI direct | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter (any model, any provider) | `https://openrouter.ai/api/v1` | e.g. `anthropic/claude-3.5-sonnet` |

## Test it on a fork

1. Push the workflow + script to a fork.
2. Add the `LLM_API_KEY` secret on the fork.
3. Open an issue with `@hmanlab` in the body:
   ```bash
   gh issue create --title "test @hmanlab" --body "I get a TypeError when I run `hl-plugins install mmx`."
   ```
4. Within a minute, a triage comment should appear on the issue.
5. If it fails, check the Actions run — the script posts a short failure
   comment to the issue too.

## Negative tests

- Open an issue **without** `@hmanlab` → workflow skipped (no Actions run).
- Open an issue **with** `@hmanlab` but from the bot account itself
  → workflow skipped (loop guard).

## Disable

Either:

- Rename `.github/workflows/hmanlab-triage.yml` to start with `_` (GitHub
  ignores `_`-prefixed workflow files), **or**
- Set the repo variable `OPENAI_MODEL` to empty. The script will fail fast
  with a clear "missing env" error and the Actions run will show it
  without posting a comment.

## Cost & rate notes

- A typical triage on this repo is ~5–15k input tokens + ~1k output. At
  `MiniMax-M3` pricing that's effectively free; at raw OpenAI `gpt-4o-mini`
  pricing it's a fraction of a cent.
- The script calls the LLM once per issue. There is no retry. Failures
  post a short failure comment and surface the error in the Actions UI.
- The script truncates every file it reads to 400 lines / 6 KB, and caps
  the total file list at 12, to stay well within the context window of
  every supported model.

## M3 thinking-content caveat (handled)

`MiniMax-M3` has thinking enabled by default. When `reasoning_split` is
`false` (the default), the model's reasoning gets injected into the
response `content` field wrapped in `<think>...</think>` tags — which
would pollute the triage comment posted to the issue.

The script handles this in two ways:

1. **For any MiniMax model** (`OPENAI_MODEL` starts with `MiniMax-`), it
   passes `extra_body: { thinking: { type: "disabled" } }` so M3 skips
   thinking entirely (M2.x accepts the param but ignores it — no error).
2. **Defense in depth:** a post-processing pass strips any
   `<think>...</think>` blocks that still leak into the reply, so the
   comment posted to GitHub is always clean analysis.

For non-MiniMax providers (GLM, Kimi, OpenAI, etc.) this whole concern
doesn't apply — thinking blocks aren't a feature of those APIs.

## What the script does NOT do

- It does not close issues, apply labels, or assign anyone. Maintainer
  stays in the loop.
- It does not push commits or open PRs. The comment is a starting point
  for the maintainer's review.
- It does not react to `@hmanlab` in **comments** — only on issue
  creation. (Easy to extend to `issue_comment: created` later if wanted.)
- It does not touch PRs. PR triage is a separate concern.
