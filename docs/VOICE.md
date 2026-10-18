# Voice ("Jarvis mode")

Talk to Hermes and hear it answer, from anywhere in Jarod-OS. Hermes stays the brain in every
mode: the same sessions, tools, memory and approval cards; only the audio path changes.

## Starting a conversation

| How | Where |
| --- | --- |
| Global hotkey (`Alt+Space` by default) | Any app, while Jarod-OS runs |
| "Hey Hermes" wake word | Anywhere, when enabled in Settings > Voice |
| Microphone button | Menu bar, Overview composer, Hermes composer, Applications overlay |
| `herald-os voice [toggle\|start\|stop\|mute]`, `Mod+V` | Linux session |

While a conversation runs the orb sits at the bottom of the Hermes window: state (listening,
thinking, speaking), captions, mute, "stop talking" and end. Say "stop", "that's all" or
"never mind" to end it by voice. The menu-bar microphone lights whenever the mic is open.

After Hermes finishes speaking the mic keeps listening for a follow-up (8 s by default), then the
conversation closes on its own.

## Engines

### Free (default)

`mic -> transcription -> Hermes turn -> speech, streamed sentence by sentence`

- Turn latency is about two seconds (end-of-speech detection, transcription, first sentence).
- Speak over Hermes to interrupt it; the turn is stopped and your new request is sent.
- Nothing extra is billed. Speech providers come from the Hermes runtime's config and are chosen
  in Settings > Voice > Speech providers:

| Provider | Cost | Notes |
| --- | --- | --- |
| Nous subscription (`nous`) | Included | OpenAI `gpt-4o-mini-transcribe` / `gpt-4o-mini-tts` through the Nous gateway; needs a Nous Portal sign-in (`hermes portal`) with a plan that includes managed tools |
| On this device (`local` STT, `edge` TTS) | Free | faster-whisper runs offline; Edge neural voices need internet, no key |
| OpenAI / ElevenLabs / Groq / Mistral | Your key | Set the key in `~/.hermes/.env`; OpenAI and ElevenLabs stream PCM |
| NeuTTS / KittenTTS / Piper | Free, local | Install the matching extra in the Hermes venv |

If the configured provider cannot run (no API key, a managed gateway your account is not entitled
to, a missing package), Jarod-OS switches that setting to the free provider (`local` for speech
to text, `edge` for speech), tells you once, and retries. Pick a different provider in Settings
whenever you want it back.

### Live (opt-in)

OpenAI `gpt-live-1` listens and speaks over WebRTC, full duplex, and delegates every real request
to Hermes. Replies start in under a second and interruptions feel natural.

- Cost: **$0.05 per minute** of open session, billed per second by OpenAI (about 15 s minimum per
  session). Hermes's own tokens are unchanged.
- Needs an OpenAI key (`OPENAI_API_KEY` or `voice.gpt_live.api_key` in Hermes config) and Hermes
  0.21.3 or newer (`hermes update`). The Nous gateway does not proxy Live sessions.
- Cost controls in Settings > Voice: the session closes after `Close after silence` seconds of
  quiet (45 s default) and new sessions are refused once today's `Daily cap` is spent (60 min
  default). The orb shows the session clock and today's estimate. When Live cannot start, the
  free engine is used and the reason is shown.

## Controlling the OS by voice

Every user-visible action in Jarod-OS is a command in one registry (`apps/desktop/src/store/os-commands.ts`,
catalogue under `apps/desktop/src/commands/`). Three things call it:

1. **The voice fast path.** Simple utterances match a command locally in under 100 ms and cost no
   tokens: "open missions", "show my memory", "open the terminal", "close this window", "remember
   that I prefer short answers", "pause the daily digest", "start a mission to …", "open Safari",
   "hide the sidebar", "switch to the live voice engine". Hermes hears a short acknowledgement
   ("Opening Missions."). Anything that needs reasoning, is long, or is destructive goes to Hermes.
2. **Hermes itself** through the `os_ui` tool (bridge plugin): `list` the catalogue, read the
   screen `state`, `run` a command. Hermes uses it whenever you ask it to open, show, add, find or
   change something in the OS, and to show its work after its own memory / automation / file tools.
   Results (page, highlighted item, list data) flow back so it can answer precisely.
3. **The command bar** (Cmd+K, group "Do") and the `herald-os os <id> [json]` CLI on Linux.

You watch it happen: a caption at the top of the Hermes window names each action ("Remembered:
…", "Paused Daily digest") with its origin (voice / Hermes), the page switches, and the touched
item scrolls into view with a brief accent pulse. "Follow Hermes" (Settings > Voice) extends this to
typed conversations too.

**Typing and editing** act on the focused text field, the terminal, or the web page in front (the
field you were in before clicking the mic is remembered): "type how are you question mark",
"type ls -la and press enter", "new line", "press escape", "select all", "select the last word",
"copy", "cut", "paste", "undo", "redo", "delete that", "delete the last word", "clear the field",
"scroll down", "go to the top". Say "comma", "period", "question mark", "new line" for punctuation.

**Files and apps stay inside Jarod-OS.** "Open hello.pdf" (or "open hello dot pdf", "open the file
report") finds the file by name in your home folder (Spotlight on macOS, a bounded `find` on Linux;
exact names beat partial ones, user folders beat caches) and shows PDFs, images, text and media in a
Jarod-OS viewer window (Chromium's PDF viewer, no network, no downloads). Other file types open in
Files with the file selected; say "open it in its app" to hand one to macOS. "Open Apps" is the
Jarod-OS app launcher. A transcript that looks like a web address but ends in a file extension
("www.openhello.pdf") is treated as a file. When Hermes calls `system_open` while the shell is
running, web pages open in a Jarod-OS window, files in the viewer and folders in Files; only a
named Mac app ("open it in Preview") leaves the OS.

**Build something and watch it happen.** "Create a website for a hair salon" (also "build me …",
"make an app that …", "start a project to …") creates a project folder under `~/Projects`
(Settings > General > Projects folder), starts a Hermes session working there and opens the
**Studio**, one large window per session:

- Files: the project tree; new files are marked A, edited ones M, the one being written pulses.
- Code: the file Hermes is writing appears as it types, then syntax-coloured, with the lines each
  edit changed marked and scrolled into view. It follows Hermes from file to file; the pin keeps
  it on one file. One click opens it in your code editor.
- Terminal: every command Hermes ran with its output, plus a live read-only tab per background
  process (the dev server).
- Preview: the running site. The dev server's address is picked up from its output (or Hermes names
  it with `studio.preview`); a static site previews its `index.html`. It waits while the server
  starts and refreshes after each change.
- Header: what Hermes is doing now, the todo progress, a box to ask for a change, Stop, and the
  conversation.

Keep talking while it works: "make the header pink", "stop", "show me the code" (`studio.open`
brings the Studio back), "close the studio". A session you did not start with "build" shows a
caption the first time Hermes writes code; say "show me" to open its Studio.

**Windows** respond to plain verbs on the window in front: "close", "minimize" (or "minimise"),
"expand"/"maximize", "restore", "fullscreen", "go back".

The complete, always-current list is **Settings > Voice commands** (say "what can I say"): every
command grouped by area, the words to say, what it does, whether it asks first, and a Try button.

Command families: `page.open|back`, `window.focus|close|minimize|maximize|restore`, `text.type|newLine`,
`key.press`, `edit.selectAll|select|deselect|copy|cut|paste|undo|redo|delete`, `view.scroll`,
`overlay.*`, `sidebar.toggle`, `space.switch`, `help.commands`; `chat.new|open|stop|popout`; `mission.start|open|list|pause|markReviewed`;
`memory.show|search|add|update|forget`; `file.open|openExternal`, `files.open|show|search|reveal|newFolder`; `automation.list|show|run|pause|resume|create|delete`;
`connection.list|show|enable|disable`; `build.start`, `studio.open|preview|file|close`; `native.launch`, `web.open`; `settings.open`, `theme.set`, `accent.set`,
`motion.reduce`, `dock.autoHide`, `voice.engine.set`, `voice.duplex.set`, `voice.wake.set`; `agents.pauseAll`.

Tiers: `read` and `act` commands run immediately (audited when Hermes runs them); `mutate` (add a
memory, pause an automation, change a setting) runs and is shown in the caption; `destructive`
(forget, delete, trash) never runs from the fast path and asks for approval when Hermes runs it.

## Settings

Settings > Voice: enable, microphone permission, engine, wake word, hotkey (Electron accelerator
syntax), follow-up window, speak notifications aloud, speech providers, Live limits, and two test
buttons ("Say hello", "Start talking").

Preferences live in Jarod-OS's `prefs.json` (`voice.*`). Speech providers and the wake word's
enabled flag are written to the Hermes runtime's `config.yaml` (`stt.provider`, `tts.provider`,
`wake_word.enabled`) so `hermes tools` and the CLI see the same choice.

Local transcription accuracy: Hermes's default local model (`base`) mishears short commands. Once,
when voice is on and `stt.provider` is `local`, Jarod-OS sets `stt.local.model: small.en` (about
0.8 s per sentence on a laptop CPU) unless you chose another model, and writes a Jarod-OS
vocabulary to `stt.local.initial_prompt` unless you wrote your own. Settings > Voice > Transcription
model switches between fast, accurate, multilingual and most-accurate models.

## Requirements and troubleshooting

- macOS asks for microphone access on the first conversation. If it was denied: System Settings >
  Privacy & Security > Microphone > Jarod-OS.
- `npm run bootstrap` reports the runtime version and whether `openwakeword`, `faster_whisper` and
  `edge_tts` import in the Hermes venv (`pip install 'hermes-agent[voice]'` inside the venv adds them).
- When the model provider is signed out (expired or revoked login), Jarod-OS shows its sign-in
  card: one click opens the provider's page with a one-time code inside Jarod-OS, as a Jarod-OS
  window beside the card (never the system browser), and both the page and the card close
  themselves once the sign-in is approved. The voice says so too instead of failing silently.
  Settings > Hermes & agents > Account shows the current state and a Sign in button.
- The wake word runs inside the Hermes runtime (openWakeWord, on-device). On runtimes older than
  0.21.3 the runtime opens the host mic itself; newer ones take audio from Jarod-OS. Only one
  Hermes client can own the detector at a time.

## Architecture

```
apps/desktop/src/store/voice.ts          state machine, hotkey/CLI commands, announcements, Live accounting
apps/desktop/src/store/wake.ts           wake.start / wake.feed / wake.detected
apps/desktop/src/lib/voice/audio-capture.ts   one mic graph (AudioWorklet -> 16 kHz int16 frames)
apps/desktop/src/lib/voice/vad.ts        energy endpointing (utterance start/end, barge-in)
apps/desktop/src/lib/voice/chained-engine.ts  free engine
apps/desktop/src/lib/voice/live-engine.ts     GPT-Live engine (WebRTC + delegation loop)
apps/desktop/src/lib/voice/speak-stream.ts    /api/audio/speak-stream player, POST /api/audio/speak fallback
apps/desktop/src/lib/voice/speech-text.ts     sanitizer, sentence chunker, commentary chunking, stop phrases
apps/desktop/src/features/voice/               VoiceOrb, MicButton, VoiceIndicator
apps/desktop/electron/ipc/voice.ts        mic permission, audio WebSocket URL, global hotkey
```

Decisions: `docs/DECISIONS.md` ADR-013 (and the ADR-007 amendment).

## Duplex mode (Jarod-OS, 2026-10-18)

Speak while Jarod is answering to interrupt it, and correct a request without losing the thread.

### Modes

- **Duplex** (default, Settings › Voice › "Mode duplex"): the mic stays open while Jarod speaks. A stricter detector (`BARGE_IN_ENDPOINTER`: confirmation over a longer stretch, a higher threshold) tells your voice apart from Jarod's.
- **Classic**: the mic is closed while Jarod speaks. The stop button still interrupts.
- **Always shown**: the orb displays "écoute continue" in duplex mode, "micro coupé" when muted, and the mute button cuts the mic at once.

### What happens when you speak over Jarod

1. The audio stops at once: streaming player, sentence player, fallback audio.
2. The model's turn is interrupted (`host.interrupt()`).
3. The syllables already heard are kept for the next utterance (pre-roll).
4. The answer still being generated is invalidated: each playback is tied to its turn (`this.speak !== speak`, `this.sentences !== sentences`), and a synthesis that arrives after the stop is dropped (`SentenceSpeaker.stop`). An old answer can never start playing again.
5. The context separates **what was said aloud** from **what was generated but not heard**. Only the sentences actually started are kept, marked `[interrupted here by the user: the rest was not heard]`. The caption shows "— interrompu".

### Transcripts

- Speech-to-text works on the **whole utterance**, after the end of speech: there is no partial transcript, so nothing is acted on from an incomplete transcript.
- Destructive OS commands never run from the voice fast path (see "Tiers" above).
- Confirmations for sensitive actions are unchanged.

### With the Jarod core

The core does not serve `speak-stream`. Before, the whole answer was spoken once the model had finished. Now `SentenceSpeaker` sends each sentence to `/api/audio/speak` as soon as it is complete in the stream, synthesizing the next sentence while the current one plays.

### Echo

- The mic is opened with Chromium's `echoCancellation`, `noiseSuppression` and `autoGainControl` (`audio-capture.ts`).
- With speakers, Jarod's voice can still trigger an interruption. These are counted: an interruption followed by no words counts as "sans parole".
- **Headphones are the most reliable.** Without them, switch to classic mode if false interruptions happen.

#### Automatic reaction (`src/lib/voice/echo-guard.ts`, `src/store/voice-echo.ts`)

- **Threshold:** 3 interruptions with no words recognised within 60 s. A reply lasts 5–20 s and an echo cuts it within its first seconds, so a real echo reaches 3 well inside a minute; 2 would trip on one cough plus one stray noise.
- **Reset:** an interruption that held real words starts the count over. A normal request does not: after an echo the person repeats the request, and counting that would hide every echo.
- **Reaction:** Jarod switches to classic mode **for the rest of this Jarod-OS run** (the mic closes while it speaks; the stop button still interrupts) and shows one notification, "Écho détecté : mode classique", which explains why and suggests headphones. The orb shows "classique (écho)".
- **Reversible:** the notification has "Revenir au duplex" and "Garder le mode classique" (saved). The Settings › Voice duplex toggle and the `voice.duplex.set` command ("turn on duplex mode", "use classic voice mode") do the same. The saved `voice.duplex` preference is never changed until the person chooses; restarting Jarod-OS also returns to the saved choice.
- **Never loops:** the guard trips once per run. After it tripped, whatever the person chooses, no further prompt appears until Jarod-OS restarts.
- Live engine: not concerned (OpenAI handles echo in its WebRTC session).

### Privacy

No audio is recorded or kept. Transcripts live in the conversation like typed messages.

### Measurements (Settings › Voice › "Mesures de cette session")

These are measured, not targets. They are kept in memory for the current run:

- median time from the end of your speech to the transcript, to the model's first word, and to the first sound;
- median time from an interruption to silence;
- number of interruptions, and how many had no words.

Measured on 2026-10-18 on this machine:

| Measure | Result |
|---|---|
| Synthesis by the Jarod core, Windows voice | One sentence 241–264 ms; a four-sentence answer 268–293 ms (`e2e/voice-latency.spec.ts`) |
| Silencing on interruption | Synchronous in the code (stop + pause) |
| One spoken turn, real model (LM Studio, `qwen3.5-9b…`, already loaded), Chromium fake mic, core speech | End of speech → first model token 90–2510 ms; → first sound 850–3258 ms (3 runs, `e2e/voice-turn-latency.spec.ts`). Transcription was stubbed (no speech-to-text provider in the throwaway root): add your own transcription time on top |

**Not measured:**

- transcription with a real provider (the end-to-end test stubs it when the core cannot transcribe);
- interruptions and echo with a real microphone and speakers (the echo reaction is covered by unit tests only);
- behaviour under load.

#### Measuring a real turn yourself

`e2e/voice-turn-latency.spec.ts` drives one spoken turn through the real app: Chromium's fake capture device plays a question synthesized by Windows System.Speech, through the real mic graph, endpointer and free engine; the chosen model answers; the core speaks sentence by sentence. The engine records each stage per turn (`store/voice-metrics.ts`, `lastTurn`, exposed on the orb as `data-voice-turn`) and the test prints them. It is skipped unless a model is named:

```
cd apps/desktop
npm run build
$env:JAROD_E2E_VOICE_MODEL = 'lmstudio:<a model loaded in LM Studio>'   # <provider>:<model>, as the core names them
npx playwright test e2e/voice-turn-latency.spec.ts
```

The model is set in the test's throwaway root only (`PUT /api/config`); the real profile and its keys are never read. A provider that needs a key cannot be used this way, because launches strip provider keys from the environment; a local server (LM Studio, Ollama) needs none. If the core of the throwaway root can transcribe, the transcript stage is real; otherwise main answers `/api/audio/transcribe` with the known text and the line says "stubbed, not a measure". Each run prints `VOICE-TURN … transcript … → first token … → first sound …`.

### Tests

| Test | What it covers |
|---|---|
| `src/lib/voice/sentence-speaker.test.ts` | Fake audio: the first sentence plays while the answer streams; a stop silences at once and drops late syntheses; errors; empty answers |
| `vad.test.ts`, `speech-text.test.ts` | Existing |
| `src/lib/voice/echo-guard.test.ts` | Echo threshold (3), window (60 s), reset after a barge-in with words, trips once only |
| `src/store/voice-echo.test.ts` | Classic for the run, one notification with both choices, saved preference untouched until chosen, no second prompt |
| `e2e/voice-latency.spec.ts` | The core's real synthesis |
| `e2e/voice-turn-latency.spec.ts` | One spoken turn with a real model (opt-in, see above) |
