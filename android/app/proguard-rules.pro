# Minification is off (see build.gradle.kts). If it is ever turned on, sshj, BouncyCastle and
# EdDSA need keeps for their reflective provider/algorithm lookups.
-keep class net.schmizz.sshj.** { *; }
-keep class org.bouncycastle.** { *; }
-keep class net.i2p.crypto.eddsa.** { *; }
-dontwarn javax.naming.**
-dontwarn org.slf4j.**
