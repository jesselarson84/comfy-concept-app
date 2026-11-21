# Comfy Concept App - build spec

Owner: the project owner. Android phone + tablet front-end for a home PC's ComfyUI, for CONCEPTING (text prompt -> images, optional reference image). Not restore/upscale.

## Environment facts
- PC: Windows, RTX 2080 Ti (RTX 5080 planned - nothing GPU-specific may be hard-coded). Node 24 is on the PC.
- ComfyUI is the Comfy Desktop app. Port is configurable: default COMFY_URL=http://127.0.0.1:8000 (also try 8188). Must be a config value, not hard-coded.
- Remote access will be Tailscale (`tailscale serve` provides HTTPS in front of this app). App binds 127.0.0.1 only. Never expose ComfyUI directly.
- Sample API-format workflows live in ../claude_tests/klein/*.json (Flux.2 klein 4B: UNETLoader flux-2-klein-4b.safetensors, CLIPLoader qwen_3_4b.safetensors type flux2, VAELoader flux2-vae.safetensors). READ THEM IN FULL and base the shipped presets on those loaders/sampler nodes.
- The dev shell (device_bash) is a Linux VM that CANNOT reach the PC's localhost. So ComfyUI is unreachable during development: write and test against a MOCK ComfyUI server (same endpoints) that you also build under test/. Real-ComfyUI verification is left to the owner; list exactly what he must check.

## Requirements (all from the owner)
1. Prompt screen: big prompt box, batch count 1-20, aspect ratio (portrait / square / landscape), seed (random or locked), Generate. Negative prompt behind a toggle if the workflow has one.
2. Full-screen viewer: image fills screen, swipe left/right between images, pinch-zoom + double-tap zoom, tap toggles controls. Buttons: favorite, save to device, share, reuse prompt+seed.
3. Batch: queue N prompts (N separate jobs with different seeds). Images appear in the swipe strip as each finishes, so the user can swipe while the rest generate. Bottom thumbnail strip shows pending (progress) and finished. Cancel/clear queue button (ComfyUI /interrupt and /queue delete).
4. History persisted on the PC (prompt, seed, workflow, size, favorite flag, image filename), grouped by session, browsable from any device. Image bytes stay in ComfyUI's output; app only stores metadata (data/history.json, atomic writes).
5. Workflow presets dropdown at top. Presets = API-format JSON files in workflows/. Ship: "Fast concept" (txt2img, Flux.2 klein), "From reference image" (img2img with strength slider, reference slot). More can be added by dropping a file in workflows/; the server watches the folder.
6. Auto-detect controls in any API-format workflow: positive prompt (CLIPTextEncode / equivalent text node), negative prompt, seed (KSampler/RandomNoise/etc.), steps, batch/latent size (EmptyLatentImage/EmptyFlux2LatentImage or equivalent), LoadImage = reference slot. Override/extend with node titles in `_meta.title`: `#prompt`, `#negative`, `#seed`, `#image`, `#strength`, `#width`, `#height`, `#expose` (shows as generic control). Unknown workflow with nothing detectable should still list, with a clear message.
7. "Advanced" button opens the real ComfyUI web UI (reverse-proxied under /comfy/ incl. websocket) in the same browser/app, so the user can build custom graphs there. Custom graphs saved as API-format JSON into workflows/ appear in the dropdown. Also provide an "Import workflow" button (file picker) as a fallback that uploads API JSON to workflows/.
8. Reference images: PWA Web Share Target (Android Chrome) so Share -> app on a screenshot/photo lands as the reference image (manifest share_target, POST multipart to /share, service worker or server handles, then redirects into the app with the image preselected; auto-switch to the reference preset). Also file picker + camera capture + paste. Upload goes to ComfyUI /upload/image.
9. Phone AND tablet: responsive. Phone = single column, thumb-reach controls. Tablet = prompt panel + thumbnail grid side by side, viewer still full screen. Dark UI, large touch targets, works in portrait and landscape, safe-area insets.
10. Installable PWA: manifest, icons (generate simple ones), service worker caching app shell only (not images, not API).

## Architecture
- /server: Node (use `ws` + plain http or Express; keep deps minimal). Serves /app static, proxies /comfy/* HTTP + WS to COMFY_URL, endpoints: GET /api/config, GET /api/workflows (parsed, with detected controls), POST /api/workflows (import), POST /api/history, GET /api/history, POST /share. Config via config.json + env.
- /app: vanilla JS/ES modules, no build step (so the owner can read and edit it). Small, commented, one concept per file. Browser talks to ComfyUI through the proxy: POST /comfy/prompt, WS /comfy/ws, GET /comfy/view, POST /comfy/upload/image.
- Run: `start.bat` (Windows) and `npm start`. README.md covers: setting Comfy Desktop to accept the proxy (and whether --listen is even needed since the proxy is local), Tailscale install on PC + Android, `tailscale serve` command for HTTPS, installing the PWA, adding workflows, #tags reference.
- Teaching preference: The owner wants to understand mechanics. Code comments should explain WHY and the ComfyUI API flow (prompt_id, ws events `executing`/`progress`/`executed`, history, view params).

## Testing (required)
- test/mock-comfy.js: fake ComfyUI (/prompt, /ws progress events, /history/<id>, /view, /upload/image, /queue, /interrupt, /system_stats) returning generated placeholder PNGs.
- Node tests for: workflow control detection (use the real klein JSONs + synthetic ones), workflow param injection (seed/prompt/size/image), history persistence, share endpoint, proxy HTTP+WS passthrough.
- Run the app against the mock and drive it with headless Chromium/Playwright if installable in the VM; otherwise test the server and pure-JS modules thoroughly and state what was not browser-tested.

## Definition of done
Everything above works against the mock; README written; a short "VERIFY ON REAL COMFYUI" checklist for the owner; honest list of anything not done. Do not commit secrets. Do not modify anything outside comfy-concept-app/.
