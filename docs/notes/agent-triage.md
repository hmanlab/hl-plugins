# Triage bot (`@hmanlab` mention on issues)

When someone triggers the bot on `hmanlab/hl-plugins`, a workflow runs an
LLM agent that:

1. Reads the issue (and recent comment thread, if the trigger was a comment)
2. Scans the repo for relevant files (ripgrep on keywords from the
   issue, plus always include `AGENTS.md`, `README.md`, `package.json`,
   `tsconfig.base.json`)
3. Drafts a response and posts it as a comment on the issue
4. (Claim flow only) parses the verdict and applies a `triage/claim-*` label

The workflow file is `.github/workflows/hmanlab-triage.yml`. The script is
`scripts/triage/issue-triage.ts` and runs via `tsx` (already a root
devDep).

## Triggers

| Where | When |
|---|---|
| `issues: opened` | Issue title or body contains `@hmanlab` |
| `issue_comment: created` | Comment body contains `@hmanlab` AND it's on an issue (not a PR review) |

Loop guard: the bot's own comments (`github-actions[bot]`) do not trigger
re-analysis. If the bot has already replied to the issue, new
`@hmanlab` mentions on the same thread are skipped (unless the new
trigger is a `@hmanlab claim:` from a different author — that path
re-runs the claim review).

## Three intents

### 1. `@hmanlab` (in issue body / title / comment)

Standard issue-triage analysis. The bot posts a comment in the
AGENTS.md issue body format (Summary, Repro, Root cause, Impact,
Proposed fix, Behavior after, Alternatives, Affected files, Version).

### 2. `@hmanlab claim: <proposal>` (in a comment)

Claim-review pass. The bot judges whether the contributor's proposal
would correctly solve the issue, then posts a structured verdict.

**Output format (strict):**

```
**Claim review** — `@<author>` proposes to <one-line summary>.

**Verdict:** looks good | has concerns | doesn't fit
**Reasoning:** <2-4 sentences>
**Concerns:** <bullet list, or "none">
**Suggested next step:** <what should happen next>
```

**Verdict → label mapping** (applied automatically):

| Verdict | Label |
|---|---|
| looks good | `triage/claim-recommended` |
| has concerns | `triage/claim-concerns` |
| doesn't fit | `triage/claim-rejected` |

**The bot does NOT assign anyone.** Maintainer reviews the verdict
+ label and assigns via the GitHub UI. This is intentional — see the
**Why no auto-assign** note below.

### 3. No mention

Workflow is skipped (no Actions run).

## Why no auto-assign

The bot does not call the assignees endpoint. Rationale:

- An LLM-as-judge on a contributor's plan is easily fooled by
  confident-but-wrong text. Auto-assignment is unilateral.
- "Fits" is subjective — even two maintainers will disagree. Coding
  the LLM's verdict into a permission is overreach.
- Audit trail stays clean: human-in-the-loop on the assignment.

If a maintainer later wants to opt in to auto-assign, flip a future
`AUTO_ASSIGN_ON_CLAIM` repo variable (not yet implemented). The
recommend-only path is the safe default.

## Required setup (one-time)

In **Settings → Secrets and variables → Actions** for the repo:

| Type | **Name** | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| **Secret** | `LLM_API_KEY` | yes | — | API key for whatever provider you point at |
| Variable | `OPENAI_BASE_URL` | no | `https://api.minimax.io/v1` | Any OpenAI-compatible base URL |
| Variable | `OPENAI_MODEL` | no | `MiniMax-M3` | Any model id the endpoint understands |

Both the workflow and the script have built-in fallbacks: if the
repo variables are unset (or empty), they default to the values in
the table above. So setting them is optional — you only need to set
them if you want to point at a different provider.

> **Secrets vs Variables.** `LLM_API_KEY` is a **Secret** (it's
> sensitive). `OPENAI_BASE_URL` and `OPENAI_MODEL` are
> **Variables** (not sensitive — just config). The workflow reads
> them from the correct tab via `secrets.X` and `vars.X`
> respectively.

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
5. Comment `@hmanlab claim: I'll change the install command to use a different flag` on the
   same issue — a claim review should appear within a minute.
6. If it fails, check the Actions run — the script posts a short failure
   comment to the issue too.

## Negative tests

- Open an issue **without** `@hmanlab` → workflow skipped (no Actions run).
- Open an issue **with** `@hmanlab` but from the bot account itself
  → workflow skipped (loop guard).
- Comment **without** `@hmanlab` on any issue → workflow skipped.
- Comment on a PR review thread with `@hmanlab` → workflow skipped
  (the `if:` filter requires `github.event.issue.pull_request == null`).
- The bot already replied to the thread, then someone comments
  `@hmanlab` again → workflow skips (loop guard prevents the bot
  re-reacting to its own words).

## Disable

Either:

- Rename `.github/workflows/hmanlab-triage.yml` to start with `_` (GitHub
  ignores `_`-prefixed workflow files), **or**
- Set the repo variable `OPENAI_MODEL` to empty. The script will fail fast
  with a clear "missing env" error and the Actions run will show it
  without posting a comment.

## Cost & rate notes

- A typical triage on this repo is ~5–15k input tokens + ~1k output. A
  claim review is similar. At `MiniMax-M3` pricing that's effectively
  free; at raw OpenAI `gpt-4o-mini` pricing it's a fraction of a cent.
- The script calls the LLM once per trigger. There is no retry. Failures
  post a short failure comment and surface the error in the Actions UI.
- The script truncates every file it reads to 400 lines / 6 KB, and caps
  the total file list at 12, to stay well within the context window of
  every supported model.
- Comment history is capped at the last 10 comments × 1 KB each.

## No-code policy (strict)

The bot's replies must contain **no** fenced code blocks (``` or ~~~),
**no** diffs, and **no** inline backticks around code identifiers.
Prose only. The human writes the code.

This is enforced in two layers:

1. **Prompt layer** — the system prompt forbids all three explicitly.
2. **Post-processing layer** — `stripCodeBlocks()` removes any fenced
   blocks (``` and ~~~) that slip through, so the user never sees
   them even if the model ignores the rule.

If the LLM produces an inline-backtick identifier (e.g. `` `npm install` ``),
the strip pass leaves it alone (it only touches fenced blocks), but
the prompt tells the model to avoid it. Stripping inline backticks
would destroy prose like "the npm install command" in a future fix
to the strip pass.

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

- It does not close issues, apply labels (other than the three
  `triage/claim-*` ones), or assign anyone. Maintainer stays in the
  loop.
- It does not push commits or open PRs. The comment is a starting point
  for the maintainer's review.
- It does not react to `@hmanlab` on PR review comments — only on
  issue comments and on issue creation.
- It does not touch PRs. PR triage is a separate concern.