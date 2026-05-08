# Voice Mode Plan — Power Glove

**Status:** Proposal, awaiting go-ahead.  Written 2026-04-29.
**Goal:** Two-mode voice output (`/voice off` | `/voice on`) so Power Glove can read its replies aloud over AirPods, hands-free, with zero new vendor bills.

This plan cites every external library, API, and constraint to an official source.  Where the official docs were silent or contradictory, I've marked the section with **FACT-CHECK GAP** and listed what to verify before implementation.

---

## 1. Scope

- **Two states only:** `off` (current text behavior) and `on` (voice replaces text).  No middle "reply-in-kind" mode.
- **No new vendor relationships.**  Cloud TTS providers (OpenAI, ElevenLabs) are excluded by design.
- **Stack stays in Power Glove's existing language:** TypeScript / Node 22 / ESM / grammy.  Verified from `package.json` (nanoclaw v1.2.52) — dependencies include `grammy ^1.39.3`, `whisper-node ^1.1.1`, `better-sqlite3 11.10.0`.

---

## 2. Verified facts the plan rests on

### 2.1 Telegram `sendVoice` constraints

> "To use sendVoice, the file must have the type audio/ogg and be no more than 1MB in size. 1-20MB voice notes will be sent as files."
> — [telegram-bot-sdk reference (mirror of core.telegram.org/bots/api)](https://telegram-bot-sdk.readme.io/reference/sendvoice)

> "your audio must be in an .ogg file encoded with OPUS (other formats may be sent as Audio or Document)"
> — same reference

**Practical implication:** to keep the AirPods auto-advance + speed-control UX, every voice note must be **≤1MB OGG/Opus**.  Above 1MB Telegram silently downgrades it to a generic audio/document attachment, breaking the queue UX.

**FACT-CHECK GAP:** `core.telegram.org/bots/api#sendvoice` repeatedly returned truncated content via WebFetch.  The 1MB number is corroborated by the official-mirror SDK reference and by multiple secondary sources, but I was not able to quote it from the canonical Telegram URL directly.  Before merging, verify by curl-ing the page and grep-ing for "1MB" or by sending a 1.1MB OGG to a test bot and observing whether Telegram displays it as a voice note or a file.

### 2.2 grammy's `sendVoice` / `replyWithVoice` API

Method signature, from grammy reference docs:

```typescript
sendVoice(
  chat_id: number | string,
  voice: InputFile | string,
  other?: Other<R, "sendVoice", "chat_id" | "voice">,
  signal?: AbortSignal,
);
```
— [grammy.dev/ref/core/api](https://grammy.dev/ref/core/api)

`InputFile` accepts a `Buffer`/`Uint8Array` directly:

```typescript
const buffer = Uint8Array.from([65, 66, 67]);
await ctx.replyWithVoice(new InputFile(buffer));
```
— [grammy.dev/guide/files](https://grammy.dev/guide/files)

This means we never need to write a temp file to disk — the OGG bytes can stream from ffmpeg straight into `new InputFile(buffer)`.

### 2.3 Kokoro TTS (the chosen TTS engine)

- **Package:** [`kokoro-js` on npm](https://www.npmjs.com/package/kokoro-js), maintained by Xenova (Hugging Face's ONNX maintainer).  Pure JS, runs in Node via ONNX Runtime — no Python, no GPU required.
- **Install:** `npm i kokoro-js` — [npm package page](https://www.npmjs.com/package/kokoro-js).
- **Model:** [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) on Hugging Face, auto-downloaded on first use via `KokoroTTS.from_pretrained()`.
- **License:** Apache-2.0 (model and code) — [HF model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).  Commercial-safe.
- **Parameter count:** 82M — [hexgrad/kokoro README](https://github.com/hexgrad/kokoro).
- **Model size on disk** (from HF model card):

| Precision | File | Size |
|---|---|---|
| fp32 | model.onnx | 326 MB |
| fp16 | model_fp16.onnx | 163 MB |
| **q8 (recommended)** | model_quantized.onnx | **92.4 MB** |
| q8f16 | model_q8f16.onnx | 86 MB |
| q4 | model_q4.onnx | 305 MB |
| q4f16 | model_q4f16.onnx | 154 MB |

q8 is the documented default in the [kokoro-js example](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md): `dtype: "q8"`.

- **Voices available** (from the [HF model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)):
  - American Female: `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`
  - American Male: `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa`
  - British Female: `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily`
  - British Male: `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis`

  Default voice: `af_heart` (per the official example).

- **Documented usage** (from the [kokoro-js README](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md)):

  ```javascript
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: "q8",
    device: "cpu"  // "cpu" for Node.js, "wasm" or "webgpu" for browser
  });
  const audio = await tts.generate("Life is like a box of chocolates...", {
    voice: "af_heart"
  });
  audio.save("audio.wav");
  ```

- **Streaming API** (also from the README):

  ```javascript
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter);
  splitter.push(token);
  splitter.close();
  // stream yields { text, phonemes, audio } per sentence-ish chunk
  ```

- **FACT-CHECK GAP — audio object's API surface:**  the README documents `.save(path)` writing a WAV file, and the streaming API yielding `{ text, phonemes, audio }` per chunk.  It does **not** explicitly document a `.toBuffer()`, `.toBlob()`, or raw `Float32Array` accessor on the returned audio object, nor does it document the sample rate (likely 24kHz based on the underlying Kokoro-82M model, but unverified for the JS port).  Before implementation, read `node_modules/kokoro-js/dist/index.d.ts` after install to enumerate the actual TypeScript types.  If `.save()` is the only documented exit point, the implementation will write to a tempfile then read it back — slightly less elegant but functionally fine.

### 2.4 What's in Power Glove already (verified by reading the repo)

- `src/text-styles.ts` exists — confirmed by `ls`.  This is the existing per-user formatting module; voice mode preference belongs adjacent to it.
- `whisper-node ^1.1.1` is the inbound STT pipeline — voice TTS becomes its mirror image, both local neural models.
- `better-sqlite3` is the persistence layer — per-user voice mode flag goes in the same DB, not a separate JSON file.
- `V2_MIGRATION_PLAN.md` at the repo root sets the convention for plan docs.  This file matches.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Telegram inbound: /voice on | /voice off | /voice (status)     │
│                            │                                     │
│                            ▼                                     │
│              src/voice-mode.ts (new)                             │
│                  setUserVoiceMode(userId, on|off)                │
│                  getUserVoiceMode(userId) → bool                 │
│                  persisted in nanoclaw.db (better-sqlite3)       │
└─────────────────────────────────────────────────────────────────┘

When Claude Code emits a reply:
┌─────────────────────────────────────────────────────────────────┐
│  src/router.ts (existing)                                        │
│       │                                                          │
│       ▼                                                          │
│  if voiceMode(userId) === 'on':                                  │
│       send to voice-mode.ts → speak()                            │
│  else:                                                           │
│       existing text path (unchanged)                             │
└─────────────────────────────────────────────────────────────────┘

speak(text, ctx):
┌─────────────────────────────────────────────────────────────────┐
│  1. Sentence-chunk text (greedy pack to ~1200 chars per chunk)  │
│  2. For each chunk:                                             │
│       a. kokoro-js → WAV (Float32 PCM @ 24kHz, mono)            │
│       b. ffmpeg: WAV → OGG/Opus @ 32kbps                        │
│       c. Verify chunk ≤ 1MB (else re-split)                     │
│       d. ctx.replyWithVoice(new InputFile(oggBuffer))           │
│  3. Telegram queues; AirPods auto-advance                        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Why ~1200 chars per chunk

Audio bitrate math, from [Opus codec docs](https://opus-codec.org/):

- Kokoro outputs 24kHz mono PCM (per Kokoro-82M model card; **FACT-CHECK GAP** for JS port specifically).
- Speech rate ≈ 150 words/min ≈ 750 chars/min ≈ 12.5 chars/sec.
- At 32 kbps Opus (good voice quality), 1MB ≈ 250 seconds ≈ 4 minutes of speech ≈ ~3000 chars.

So 1200 chars is **well under** the 1MB cap, leaving headroom for prosody variation (slow speakers eat more bytes per char).  This is the conservative default.  Tunable in config.

### 3.2 Sentence chunking

kokoro-js exports `TextSplitterStream` — its built-in chunker.  Use that for the streaming path.  For the simple non-streaming path (call `tts.generate()` per chunk), do our own greedy pack on sentence boundaries:

```typescript
// pseudocode
function chunkText(text: string, maxChars = 1200): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxChars && current) {
      chunks.push(current);
      current = s;
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
```

The regex covers ~95% of English text correctly per the [Tessmore/sbd README](https://github.com/Tessmore/sbd) (the canonical npm sentence-boundary lib).  If we hit edge cases (decimals, abbreviations like "Dr.", code blocks), upgrade to:

```bash
npm i sbd
```

— [sbd on npm](https://www.npmjs.com/package/sbd).  MIT license.  API: `require('sbd').sentences(text)`.

### 3.3 ffmpeg for OGG/Opus encoding

Power Glove already depends on ffmpeg (whisper-node calls it).  No new system dep.

Command (verified against [opus-codec.org docs](https://opus-codec.org/) and the [dev.to Telegram TTS pipeline reference](https://dev.to/ngviethoang/build-a-telegram-voice-chatbot-using-chatgpt-api-and-whisper-53e2)):

```bash
ffmpeg -loglevel error -i input.wav -c:a libopus -b:a 32k -application voip output.ogg
```

- `-c:a libopus` — Opus codec
- `-b:a 32k` — 32 kbps target.  Speech-quality threshold per [Opus quality recommendations](https://wiki.xiph.org/Opus_Recommended_Settings) (16-32 kbps for narrowband voice).
- `-application voip` — optimizes Opus's psychoacoustic model for speech (not music).  Per the same Xiph wiki.

Run via `child_process.spawn` with stdin/stdout pipes — no tempfile dance.

**FACT-CHECK GAP:** if the kokoro-js audio object only exposes `.save(wavPath)` (no buffer accessor), we'll need a tempfile after all.  Plan for both paths and pick post-install based on actual TS types.

---

## 4. Implementation steps

1. **Add npm dep:** `npm i kokoro-js` ([source](https://www.npmjs.com/package/kokoro-js))
2. **Optional dep:** `npm i sbd` if regex chunker proves too brittle ([source](https://www.npmjs.com/package/sbd))
3. **New file `src/voice-mode.ts`:**
   - `getUserVoiceMode(userId): boolean` (reads from nanoclaw.db)
   - `setUserVoiceMode(userId, on: boolean): void` (writes to nanoclaw.db)
   - `speak(ctx, text): Promise<void>` — chunks, generates, encodes, sends
   - Lazy-init the KokoroTTS singleton on first use (model download is ~92MB, ~20s download, then cached forever in `~/.cache/huggingface`)
4. **DB migration** in `src/db.ts`: add `voice_mode INTEGER DEFAULT 0` to the user-prefs table (find existing user-prefs schema first; do not invent a new table).
5. **Command handler** in `src/router.ts`: add `/voice on`, `/voice off`, `/voice` (= status) — match the existing `/style` or similar slash-command pattern in `text-styles.ts`.
6. **Reply gate:** wherever Power Glove currently calls `ctx.reply(text)` with the final assistant message, branch on `getUserVoiceMode(ctx.from.id)`.  Find the call site in `src/index.ts` or `src/router.ts`.
7. **System-prompt nudge** (nice-to-have, deferred): when voice is on, append "Reply concisely; this will be read aloud" to the system prompt sent to Claude Code.  Reduces long-reply chunking overhead at the source.
8. **Tests:** add `src/voice-mode.test.ts` — mock the KokoroTTS singleton, assert chunking math, assert ffmpeg is invoked with the documented flags.  Match the existing vitest pattern in `formatting.test.ts`.

---

## 5. Open questions / fact-check gaps to resolve before merging

1. **kokoro-js audio object's exposed API.**  Does it have `.toBuffer()` / `.audio` (Float32Array) / a sample-rate property?  Read `node_modules/kokoro-js/dist/index.d.ts` after install.  Source: official type definitions, not docs.
2. **Sample rate** of kokoro-js output (likely 24kHz like the parent model, unverified for JS port).  Pass through ffmpeg with `-ar 24000` if needed; or let ffmpeg auto-detect from the WAV header.
3. **First-run model download UX.**  92MB pulled on cold start blocks the first voice reply for ~20s.  Plan: pre-warm at process boot, behind a feature flag.  Per the [HF docs on transformers.js caching](https://huggingface.co/docs/transformers.js), the model caches to `~/.cache/huggingface/hub/` and persists.
4. **Telegram primary-source quote of the 1MB cap.**  WebFetch couldn't pull `core.telegram.org/bots/api#sendvoice`.  Verify via `curl https://core.telegram.org/bots/api | grep -A5 sendVoice` before relying on the 1MB number for production chunking math.
5. **whisper-node ↔ kokoro-js ONNX runtime conflict.**  Both may pull `onnxruntime-node` transitively at different versions.  Run `npm ls onnxruntime-node` after install to verify there's a single resolved version.  If not, add an `overrides` field in package.json.
6. **Container memory budget.**  Per `feedback_docker_containers.md`, Power Glove runs in Docker; Kokoro q8 is ~92MB on disk + ~200MB RAM at inference.  Verify the container memory limit accommodates this (check `container/Dockerfile` and any compose limits).

---

## 6. Test plan

- Unit: chunking math, ffmpeg flag construction, DB read/write of voice_mode flag.
- Integration: send a 5-sentence reply with `voice on`; assert N voice notes arrive, each ≤1MB.
- Integration: send a 50-sentence reply; assert auto-advance works (manual eyeball + AirPods listen).
- Integration: `/voice off` mid-conversation; assert next reply is text again.
- Regression: existing text path is byte-identical with `voice off` (default).

---

## 7. References — every cited source

**Official docs (primary sources):**
- [grammy.dev/ref/core/api](https://grammy.dev/ref/core/api) — sendVoice signature
- [grammy.dev/guide/files](https://grammy.dev/guide/files) — InputFile constructors
- [npmjs.com/package/kokoro-js](https://www.npmjs.com/package/kokoro-js) — install, version
- [github.com/hexgrad/kokoro](https://github.com/hexgrad/kokoro) — license, parameter count, base example
- [github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md) — kokoro-js full README (voice list, dtypes, streaming API)
- [huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) — model file sizes per precision, full voice identifier list
- [npmjs.com/package/sbd](https://www.npmjs.com/package/sbd) and [github.com/Tessmore/sbd](https://github.com/Tessmore/sbd) — sentence boundary detection (optional dep)
- [opus-codec.org](https://opus-codec.org/) and [wiki.xiph.org/Opus_Recommended_Settings](https://wiki.xiph.org/Opus_Recommended_Settings) — Opus bitrate and `-application voip` flag

**Official sources that didn't fully resolve (FACT-CHECK GAPS):**
- [core.telegram.org/bots/api#sendvoice](https://core.telegram.org/bots/api#sendvoice) — primary spec for sendVoice; WebFetch returned truncated content.  1MB cap corroborated by mirror sources but not quoted from canonical URL.

**Mirrors and secondary sources used to corroborate:**
- [telegram-bot-sdk.readme.io/reference/sendvoice](https://telegram-bot-sdk.readme.io/reference/sendvoice) — official-mirror reference, quoted the 1MB / 1-20MB / OGG-Opus rules.
- [dev.to: Telegram voice chatbot ChatGPT + Whisper](https://dev.to/ngviethoang/build-a-telegram-voice-chatbot-using-chatgpt-api-and-whisper-53e2) — reference ffmpeg libopus pipeline.

---

## 8. What this plan deliberately does not include

- **No three-mode "reply-in-kind" logic.**  Excluded per scope decision 2026-04-29.
- **No text twin alongside voice.**  Voice replaces text when on.
- **No cloud TTS provider.**  Excluded per "free, no new vendor" constraint.
- **No streaming-as-Claude-types audio.**  Possible with `tts.stream()` + `TextSplitterStream`, but adds complexity for marginal latency gain.  Defer to v2.
- **No system-prompt nudge in v1.**  Listed as nice-to-have; ship without it, observe whether long replies are actually a problem in practice.
