# Comfy UI for Android (Comfy Concept app)

A real, installable Android app (package `app.jesse.comfyconcept`, phone and tablet) that wraps the Comfy Concept web app (shown as **Comfy UI**) served over Tailscale at `https://my-pc.my-tailnet.ts.net`. It has no browser bar. It also does what the PWA cannot:
- receive shared images
- save images to the gallery
- share real image files
- keep the screen on during a batch
- show an offline screen with a button for Tailscale

> **Built on 2026-11-21** on the PC from the command line (no compile errors): `android\app\build\outputs\apk\debug\app-debug.apk`. Toolchain, chosen to match what is installed on the PC (see *Build from the command line*): **AGP 9.3.3, Gradle 9.7.1 (wrapper included, checksum-pinned), compileSdk 37, targetSdk 35, minSdk 26, JDK = Android Studio's JBR (Java 25)**.

## 1. Open the project

1. Install Android Studio (2026.1 "Quail" or newer; AGP 9.3 needs it).
2. Choose **File > Open** and select this `android/` folder (not the repo root).
3. Accept the Gradle sync. The project pins **AGP 9.3.3** and **Gradle 9.7.1**; the wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`) is included and `gradle-wrapper.properties` carries the official `distributionSha256Sum`.
4. SDK: compileSdk is **37** (the `android-37.0` platform already installed on the PC) with build-tools 36.0.0; targetSdk stays **35** (behaviour unchanged) and minSdk is 26 (Android 8.0).

### Build from the command line (Windows PowerShell)

```powershell
cd C:\Users\<you>\Documents\comfy\comfy-concept-app\android
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'   # this window only
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat --no-daemon assembleDebug
# -> app\build\outputs\apk\debug\app-debug.apk
```

Why the toolchain moved from AGP 8.7.3 / Gradle 8.9 / compileSdk 35: Gradle 8.9 cannot run on Android Studio's bundled JBR (Java 25), and the PC's SDK has only the android-37.0 platform, so the old pins would have needed a different JDK plus an SDK download. AGP 9.3.3 and Gradle 9.7.1 are the versions Android Studio already had in its Gradle cache. The only build warning is that `android.useAndroidX=false` is deprecated (AGP 10 will drop the option; the app uses no AndroidX anyway).

## 2. Run on a phone or tablet (USB)

1. On the phone, open **Settings > About phone** and tap **Build number** 7 times. Then go to **Settings > System > Developer options** and turn on **USB debugging**.
2. Plug the phone into the PC. On the phone, allow the PC when it asks ("Allow USB debugging?", then tick *Always allow*).
3. In Android Studio, pick the phone in the device dropdown in the toolbar and press **Run** (the green triangle).

The tablet works the same way.

## 3. Sideload an APK instead

1. Choose **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
2. The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Studio's "locate" link opens the folder.
3. Install it with `adb install -r app-debug.apk` (`adb` is in `%LOCALAPPDATA%\Android\Sdk\platform-tools`). You can also copy the APK to the device and open it there; Android will ask you to allow installs from that app.

A **release** build (**Build > Generate Signed Bundle/APK**, or the `release` variant) is signed with the debug key, so you can sideload it too. Release builds turn WebView remote debugging off. Debug builds leave it on, so you can inspect pages at `chrome://inspect` on the PC.

## 4. First launch

- The app first asks you to confirm the server address. It is prefilled with `https://my-pc.my-tailnet.ts.net`. Tap **Connect**.
- The **Tailscale app must be installed and connected** on the device. The PC must be on, with Comfy Concept running and `tailscale serve --bg 3100` active.
- If the server can't be reached, a native screen appears with these options: **Retry**, **Open Tailscale** (or its Play Store page if it isn't installed), and **Change address**.

## 5. Everyday use, settings, limits

**Change the address**, in any of these ways:
- long-press the launcher icon and choose **Change address** (a static shortcut)
- tap **Change address** on the offline screen
- clear the app's storage, which brings the first-run prompt back

Only `https://host[:port]` is accepted, with no path. A bare host gets `https://` added.

**Share in.** In Photos (or after taking a screenshot), choose Share and then **Comfy UI**. The image goes to `POST /share`, which is the same contract as the PWA (`server/share.js`). The app then opens on *FLUX.2 Klein 4B Image Edit* with the picture in the slot.

**Save / Share in the viewer.** These buttons use the native side:
- Save puts the image in **Pictures/Comfy UI**, where it shows up in the gallery. (Builds before batch 1 saved to Pictures/Comfy Concept; those files stay there.)
- Share opens the Android share sheet with the real PNG.

Other downloads go to the same place. Images go to Pictures/Comfy UI and everything else goes to Download/Comfy UI; this includes a workflow `.json` exported from the *ComfyUI canvas*.

**Keep awake.** The screen stays on while a batch is queued or running, and is released when the queue is idle.

**Swap the icon.** The current icon is a yellow-green "C" mark (#F2FF5A) on a dark plum tile (#201A27). It is drawn from these files:
- `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`: the adaptive icon (Android 8+). Each one stacks three layers: background, foreground and monochrome.
- `app/src/main/res/values/ic_launcher_background.xml`: the tile colour, `ic_launcher_background` = `#FF201A27`. `drawable/ic_launcher_background.xml` is a plain rectangle in that colour.
- `app/src/main/res/drawable/ic_launcher_foreground.xml`: the "C" mark as a vector path on the 108x108 adaptive grid, filled with #FFF2FF5A. Keep it inside the central 66-unit safe zone. `values/colors.xml` holds the same colour as `ic_launcher_mark`; change both if you recolour it.
- `app/src/main/res/drawable/ic_launcher_monochrome.xml`: the same path in white, the themed-icon layer for Android 13+. Only its alpha is used.
- `app/src/main/res/mipmap-mdpi` through `mipmap-xxxhdpi`: PNG renders (`ic_launcher.png`, `ic_launcher_round.png`, `ic_launcher_foreground.png`). These are fallbacks for launchers that do not use the adaptive icon.
- `icon-preview.png` (in this folder): a 512x512 render of the current icon, for reference only.
- The PWA uses the same mark: `app/icons/icon-192.png`, `icon-512.png` and `maskable-512.png` (in the web app, not in `android/`). `scripts/make-icons.js` still draws the old placeholder "spark" icon, so do not run it unless you want that icon back.

To use new artwork, replace the foreground and monochrome paths, or use **File > New > Image Asset** in Android Studio with the name `ic_launcher`. Then re-render the mipmap PNGs, the PWA icons and `icon-preview.png` so they all match. The launcher label is `app_name` in `values/strings.xml` ("Comfy UI"). Changing the icon or the label does not change the package (`app.jesse.comfyconcept`), so the app still updates in place.

**Known limits**
- From a share, only **one reference image** is used. If you share several images, the app takes the first and shows a message.
- Everything needs **Tailscale connected** on the device, and the **PC on** with the app running. Nothing works offline except the offline screen.
- The **camera button** hands off to the system camera app.
- The **Paste** button in the web app depends on WebView clipboard support. It may say "No image on the clipboard" where Chrome would work. Share the image into the app instead.
- If the app is killed while the camera or file picker is open (low memory), the picked file is lost. Pick it again.

## 6. Verify on the device

Tick these off on the **phone** and on the **tablet**:

1. **First launch**: the address prompt appears and **Connect** loads the app. There is no browser bar, and the status and navigation bars are dark (#171718) with nothing covered by them.
2. **Share from Photos**: share a photo to Comfy UI. The app opens on *FLUX.2 Klein 4B Image Edit* with that photo in the slot.
3. **Share a screenshot**, using the screenshot preview's Share button: same result.
4. **Share 3 images at once**: a message says only the first is used, and the first is in the slot.
5. **Camera capture**: on *FLUX.2 Klein 4B Image Edit*, tap **Camera** in the slot. The camera app opens; take a photo and accept it, and it uploads into the slot. Also test **Pick**: the picker offers Photos/Files plus Camera.
6. **Import workflow** (menu): the file picker lets you choose a `.json` from Downloads.
7. **Save to gallery**: in the viewer, tap Save. A "Saved to Pictures/Comfy UI" message appears and the image is in the gallery. On an Android 8/9 device, the first Save asks for storage permission.
8. **Share out**: in the viewer, tap Share. The share sheet opens, and sending to e.g. Messages or Drive delivers the real image.
9. **Keep awake during a batch**: set the screen timeout to 30 s, then start a batch of 10. The screen stays on until the batch finishes, then times out normally.
10. **Rotation**: rotate during a batch. The page does **not** reload, progress continues, and the open viewer stays open.
11. **Tablet layout**: the panel and the grid sit side by side in landscape. Split-screen and freeform resizing work.
12. **Keyboard**: typing a prompt pushes the content up, and the Generate button is not hidden behind the keyboard.
13. **Back button**: in the viewer, Back closes the viewer. In the *ComfyUI canvas*, Back returns to the app. On the main screen, Back exits.
14. **Tailscale off**: disconnect Tailscale and reopen the app. The offline screen shows the address and the three buttons. **Open Tailscale** opens the Tailscale app. Reconnect, tap **Retry**, and the app loads.
15. **Change address**: long-press the launcher icon and choose **Change address**. An invalid entry (e.g. `http://x` or `https://x/path`) shows an error and is not saved. **Default** restores the stock address.
16. **External links**: a link to another site opens in the browser, not inside the app.
17. **ComfyUI canvas, Export (API)**: the exported `.json` lands in Download/Comfy UI. If it says "Save failed", that ComfyUI build revokes its blob URL too early; this is a known edge (see Decisions).

## Decisions

- **No CAMERA permission.** The spec allowed CAMERA "only if needed". It is not needed: the camera path uses `MediaStore.ACTION_IMAGE_CAPTURE`, and the system camera app takes the photo. Android only blocks that intent when an app *declares* CAMERA without having been granted it. Not declaring it means there is no permission prompt at all, and the only permissions left are INTERNET and WRITE_EXTERNAL_STORAGE (maxSdkVersion 28). If you later add in-page `getUserMedia` camera use, you would need CAMERA plus `onPermissionRequest`.
- **Own `CacheFileProvider` instead of `FileProvider`.** `FileProvider` only exists in AndroidX. The replacement is a ~150-line `ContentProvider`. It is not exported; other apps get in only through per-URI grants. It serves `cache/shared/` read-only (Share out) and `cache/camera/` read-write (the camera writes the photo there). Because of that, there is no `file_paths.xml`.
- **Bridge security.** `window.AndroidBridge` is attached once. Every method refuses to work unless the current top-level page is on the configured https origin. That flag is set in `onPageStarted`.
  - The top-level page can never leave the server: other-origin links open in the browser, and other-origin sub-frame navigations are blocked.
  - `saveImage`/`shareImage` only download URLs on the server origin.
  - This was chosen over `shouldInterceptRequest`, because that runs on a background thread for every sub-resource and cannot tell an iframe from an image.
  - Residual risk: a cross-origin iframe embedded by a server page would also see the object, but it could only save or share images from your own server. The web app has no iframes.
- **Offline detection.** The PWA's service worker can serve the cached app shell while the server is down. In that case the WebView reports no error and you would just see the web app's "App server not reachable" banner. So the app also checks `GET <server>/api/config` itself after each load. If that fails, or answers 5xx, the native offline screen is shown. Main-frame load errors, HTTP 5xx and TLS errors also show it, and TLS errors are never bypassed.
- **Edge-to-edge on every Android version** (Android 15 forces it). The root view takes the system-bar, cutout and keyboard insets as padding, and its background (#171718, the web UI's top/bottom bar colour) shows behind the bars. The insets are consumed natively, so the page's `env(safe-area-inset-*)` stays 0 and nothing is padded twice.
- **Rotation without reload.** The activity handles the config changes itself (`orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode`). `screenOrientation=fullUser` allows every orientation while respecting the rotation lock.
- **`launchMode=singleTask`.** A share arrives in the running app (`onNewIntent`) instead of stacking a second copy. A restored activity never re-sends a share: the intent is ignored when restored or launched from Recents.
- **Back** uses the classic `onBackPressed`. Predictive back is not opted in, so it works the same on API 26-35. It follows the WebView history first, so the web viewer's `history.pushState` makes Back close the viewer.
- **Downloads.** Images go to Pictures/Comfy UI and other files to Download/Comfy UI (the old Comfy Concept folders are left as they are): MediaStore on Android 10+, and a file plus a media scan on 8-9.
  - `blob:` downloads, such as ComfyUI's export, are read by injected JS and handed over as a `data:` URL (the bridge's internal `saveDataUrl`).
  - Downloads from other sites open in the browser.
- **File chooser.**
  - `capture` inputs go straight to the camera.
  - Image inputs get the system picker plus a Camera entry.
  - Other inputs, such as the `.json` import, use `*/*`, because many providers label `.json` as octet-stream.
- **`setAllowContentAccess(false)`.** The spec said "only as needed". Uploads from the file chooser are read by the WebView in the app's own process and should not need it. If picking a photo ever fails, flipping this one line to `true` in `MainActivity.setupWebView` is the first thing to try.
- **No analytics.** WebView metrics opt-out and Safe Browsing are off (manifest meta-data and `setSafeBrowsingEnabled(false)`). Safe Browsing sends URL lookups to Google, which is pointless for a tailnet-only app. `allowBackup=false`. Cleartext HTTP is off (`usesCleartextTraffic=false` plus a network security config).
- **Release build** is signed with the debug key and lint never blocks a build (`abortOnError false`). Both make local builds painless. Change them if you ever publish.
- **Web changes.** `app/js/native.js` is new. The viewer's Save/Share and `main.js` (keep-awake) use the bridge when it is present; without it, nothing changes.
  - The service worker cache version went to `shell-v2`, and `native.js` was added to its shell list.
  - The existing service-worker browser test now reads the cache name from `app/sw.js` instead of hard-coding `shell-v1`.
- **Icon (approved set, 2026-11-21).** Mark #F2FF5A on tile #201A27: adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` with background, foreground and monochrome drawables), PNG mipmaps mdpi-xxxhdpi (`ic_launcher`, `ic_launcher_round`, `ic_launcher_foreground`), `values/ic_launcher_background.xml` = #FF201A27. The manifest uses `@mipmap/ic_launcher` and `@mipmap/ic_launcher_round`. Android 12+ splash background = the tile colour (`values-v31/themes.xml`), and the address-shortcut icon uses the same colours. The web app's PWA icons (`app/icons/icon-192.png`, `icon-512.png`, `maskable-512.png`) are the same set. The old lavender "C" placeholders are in the 2026-11-21 backup zip.

## If the build fails (most likely spots)

- **Gradle/AGP versions**: let Studio upgrade them. Nothing in the code depends on a specific AGP version.
- **`mipmap-anydpi-v26/ic_launcher.xml` `<monochrome>`**: that element needs compileSdk 33+, which you have (37). If aapt complains, delete the `<monochrome .../>` line.
- **`MainActivity.setupSystemBars`** uses `Window.setStatusBarColor`/`setNavigationBarColor`, `View.setSystemUiVisibility` and `WindowInsets.getSystemWindowInset*`. They are deprecated (warnings), but present in API 35.
- **`Intent.getParcelableExtra` / `getParcelableArrayListExtra`**: these are the deprecated, untyped versions, used because the typed ones are API 33+. They produce warnings only.
- **Lint `NewApi` warnings** on `Insets` / `WindowInsets.Type`: those calls are behind `Build.VERSION.SDK_INT` checks.
