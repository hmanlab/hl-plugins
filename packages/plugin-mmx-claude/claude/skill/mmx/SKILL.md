---
name: mmx
description: Use when the user wants to generate images, video, music, speech, run web search, analyze images, or check Token Plan quota. Wraps the official mmx-cli so multimodal MiniMax capabilities can be invoked directly from inside a Claude Code session without leaving the chat. Front-load keywords: image, picture, illustration, logo, artwork, generate, mmx, MiniMax, video, music, song, voiceover, TTS, speech, search, vision, quota, usage.
---

# mmx — MiniMax multimodal tools

The `mmx-claude` MCP server exposes seven tools that wrap the official MiniMax CLI. They are auto-registered when the user runs `hl-plugins install mmx-claude` and Claude Code restarts.

| Tool              | What it does                                         |
| ----------------- | ---------------------------------------------------- |
| `mmx_image`       | Text → image (image-01 model)                        |
| `mmx_speech`      | Text → MP3 voiceover (speech-2.8-hd)                 |
| `mmx_video`       | Text → MP4 short video (Hailuo-2.3)                  |
| `mmx_music`       | Text → song / instrumental (music-2.6)               |
| `mmx_search`      | Web search via MiniMax search API                    |
| `mmx_vision`      | Image → text description / OCR / Q&A                |
| `mmx_quota`       | Show Token Plan usage and remaining quota            |

These are the same seven tools available to OpenCode users via `@hl-plugins/mmx`. Same `mmx-cli` binary, same auth state, same MiniMax API key.

## Setup (one-time, on the machine)

1. Install the CLI: `npm install -g mmx-cli`
2. Install Bun (the MCP server runs on it): `curl -fsSL https://bun.sh/install | bash`
3. Authenticate with the user's API key: `mmx auth login --api-key sk-xxxxx`
   The key is stored locally — never paste it into chat.
4. If calls return 401, the region auto-detect failed. Set it manually:
   - Overseas: `mmx config set --key region --value global`
   - Mainland China: `mmx config set --key region --value cn`
5. Confirm with: `mmx quota` and `mmx auth status`

The user runs `hl-plugins install mmx-claude` once and the CLI handles steps 1–4 automatically (auto-installing Bun and `mmx-cli` if missing).

## Output location

All generated files save to `~/Desktop/mmx-output/` by default — regardless of which repo or directory Claude Code was launched from. This is intentional; do not override it on your own.

**Never pass `out_dir` / `out_path` unless the user explicitly asked for a different save location in this conversation.** Passing these args based on your own inference (e.g. "save to the current repo") is wrong and will be silently corrected to the default with a warning in the tool output.

Two ways the user can legitimately override:

1. **Per-call:** tell you explicitly in chat ("save this to my Pictures folder"), and you pass the right `out_dir` / `out_path`.
2. **Permanent:** set `MMX_OUTPUT_DIR=/some/path` in the user's shell rc (`~/.zshrc`, `~/.bashrc`) before launching Claude Code. This changes the default for all mmx tools.

Suspicious paths (`$HOME`, `~/Desktop`, `/tmp`, `.`) passed via `out_dir` / `out_path` are always rejected and fall back to `~/Desktop/mmx-output/` — even when the user explicitly asks for them. (Users wanting those locations should use `MMX_OUTPUT_DIR` for the legitimate case.)

`mmx_image` defaults to a unique filename prefix per call (`image-<timestamp>`) so back-to-back calls don't overwrite each other. Pass an explicit `filename_prefix` when you want predictable sequential naming (e.g. `logo_001.jpg`, `logo_002.jpg`).

## Common patterns

- **Cover image for a slide / social post** — call `mmx_image` with a detailed style prompt and `aspect_ratio: "16:9"` or `"1:1"`.
- **Voiceover for a video** — `mmx_speech` with the script as `text`. Override voice ID if the default English narrator doesn't fit.
- **Background music** — `mmx_music` with `instrumental: true` and a style prompt like "calm ambient pad, lo-fi beat, 70 bpm".
- **Verify what's left in the quota** — `mmx_quota` before starting a long batch.
- **Describe a screenshot the user dropped in** — `mmx_vision` with the local path.

## Tips

- Image prompts should be **specific and detailed**: subject, style, lighting, composition, mood. Vague prompts produce vague results.
- For reproducible images, pass `seed`. Same prompt + same seed = same image.
- Video and music calls block for 1–3 minutes — call them only when the user actually wants the output.
- If `mmx_image` returns a failed exit code, surface the stderr verbatim — that's where mmx-cli writes quota errors, region errors, and validation issues.

## When NOT to use these tools

- For diagrams, charts, tables, or anything textual — render with HTML/JSX instead.
- For tiny UI icons — too heavy; use SVG.
- If the user is on the free tier or hasn't authenticated, point them at the setup section above before retrying.
