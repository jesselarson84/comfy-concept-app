# Setting up Comfy UI (the Comfy Concept app)

From a fresh clone to using the app on your phone or tablet.

```
phone / tablet --HTTPS over Tailscale--> this app (Node, 127.0.0.1:3100 on the PC) --localhost--> ComfyUI (127.0.0.1:8188)
```

- The app and ComfyUI run on the same Windows PC.
- Your phone only talks to the app, through Tailscale. ComfyUI is never opened to the network.

**How to use this guide.** Work through the sections in order. Every section has the same parts:

- **Goal**: what the section gets you.
- **Steps**: tick them off as you go.
- **Done when**: one command or check. Don't move on until it passes.
- **If it fails**: where to look.

Sections marked **Required** are needed for the app to run. **Optional** ones add features.

## Placeholders

Replace these wherever they appear. They're always written exactly like this:

| Placeholder | Meaning | Example |
|---|---|---|
| `<you>` | Your Windows user name | `alex` |
| `<owner>` | The GitHub account the repo lives under | `someone` |
| `<app-folder>` | Where you cloned the repo | `C:\Code\comfy-concept-app` |
| `<models>` | ComfyUI's models folder | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models` |
| `<custom_nodes>` | ComfyUI's custom nodes folder | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes` |
| `<output>` | ComfyUI's output folder | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output` |
| `<pc-name>.<tailnet>.ts.net` | The PC's Tailscale address (shown in step 8) | `studio-pc.example-tailnet.ts.net` |

Commands are for **PowerShell** on the PC unless a step says otherwise.

## Contents

| # | Section | Needed? |
|---|---|---|
| 1 | [What you need](#1-what-you-need) | Required |
| 2 | [Install ComfyUI](#2-install-comfyui) | Required |
| 3 | [Install the custom nodes](#3-install-the-custom-nodes) | Optional (some presets) |
| 4 | [Download the models](#4-download-the-models) | Required (3 files), the rest optional |
| 5 | [Get the app and start it](#5-get-the-app-and-start-it) | Required |
| 6 | [Your own settings (config.local.json)](#6-your-own-settings-configlocaljson) | Optional (recommended) |
| 7 | [Keep it running](#7-keep-it-running) | Optional (recommended) |
| 8 | [Reach it from your phone with Tailscale](#8-reach-it-from-your-phone-with-tailscale) | Required for phone use |
| 9 | [Install it on the phone or tablet](#9-install-it-on-the-phone-or-tablet) | Required for phone use |
| 10 | [Claude features](#10-claude-features) | Optional |
| 11 | [Troubleshooting](#11-troubleshooting) | |

---

## 1. What you need

**Required.**

**Goal:** the PC has the tools the later steps use.

**Steps**

- [ ] A Windows PC with an **NVIDIA GPU**. The presets were tuned on 11 GB (RTX 2080 Ti); the app warns when a preset is tight on your card.
- [ ] **Node.js 22 or newer** from https://nodejs.org (the LTS installer).
- [ ] **git** from https://git-scm.com/download/win
- [ ] **Disk space:** about 20 GB for the minimum models; the full set is well over 150 GB.
- [ ] *(Optional)* An **Anthropic API account** with credits, for the Claude features (section 10).

**Done when**

```powershell
node --version   # v22 or higher
git --version    # any version
```

**If it fails:** close and reopen PowerShell after installing, so it finds the new programs.

## 2. Install ComfyUI

**Required.**

**Goal:** ComfyUI runs on the PC, reachable only from the PC itself.

**Steps**

- [ ] Install **Comfy Desktop** from https://www.comfy.org/download and finish its first-run setup.
- [ ] Leave its network settings at their defaults. **Don't add `--listen`**: the app runs on the same PC and talks to ComfyUI over localhost.
- [ ] Note the folders `<models>`, `<custom_nodes>` and `<output>` (see [Placeholders](#placeholders)). With a portable or manual ComfyUI install, use its own `models`, `custom_nodes` and `output` folders instead.

**Done when**

```powershell
(Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing).StatusCode   # 200
```

**If it fails:** see [ComfyUI not reachable](#comfyui-not-reachable).

## 3. Install the custom nodes

**Optional.** Most presets use only ComfyUI's built-in nodes. A preset whose node pack is missing shows **missing node** in the app, and everything else still works.

**Goal:** the node packs for the presets you want are installed.

**Steps**

- [ ] Pick the packs you need from the table below.
- [ ] Install each one with **ComfyUI Manager**: *Manager* → *Custom Nodes Manager* → search the name → *Install*.
- [ ] Restart ComfyUI.

| Node pack | Needed for |
|---|---|
| **ComfyUI-GGUF** (city96) | FLUX.1 Dev / Schnell / Fill, Qwen Image Edit 2511, Concept Looks (FLUX.1 Dev), Remove Lighting, Photo to Texture, Photo to 3D Model |
| **comfyui_controlnet_aux** (Fannovel16) | Concept Looks (Pose, FLUX.1 Dev, Qwen-Image). It downloads its own pose-detector files on first use. |
| **ComfyUI-Inpaint-CropAndStitch** (lquesada) | FLUX.1 Fill, FLUX.2 Klein 4B Inpaint |
| **comfyui-inpaint-nodes** (Acly) | FLUX.1 Fill, FLUX.2 Klein 4B Inpaint |
| **ComfyUI-Chatterbox** (wildminder) | Chatterbox TTS, Chatterbox Voice Swap, Voice Line with Sound, Voice Line in Any Voice |
| **ComfyUI-VibeVoice** (wildminder) | VibeVoice TTS |
| **ComfyUI-Chord** | PBR Maps (CHORD). Research-only license. |

- [ ] *(Optional)* Install the app's own ComfyUI add-on. It adds **AI Models** / **AI Workflows** to ComfyUI's right-click menu and a **Concept** tab to ComfyUI's left sidebar that shows this app next to the node graph (drag the panel's edge to make it wider; the app must be running). Run this after section 5, then reload ComfyUI:

  ```powershell
  cd <app-folder>
  node scripts/sync-comfy-menu.mjs --install "<custom_nodes>"
  ```

**Done when:** after a ComfyUI restart, each pack you installed is listed as installed in *Manager* → *Custom Nodes Manager*. Once the app runs (section 5), the presets that use it are no longer greyed out with **missing node**.

**If it fails:** ComfyUI's log names the pack that failed to load. Reinstall it from the Manager, or use *Try fix*.

## 4. Download the models

**Required: 3 files** (Z-Image Turbo, the default preset). **The rest are optional**: get the ones for the presets you want.

**Goal:** the model files for your presets are in `<models>`.

**Steps**

- [ ] Check what's missing. This asks the running ComfyUI, so model folders you added to ComfyUI count too:

  ```powershell
  cd <app-folder>
  node scripts/check-models.mjs --required         # the minimum
  node scripts/check-models.mjs                    # everything
  node scripts/check-models.mjs --preset qwen-edit-2511,klein-4b-edit   # some presets
  ```

- [ ] Get the missing files. Either let the script download them into `<models>`:

  ```powershell
  node scripts/check-models.mjs --required --download
  node scripts/check-models.mjs --preset qwen-edit-2511 --download
  ```

  or download them yourself from the tables below and save each file in the `<models>` subfolder shown.
- [ ] Restart ComfyUI, or press *Refresh* in it.

The full list is in [`config/models.json`](config/models.json) (file, folder, link, presets), which the script and the app's tests use. Add `--json` for output a script can read, and `--models-dir "<path>"` if your models folder is somewhere else.

**Done when**

```powershell
node scripts/check-models.mjs --required   # ends with "3 of 3 present", exit code 0
```

**If it fails:** see [A preset says "needs download" or "missing node"](#a-preset-says-needs-download-or-missing-node).

> **Licenses.** Some models have their own terms. Check the model's page before using results commercially, notably **CHORD** (research only) and **FLUX.1 Dev / Fill** (non-commercial).

### Required: Z-Image Turbo

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Required | `z_image_turbo_bf16.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors) | Z-Image Turbo (default), Concept Looks (Edges / Depth / Pose), Make Seamless, Grunge Map, Photo to Texture |
| Required | `qwen_3_4b.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors) | Z-Image Turbo, FLUX.2 Klein 4B (all) |
| Required | `ae.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors) | Z-Image Turbo, FLUX.1 (all) |

### Optional: Image

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Optional | `flux-2-klein-base-4b.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors) | FLUX.2 Klein 4B Text to Image |
| Optional | `flux-2-klein-4b.safetensors` | `diffusion_models` | [link](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/flux-2-klein-4b.safetensors) | FLUX.2 Klein 4B Image Edit and Inpaint (also used by Share → Comfy UI) |
| Optional | `flux2-vae.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors) | FLUX.2 Klein 4B (all) |
| Optional | `flux1-dev-Q5_K_S.gguf` | `diffusion_models` | [link](https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q5_K_S.gguf) | FLUX.1 Dev, Concept Looks (FLUX.1 Dev) |
| Optional | `flux1-schnell-Q5_K_S.gguf` | `diffusion_models` | [link](https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q5_K_S.gguf) | FLUX.1 Schnell |
| Optional | `flux1-fill-dev-Q5_K_S.gguf` | `diffusion_models` | [link](https://huggingface.co/YarvixPA/FLUX.1-Fill-dev-GGUF/resolve/main/flux1-fill-dev-Q5_K_S.gguf) | FLUX.1 Fill (inpaint, outpaint) |
| Optional | `t5xxl_fp8_e4m3fn.safetensors` | `text_encoders` | [link](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors) | FLUX.1 (all) |
| Optional | `clip_l.safetensors` | `text_encoders` | [link](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors) | FLUX.1 (all) |
| Optional | `qwen_image_2512_fp8_e4m3fn.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors) | Qwen 2512, Concept Looks (Qwen-Image) |
| Optional | `qwen-image-2512-Q5_K_M.gguf` | `diffusion_models` | [link](https://huggingface.co/unsloth/Qwen-Image-2512-GGUF/resolve/main/qwen-image-2512-Q5_K_M.gguf) | Qwen 2512 on GPUs under 12 GB (used there instead of the fp8 file) |
| Optional | `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | `loras` | [link](https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors) | Qwen 2512, Concept Looks (Qwen-Image) |
| Optional | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) | Qwen Image Edit 2509 |
| Optional | `Qwen-Image-Edit-2509-Q5_K_M.gguf` | `diffusion_models` | [link](https://huggingface.co/QuantStack/Qwen-Image-Edit-2509-GGUF/resolve/main/Qwen-Image-Edit-2509-Q5_K_M.gguf) | Qwen Image Edit 2509 on GPUs under 12 GB (used there instead of the fp8 file) |
| Optional | `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | [link](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) | Qwen Image Edit 2509 |
| Optional | `qwen-image-edit-2511-Q5_K_M.gguf` | `diffusion_models` | [link](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main/qwen-image-edit-2511-Q5_K_M.gguf) | Qwen Image Edit 2511, Remove Lighting, Photo to Texture, Photo to 3D Model |
| Optional | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | [link](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors) | the same as Qwen Image Edit 2511 |
| Optional | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) | every Qwen preset |
| Optional | `qwen_image_vae.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) | every Qwen preset |
| Optional | `seedvr2_7b_int8_convrot.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors) | SeedVR2 7B (image upscale) |
| Optional | `seedvr2_ema_vae_fp16.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors) | SeedVR2 (image and video) |
| Optional | `4x-UltraSharp.safetensors` | `upscale_models` | [link](https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors) | 4x Model (upscale), Upscale Texture, Photo to Texture, the 4K resolution option |

### Optional: Concept and texture workflows

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Optional | `Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors` (6.7 GB) | `model_patches` | [link](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors) | Concept Looks (Edges / Depth / Pose) |
| Optional | `Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors` (2 GB) | `model_patches` | [link](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors) | Make Seamless, Photo to Texture |
| Optional | `FLUX.1-dev-ControlNet-Union-Pro-2.0.safetensors` | `controlnet` | [link](https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro-2.0/resolve/main/diffusion_pytorch_model.safetensors) (saves as `diffusion_pytorch_model.safetensors`: **rename it**; the script does this for you) | Concept Looks (FLUX.1 Dev) |
| Optional | `Qwen-Image-InstantX-ControlNet-Union.safetensors` | `controlnet` | [link](https://huggingface.co/Comfy-Org/Qwen-Image-InstantX-ControlNets/resolve/main/split_files/controlnet/Qwen-Image-InstantX-ControlNet-Union.safetensors) | Concept Looks (Qwen-Image). [Not on RTX 20-series](#black-images-from-concept-looks-qwen-image-on-rtx-20-series). |
| Optional | `depth_anything_3_base.safetensors` | `geometry_estimation` | [link](https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_base.safetensors) | Concept Looks (Depth, FLUX.1 Dev, Qwen-Image) |
| Optional | `moge_2_vitl_normal_fp16.safetensors` | `geometry_estimation` | [link](https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors) | Depth + Normal, Pixal3D |
| Optional | `chord_v1.safetensors` | `checkpoints` | [page](https://huggingface.co/Ubisoft/ubisoft-laforge-chord) (sign in and accept the terms, then download in the browser; the script can't) | PBR Maps (CHORD). Research-only license. Needs ComfyUI-Chord. |

PBR Maps (not CHORD) needs no model.

### Optional: 3D

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Optional | `hunyuan_3d_v2.1.safetensors` | `checkpoints` | [link](https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors) | Hunyuan3D 2.1, Photo to 3D Model |
| Optional | `birefnet.safetensors` | `background_removal` | [link](https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors) | Hunyuan3D 2.1, Pixal3D, Photo to 3D Model |
| Optional | `pixal3d_int8_convrot.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors) | Pixal3D |
| Optional | `trellis_2_int8_convrot.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors) | Pixal3D |
| Optional | `trellis_2_shape_vae_bf16.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors) | Pixal3D |
| Optional | `trellis_2_texture_vae_bf16.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors) | Pixal3D |
| Optional | `dino_v3_L_naf_fp32.safetensors` | `clip_vision` | [link](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors) | Pixal3D |

### Optional: Video

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Optional | `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| Optional | `wan2.2_vae.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| Optional | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| Optional | `seedvr2_3b_int8_convrot.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors) | SeedVR2 3B Video Upscale (also needs `seedvr2_ema_vae_fp16.safetensors` above) |
| Optional | `RealESRGAN_x4plus.safetensors` | `upscale_models` | [link](https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors) | Real-ESRGAN Video Upscale |

### Optional: Audio

| Needed? | File | Folder | Download | Used by |
|---|---|---|---|---|
| Optional | `acestep_v1.5_turbo.safetensors` | `diffusion_models` | [link](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors) | ACE-Step 1.5 (music) |
| Optional | `qwen_0.6b_ace15.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors) | ACE-Step 1.5 |
| Optional | `qwen_1.7b_ace15.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_1.7b_ace15.safetensors) | ACE-Step 1.5 |
| Optional | `ace_1.5_vae.safetensors` | `vae` | [link](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors) | ACE-Step 1.5 |
| Optional | `stable_audio_3_small_sfx.safetensors` | `checkpoints` | [link](https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx.safetensors) | Stable Audio 3 SFX, Sound Effect Set, Voice Line with Sound |
| Optional | `t5gemma_b_b_ul2.safetensors` | `text_encoders` | [link](https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors) | the same as Stable Audio 3 SFX |
| Optional | `t3_cfg.safetensors`, `s3gen.safetensors`, `ve.safetensors` | `tts\chatterbox\chatterbox` | [repo](https://huggingface.co/ResembleAI/chatterbox/tree/main) | Chatterbox TTS, Chatterbox Voice Swap, Voice Line with Sound, Voice Line in Any Voice. The node pack can also fetch them on first use. |
| Optional | `model-00001-of-00003.safetensors`, `model-00002-of-00003.safetensors`, `model-00003-of-00003.safetensors`, `model.safetensors.index.json`, `config.json`, `preprocessor_config.json` | `tts\VibeVoice\VibeVoice-1.5B` | [repo](https://huggingface.co/microsoft/VibeVoice-1.5B/tree/main) | VibeVoice TTS. The node pack can also fetch them on first use. |

## 5. Get the app and start it

**Required.**

**Goal:** the app runs on the PC at http://127.0.0.1:3100/.

**Steps**

- [ ] Clone the repo and install its one dependency (the Claude SDK; without it, everything works except Claude):

  ```powershell
  git clone https://github.com/<owner>/comfy-concept-app.git <app-folder>
  cd <app-folder>
  npm install
  ```

- [ ] Start ComfyUI first, then the app:

  ```powershell
  npm start
  ```

  You can also double-click `start.bat`. It uses `runtime\node.exe` if that file exists and your installed Node otherwise. README.md ("Bundled Node runtime") explains the optional pinned Node.

**Done when**

```powershell
(Invoke-WebRequest http://127.0.0.1:3100/api/config -UseBasicParsing).Content   # JSON with "comfyReachable": true
```

Opening http://127.0.0.1:3100/ on the PC shows the form with the preset picker at the top.

**If it fails:** `"comfyReachable": false` means the app can't see ComfyUI; see [ComfyUI not reachable](#comfyui-not-reachable). *Port in use* means something else is on 3100; set another `port` in section 6.

## 6. Your own settings (config.local.json)

**Optional, recommended.**

**Goal:** your PC's settings live in a file git never commits.

- `config.json` holds the shared defaults and is committed. **Don't edit it for your own PC.**
- `config.local.json` (git-ignored) overrides it. Environment variables override both.
- The app keeps its own data (history, settings, the Claude key) in `data\`, which is also git-ignored.

**Steps**

- [ ] Create `<app-folder>\config.local.json`. Every key is optional; replace the `<…>` parts and double the backslashes:

  ```json
  {
    "comfyUrl": "http://127.0.0.1:8188",
    "port": 3100,
    "comfyOutputDir": "C:\\Users\\<you>\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\output"
  }
  ```

  | Key | What it does | Default |
  |---|---|---|
  | `comfyUrl` | Where ComfyUI listens | `http://127.0.0.1:8188` (8000 is tried too) |
  | `port` | The app's own port (use the same port in section 8) | `3100` |
  | `comfyOutputDir` | ComfyUI's `<output>` folder; needed to delete from **Files** and for *From Comfy UI* | found automatically when possible |

  The full list of settings is in README.md under **Run it**.
- [ ] Restart the app (`stop-app.bat`, then `npm start`).

**Done when**

```powershell
git status --short config.local.json   # prints nothing: git ignores the file
(Invoke-WebRequest http://127.0.0.1:3100/api/config -UseBasicParsing).StatusCode   # 200 after the restart
```

**If it fails:** a JSON typo stops the app from starting. Check the console or `data\server.log`; single backslashes in paths are the usual cause.

## 7. Keep it running

**Optional, recommended.**

**Goal:** the app starts with Windows and runs in the background.

**Steps**

- [ ] Double-click **`install-autostart.bat`** once. It adds a launcher to your Windows Startup folder and starts the app hidden now. (`remove-autostart.bat` undoes it.)
- [ ] Keep Comfy Desktop running too. The app and ComfyUI are separate programs.
- [ ] *(Optional)* Add a tray icon with Start / Stop / Restart / Open log: double-click `tools\tray\Tray.vbs` (see `tools\tray\README.md`).

| To… | Use |
|---|---|
| Start hidden now | `start-background.vbs` (logs to `data\server.log`) |
| Stop | `stop-app.bat` |
| See the log | `data\server.log` |

**Done when:** after signing out and back in (or a reboot):

```powershell
(Invoke-WebRequest http://127.0.0.1:3100/api/config -UseBasicParsing).StatusCode   # 200
```

**If it fails:** look at the end of `data\server.log`. Check the launcher exists: `Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ComfyConceptApp.vbs"`.

## 8. Reach it from your phone with Tailscale

**Required for phone use.**

**Goal:** a private HTTPS address for the app that only your own devices can open. Nothing is opened to the internet.

**Steps**

- [ ] Install **Tailscale** on the PC (https://tailscale.com/download/windows) and on the phone or tablet (Play Store or App Store).
- [ ] Sign in with the **same account** on every device.
- [ ] In the admin console (https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**.
- [ ] Publish the app on the PC. Double-click `enable-remote.bat`, or run:

  ```powershell
  tailscale serve --bg 3100
  ```

  It prints `https://<pc-name>.<tailnet>.ts.net/`, which forwards to the app on `127.0.0.1:3100` (HTTPS and websockets). Tailscale remembers it after a restart.

> Don't use `tailscale funnel`: that would put the app on the public internet. The app has no login of its own; anyone in your tailnet can use it. `tailscale serve reset` turns it off.

**Done when**

```powershell
tailscale serve status   # shows https://<pc-name>.<tailnet>.ts.net -> http://127.0.0.1:3100
```

On the phone, with Tailscale connected, `https://<pc-name>.<tailnet>.ts.net/` shows the same form as on the PC.

**If it fails:** see [The phone can't open the address](#the-phone-cant-open-the-address).

## 9. Install it on the phone or tablet

**Required for phone use.**

**Goal:** the app is on the home screen and opens full screen.

**Steps (Android, recommended)**

- [ ] Open `https://<pc-name>.<tailnet>.ts.net/` in **Chrome**.
- [ ] Menu → **Install app** (or *Add to Home screen*).
- [ ] *(Optional)* Share a photo to **Comfy UI** from the Share sheet. It opens on an image-edit preset with that picture loaded.

**Steps (iPhone / iPad)**

- [ ] Open the address in **Safari** → Share → **Add to Home Screen**. The Android Share-sheet entry isn't available there.

**Optional:** a small native Android app wraps the same page and adds saving to the gallery, sharing and voice input. See [ANDROID_SPEC.md](ANDROID_SPEC.md) and `android/README-ANDROID.md`.

**Done when:** a **Comfy UI** icon is on the home screen and opens the app full screen, without the browser bar.

**If it fails:** see [No "Install app" option](#no-install-app-option-or-comfy-ui-isnt-in-the-share-sheet).

## 10. Claude features

**Optional.** Claude is off by default, and everything else works without it.

**Goal:** Claude can write prompts, fix results and chat about ComfyUI (the floating button bottom right), within a spend limit you set.

It uses the **Anthropic API**, which is billed separately from a Claude.ai subscription and is prepaid.

**Steps**

- [ ] Make an account at https://platform.claude.com and add a payment method.
- [ ] **Buy credits** on the console's Billing page. Requests stop when they run out.
- [ ] Make a **separate Workspace** for this app and give it a **monthly spend limit**. This is your backstop.
- [ ] Create an **API key in that Workspace** and copy it (it starts with `sk-ant-`).
- [ ] In the app: **Settings** (gear, top right) → **Claude** → paste the key → **Save** → turn on **Use Claude**.
  - The key is stored only on the PC, in `data\claude-key.json` (git-ignored). The phone never sees it.
  - Alternatively, set the `ANTHROPIC_API_KEY` environment variable on the PC before starting the app.
- [ ] Set the app's **Monthly limit** in the same card (default **$20**). The app adds up the real cost of each request and pauses Claude for the rest of the month once the limit is reached.
- [ ] *(Optional)* Choose which model Claude starts on: Haiku is cheapest, Opus is strongest. Fixing pictures, variations and building workflows always use Opus.

**Done when:** the Claude button shows in the bottom-right corner, and asking it a question gets an answer.

**If it fails:** see [Claude errors](#claude-no-api-key-the-api-key-was-refused-or-monthly-limit-reached).

## 11. Troubleshooting

### ComfyUI not reachable

- [ ] Comfy Desktop is running: `(Invoke-WebRequest http://127.0.0.1:8188/system_stats -UseBasicParsing).StatusCode` gives 200.
- [ ] If your ComfyUI uses another port, set `comfyUrl` in `config.local.json` (section 6) and restart the app.
- [ ] Don't add `--listen` to ComfyUI. It isn't needed, and it opens ComfyUI to your network.

### A preset says "needs download" or "missing node"

- [ ] Tap the greyed-out preset in the app: it names the missing file or node.
- [ ] Run `node scripts/check-models.mjs --preset <preset-id>` to see what that preset is missing. Add `--download` to fetch it.
- [ ] Missing node: install the pack (section 3) and restart ComfyUI.
- [ ] Reopen the picker. The app re-checks about once a minute.

### Black images from Concept Looks (Qwen-Image) on RTX 20-series

- **Cause:** GPUs without bf16 support (the RTX 20-series, e.g. the 2080 Ti) give all-black images with Qwen-Image plus the InstantX ControlNet.
- **Fix:** use **Concept Looks (Edges / Depth / Pose)** (Z-Image Turbo) or **Concept Looks (FLUX.1 Dev)** on those cards. RTX 30-series and newer aren't affected.

### Out of memory, or very slow

- The picker marks presets that are tight on your card or will use system RAM.
- After an out-of-memory error, the next run of that preset decodes in tiles automatically.
- Close other GPU programs (games, local LLMs, browsers with many tabs), or lower the resolution or batch.

### The phone can't open the address

- [ ] Tailscale is **connected** on both the PC and the phone, with the same account.
- [ ] `tailscale serve status` on the PC shows the address pointing at port 3100.
- [ ] The app runs: http://127.0.0.1:3100/ opens on the PC.
- [ ] MagicDNS and HTTPS Certificates are on in the Tailscale admin console.

### No "Install app" option, or Comfy UI isn't in the Share sheet

- Both need the **HTTPS** `https://<pc-name>.<tailnet>.ts.net/` address in Chrome, not `http://` or an IP address.
- The Share entry appears only after the app is installed.

### Deleting from Files fails ("ComfyUI output folder is unknown")

- Set `comfyOutputDir` in `config.local.json` (section 6) and restart the app.
- If one file can't be deleted because it's open somewhere (for example a 3D model still loading), close it and try again.

### Claude: "No API key", "The API key was refused" or "Monthly limit reached"

| Message | Fix |
|---|---|
| No API key | Add it in Settings → Claude (section 10). |
| The API key was refused | The key was revoked or mistyped. Make a new one in your Workspace and use **Replace…** in Settings. |
| Monthly limit reached | The app's limit is used up. Raise it in Settings, or wait for the reset date shown there. |
| Requests fail, limit not reached | Check your credits and the Workspace limit at platform.claude.com. |
| The Claude SDK is not installed | Run `npm install` in `<app-folder>`, then restart the app. |

### Where to look

- **The app's log:** `data\server.log` when started hidden, or the `start.bat` window.
- **ComfyUI's log:** in Comfy Desktop (look for *Logs* in its menu). Errors also show on ComfyUI's page at http://127.0.0.1:8188/.
