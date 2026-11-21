# Comfy UI (the Comfy Concept app)

The app shows up as **Comfy UI** on the phone (launcher label, PWA name, page title and share sheet). The repo, folders, package `app.jesse.comfyconcept` and internal names are still "Comfy Concept".

A phone and tablet front-end (an installable PWA) for the ComfyUI on your home PC. It is built for **concepting**: you type a prompt and get a batch of images, with an optional reference image.

```
Android phone/tablet --HTTPS (Tailscale)--> this app (127.0.0.1:3100 on the PC) --localhost--> ComfyUI (127.0.0.1:8188)
```

## Run it

1. Start Comfy Desktop.
2. Double-click `start.bat`, or run `npm start`. You need Node 22 or newer. **No `npm install` is needed**, because the server has no dependencies.
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

### Bundled Node runtime (not in git)

`start.bat` and `start-background.vbs` use `runtime\node.exe` when it exists, and otherwise fall back to a system Node 22+. The binary is not committed. To restore it, download the official Node.js v24.22.3 Windows x64 `node.exe` from https://nodejs.org/dist/v24.22.3/win-x64/node.exe and put it in `runtime\`. Before using it, check it against https://nodejs.org/dist/v24.22.3/SHASUMS256.txt: the `win-x64/node.exe` line is `86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6`. In PowerShell, run `Get-FileHash runtime\node.exe`.
## ComfyUI settings: none needed

ComfyUI stays bound to **localhost only**. **You do not need `--listen`**. The app server runs on the same PC and reverse-proxies `/comfy/*` (HTTP and the websocket) to `127.0.0.1:8188`. Your phone never talks to ComfyUI directly. Leave Comfy Desktop's network settings at their defaults.

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

- **Preset picker** (top): the same sections as ComfyUI's right-click *AI Workflow* menu (3D / Image / Video / Audio), and **My presets** at the bottom: setups saved from the chat builder, plus any workflow you import or drop into `workflows/`. The default preset is **FLUX.2 Klein 4B Text to Image**.
  - The old built-in presets *Fast concept* and *From reference image* (the "App presets" section) are retired. Anything saved with them still works: the chosen preset in the browser, history entries (Reuse) and chat images map *Fast concept* to **FLUX.2 Klein 4B Text to Image** and *From reference image* to **FLUX.2 Klein 4B Image Edit**, and an old reference image lands in the Image Edit slot. The mapping happens when the app reads the data (`app/js/lib/legacy-presets.js`); `data/history.json`, `data/chats.json` and settings are not rewritten. Each row shows its live availability. **needs download** and **missing node** rows are greyed out; tap one to see why. **slow · RAM offload** and **tight on 11 GB** are hints. See *AI Workflow presets*.
- **Prompt, Aspect** (1:1 / 4:3 / 3:2 / 16:9 chips plus a portrait/landscape flip; the size is shown and kept inside the preset's range), **Batch (1-20), Seed** (Lock = fixed; the dice button picks a new one). The negative prompt toggle appears only if the workflow has a real negative text node. The klein presets do not: their negative is a zeroed copy.
- **Run** (the blue button; blue is used only here) queues *N separate jobs*. Thumbnails in the bottom strip (phone) or the right-hand grid (tablet) show progress, and each fills in as its job finishes.
- **Cancel queue** removes your pending jobs from ComfyUI's queue and interrupts the one that is running.
- **Tap a thumbnail** to open the full-screen viewer:
  - Swipe left and right between images.
  - Pinch or double-tap to zoom.
  - Tap to hide or show the controls.
  - The star marks a favourite.
  - Save downloads the image to the device.
  - Share opens the Android share sheet.
  - Reuse loads that image's prompt and seed (locked).
- **History**: everything you have generated, from any device, grouped into sessions. A new session starts after 90 minutes with no generations. The star filter shows favourites only.
- **Menu (⋮) > ComfyUI canvas** opens the real ComfyUI UI at `/comfy/` in the same window. Use Back to return.
- **Menu (⋮) > Import workflow** uploads an API-format `.json` into `workflows/`.
- **Menu (⋮) > GPU & memory** shows the detected GPU (name, total and free VRAM), system RAM, the active memory profile with a manual override, and which chat model is loaded (see *GPU & memory profiles*).
- **Prompt assistant** (under the prompt box) and **💬 Discuss** in the viewer: see below.

## Prompt assistant (Ollama chat, tied to the prompt box)

The prompt box is the single source of truth. The assistant sits right under it and every turn sends the **current prompt box** (and the negative prompt if this preset has one and it is on) to a local Ollama model, together with the conversation and the images you discussed (their prompt and seed).

- **Create**: "a purple duck at a misty pond" gives a full Flux.2 [klein] style natural-language prompt.
- **Revise**: "make it moodier, dusk light". The model returns the complete new prompt.
- **Fix an image**: open it in the viewer and tap **💬 Discuss**. The image is attached (resized to 896 px, JPEG, base64) to your next message for vision models (gemma3:4b "sees images"); non-vision models get only its prompt and seed. Say what is wrong ("looks like a swan, not a duck").
- Every proposal shows a **word diff** against the box and **Apply**, **Apply + Run (new seed)** and, after Discuss, **Apply + same seed N** (re-runs the discussed seed so only the prompt change shows). Nothing is written into the box automatically.
- **Undo** (under the prompt box) and **Versions (n)** keep the last 30 prompt versions (this device, localStorage).
- Replies are structured (Ollama `format` = JSON schema: `reply`, `prompt` or null, `negative`, `action`). If a model ignores the schema the app still finds JSON inside prose, a ```prompt block or a "Prompt:" line; truncated output never touches the box.
- Conversations are saved on the PC in `data/chats.json` (next to `history.json`) and are shared by all devices. The model picker lists `/api/tags`; if Ollama is not running the panel says so and offers Retry.
- Ollama stays on 127.0.0.1:11434. The app proxies only `GET /api/tags|version|ps` and `POST /api/show|chat` under `/ollama/`; pull, delete, create and so on answer 403.

**Why one-tap Apply and not automatic**: you may have edited the box while the model was thinking; small models sometimes drop details from a long prompt (the diff makes that visible before it costs a render); and the box stays the one source of truth that Run uses. Apply is one tap, and Undo/Versions make it reversible.

## Workflow actions ("upscale this", "make it 3D")

Actions are API-format workflows in `workflows/actions/*.json` with a small manifest (`action`: name, description, keywords, the `#image` LoadImage node, and `params` that point at `#expose` nodes with min/max/options). The model sees the list and may answer with `{action, params, image_ref}`; it never sends node graphs. The app:
- ignores an action the user did not ask for (your words must name it), and lets your words win when the model picks the wrong one;
- clamps numbers into range and resets unknown enum values to the default (shown as notes);
- uses the image you named (`img2`) or the last discussed one; output images are wired as `"concept-app/x.png [output]"`, which LoadImage accepts without re-uploading;
- shows a confirm chip ("Upscale (scale 3, …) on img2. Run?"). Nothing is queued before you tap **Run**.
Results go to the strip and History, linked to the parent image.

Shipped actions (both verified on the PC):
- **Upscale** (`upscale.json`): UpscaleModelLoader (4x-UltraSharp default; RealESRGAN x4plus, 4x-ClearReality, 4x Remacri) + ImageScaleBy, scale 1.5-4.
- **Image to 3D** (`image-to-3d.json`): Hunyuan3D 2.1 with core ComfyUI nodes (`hunyuan_3d_v2.1.safetensors`, already installed), steps 10-50, octree detail 128-384. The `.glb` shows as a **3D ↓** tile that downloads the file (no 3D viewer, to stay dependency-free). Open it in Blender/Houdini or Windows 3D Viewer.

## GPU & memory profiles (2080 Ti now, RTX 5080 later)

The app reads the GPU's name, total and free VRAM (`nvidia-smi`, falling back to ComfyUI `/system_stats`) and system RAM at startup and on refresh, and picks a profile from **total VRAM**. All numbers are in `config/memory-profiles.json` (edits apply without a restart).

| | small (< 12 GB, RTX 2080 Ti 11 GB) | large (16 GB+, RTX 5080 16 GB) |
|---|---|---|
| Before every ComfyUI queue (batch or action) | unload the chat model (`keep_alive: 0`, checked with `/api/ps`) | keep it, unless free VRAM - headroom < the workflow's `workflowVramNeedMB` |
| Chat model keep_alive | 5m | 10m |
| Before a chat turn | ComfyUI `/free` (unload models) if free VRAM is too low for the model | nothing; ComfyUI keeps its models; Ollama may spill part of the model to RAM |
| Chat models in the picker | up to ~6.5 GB loaded | up to ~26 GB (12B class fits; bigger ones run partly in RAM) |
| Out-of-memory fallback | ComfyUI `/free` {unload_models, free_memory}, retry once | ComfyUI `/free` {free_memory}, retry once |

- **RAM (96 GB) is spill and cache room.** Models that do not fit in free VRAM are labelled "slower, partly in RAM"; when a loaded model's `/api/ps size_vram < size` the chat shows the badge "slower, runs partly in RAM (N% on GPU)". A model that would not fit in free VRAM + (free RAM - 8 GB reserve) is refused instead of pushing Windows into the page file.
- **Override**: Menu (⋮) > GPU & memory > Profile (saved in `data/memory-profile.json`), or `"profile"` in the config file, or env `MEMORY_PROFILE`. Precedence: env > app setting > config file > auto.
- The app never closes or restarts ComfyUI; `/free` is an API call.
- **After the 5080 swap**: nothing to change here (auto-detect). ComfyUI's bundled PyTorch already supports it: torch 2.10.0+cu130, arch list sm_75 … sm_120 (checked 2026-11-21).

## Adding workflows

1. Build the graph in ComfyUI. You can do this on the PC, or on the phone through **ComfyUI canvas**.
2. Use **Workflow > Export (API)**. Only API format can be queued. The normal "Save" writes UI format, and the app rejects that with a message.
3. Either save the file into `comfy-concept-app/workflows/`, or use **Import workflow** in the app. The server watches the folder, so open apps refresh their dropdown on their own.
   (ComfyUI's own "Save" stores files in its user folder, not here. That is why Export/Import is the route.)

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

## Setup builder (in the Prompt assistant)

Ask for a setup in the chat, e.g. "make a setup: schnell then upscale 2x", or start with `/build`. The builder model may only pick **tested blocks**: input image, model (FLUX.2 Klein / FLUX.1 schnell / FLUX.1 dev / Z-Image Turbo / Qwen-Image), LoRA, ControlNet (Qwen only), txt2img, img2img, upscale, image to 3D, video, audio (Chatterbox / VibeVoice) and save. Ollama answers with JSON blocks through `format`, and the **server** assembles the graph and validates it against the live `/object_info` and the installed models: class names, required inputs, link types, combo values and ranges. A setup that does not fit is rejected with a plain reason, for example "ControlNet only works with Qwen-Image" or "needs download: wan2.2_ti2v_5B_fp16.safetensors".

The chat shows a summary card with **Test run** (one result at reduced size, never saved), **Save as preset** and **Discard**. A setup becomes a preset only when you tap Save. It then appears under **My presets**, where you can rename or delete it (the ⚙ button on its row). Saved setups are stored as blocks in `data/user-presets.json` (gitignored) and re-validated every time the list loads.

**Builder model:** Menu (⋮) > *Setup builder model* (saved in `data/builder.json`). The default is `gemma3:4b`, which fits next to ComfyUI on the 11 GB card. After the RTX 5080 (16 GB) swap, the recommended model is **gemma3:12b**, or **qwen3:14b** as the alternative; both follow the JSON schema more reliably. They need `ollama pull` first, which the app never does by itself.

## Tests

```
npm install            # dev only: playwright-core + a bundled Chromium for Linux
npm test               # detection, injection, history, server, proxy HTTP+WS, share, chat/actions, memory profiles (node:test)
npm run test:browser   # drives the real UI in headless Chromium against the mocks (app, chat, memory)
npm run dev:mock       # app + fake ComfyUI, http://127.0.0.1:3100 (no GPU needed)
```
`test/mock-ollama.js` is a fake Ollama (tags, ps, show, chat with JSON `format`, keep_alive 0 unload; trigger words exercise malformed/no-change/action replies). `test/mock-comfy.js` is a fake ComfyUI. It has the same endpoints and websocket messages as the real one, returns placeholder PNGs, and has the same Origin check. On Windows, the browser tests use your installed Chrome through playwright-core's `channel: 'chrome'`, or `CHROME_PATH`.

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
- **ComfyUI canvas** opens `/comfy/` in the same window (it also works inside the installed PWA). Back returns to the app, and presets reload when the app becomes visible again.
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
9. **ComfyUI canvas**: the ComfyUI frontend loads under `/comfy/`. Check that the graph canvas, the node library, queueing from it and its websocket all work. If the frontend refuses to run under a sub-path, open http://127.0.0.1:8188 on the PC instead and report it. That would mean switching to a separate port for the proxy.
10. **Export (API)** a graph from ComfyUI into `workflows/`: it appears in the open app's dropdown within a second or two, without a reload. Also test **Import workflow** with the same file.
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
