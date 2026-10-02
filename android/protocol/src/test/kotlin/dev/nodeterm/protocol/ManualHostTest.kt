package dev.nodeterm.protocol

import dev.nodeterm.protocol.host.Capability
import dev.nodeterm.protocol.host.HostCapabilities
import dev.nodeterm.protocol.host.HostException
import dev.nodeterm.protocol.host.LegRouting
import dev.nodeterm.protocol.host.LegRouting.Leg
import dev.nodeterm.protocol.host.LegRouting.RelayLeg
import dev.nodeterm.protocol.host.NeedsRelayException
import dev.nodeterm.protocol.host.SshAuthRefusedException
import dev.nodeterm.protocol.host.TransportKind
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.pairing.PairingPayload
import dev.nodeterm.protocol.pairing.PairingResult
import dev.nodeterm.protocol.pairing.SshIdentity
import dev.nodeterm.protocol.ssh.HostKeyChangedException
import dev.nodeterm.protocol.ssh.HostKeyPin
import dev.nodeterm.protocol.ssh.ManualHost
import dev.nodeterm.protocol.ssh.ManualHost.Check
import dev.nodeterm.protocol.ssh.SshFallback
import dev.nodeterm.protocol.ssh.SshHostConnection
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.config.keys.AuthorizedKeysAuthenticator
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider
import org.apache.sshd.server.session.ServerSession
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Audit A27, part b: a computer added by its SSH address ("Add SSH server") instead of a pairing code
 * — a headless Server Edition (no pairing service exists) or a dev host the phone reaches only over
 * SSH. The form's checks, the record and its persisted shape, the one-line key install (run for real
 * under `/bin/sh`), the first connect against a real SSH server that reads that `authorized_keys`, and
 * the routing that keeps such a computer SSH-only with no relay offer anywhere.
 */
class ManualHostTest {
    private val identity = SshIdentity.generate()

    // ---- the form ---------------------------------------------------------------------------------

    private fun ok(host: String, port: String = "", user: String = "dev", name: String = ""): ManualHost.Address =
        assertIs<Check.Ok>(ManualHost.check(host, port, user, name), "$host:$port $user").address

    private fun invalid(host: String, port: String = "", user: String = "dev"): Check.Invalid =
        assertIs<Check.Invalid>(ManualHost.check(host, port, user), "$host:$port $user")

    @Test
    fun `host names, IPv4 and IPv6 addresses are accepted, port 22 by default and the host as the name`() {
        assertEquals(ManualHost.Address("devbox.local", 22, "dev", "devbox.local"), ok("  devbox.local "))
        assertEquals(ManualHost.Address("192.168.1.20", 2222, "dev", "Build box"), ok("192.168.1.20", "2222", name = " Build box "))
        assertEquals("fe80::1%wlan0", ok("fe80::1%wlan0").host)
        assertEquals("2001:db8::7", ok("[2001:db8::7]").host, "brackets are how an IPv6 address is often written")
        assertEquals("my_host-1.example.com.", ok("my_host-1.example.com.").host)
        assertEquals("alice@corp.example", ok("box", user = "alice@corp.example").user, "a domain login is a user name")
        assertEquals("x".repeat(ManualHost.MAX_NAME), ok("box", name = "x".repeat(200)).name)
        assertEquals("box", ok("box", name = "\u0007\n").name, "control characters only: no name, so the host")
    }

    @Test
    fun `each wrong field says what is wrong, and a right one says nothing`() {
        invalid("").let { assertTrue(it.host!!.contains("address")); assertNull(it.port); assertNull(it.user) }
        assertTrue(invalid("alice@devbox").host!!.contains("User"), "the user typed in the address field")
        assertTrue(invalid("devbox:2222").host!!.contains("Port"), "the port typed after the address")
        assertTrue(invalid("ssh://devbox").host!!.contains("ssh://"))
        assertTrue(invalid("dev box").host!!.contains("spaces"))
        assertTrue(invalid("-oProxyCommand=x").host != null, "never something that reads as an option")
        assertTrue(invalid("dev..box").host != null)
        assertTrue(invalid("[zz::1]").host!!.contains("IPv6"))
        assertTrue(invalid("box;rm").host != null)
        for (port in listOf("0", "65536", "22a", "-1", "123456")) assertTrue(invalid("box", port).port != null, port)
        assertEquals(1, ok("box", "1").port)
        assertEquals(65535, ok("box", "65535").port)
        for (user in listOf("", "a b", "-root", "a:b", "x".repeat(65), "a\tb")) assertTrue(invalid("box", user = user).user != null, "[$user]")
        val all = invalid("", "0", "")
        assertTrue(all.host != null && all.port != null && all.user != null, "every field is checked at once")
    }

    @Test
    fun `an address already in the list is found, paired or added, whatever the host name's case`() {
        val paired = PairedHost.from(
            PairingPayload.parse("""{"v":1,"host":"DevBox.local","user":"dev","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!,
            PairingResult("dev-1", "tok", null, null),
            now = 1
        )
        assertEquals(paired, ManualHost.existing(listOf(paired), ok("devbox.local")))
        assertNull(ManualHost.existing(listOf(paired), ok("devbox.local", "2222")), "another port is another login")
        assertNull(ManualHost.existing(listOf(paired), ok("devbox.local", user = "root")), "another user too")
    }

    // ---- the record -------------------------------------------------------------------------------

    @Test
    fun `the record is SSH-only with its pin, and survives a JSON round trip`() {
        val address = ok("srv.example", "2200", "ops", "Server")
        val h = ManualHost.record(address, "SHA256:abc", id = "ssh-1", now = 7)
        assertTrue(h.manual && h.sshAvailable)
        assertNull(h.relay)
        assertNull(h.hostKeyB64)
        assertNull(h.relayHostKeyB64)
        assertEquals("SHA256:abc", h.sshHostKeyFingerprint)
        assertEquals("Over SSH", h.sshLegName)
        assertEquals(h, PairedHost.fromJson(h.toJson()))
        assertEquals(JsonPrimitive(true), h.toJson()["manual"])
        assertTrue(ManualHost.newId().startsWith(ManualHost.ID_PREFIX))
        assertFailsWith<IllegalArgumentException>("no record without the pin the first connect made") {
            ManualHost.record(address, "")
        }
    }

    @Test
    fun `a paired computer's record is what it was, and an older build reads an added one as SSH with no relay`() {
        // A paired record carries no `manual` key, so what a build before A27 wrote and reads is unchanged.
        val paired = PairedHost.from(
            PairingPayload.parse("""{"v":1,"host":"10.0.0.2","user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"Box"}""")!!,
            PairingResult("dev-1", "tok", null, null),
            now = 5
        )
        assertFalse("manual" in paired.toJson())
        assertFalse(paired.manual)
        assertEquals("On your network", paired.sshLegName)
        // A build that predates the flag ignores the key: what it then reads (this build, without the
        // key) is a computer with SSH, no relay and the same pin — so it connects to it over SSH.
        val added = ManualHost.record(ok("box"), "SHA256:pin", id = "ssh-2", now = 9).toJson()
        val asOlderBuild = PairedHost.fromJson(JsonObject(added - "manual"))!!
        assertTrue(asOlderBuild.sshAvailable)
        assertNull(asOlderBuild.relay)
        assertEquals("SHA256:pin", asOlderBuild.sshHostKeyFingerprint)
        assertEquals(listOf("id", "name", "host", "port", "user", "sshAvailable", "sshHostKeyFingerprint", "pairedAt", "manual"), added.keys.toList())
    }

    @Test
    fun `a record added by address never carries a relay leg, even when the stored JSON says one`() {
        val tampered = JsonObject(
            ManualHost.record(ok("box"), "SHA256:pin", id = "ssh-3").toJson() + mapOf(
                "sshAvailable" to JsonPrimitive(false),
                "hostKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                "relay" to JsonObject(
                    mapOf(
                        "hostId" to JsonPrimitive("h"),
                        "hostPublicKeyB64" to JsonPrimitive("A".repeat(43) + "="),
                        "relayEndpoint" to JsonPrimitive("wss://relay.nodeterm.dev")
                    )
                )
            )
        )
        val h = PairedHost.fromJson(tampered)!!
        assertTrue(h.manual)
        assertTrue(h.sshAvailable, "SSH is its only route")
        assertNull(h.relay)
        assertNull(h.relayHostKeyB64)
    }

    // ---- the key install --------------------------------------------------------------------------

    private fun sh(command: String, home: File): Int {
        val pb = ProcessBuilder("/bin/sh", "-c", command).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(mapOf("HOME" to home.path, "PATH" to "/usr/bin:/bin"))
        val p = pb.start()
        val out = p.inputStream.bufferedReader().readText()
        val code = p.waitFor()
        assertEquals(0, code, out)
        return code
    }

    private fun mode(f: File) = PosixFilePermissions.toString(Files.getPosixFilePermissions(f.toPath()))

    @Test
    fun `the install line adds the key once, after a newline the file lacked, with the modes sshd wants`() {
        assumeTrue(File("/bin/sh").canExecute())
        val line = ManualHost.authorizedKeysLine(identity)
        assertTrue(line.startsWith("ssh-ed25519 ") && line.endsWith(" ${ManualHost.KEY_COMMENT}"), line)
        val command = ManualHost.installCommand(line)
        assertTrue(command.startsWith("sh -c '") && command.endsWith("'") && command.count { it == '\'' } == 2, command)

        val fresh = Files.createTempDirectory("nt-manual").toFile()
        try {
            sh(command, fresh)
            val keys = File(fresh, ".ssh/authorized_keys")
            assertEquals("$line\n", keys.readText())
            assertEquals("rwx------", mode(File(fresh, ".ssh")))
            assertEquals("rw-------", mode(keys))
            sh(command, fresh)
            assertEquals("$line\n", keys.readText(), "running it again adds nothing")
        } finally {
            fresh.deleteRecursively()
        }

        val existing = Files.createTempDirectory("nt-manual").toFile()
        try {
            val keys = File(existing, ".ssh").apply { mkdirs() }.resolve("authorized_keys")
            keys.writeText("ssh-rsa AAAAother laptop") // no newline at the end
            sh(command, existing)
            assertEquals("ssh-rsa AAAAother laptop\n$line\n", keys.readText(), "the other key's line stays whole")
        } finally {
            existing.deleteRecursively()
        }
        assertFailsWith<IllegalArgumentException>("nothing but a key line goes inside the quotes") {
            ManualHost.installCommand("ssh-ed25519 AAAA x'; rm -rf ~; echo '")
        }
    }

    // ---- the first connect --------------------------------------------------------------------------

    private fun server(home: File, hostKey: File): SshServer = SshServer.setUpDefaultServer().apply {
        host = "127.0.0.1"
        port = 0
        keyPairProvider = SimpleGeneratorHostKeyProvider(hostKey.toPath())
        // What sshd does with the key: read the user's authorized_keys, the file the install line writes.
        publickeyAuthenticator = object : AuthorizedKeysAuthenticator(File(home, ".ssh/authorized_keys").toPath()) {
            override fun isValidUsername(username: String?, session: ServerSession?) = username == "dev"
        }
        start()
    }

    private class MemoryPin(var value: String? = null) : HostKeyPin {
        override fun pinned() = value
        override fun pin(fingerprint: String) {
            value = fingerprint
        }
    }

    @Test
    fun `connect pins only once the computer accepts the phone's key, and later connects verify that pin`() {
        assumeTrue(File("/bin/sh").canExecute())
        val root = Files.createTempDirectory("nt-manual").toFile()
        val home = File(root, "home").apply { mkdirs() }
        val sshd = server(home, File(root, "hostkey.ser"))
        try {
            val address = ok("127.0.0.1", sshd.port.toString(), "dev", "Server Edition")
            // Before the key is installed: the server answers and refuses us. No record, no pin, and the
            // message says what to do.
            val refused = assertFailsWith<HostException> { ManualHost.connectFirst(address, identity) }
            assertEquals(ManualHost.keyNotAccepted(address), refused.message)
            assertTrue(refused.message!!.contains("authorized_keys"))
            val pin = MemoryPin()
            assertFailsWith<SshAuthRefusedException> {
                SshHostConnection.connect(address.host, address.port, address.user, identity, pin)
            }
            assertNull(pin.value, "a refusing server is never pinned (A49)")

            // The user runs the install line on the computer; now the first connect adds it.
            sh(ManualHost.installCommand(ManualHost.authorizedKeysLine(identity)), home)
            val added = ManualHost.connectFirst(address, identity, id = "ssh-9", now = 3)
            val serverKey = sshd.keyPairProvider.loadKeys(null).first().public
            assertEquals(SshHostConnection.fingerprint(serverKey), added.sshHostKeyFingerprint, "the pin is the key of the server that let us in")
            assertEquals(ManualHost.record(address, added.sshHostKeyFingerprint!!, "ssh-9", 3), added)

            // A later connect verifies against the kept pin…
            val kept = PairedHost.fromJson(added.toJson())!!
            SshHostConnection.connect(kept.host, kept.port, kept.user, identity, MemoryPin(kept.sshHostKeyFingerprint)).close()
            // …and another user on the same computer is refused like a missing key.
            val other = ok("127.0.0.1", sshd.port.toString(), "root")
            assertEquals(ManualHost.keyNotAccepted(other), assertFailsWith<HostException> { ManualHost.connectFirst(other, identity) }.message)
        } finally {
            sshd.stop(true)
        }

        // Another server at that address (a reinstall, or something else answering there): refused,
        // and with no relay to fall back to, the stop says to forget and add it again.
        val impostor = server(home, File(root, "other-hostkey.ser"))
        try {
            val kept = ManualHost.record(ok("127.0.0.1", impostor.port.toString(), "dev"), "SHA256:the-real-one")
            val changed = assertFailsWith<HostKeyChangedException> {
                SshHostConnection.connect(kept.host, kept.port, kept.user, identity, MemoryPin(kept.sshHostKeyFingerprint))
            }
            val next = assertIs<SshFallback.Next.Stop>(SshFallback.afterFailure(changed, false, false, addedOverSsh = kept.manual))
            assertTrue(next.message.contains(SshFallback.ADDED_OVER_SSH_KEY_ADVICE), next.message)
            assertFalse(next.message.contains("remote access"), "nothing on the computer can turn a relay on for it")
        } finally {
            impostor.stop(true)
            root.deleteRecursively()
        }
    }

    @Test
    fun `a computer that does not answer says how to check the address, and adds nothing`() {
        val dead = java.net.ServerSocket(0).use { it.localPort } // closed again: nothing listens there
        val e = assertFailsWith<HostException> {
            ManualHost.connectFirst(ok("127.0.0.1", dead.toString()), identity, connectTimeoutMs = 2_000)
        }
        assertTrue(e.message!!.endsWith(ManualHost.UNREACHABLE_ADVICE), e.message)
    }

    // ---- no relay, anywhere -------------------------------------------------------------------------

    @Test
    fun `a computer added by address has no relay leg, and every relay verb says remote access isn't set up`() {
        assertEquals(RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = true, addedOverSsh = true))
        // Whatever else the phone holds (a token left over, a route set before), it is not a relay leg.
        assertEquals(RelayLeg.ADDED_OVER_SSH, LegRouting.relayLeg(relayConfigured = true, sshOnlyRoute = false, addedOverSsh = true))
        assertEquals(RelayLeg.NOT_SET_UP, LegRouting.relayLeg(relayConfigured = false, sshOnlyRoute = false))
        val ssh = HostCapabilities(boardWrites = false, git = false, nodeActions = false, registerNode = false, answerApprovals = true)
        for (cap in listOf(Capability.BOARD_WRITES, Capability.REGISTER_NODE, Capability.NODE_ACTIONS, Capability.GIT)) {
            for (primary in listOf(TransportKind.SSH, null)) {
                val leg = assertIs<Leg.Unavailable>(LegRouting.route(cap, primary, ssh.takeIf { primary != null }, RelayLeg.ADDED_OVER_SSH), "$cap")
                assertTrue(leg.reason.contains("remote access isn't set up for this computer"), leg.reason)
                // Not the paired computer's advice: there is no Settings → Phone to turn it on with.
                assertFalse(leg.reason.contains("Settings"), leg.reason)
            }
        }
        // What the machine does itself stays on SSH.
        assertEquals(Leg.Primary, LegRouting.route(Capability.ANSWER_APPROVALS, TransportKind.SSH, ssh, RelayLeg.ADDED_OVER_SSH))
    }

    @Test
    fun `a refusal with no relay to offer says remote access isn't set up, and promises no relay`() {
        val e = NeedsRelayException("n1", "It opens through the relay.")
        assertEquals("It opens through the relay. ${NeedsRelayException.NO_RELAY_TO_OFFER}", e.withoutRelay)
        assertTrue(NeedsRelayException.NO_RELAY_TO_OFFER.startsWith("Remote access isn't set up for this computer"))
    }

    @Test
    fun `failures of a computer added by address stop on SSH and are said without your network`() {
        val down = HostException("Couldn't connect over SSH to dev@box:22 (timeout).")
        assertEquals(SshFallback.Next.Stop("Couldn't connect over SSH to dev@box:22 (timeout)."), SshFallback.afterFailure(down, false, false, addedOverSsh = true))
        // Even if a route allowing the relay were somehow stored for it.
        assertIs<SshFallback.Next.Stop>(SshFallback.afterFailure(down, relayAllowed = true, relayConfigured = true, addedOverSsh = true))
    }

    // ---- the app's wiring (only type-checked here, so pinned in its source) ------------------------

    @Test
    fun `the app keeps a computer added by address on SSH, adopts no relay for it and offers it none`() {
        val store = AppSourcePins.app("data/HostStore.kt")
        // Its route is SSH whatever is stored, and the stored route says so too for an older build.
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "fun route(id: String)"),
            "if (get(id)?.manual == true) return RoutePreference.SSH_ONLY"
        )
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(store, "fun addManual(host: PairedHost)"),
            "ManualHost.existing(", "?.let { return it }",
            "save(_hosts.value + host)",
            "putString(\"route.\${host.id}\", RoutePreference.SSH_ONLY.name)"
        )
        val session = AppSourcePins.app("conn/ConnectionManager.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(session, "private suspend fun adoptRelayIfAdvertised("),
            "if (host.manual) return",
            "ssh.readRelayAdvertisement()"
        )
        AppSourcePins.assertInOrder(session, "private fun relayConfigured(host: PairedHost): Boolean =", "!host.manual &&")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(session, "fun relayLeg()"), "addedOverSsh = host.manual")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(session, "private suspend fun connectLocked("),
            "SshFallback.afterFailure(", "addedOverSsh = host.manual"
        )
        // A08/A09 refusals with no relay leg say so, never the relay offer's text.
        AppSourcePins.assertInOrder(
            AppSourcePins.ui("TerminalController.kt"),
            "catch (e: NeedsRelayException)",
            "if (session.hasRelay) TermState.RelayOffer(msg) else TermState.Ended(e.withoutRelay)"
        )
        for (file in listOf("SessionsTab.kt", "InboxTab.kt")) {
            AppSourcePins.assertInOrder(
                AppSourcePins.ui(file),
                "catch (e: NeedsRelayException)",
                "if (!session.hasRelay) throw HostException(e.withoutRelay)"
            )
        }
    }

    @Test
    fun `the Hosts screen reaches the flow, which connects first and keeps only what authenticated`() {
        val hosts = AppSourcePins.ui("HostsScreen.kt")
        assertTrue(hosts.split("nav.push(Route.AddSshHost)").size - 1 >= 2, "both the empty list and the list offer it")
        val forget = AppSourcePins.blockAfter(hosts, "removing?.let { host ->")
        AppSourcePins.assertInOrder(forget, "if (host.manual)", "ManualHost.revokeHint(host.user)", "graph.connections.forget(host.id)", "graph.hosts.remove(host.id)")
        val main = AppSourcePins.app("MainActivity.kt")
        AppSourcePins.assertInOrder(main, "Route.AddSshHost -> listOf(\"addssh\")", "\"addssh\" -> Route.AddSshHost", "Route.AddSshHost -> AddSshHostScreen(nav)")
        val screen = AppSourcePins.ui("AddSshHostScreen.kt")
        AppSourcePins.assertInOrder(
            AppSourcePins.blockAfter(screen, "fun connect()"),
            "ManualHost.check(address, port, user, name)",
            "ManualHost.existing(graph.hosts.hosts.value, ok)",
            "ManualHost.connectFirst(ok, graph.sshIdentity)",
            "graph.hosts.addManual(record)"
        )
        AppSourcePins.assertInOrder(screen, "ManualHost.authorizedKeysLine(graph.sshIdentity)", "ManualHost.installCommand(keyLine)")
        AppSourcePins.assertInOrder(AppSourcePins.blockAfter(screen, "private fun Added("), "host.sshHostKeyFingerprint", "ManualHost.FINGERPRINT_CHECK_COMMAND")
    }

    @Test
    fun `the revoke hint and the fingerprint check name what the user looks for on the computer`() {
        assertTrue(ManualHost.revokeHint("ops").contains("${ManualHost.KEY_COMMENT} from ~/.ssh/authorized_keys of ops"))
        assertTrue(ManualHost.FINGERPRINT_CHECK_COMMAND.contains("ssh-keygen -lf"))
    }
}
