# Offline type-check for the Android app

This is a stopgap for sandboxes that cannot reach Google Maven (`dl.google.com` / `maven.google.com`),
where the Android Gradle Plugin (AGP) cannot resolve. It compiles `android/app/src/main/kotlin` as
plain Kotlin/JVM against:

- `org.robolectric:android-all` (the Android framework classes, from Maven Central),
- Compose Multiplatform **desktop** artifacts (the same Compose APIs, from Maven Central), and
- hand-written stubs in `stubs/` for the androidx / zxing classes that exist only on Google Maven
  (activity-compose, work, core, the zxing scanner contract, and `R`).

```bash
cd android/tools/typecheck
gradle compileKotlin            # needs Gradle 8.x and a JDK 17+ on PATH; no wrapper here on purpose
```

What it catches: Kotlin compile errors, wrong imports, API misuse visible in signatures.

What it cannot catch: anything aapt2, the manifest merger, R8/D8 or a device would catch —
missing resources, manifest errors, Android-only runtime rules (e.g. `NetworkOnMainThreadException`),
API-level availability, and any difference between Compose Multiplatform desktop and Jetpack Compose
for Android. The real build is `./gradlew :app:assembleDebug` in `android/`, which CI runs
(`.github/workflows/android.yml`).

When the app starts using a new androidx/Google-Maven-only class, add a stub with the same
package, name and the signatures the app calls. `stubs/java/dev/nodeterm/android/R.java` must list
every `R.*` id the Kotlin references.
