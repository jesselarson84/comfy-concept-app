# Comfy UI (the Comfy Concept app)

> **Setting it up?** Start with **[SETUP.md](SETUP.md)**: ComfyUI and its custom nodes, every model file the presets use (with download links and folders), Tailscale, installing it on your phone, and the optional Claude features.

The app shows up as **Comfy UI** on the phone (launcher label, PWA name, page title and share sheet). The repo, folders, package `app.jesse.comfyconcept` and internal names are still "Comfy Concept".

A phone and tablet front-end (an installable PWA) for the ComfyUI on your home PC. It is built for **concepting**: you type a prompt and get a batch of images, with an optional reference image.

```
Android phone/tablet --HTTPS (Tailscale)--> this app (127.0.0.1:3100 on the PC) --localhost--> ComfyUI (127.0.0.1:8188)
```

## Run it

1. Start Comfy Desktop.
2. Double-click `start.bat`, or run `npm start`. You need Node 22 or newer. Run `npm install` once (batch 16): the only dependency is the Claude SDK (`@anthropic-ai/sdk`); without it everything works except Claude.
3. On the PC, open http://127.0.0.1:3100/.

Settings live in `config.json`. Put your own overrides in `config.local.json`, which git ignores. Environment variables take priority over both:

| key | default | env |
|---|---|---|
| comfyUrl | `http://127.0.0.1:8188` | `COMFY_URL` |
| comfyUrlFallbacks | 8188, then 8000 (tried at startup only if `COMFY_URL` is not set) | |
| port / host | `3100` / `127.0.0.1` | `PORT` / `HOST` |
| workflowsDir / dataDir | `workflows` / `data` | `WORKFLOWS_DIR` / `DATA_DIR` |
| sessionGapMinutes | 90 | |
| outputSubfolder | `concept-app` (images go to `ComfyUI/output/concept-app/`; set `""` to leave prefixes alone) | |
| comfyOutputDir | `""` = ask ComfyUI (see below) | `COMFY_OUTPUT_DIR` |

**ComfyUI's output folder** (needed to delete results from History and for the "From Comfy UI" grid). ComfyUI has no API for deleting output files, so the app deletes them from disk and has to know where that folder is. It looks in this order:

1. `comfyOutputDir` in `config.local.json` (or `COMFY_OUTPUT_DIR`). Setting it is the most reliable. On the owner's PC (Comfy Desktop) it is `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output`, so `config.local.json` would contain `{ "comfyOutputDir": "C:\\Users\\the owner\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\output" }` (backslashes doubled in JSON). The path is not in the code.
2. ComfyUI's own command line, from `GET /system_stats` (8 s timeout): `--output-directory X`, `--output-directory=X`, or `--base-directory X` plus `\output` (what Comfy Desktop passes).
3. The last folder found by step 2, kept in `data/comfy-output-dir.json`, used while that folder still exists.

If none of these works, a delete answers *"ComfyUI output folder is unknown, nothing was deleted"*, and the reason is written to `data\server.log`.

**Deleting a file that is open** (a .glb still loading in the 3D viewer, a file open in another program) fails on Windows with `EBUSY`. The app retries for about a second, then reports *"File is in use (open in a viewer or another app), try again"* for that file and carries on with the rest of the selection. History keeps only the files that are still on disk.

### Bundled Node runtime (not in git)

`start.bat` and `start-background.vbs` use `runtime\node.exe` when it exists, and otherwise fall back to a system Node 22+. The binary is not committed. To restore it, download the official Node.js v24.22.3 Windows x64 `node.exe` from https://nodejs.org/dist/v24.22.3/win-x64/node.exe and put it in `runtime\`. Before using it, check it against https://nodejs.org/dist/v24.22.3/SHASUMS256.txt: the `win-x64/node.exe` line is `86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6`. In PowerShell, run `Get-FileHash runtime\node.exe`.
## ComfyUI settings: none needed

ComfyUI stays bound to **localhost only**. **You do not need `--listen`**. The app server runs on the same PC and reverse-proxies `/comfy/*` (HTTP and the websocket) to `127.0.0.1:8188`. Your phone never talks to ComfyUI directly. Leave Comfy Desktop's network settings at their defaults.

The proxy adds one small snippet to ComfyUI's own page at `/comfy/` (and only to that page): `app/comfy-tweaks.css` and `app/js/comfy-tweaks.js`. It hides ComfyUI's **Agent** button and removes the red *Comfy Agent error / Comfy Agent hit a server error* toasts. They are found by their text ("Agent", "Comfy Agent"), because ComfyUI's class names change between versions. If injecting fails for any reason, the page is served unmodified. The proxy also relaxes `X-Frame-Options` / CSP `frame-ancestors` from ComfyUI to same-origin so the app can show ComfyUI as its node view.

The proxy also rewrites the `Origin`/`Host` headers to ComfyUI's own address. Recent ComfyUI refuses requests whose Origin doesn't match its host. That is its protection against random web pages talking to a localhost ComfyUI.

## Remote access with Tailscale

1. Install Tailscale on the PC (https://tailscale.com/download/windows) and on the Android devices (Play Store). Sign in to the same account on every device.
2. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.
3. On the PC, in a terminal:
   ```
   tailscale serve --bg 3100
   ```
   This publishes `https://<pc-name>.<tailnet>.ts.net/` **only inside your tailnet**. It forwards to `http://127.0.0.1:3100` and handles HTTPS and websockets. `tailscale serve status` shows it, and `tailscale serve reset` turns it off. (Don't use `tailscale funnel`, which would make the app public.)
4. On the phone, open `https://<pc-name>.<tailnet>.ts.net/`.

The app has no login of its own. Anyone in your tailnet can use it.

## Install the PWA on Android

Open the HTTPS URL in **Chrome**, then go to the menu and choose **Install app** (or *Add to Home screen*). Once it is installed:
- It opens full screen like a native app.
- **Share -> Comfy UI** appears in the Android share sheet for images. A shared screenshot or photo is uploaded to ComfyUI. The app opens on the *FLUX.2 Klein 4B Image Edit* preset with that picture already in the slot. Shared text becomes the prompt.

Chrome only offers the share target for an installed PWA served over HTTPS, which is why Tailscale is needed.

## Using it

- **Preset picker** (top): **Models | Workflows** tabs, the same as ComfyUI's right-click *AI Models* / *AI Workflows* menus. **Workflows** holds the task pipelines: Textures / Concept / VFX (see *Models and Workflows*). **Models** has the sections 3D / Image / Video / Audio, with Image split into **Text to Image, Image Edit, Inpainting, Upscale** (from each preset's `menuPath`, e.g. `Image/Text to Image/Z-Image Turbo`; the last part is the short name the row shows, `menuOrder` sorts the rows; the button reads *Image › Text to Image › Z-Image Turbo* and drops *Image ›* on a narrow phone), and **My presets** at the bottom: presets saved from the node view, plus any workflow you import or drop into `workflows/`. The default preset is **FLUX.2 Klein 4B Text to Image**. A fresh client opens on it whenever it is available; if it is not, on the first available AI Workflow entry, never on My presets. After you pick a preset, the app reopens on your pick (`app/js/lib/preset-choice.js`; `/api/workflows` also returns this `default`).
  - The old built-in presets *Fast concept* and *From reference image* (the "App presets" section) are retired. Anything saved with them still works: the chosen preset in the browser, history entries (Reuse) map *Fast concept* to **FLUX.2 Klein 4B Text to Image** and *From reference image* to **FLUX.2 Klein 4B Image Edit**, and an old reference image lands in the Image Edit slot. The mapping happens when the app reads the data (`app/js/lib/legacy-presets.js`); `data/history.json`, `data/chats.json` and settings are not rewritten. Each row shows its live availability. **needs download** and **missing node** rows are greyed out; tap one to see why. **slow · RAM offload** and **tight on 11 GB** are hints. See *AI Workflow presets*.
- **Prompt, Aspect** (1:1 / 4:3 / 3:2 / 16:9 chips plus a portrait/landscape flip; the size is shown and kept inside the preset's range), **Batch (1-20), Seed** (Lock = fixed; the dice button picks a new one). The negative prompt toggle appears only if the workflow has a real negative text node. The klein presets do not: their negative is a zeroed copy.
- **Run** (the blue button; blue is used only here) queues *N separate jobs*. Thumbnails in the bottom strip (phone) or the right-hand grid (tablet) show progress, and each fills in as its job finishes.
- **While a run is going the form is locked** (prompt, aspect, batch, seed, Settings and reference slots): nothing can change until every job of the run has finished, failed or been cancelled. Cancel queue, the thumbnails and viewer, History, the canvas toggle and scrolling keep working (`app/js/ui/form-lock.js`).
- **Reconnecting**: coming back from another app reconnects the ComfyUI websocket at once (on visibility, focus, pageshow, online and the Android app's onResume; after more than 10 s away the socket is replaced even if it still looks open) and catches results up from `/history`. *Not connected to ComfyUI - retrying…* only appears when the connection has been down for 4 s (`app/js/lib/conn-banner.js`).
- **(i) next to every setting** opens a short plain-language explanation (tap outside or Escape closes it). The texts live in `app/js/lib/setting-info.js` (a glossary by setting name) and can be changed or added per preset in its JSON: `preset.params.<key>.info`, or `preset.info.<key>` for the other controls (`prompt`, `negative`, `aspect`, `batch`, `seed`, `image`, `image.<node>`, `mask`, `video`, `audio`). A unit test fails if any control of a bundled workflow has no text.
- **Cancel queue** removes your pending jobs from ComfyUI's queue and interrupts the one that is running.
- **Tap a thumbnail** to open the full-screen viewer:
  - Swipe left and right between images.
  - Pinch or double-tap to zoom.
  - Tap to hide or show the controls.
  - The star marks a favourite.
  - Save downloads the image to the device.
  - Share opens the Android share sheet.
  - Reuse loads that image's prompt and seed (locked).
- **History** (folder button, top bar): everything you have generated, from any device, grouped by day. Like the node view it is a toggle: the area under the top bar switches to your files and the top bar stays put; the workflow dropdown and Run hide meanwhile. Long-press to select; the selection bar (under the top bar) has a star that favourites the whole selection, or unfavourites it when it is all favourites already.
- **Viewer**: a gallery strip. Drag and the next picture slides in under your finger; a quick flick or a drag past a third of the screen moves on, otherwise it springs back; the ends rubber-band. Swipe down to close. The thumbnail strip at the bottom jumps to any picture. The trash button deletes that one picture from the PC (after a confirm) and shows the next.
- **Canvas button** (top bar) toggles the **node view**: ComfyUI's own UI (`/comfy/`) fills the screen under the app's top bar, and the button stays highlighted. Tap it again (or press Back) for the normal view. It opens the **selected preset's graph** (loaded when you enter after picking a different preset; going in and out with the same preset keeps your canvas edits). The ComfyUI page is loaded once and then only hidden and shown, so your graph, its undo history and its websocket survive switching back and forth, and ComfyUI's *Changes you made may not be saved* prompt does not appear. The workflow dropdown is hidden while the node view is shown, and History and the node view switch straight across. (`app/js/ui/node-view.js`)
- **Save preset** (top bar, node view only): saves the graph on the canvas as a preset. The sheet asks for a name, a section (3D / Image / Video / Audio / My presets) and, for Image, a sub section, and lists the controls the form will show (prompt, negative, pictures, aspect, seed, steps, strength: detected like a dropped-in workflow; anything else runs as built). Saving from a built-in preset always makes a new one; from one of your saved presets you get **Update** or **Save as new**. The ⚙ on a saved preset's row in the picker renames it, moves it to another section, or deletes it. Stored in `data/graph-presets.json` (git-ignored). (`app/js/ui/save-preset.js`, `server/graph-presets.js`)
- **Aspect / resolution**: the ratio dropdown, the orientation buttons (they only swap the numbers, 16:9 ↔ 9:16; hidden on 1:1) and, on text-to-image presets, **1K / 2K / 4K** (long side 1024 / 2048; 4K renders at 2K and upscales 2× with an installed 4x model in the same graph). Batch and Seed share the next row. (`app/js/lib/resolution.js`)
- **Dropdowns** (batch 15): the ratio grid, 1K / 2K / 4K, every dropdown under Settings and the Section pickers use the app's own pop-up instead of the phone's menu. It **stays open after a pick**, so you can try a few values; a tap outside (which does nothing else) or Escape closes it. The preset picker at the top still closes when you pick. (`app/js/ui/dropdown.js`)
- There is no ⋮ menu any more (batch 5): workflows arrive by exporting into `workflows/`, and a saved CPU text-encoder switch in `data/memory-settings.json` is still honoured.
## Prompt assistant, workflow actions and setup builder: removed (batch 15)

The Ollama chat under the prompt box (with its Undo / Versions), the chat's workflow actions (upscale, image to 3D) and the chat's setup builder are gone, to make room for a Claude integration. Ollama stays for the History tagger. An old `data/chats.json`, `data/user-presets.json` or `data/builder.json` is left on disk and no longer read.

## Claude (batches 16-17)

Claude (Anthropic's API) can fill in the form for you. It is **off by default**.

- **Settings** (gear in the top bar): *Use Claude* on/off, this month's spend ("About $X of $Y used this month · resets Dec 1"), the **monthly limit** (default $20), which model Claude starts on (Haiku / Sonnet / Opus) and the **API key**. Off = no Claude buttons anywhere, nothing is sent.
- **The key stays on the PC**: typed once on the phone, stored in `data/claude-key.json` (git-ignored) and never sent back (the phone only sees "Saved on your PC"). `ANTHROPIC_API_KEY` in the environment works too. Make the key at platform.claude.com in its **own Workspace** and give that Workspace a spend limit as a backstop.
- **Monthly limit**: the server adds up every reply's real cost from its `usage` (input, output, cache write / read at each model's price) in `data/claude-spend.json` and refuses Claude requests once the limit is reached, until the 1st of next month.
- **Prompt help** (the prompt's ⋮ → *Write prompt…* or *Talk prompt*, batch 17): a sheet with the model switch (resets to the Settings default each time the app opens) and one rounded input bar: text, a small mic and the orange send arrow. The mic uses the phone's own speech recognition (Web Speech in browsers; Android's SpeechRecognizer through the app's bridge) and sends by itself when you stop talking; *Talk prompt* starts listening at once. Claude **fills in the form and stops**: prompt, negative, preset, aspect, resolution, batch, seed, preset settings. You press Run or + Batch. What it changed gets an orange dot / outline, which stays until the run finishes. No summary, no Undo, and **one-shot**: every request starts fresh (no chat memory).
- **Ask Claude** (the floating Claude button, bottom right on every screen): questions about Comfy, your presets and settings. **Answers only**: it gets look-only tools and never changes the form.
- **Fix this result**: viewer ⋮ → *Ask Claude about this* (the picture, about 1024 px, plus its settings; always Opus).
- **Files**: select pictures (numbered in the order you tap them) → the Claude button. Merge looks, variations of one picture, or ask about them (Opus).
- **Variations**: "6 takes, vary the light" adds jobs to the **batch, not started**, each one different in a real way (Opus).
- **Building a workflow**: when no preset fits (e.g. 4 reference pictures), Opus builds a one-off graph. The server checks it against ComfyUI's live `/object_info` and installed models (`app/js/lib/graph-validate.js`); Claude gets the errors and may try 3 times, else it says it can't. It loads as a one-off preset (grey line "Claude"); the node view's *Save preset* keeps it. Never queued.
- **What Claude can do** is exactly the tools in `server/claude.js`: look (form, presets, a preset's settings, Files search, view a picture, and for Opus a preset's graph / node info) and change (form fields, preset settings, load pictures, add jobs unstarted, propose a graph). Every call is checked and clamped on the PC. No deleting, no Drive, no queueing, no other ComfyUI calls.
- **Cost**: Haiku / Sonnet / Opus per the switch; Opus for fix, Files, variations and building; the system prompt and tools are cached; at most 8 tool steps (14 for Opus) and 8k / 16k output tokens per request; each reply shows its cost. History tagging stays on Ollama.
- Tests never call the real API: `test/mock-claude.js` is a fake Claude server the SDK is pointed at (`baseURL`). When the SDK is not installed, the tests use a small stand-in client from that file instead; the app itself always uses the SDK.
- Batch 17 form changes: the preset button reads the model name in full with "Text to Image" under it (beside it on a tablet); the prompt box sizes itself (3 lines empty, up to 6 on a phone or 15 on a tablet, then it scrolls) with ⋮ *Expand* (full screen) and *Clear prompt* (with Undo); the + has its own strip; the negative prompt is a "+ Negative prompt" line until you turn it on; Z-Image Turbo is the default preset; Settings › *Reset to defaults when the app closes* (this device, off by default).
- Node view (also batch 16): the graph is fitted into view every time it is loaded or shown (ComfyUI's fit-view command, else by hand).
- Batch 18: the preset button has a GPU chip icon. The bottom area (Run bar, plus *This session* once it has pictures) is one slightly lighter panel with rounded top corners and a soft shadow, no divider lines; *This session* is hidden while empty. On a phone the floating Ask Claude button sits just above that panel (`--dock-h`, kept current in `app/js/main.js`), so it never covers a thumbnail.

## GPU & memory profiles (2080 Ti now, RTX 5080 later)

The app reads the GPU's name, total and free VRAM (`nvidia-smi`, falling back to ComfyUI `/system_stats`) and system RAM at startup and on refresh, and picks a profile from **total VRAM**. All numbers are in `config/memory-profiles.json` (edits apply without a restart).

| | small (< 12 GB, RTX 2080 Ti 11 GB) | large (16 GB+, RTX 5080 16 GB) |
|---|---|---|
| Before every ComfyUI queue | unload Ollama's model (the tagger's; `keep_alive: 0`, checked with `/api/ps`) | keep it, unless free VRAM - headroom < the workflow's `workflowVramNeedMB` |
| Out-of-memory fallback | ComfyUI `/free` {unload_models, free_memory}, retry once | ComfyUI `/free` {free_memory}, retry once |

- **RAM (96 GB) is spill and cache room.** `/api/memory` reports a badge "slower, runs partly in RAM (N% on GPU)" when a loaded Ollama model's `/api/ps size_vram < size`.
- **Override**: Menu (⋮) > GPU & memory > Profile (saved in `data/memory-profile.json`), or `"profile"` in the config file, or env `MEMORY_PROFILE`. Precedence: env > app setting > config file > auto.
- The app never closes or restarts ComfyUI; `/free` is an API call.
- **After the 5080 swap**: nothing to change here (auto-detect). ComfyUI's bundled PyTorch already supports it: torch 2.10.0+cu130, arch list sm_75 … sm_120 (checked 2026-11-21).

## Adding workflows

1. Build the graph in ComfyUI. You can do this on the PC, or on the phone in the **node view** (canvas button in the top bar).
2. Use **Workflow > Export (API)**. Only API format can be queued. The normal "Save" writes UI format, and the app rejects that with a message.
3. Save the file into `comfy-concept-app/workflows/`. The server watches the folder, so open apps refresh their dropdown on their own.
   (ComfyUI's own "Save" stores files in its user folder, not here. That is why Export is the route.)

The dropdown label comes from the filename: `my-cool-graph.json` becomes "My cool graph".

### How controls are detected (and the `#tags`)

The app reads the graph and finds these controls itself:
- **Prompt and negative**: it traces backwards from every sampler or guider's `positive` and `negative` inputs to the text-encoder nodes. The trace passes through ReferenceLatent, FluxGuidance and so on. A negative that goes through `ConditioningZeroOut` counts as "no negative".
- **Seed**: any `seed` or `noise_seed` input (KSampler, RandomNoise, ...).
- **Steps**: any `steps` input.
- **Size and batch**: literal `width`/`height`/`batch_size` on latent or scheduler nodes (EmptyLatentImage, EmptyFlux2LatentImage, Flux2Scheduler...). If width or height is *wired* from another node (for example GetImageSize), the aspect control is hidden.
- **Reference slots**: every `LoadImage` node.
- **Strength**: a `denoise` input, but only in graphs that have an image slot.

If an input is wired to a primitive node (PrimitiveInt, PrimitiveString...), the value is edited at that source node.

To override or extend detection, put a tag in a node's **title** in ComfyUI. A tag replaces auto-detection for its kind.

| tag | effect |
|---|---|
| `#prompt` | this node's text is the prompt |
| `#negative` | this node's text is the negative prompt |
| `#seed` | this node's seed/noise_seed/value is the seed |
| `#image` | this node's `image` is a reference slot |
| `#strength` | this node's denoise/strength/value is the strength slider |
| `#width` `#height` | size targets (the aspect buttons drive them) |
| `#steps` | steps field (under "More settings") |
| `#expose` | every literal input on the node becomes a generic field under "More settings" |

For a tagged node, the app tries the usual input names first, then the node's first input of the right type. A graph with nothing detectable is still listed, with a message, and runs exactly as saved.

## How it works (the ComfyUI API flow)

The full step-by-step explanation is in the comments at the top of `app/js/comfy-client.js`. In short:
1. The browser opens `wss://.../comfy/ws?clientId=<id>`.
2. It sends `POST /comfy/prompt {prompt: <API graph with your values injected>, client_id}` and gets back a `prompt_id`.
3. Websocket messages report progress for that `prompt_id`: `execution_start`, `executing {node}`, `progress {value,max}`, `executed {output.images}`, and `executing {node:null}` (meaning done).
4. Each image is shown with `GET /comfy/view?filename&subfolder&type=output`. Thumbnails add `&preview=webp;70`.
5. If websocket messages were missed (for example the phone slept), `GET /comfy/history/<prompt_id>` returns the outputs. The server also fills in history entries this way.

| file | what it is |
|---|---|
| `server/index.js` | routes; `/api/*`, `/share`, static files, proxy |
| `server/proxy.js` | HTTP and websocket reverse proxy, Origin rewrite |
| `server/workflows.js` | the `workflows/` folder: list, watch, import |
| `server/history.js` | `data/history.json` (metadata only, atomic writes, sessions) |
| `server/share.js` | Android share target -> `/upload/image` -> redirect |
| `app/js/lib/workflow-detect.js` | control detection (shared by server and browser) |
| `app/js/lib/workflow-inject.js` | writes your values into a copy of the graph |
| `app/js/comfy-client.js` | ComfyUI API: websocket, prompt, upload, cancel |
| `app/js/job-queue.js` | a batch of N jobs and their live state |
| `app/js/ui/*.js` | prompt panel, reference slots, thumbnails, viewer, history |
| `app/sw.js` | service worker (caches the app shell only) |
| `workflows/*.json` | presets |
| `scripts/write-presets.py` | generator for the two shipped presets |

History stores only metadata: prompt, seed, preset, size, favourite, and the image's filename/subfolder/type. **Image files stay in ComfyUI's output folder.** Deleting `data/history.json` deletes no images.

## AI Workflow presets (3D / Image / Video / Audio)

`workflows/ai/<id>.json` holds one preset for each of the 16 entries in ComfyUI's *AI Workflow* menu, plus **Chatterbox** and **VibeVoice** text-to-speech. Each file is `{ "preset": manifest, "workflow": API graph }`, and the picker lists it as `ai:<id>`. The manifest sets the group, label, output (image / video / audio / 3d), the size range, the clamped params (`min`/`max`/`default`; enums are filtered to the files that are installed), video input slots, a VRAM estimate and the model files.

- **Availability is computed live, never hard-coded.** The server reads ComfyUI's `/object_info` (node classes and combo lists) and `/models/<folder>`, and caches them for 60 s (`/api/workflows?fresh=1` re-reads them). VibeVoice's files are not listed by `/models/tts`, so they are checked on disk through `/internal/folder_paths`, and only when ComfyUI runs on this PC. A missing node or model file makes the preset **unavailable**, with the reason. Wan 2.2 5B and ACE-Step 1.5 show **needs download** until their models are installed. The app never downloads anything.
- **VRAM fit.** usable = GPU total - 1.2 GB for the desktop. A preset estimated at up to 85% of usable is ok; up to 100% is **tight**; up to usable + (free RAM - 8 GB) is **slow · RAM offload**; anything more is unavailable.
- **Memory profiles.** On the small profile (11 GB), Ollama is unloaded before every job. ComfyUI is also asked to `/free` its cached models when you switch to a different workflow and the free VRAM is below what that workflow needs (`freeComfyBeforeQueue: "on-switch"` in `config/memory-profiles.json`). The large profile never does this.
- Every value is clamped before queueing, and a message lists what changed. All outputs go under `output/concept-app/`. Video, audio and 3D results are download tiles ("Video ↓", "Audio ↓", "3D ↓").

### Models and Workflows

Presets come in two kinds (manifest `kind`, default `model`):

- **Models** run one model as it comes. They are grouped by output: 3D / Image / Video / Audio.
- **Workflows** (`kind: "workflow"`, files `workflows/ai/wf-*.json`) are multi-step pipelines for a task, grouped by task: **Textures**, **Concept**, **VFX**. They come from the *Comfy UI Ideas* doc.

The picker has a **Models | Workflows** tab for each kind. It opens on the tab of the current preset. ComfyUI's canvas right-click menu has two matching entries, **AI Models** and **AI Workflows**.

| Workflow | What it does | Needs |
| --- | --- | --- |
| Textures › Upscale Texture | Enlarges with an upscale model (4x), then fits to 1K / 2K / 4K on the long side. Nothing is repainted, so logos and text stay exact. | an upscale model |
| Textures › Remove Lighting | Removes baked-in shadows and highlights so a photo texture works as albedo. Uses the Qwen Image Edit 2511 graph with a built-in instruction. | as Qwen Edit 2511 |
| Textures › Make Seamless | Shifts the image by half so the old edges meet as a cross in the middle, fixes the cross, then shifts back. Only the cross changes. **AI repaint** (default): Z-Image Turbo plus the Fun ControlNet in inpaint mode redraws the cross, so shapes like bricks join up. **Blend**: the original is faded over the cross with a wide soft mask. It is instant, uses no AI, and suits noise-like surfaces. | Z-Image Turbo, lite ControlNet |
| Textures › Grunge Map | Z-Image Turbo makes the pattern. An offset blend makes it tile; in testing, an AI repaint flattened the grain into grey bands. Then grayscale (luma) and a contrast push. | Z-Image Turbo |
| Textures › Photo to Texture | A phone photo of a surface in, a tiling texture out. Your notes (e.g. "flatten the dented panel underneath, keep the chipped paint and every chip") go into Qwen Image Edit 2511 together with lighting removal. Then it can be made seamless (AI repaint or blend), and is upscaled with a model to 1K / 2K / 4K. | Qwen Edit 2511, Z-Image Turbo, lite ControlNet, an upscale model |
| Textures › PBR Maps | Normal, height, roughness, AO and an Unreal ORM map (R AO, G roughness, B metal) from one texture. Classic image math with core nodes only, like Materialize or CrazyBump: height from the picture's own detail, normals from wrap-around slopes (so tiling stays tiling). Options: DirectX or OpenGL green; "raised parts are lighter / darker" (light grout needs darker). Instant, local, fine for client work. | nothing |
| Textures › PBR Maps (CHORD) | Ubisoft's CHORD: base colour, normal, height, roughness, metalness, plus AO and ORM. **Research-only license.** Install ComfyUI-Chord through ComfyUI Manager and put `chord_v1.safetensors` (Hugging Face, Ubisoft/ubisoft-laforge-chord, accept the terms) in `models/checkpoints`; until then the preset shows *missing node*. | ComfyUI-Chord |
| Textures › Depth + Normal | Depth and scene normals from a photo or concept art (MoGe-2, core nodes). It shows the shape of a scene, not the fine detail of a flat texture (use PBR Maps for that). | MoGe-2 (installed) |
| Concept › Concept Looks (Edges / Depth) | Keeps the camera and layout of a Cinema 4D greybox, Redshift frame or depth pass, and takes the look from the prompt (Z-Image Turbo + Fun ControlNet). | Z-Image Turbo, full or lite ControlNet |
| VFX › Flipbook Sheet | Wan 2.2 5B clip on black. Evenly spaced frames are tiled into a 4×4 / 6×6 / 8×8 sheet for particle materials. | Wan 2.2 5B |

Concept Looks (Depth) can take a depth pass as it is, or estimate the depth from a normal render with MoGe ("Depth from").

Batch 7 also adds two **model** presets under Models › Audio:

- **Stable Audio 3 SFX:** sound effects and ambiences up to 2 minutes. It needs `stable_audio_3_small_sfx.safetensors` in `models/checkpoints` and `t5gemma_b_b_ul2.safetensors` in `models/text_encoders` (Comfy-Org/stable-audio-3; Stability AI Community License).
- **Chatterbox Voice Swap:** record a line with the performance you want, then swap only the voice to match a short target clip. It uses ChatterboxVC, zero-shot, already installed. Only use voices you have permission to use.

### Import (batch 7)

The top bar's **Import** button can:
- take a photo or record a video (through the system camera app);
- record audio in the app (the microphone; recorded dry, with no echo cancellation, noise suppression or auto gain);
- pick a photo, video or audio file from the device.

The file is uploaded to ComfyUI's input folder. **What next?** then lists only the presets that take that kind of file, and the one you pick gets the file in its slot. Audio slots also have their own **Record** button.

The Android app needs **versionCode 3** for live video and the microphone: video uses `ACTION_VIDEO_CAPTURE` (still no CAMERA permission), and `RECORD_AUDIO` is granted to the server's page only. The APK can be installed from `/download/comfy-ui.apk` on the server: copy the build to `app/download/` (git-ignored). The service worker leaves `/download/` alone.

ControlNet files go in `models/model_patches`, from alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1:
- `…-2.1-2602-8steps.safetensors`: full, 6.7 GB.
- `…-2.1-lite-2602-8steps.safetensors`: lite, 2 GB.

The full file plus Z-Image does not fit on an 11 GB card, so ComfyUI keeps the rest in system RAM.

Manifest extras used by workflows:
- `promptDefault`: a built-in instruction. It is shown as the prompt placeholder, and an empty prompt uses it.
- `promptFormat.template`: wraps what you type.
- `ComfyMathExpression` nodes: work out crop and mask sizes from the input picture, so any size works.

**ComfyUI menus:** the menu add-on lives in the repo at `comfyui/ComfyUI-AIWorkflowMenu`. After adding or changing a preset, rebuild its menus and install it:

```
node scripts/sync-comfy-menu.mjs --install "<ComfyUI>/custom_nodes"
```

Then reload the ComfyUI page; no restart is needed. Model presets that came from one of the add-on's hand-laid-out UI files keep that file. Everything else opens from an API-format copy and is laid out automatically. A unit test fails if the committed menu manifest is out of date.

## Tests

```
npm install            # dev only: playwright-core + a bundled Chromium for Linux
npm test               # detection, injection, history, server, proxy HTTP+WS, share, memory profiles (node:test)
npm run test:browser   # drives the real UI in headless Chromium against the mocks (app, presets, memory)
npm run dev:mock       # app + fake ComfyUI, http://127.0.0.1:3100 (no GPU needed)
```
`test/mock-ollama.js` is a fake Ollama (tags, ps, generate for the tagger, keep_alive 0 unload). `test/mock-comfy.js` is a fake ComfyUI. It has the same endpoints and websocket messages as the real one, returns placeholder PNGs, and has the same Origin check. On Windows, the browser tests use your installed Chrome through playwright-core's `channel: 'chrome'`, or `CHROME_PATH`.

## Decisions

- **Default port 8188**, matching Comfy Desktop v0.46.1. If `COMFY_URL` is not set, the app also tries 8000 at startup. The app itself listens on **127.0.0.1:3100**.
- **No `--listen`**: ComfyUI stays on localhost and the app proxies to it.
- **Zero runtime dependencies**. There is no Express and no `ws`: the websocket proxy splices raw sockets after the 101 upgrade, and multipart is parsed by a 60-line parser. The mock's websocket server is also hand-written. The only dev dependencies are for browser tests.
- **One detection module** (`workflow-detect.js`) is used by both the server and the browser, so the controls listed and the values injected always agree.
- **Batch = N separate ComfyUI jobs**, each with batch_size 1, so images arrive one at a time. **Random seeds**: each job gets a new one. **Locked seed**: job *i* uses seed+i, so job 1 reproduces the locked seed exactly.
- **Aspect**: portrait 2:3, square 1:1, landscape 3:2. The preset's pixel count is kept and sizes are rounded to multiples of 16 (1024² becomes 832x1248 / 1248x832). Width and height are written into *every* target. In Flux.2 that means EmptyFlux2LatentImage *and* Flux2Scheduler.
- **"From reference image" preset (retired in batch 1, now the test fixture `test/fixtures/workflows/basic-reference.json`)**: built from your klein_ref workflows. The pipeline is LoadImage -> ImageScaleToTotalPixels (1MP) -> VAEEncode -> ReferenceLatent on the positive and on the zeroed negative.
  - **Strength**: klein's sampler has no `denoise`, so strength is a `SplitSigmasDenoise` node. Its `low_sigmas` (output 1) feed SamplerCustomAdvanced, and the reference latent is the starting latent.
  - Strength 1.0 is a full re-generation that is still guided by ReferenceLatent; lower values stay closer to the reference. At 4 steps the effective steps are 1-4, so the slider moves in quarter steps.
  - Output size follows the reference image, so the aspect control is hidden for this preset.
- **Output subfolder**: SaveImage prefixes are rewritten to `concept-app/<name>`. You can change or disable this with `outputSubfolder`.
- **Sessions** are time-based (a new one after a 90-minute gap), so they don't depend on the device or the tab.
- **History is written by the browser**: an entry is created when a job is queued and its images are attached when it finishes. If the browser lost track of a job, the server fills it in from ComfyUI's `/history/<prompt_id>` on the next History load.
- **Extra endpoints beyond the spec**: `PATCH /api/history/:id` (favourite, images, status) and `GET /api/events` (Server-Sent Events; tells open apps when `workflows/` changed).
- **Imports never overwrite**: a name clash becomes `name-2.json`. UI-format files are rejected with an explanation.
- **Several LoadImage nodes** (as in klein_ref, which has three): each gets its own slot with Pick, Camera and Paste.
- **Node view** (was the *ComfyUI canvas* menu item, which left the app): `/comfy/` in a same-origin iframe under the top bar, created on the first toggle and never unloaded. Back returns to the normal view (one history entry, like the overlays). ComfyUI's own top bar inside it is not hidden: its selectors could not be checked from the dev VM and it holds the Workflow menu (Export (API)) and Queue; `app/comfy-tweaks.css` is where to hide it later.
- **Tablet layout** starts at a width of 820px.
- **Service worker**: network-first for the app shell, with the cache as the offline fallback. API calls, images and `/comfy` are never cached. Bump `VERSION` in `app/sw.js` after changing app files.
- **Live preview frames** (binary websocket messages) are ignored.

## VERIFY ON REAL COMFYUI

Everything was built and tested against the mock only. The dev VM cannot reach your PC's localhost. Check these on the PC, roughly in this order:

1. `start.bat` prints `ComfyUI target: http://127.0.0.1:8188 (reachable)`. In a browser on the PC, open http://127.0.0.1:3100/: there is no orange "not reachable" banner, and the picker opens on *FLUX.2 Klein 4B Text to Image* (Image section).
2. **Origin rewrite**: a Run on *FLUX.2 Klein 4B Text to Image* gets no 403 from `/comfy/prompt` or the websocket. If it does, note the ComfyUI log line.
3. **FLUX.2 Klein 4B Text to Image**: the image appears, and the file lands in `ComfyUI/output/concept-app/`. The 3:2 chip gives 1248x832, and the flip gives 832x1248.
4. **Batch 4**: thumbnails show progress (from `progress` events) and fill in one by one. You can swipe image 1 while 2-4 are still rendering.
5. **Cancel queue** during a batch: the remaining jobs disappear from ComfyUI's queue panel and the running one stops.
6. **FLUX.2 Klein 4B Image Edit**: pick a photo. Check:
   - it uploads into `ComfyUI/input/`
   - the job runs, and the result follows the picture's shape (scaled to about 1 MP)
7. **Same prompt with the same locked seed twice**: ComfyUI may serve it from cache. An image should still appear, via the `/history` fallback.
8. **Thumbnails**: `/comfy/view?...&preview=webp;70` returns a webp. If your build ignores it, the full PNG loads instead, which is fine but slower.
9. **Node view** (canvas button): the ComfyUI frontend loads under `/comfy/` inside the app. Check that the graph canvas, the node library, queueing from it and its websocket all work. If the frontend refuses to run under a sub-path, open http://127.0.0.1:8188 on the PC instead and report it. That would mean switching to a separate port for the proxy.
10. **Export (API)** a graph from ComfyUI into `workflows/`: it appears in the open app's dropdown within a second or two, without a reload.
11. **Tailscale**: `tailscale serve --bg 3100`, then the phone opens `https://<pc>.<tailnet>.ts.net/` and Generate works there. The websocket must work through `serve`; you'll know because progress bars move.
12. **Install the PWA** on the phone, then share a screenshot to "Comfy UI". The app should open on *FLUX.2 Klein 4B Image Edit* with the screenshot in the slot.
13. **On the phone and on the tablet**, test real touch:
    - swipe
    - pinch
    - double-tap
    - tap to hide or show the controls
    - Save (lands in Downloads)
    - Share (the Android sheet opens with the image)
    - Reuse
    - Paste button (asks for clipboard permission)
    - Camera button
14. **History** on the tablet shows what the phone generated. Favourites made on one device show on the other.
15. Timing on the 2080 Ti: a 1MP, 4-step image. A batch of 20 should queue without errors.

### Batch 4: check on the PC and the phone

1. **Delete a locked file**: open a .glb from History in the 3D viewer, go back, select it and delete. It should either be deleted or say *File is in use (open in a viewer or another app), try again*; the rest of the selection is deleted either way. With Explorer's preview pane showing the file, the same.
2. **Output folder**: without `comfyOutputDir` set, delete still works after a ComfyUI restart (look for `comfy-output-dir.json` in `data/`). If it says the folder is unknown, `data\server.log` says why; set `comfyOutputDir` (see *Run it*).
3. **Node view**: the canvas button shows ComfyUI under the app's top bar on the phone and the tablet; the graph is still there after toggling back and forth; no *Changes you made may not be saved* prompt; Android Back returns to the normal view. If ComfyUI's own navigation adds history entries inside the frame, Back may step through those first: report it.
4. **Agent**: no Agent button and no red *Comfy Agent error* toast in the node view or at `/comfy/`. If they show, note what the button/toast looks like (the selectors are text-based and unverified).
5. **Switching apps**: leave the app for a minute, come back: no *Not connected to ComfyUI* banner, and a run that finished meanwhile shows its results.
6. **During a run**: the form is greyed and cannot be changed; Cancel, thumbnails, History, the canvas toggle and (i) still work.

### Results on the PC (2026-11-21, Comfy Desktop 0.46.1, RTX 2080 Ti, app on a separate test port with temp data)

1. OK - "(reachable)", no banner, both presets (3100 and the test port).
2. OK - no 403s on /comfy/prompt or the websocket.
3. OK - portrait 832x1248, landscape 1248x832, files in output/concept-app/, ~3.7 s per image.
4. OK - progress 25/50/75 %, image 1 opened in the viewer while the others rendered.
5. OK - all cancelled, ComfyUI queue empty, the running job got execution_interrupted.
6. OK - upload in input/, no validation errors, output follows the reference size; strength 0.25 mean abs diff 2.1 vs 84.8 at 1.0; SplitSigmasDenoise output 1 = low_sigmas (object_info), no change needed.
7. OK - cached locked seed came back in 274 ms via the /history fallback.
8. OK - preview=webp;70 returns image/webp (24 KB vs 893 KB PNG).
9. OK after a fix - graph canvas, 817 node types, websocket. A custom-node extension (tts_audio_suite) loaded `/scripts/*`, `/assets/*` and `/api/tts-audio-suite/*` from the server root; the app now forwards those to ComfyUI (re-checked: no root-path 404s). Queueing from inside the ComfyUI UI was not clicked.
10. OK - a file dropped into workflows/ appeared in 216 ms; Import works.
11. OK from the PC itself through https://my-pc.my-tailnet.ts.net (HTTPS, WSS, progress). Not yet tried from the phone.
12. Not done - needs the phone (PWA share).
13. Partly - see README-ANDROID / phone checks.
14. Not done - needs two devices.
15. OK - batch of 20, all done in 80 s (~4.0 s per 1 MP 4-step image).
