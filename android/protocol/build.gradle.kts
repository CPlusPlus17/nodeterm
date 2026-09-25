import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.2.0"
    `java-library`
}

group = "dev.nodeterm"
version = "0.1.0"

java {
    // Android's D8 accepts Java 17 bytecode; building with a newer JDK is fine, targeting it is not.
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    // Direct-SSH transport (LAN pairing). sshj brings its own BouncyCastle + EdDSA; on Android the
    // app re-registers the full BouncyCastle provider at startup (see NodetermApp).
    api("com.hierynomus:sshj:0.39.0")
    // sshj declares EdDSA runtime-only; the phone's Ed25519 identity is built with it directly.
    api("net.i2p.crypto:eddsa:0.3.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
    // A real SSH server for the direct-SSH transport tests (runs /bin/sh + a sandboxed tmux).
    testImplementation("org.apache.sshd:sshd-core:2.14.0")
    testRuntimeOnly("org.slf4j:slf4j-simple:2.0.16")
}

tasks.test {
    useJUnitPlatform()
    // Interop tests drive this repo's TypeScript host code through node. They locate the repo root
    // from here and skip themselves (with a reason) when node or node_modules are missing.
    systemProperty("nodeterm.repoRoot", rootDir.resolve("../..").canonicalPath)
    systemProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn")
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
