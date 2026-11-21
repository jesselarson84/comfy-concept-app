# Android wrapper - build spec

Goal: a real, installable Android app ("Comfy Concept", package app.jesse.comfyconcept) for phone AND tablet that wraps the existing web app (this folder, served at https://my-pc.my-tailnet.ts.net over Tailscale). No browser bar. The owner wants a "legit app", not a bookmark.

## Hard constraints (read first)
- The dev VM CANNOT download the Android SDK, Gradle or Maven artifacts (dl.google.com, maven.google.com, plugins.gradle.org, services.gradle.org, maven central all refused). So you CANNOT compile the app. The owner will open the project in Android Studio on a Windows PC and build there.
  => Write the Android code conservatively so it compiles first try: Java (not Kotlin), plain android.* framework APIs only, NO AndroidX/Jetpack/Material dependencies at all, no third-party libraries. Use only APIs you are certain exist at API 26-35. Re-read every file for syntax/imports before finishing.
- minSdk 26, targetSdk 35, compileSdk 35. AGP 8.7.x, Gradle 8.9 (distributionUrl in gradle/wrapper/gradle-wrapper.properties; no wrapper jar is needed, Android Studio supplies it - say so in the README). Include settings.gradle, build.gradle (root + app), gradle.properties (android.useAndroidX=false is fine since no AndroidX), proguard off.
- Do not touch anything outside comfy-concept-app/. Existing server and web app keep working; only make the small additive web changes listed below, with tests.

## Layout
comfy-concept-app/android/  (Android Studio project root)
  app/src/main/AndroidManifest.xml, java/app/jesse/comfyconcept/*.java, res/...
  README-ANDROID.md (build + install steps, below)

## App behaviour
1. MainActivity: full-screen dark WebView loading the server URL (default https://my-pc.my-tailnet.ts.net, stored in SharedPreferences, changeable). JavaScript + DOM storage + service workers enabled, mixed content blocked, HTTPS only (no cleartext). Edge-to-edge dark system bars matching the web UI background. All orientations, resizeableActivity=true (tablet). Handle rotation without reloading the page (configChanges). Back button = WebView history, then exit.
2. File chooser: implement WebChromeClient.onShowFileChooser so the web app's file inputs work (photo picker / camera / files, image/*), with the needed permissions handled correctly (camera permission requested at use time only).
3. Share target: manifest intent-filter for ACTION_SEND and ACTION_SEND_MULTIPLE with mimeType image/*. On receive: read the first image URI via ContentResolver, POST it as multipart/form-data (field name "image") with HttpURLConnection to <server>/share on a background thread (followRedirects = false), read the Location header (the server answers 303 to /?ref=...), then load <server><Location> in the WebView. If several images are shared, use the first and show a Toast saying so. Show errors as a Toast and just open the app. Check server/share.js for the exact contract.
4. JavaScript bridge `window.AndroidBridge` (addJavascriptInterface, @JavascriptInterface methods only, bridge only active for the configured server origin - verify the origin in shouldInterceptRequest/onPageStarted and never expose it to other origins):
   - saveImage(url, filename): download the image (same cookies/session not needed; it is a tailnet URL) on a background thread and save to the gallery with MediaStore (Pictures/Comfy Concept), Toast on result. Must work on API 26-35 (use MediaStore.Images + RELATIVE_PATH on 29+, legacy path before 29; minSdk 26 so handle 26-28 with WRITE_EXTERNAL_STORAGE maxSdkVersion=28 and a runtime request).
   - shareImage(url, filename): download to cache, share through a FileProvider content URI with ACTION_SEND (declare the FileProvider in the manifest with its xml paths; this is framework android.content.FileProvider only if that class is in the framework - it is NOT; androidx is banned, so implement a tiny ContentProvider subclass yourself that serves files from cache/shared/ read-only, or use another safe approach. Choose the approach you are sure compiles.)
   - keepAwake(boolean): set/clear FLAG_KEEP_SCREEN_ON.
   - isNativeApp(): returns true.
5. Downloads: also set a DownloadListener that routes any download to the same MediaStore save path.
6. Error page: if the server cannot be reached (onReceivedError for the main frame), show a native fallback view (not a blank page) with: the address, "Retry", "Open Tailscale" (launch package com.tailscale.ipn if installed, else open its Play Store page), and "Change address" (dialog with a text field; validate https:// URL; save to prefs). Also expose "Change address" from a launcher shortcut (static shortcut in res/xml/shortcuts.xml).
7. No analytics, no extra permissions beyond INTERNET, CAMERA (only if you actually need it for capture; the file chooser camera path needs it), and WRITE_EXTERNAL_STORAGE maxSdkVersion 28.
8. Security: allowBackup=false, no file access from WebView (setAllowFileAccess(false)), setAllowContentAccess only as needed, WebView debugging off in release.

## Web app changes (additive, in ../app, with tests)
- In the viewer's Save and Share buttons: if window.AndroidBridge exists, call AndroidBridge.saveImage / shareImage with the absolute image URL and filename instead of the browser path. Otherwise unchanged.
- While a batch/queue is active call AndroidBridge.keepAwake(true), and false when idle.
- Add tests (browser tests with a stub window.AndroidBridge injected) proving the bridge paths are used, and that nothing changes without it. Run the existing test suites (`npm test`, `npm run test:browser`) and keep them green.

## Icon
Original design, do NOT copy any existing logo: adaptive icon (res/mipmap-anydpi-v26/ic_launcher.xml + round) with a dark slightly-purple background (#1E1730) and a bold, geometric letter "C" foreground built as a vector drawable (a thick circular-arc C with rounded ends, light lavender #CDB8FF, sized inside the 66% adaptive safe zone), plus a monochrome layer for themed icons. Keep the foreground in its own file res/drawable/ic_launcher_foreground.xml so the owner can swap in their own artwork later; document that in README-ANDROID.md. Also render a 512x512 preview PNG of the icon into android/icon-preview.png (any tool in the VM, e.g. python with PIL or node canvas; if neither is available, hand-write the PNG encoder as scripts/png.js already does).

## README-ANDROID.md must contain
1. Open android/ in Android Studio (File > Open). Accept Gradle sync; if it offers to upgrade AGP/Gradle, accept.
2. Phone: Settings > About > tap Build number x7, enable USB debugging, plug in, allow the PC; select the phone in the device dropdown; press Run. Tablet: same.
3. Sideload alternative: Build > Build Bundle(s)/APK(s) > Build APK(s); the APK path; install with `adb install -r app-debug.apk`.
4. First launch: confirm the server address; needs the Tailscale app connected on the device.
5. How to change the address, how to swap the icon, known limits (single reference image from share, needs Tailscale + PC on).
6. A list of the exact things the owner must verify on-device (share from Photos and from a screenshot, camera capture, save to gallery, share out, keep-awake during a batch, rotation, tablet layout, Tailscale-off error page).

## Definition of done
All Android source files written and re-read for compile correctness; web changes + tests green; README-ANDROID.md written; icon preview PNG; final report listing files, test results, anything uncertain about compilation (be candid: the Android part was NOT compiled), and the risk spots most likely to need a fix in Android Studio.
