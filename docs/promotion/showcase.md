# Showcase — what to generate with hl-plugins

The headline capability is **images, in chat, with no tab switching**.
Below are copy-pasteable prompts that produce useful results. Aspect
ratios and seeds are tuned for each use case.

## Images (mmx_image)

| Use case | Prompt | `aspect_ratio` | `seed` |
|---|---|---|---|
| Logo / brand mark | `minimal geometric mark for a developer tool, single continuous line forming a stylized "Q", flat single color on white, no text, modern, scalable` | `1:1` | `13` |
| Hero / OG image | `wide cinematic hero shot, abstract floating geometric shapes, deep navy gradient with soft teal and coral highlights, subtle film grain, no text` | `16:9` | `7` |
| Social square | `vibrant flat illustration of a developer at a standing desk, oversized headphones, warm sunset palette, friendly, no text` | `1:1` | `21` |
| Sprite / icon | `pixel-art treasure chest, 16-bit JRPG style, gold trim on dark wood, soft glow, transparent background feel, crisp edges` | `1:1` | `99` |
| Vertical thumbnail | `phone-thumbnail composition, top-down view of a coffee cup and open laptop on a wooden desk, morning light, cozy` | `9:16` | `31` |
| Mood / cinematic | `dark moody wide shot, lone astronaut standing at the edge of a crater, distant blue planet on the horizon, dust in the air, anamorphic lens flare` | `21:9` | `3` |
| Product mock | `sleek wireless earbuds on a polished concrete surface, soft overhead studio lighting, minimal, premium product photography` | `4:3` | `17` |
| Blog header | `isometric illustration of a small server room, pastel colors, friendly mascot character looking up, soft shadows, no text` | `16:9` | `55` |

### The demo prompt (cyberpunk cat)

Used across the README, X thread, and demo GIF:

```
cyberpunk cat with neon sunglasses, sitting on a rain-soaked rooftop,
glowing city skyline behind, neon teal and magenta lighting, cinematic
composition, shallow depth of field
aspect_ratio: "16:9"
optimize_prompt: true
seed: 42
```

### Iterating in chat

The LLM reuses `mmx_image` with updated args. Same tool loop as your file edits.

```
> draw a cyberpunk cat with neon sunglasses, sitting on a rain-soaked rooftop, 16:9, seed 42
[saved] image-1718812345.png

> make the cat orange instead of black
[regenerating, same seed for composition]
[saved] image-1718812401.png

> add lightning in the background
[regenerating]
[saved] image-1718812512.png
```

---

## Other modalities (one-liners)

- **Video** (`mmx_video`, Hailuo-2.3) — short MP4 from a scene description. 1–3 min generation.
- **Music** (`mmx_music`) — instrumental or with lyrics. Style prompt + optional BPM.
- **Speech** (`mmx_speech`, speech-2.8-hd) — voiceover / narration MP3. 40+ voices.
- **Search** (`mmx_search`) — current info, news, facts.
- **Vision** (`mmx_vision`) — describe a screenshot the user dropped in.
- **Quota** (`mmx_quota`) — check before a batch.

### Video prompt examples

```
> cinematic drone shot pulling back from a cyberpunk rooftop bar at night,
  neon signs reflecting in puddles, slow motion, 8 seconds
```

```
> close-up of a hand placing a vinyl record on a turntable, soft warm light,
  dust particles in the air, vintage film look
```

### Music prompt examples

```
> lo-fi hip-hop beat, warm Rhodes piano, soft vinyl crackle, 75 bpm,
  instrumental, study session vibe
```

```
> synthwave, retro 80s, driving bassline, gated reverb snare, 110 bpm,
  instrumental
```

### Speech prompt example

```
> "Welcome to the future of coding. Your agent doesn't just write code
  anymore — it ships assets." — warm male narrator, measured pace
```

---

## Tips

- Be **specific**: subject, style, lighting, composition, mood.
- Use `seed` for reproducibility (same prompt + seed = same image).
- `optimize_prompt: true` when the prompt is short.
- Aspect ratio cheatsheet:
  - `1:1` — social square, logo, sprite
  - `16:9` — slide / landing hero, blog header
  - `9:16` — TikTok / Reels / vertical thumb
  - `4:3` — product mock, classic photo
  - `21:9` — cinematic, video background
- If `mmx_image` returns a failed exit code, surface the stderr verbatim —
  that's where mmx-cli writes quota errors, region errors, and validation
  issues.

---

## When NOT to use these tools

(From `packages/plugin-mmx/opencode/skill/mmx/SKILL.md`, reproduced for
discoverability in the gallery.)

- For diagrams, charts, tables, or anything textual — render with HTML/JSX instead.
- For tiny UI icons — too heavy; use SVG.
- If the user is on the free tier or hasn't authenticated, point them at the
  setup section before retrying.
