// mmx-tools.ts
//
// OpenCode plugin that wraps the official MiniMax mmx-cli so the LLM can
// generate images, video, music, speech, run web search, describe images,
// and check Token Plan quota — all from inside an OpenCode session without
// leaving the chat.
//
// Requires once on the machine:
//   npm install -g mmx-cli
//   mmx auth login --api-key sk-xxxxx
// After that, no key is needed in opencode.
//
// All generated files default to ~/Desktop/mmx-output/.

import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { homedir } from "node:os"
import { join, resolve, isAbsolute } from "node:path"
import { mkdirSync, existsSync } from "node:fs"

const DEFAULT_OUT_DIR = join(homedir(), "Desktop", "mmx-output")

function resolveOutDir(outDir: string | undefined, worktree: string): string {
  const target = outDir ?? DEFAULT_OUT_DIR
  return isAbsolute(target) ? target : resolve(worktree, target)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export default async () => {
  return {
    tool: {
      // ──────────────────────────────────────────────────────────────────
      // IMAGE GENERATION (primary tool)
      // ──────────────────────────────────────────────────────────────────
      mmx_image: tool({
        description:
          "Generate one or more images from a text prompt using MiniMax's image-01 model via mmx-cli. Use this whenever the user asks for an image, illustration, logo, artwork, photo, or any visual asset. Aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Pass seed for reproducible results. Returns the saved file path.",
        args: {
          prompt: tool.schema
            .string()
            .describe(
              "Detailed text description of the image. Be specific about subject, style, lighting, composition, mood.",
            ),
          aspect_ratio: tool.schema
            .string()
            .optional()
            .describe("Aspect ratio. One of: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Default 1:1."),
          n: tool.schema
            .number()
            .optional()
            .describe("Number of images to generate. Default 1, max 4."),
          seed: tool.schema
            .number()
            .optional()
            .describe("Random seed for reproducible generation."),
          out_dir: tool.schema
            .string()
            .optional()
            .describe(
              "Directory to save images to. Default ~/Desktop/mmx-output/.",
            ),
          optimize_prompt: tool.schema
            .boolean()
            .optional()
            .describe("Auto-optimize the prompt for better quality."),
          filename_prefix: tool.schema
            .string()
            .optional()
            .describe("Filename prefix. Default 'image'."),
        },
        async execute(args, ctx) {
          const outDir = resolveOutDir(args.out_dir, ctx.worktree)
          ensureDir(outDir)
          const extra: string[] = []
          if (args.aspect_ratio) extra.push(`--aspect-ratio ${args.aspect_ratio}`)
          if (args.n) extra.push(`--n ${args.n}`)
          if (args.seed != null) extra.push(`--seed ${args.seed}`)
          if (args.optimize_prompt) extra.push(`--prompt-optimizer`)
          extra.push(`--out-dir ${outDir}`)
          extra.push(`--out-prefix ${args.filename_prefix ?? "image"}`)
          extra.push(`--non-interactive`)
          const proc = await $`mmx image generate --prompt ${args.prompt} ${extra.join(" ")}`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx image generate failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          const out = proc.stdout.toString().trim()
          return `Image generation complete.\n\n${out}\n\nSaved to: ${outDir}`
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // SPEECH SYNTHESIS
      // ──────────────────────────────────────────────────────────────────
      mmx_speech: tool({
        description:
          "Synthesize speech from text using MiniMax's speech-2.8-hd model. Use when the user wants a voiceover, narration, audio file, TTS, or to read text aloud. Saves an MP3 and returns the path. 40+ languages. Default voice: English_expressive_narrator.",
        args: {
          text: tool.schema
            .string()
            .describe("The text to speak. Up to 10,000 characters."),
          voice: tool.schema
            .string()
            .optional()
            .describe("Voice ID. Default English_expressive_narrator."),
          speed: tool.schema
            .number()
            .optional()
            .describe("Speech speed multiplier. Default 1.0."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Output .mp3 path. Default ~/Desktop/mmx-output/speech-<timestamp>.mp3"),
        },
        async execute(args, ctx) {
          const outPath =
            args.out_path ?? join(DEFAULT_OUT_DIR, `speech-${Date.now()}.mp3`)
          ensureDir(outPath.replace(/\/[^/]+$/, ""))
          const extra: string[] = []
          if (args.voice) extra.push(`--voice ${args.voice}`)
          if (args.speed != null) extra.push(`--speed ${args.speed}`)
          extra.push(`--out ${outPath}`)
          extra.push(`--non-interactive`)
          const proc = await $`mmx speech synthesize --text ${args.text} ${extra.join(" ")}`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx speech synthesize failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          return `Speech synthesized.\n\nSaved to: ${outPath}`
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // VIDEO GENERATION
      // ──────────────────────────────────────────────────────────────────
      mmx_video: tool({
        description:
          "Generate a short video from a text prompt using MiniMax's Hailuo-2.3 model. Use when the user wants a video clip, animation, or motion graphic. Generation can take 1-3 minutes. Returns the output MP4 file path.",
        args: {
          prompt: tool.schema
            .string()
            .describe("Detailed description of the video scene, including camera movement and action."),
          model: tool.schema
            .string()
            .optional()
            .describe("Model ID. Default MiniMax-Hailuo-2.3. Use MiniMax-Hailuo-2.3-Fast for quicker lower-quality results."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Output .mp4 path. Default ~/Desktop/mmx-output/video-<timestamp>.mp4"),
        },
        async execute(args, ctx) {
          const outPath =
            args.out_path ?? join(DEFAULT_OUT_DIR, `video-${Date.now()}.mp4`)
          ensureDir(outPath.replace(/\/[^/]+$/, ""))
          const extra: string[] = []
          if (args.model) extra.push(`--model ${args.model}`)
          extra.push(`--download ${outPath}`)
          extra.push(`--non-interactive`)
          const proc = await $`mmx video generate --prompt ${args.prompt} ${extra.join(" ")}`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx video generate failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          return `Video generation complete.\n\nSaved to: ${outPath}`
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // MUSIC GENERATION
      // ──────────────────────────────────────────────────────────────────
      mmx_music: tool({
        description:
          "Generate a song or instrumental music from a style prompt using MiniMax's music-2.6 model. Use when the user wants background music, a theme song, a jingle, or instrumental music. Either supply lyrics or set instrumental=true.",
        args: {
          prompt: tool.schema
            .string()
            .describe("Style description: genre, mood, instruments, tempo. E.g. 'cinematic orchestral, building tension'."),
          lyrics: tool.schema
            .string()
            .optional()
            .describe("Song lyrics with structure tags like [Verse], [Chorus]. Omit for instrumental."),
          instrumental: tool.schema
            .boolean()
            .optional()
            .describe("If true, generate instrumental music with no vocals."),
          vocals: tool.schema
            .string()
            .optional()
            .describe("Vocal style hint, e.g. 'warm male baritone'."),
          bpm: tool.schema.number().optional().describe("Exact tempo in BPM."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Output .mp3 path. Default ~/Desktop/mmx-output/music-<timestamp>.mp3"),
        },
        async execute(args, ctx) {
          const outPath =
            args.out_path ?? join(DEFAULT_OUT_DIR, `music-${Date.now()}.mp3`)
          ensureDir(outPath.replace(/\/[^/]+$/, ""))
          const extra: string[] = []
          if (args.lyrics) extra.push(`--lyrics ${args.lyrics}`)
          if (args.instrumental) extra.push(`--instrumental`)
          if (args.vocals) extra.push(`--vocals ${args.vocals}`)
          if (args.bpm != null) extra.push(`--bpm ${args.bpm}`)
          extra.push(`--out ${outPath}`)
          extra.push(`--non-interactive`)
          const proc = await $`mmx music generate --prompt ${args.prompt} ${extra.join(" ")}`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx music generate failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          return `Music generation complete.\n\nSaved to: ${outPath}`
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // WEB SEARCH
      // ──────────────────────────────────────────────────────────────────
      mmx_search: tool({
        description:
          "Search the web using MiniMax's search API. Use when the user wants current information, news, facts, or anything time-sensitive. Returns a textual summary of search results.",
        args: {
          query: tool.schema.string().describe("The search query."),
        },
        async execute(args, ctx) {
          const proc = await $`mmx search query --q ${args.query} --output json --non-interactive`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx search failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          return proc.stdout.toString().trim() || "(no results)"
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // VISION (image understanding)
      // ──────────────────────────────────────────────────────────────────
      mmx_vision: tool({
        description:
          "Describe or analyze an image using MiniMax's vision model. Pass a local file path or URL. Returns a textual description. Useful when the user uploads an image and wants analysis, OCR, or a description.",
        args: {
          image: tool.schema
            .string()
            .describe("Local file path or URL of the image."),
          prompt: tool.schema
            .string()
            .optional()
            .describe("Custom question about the image. Default 'Describe the image.'"),
        },
        async execute(args, ctx) {
          const extra: string[] = []
          if (args.prompt) extra.push(`--prompt ${args.prompt}`)
          extra.push(`--non-interactive`)
          const proc = await $`mmx vision describe --image ${args.image} ${extra.join(" ")}`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx vision describe failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || proc.stdout.toString() || "(no output)"}`
          }
          return proc.stdout.toString().trim() || "(no description)"
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // QUOTA CHECK
      // ──────────────────────────────────────────────────────────────────
      mmx_quota: tool({
        description:
          "Show current Token Plan usage and remaining quota (5-hour rolling and weekly windows). Use when the user asks about quota, usage, limits, or how many calls they have left.",
        args: {},
        async execute(_args, ctx) {
          const proc = await $`mmx quota`.nothrow()
          if (proc.exitCode !== 0) {
            return `mmx quota failed (exit ${proc.exitCode}):\n${proc.stderr.toString() || "(no stderr)"}`
          }
          const raw = proc.stdout.toString().trim()
          let data: any
          try {
            data = JSON.parse(raw)
          } catch {
            return raw || "(no quota info)"
          }
          const rows = (data.model_remains ?? []).map((m: any) => {
            const reset = new Date(m.end_time).toUTCString().replace(/^[^,]+,\s*/, "")
            return `| ${m.model_name} | ${m.current_interval_remaining_percent}% left | ${m.current_weekly_remaining_percent}% left | resets ${reset} |`
          })
          const header = "| Model | 5h window | Weekly | Next reset |\n|---|---|---|---|"
          return `Quota — Token Plan\n\n${header}\n${rows.join("\n")}\n`
        },
      }),
    },
  }
}
