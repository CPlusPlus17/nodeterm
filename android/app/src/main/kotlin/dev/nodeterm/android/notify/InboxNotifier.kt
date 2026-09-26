package dev.nodeterm.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.nodeterm.android.MainActivity
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.android.R
import dev.nodeterm.protocol.host.RelayApprovalGate
import dev.nodeterm.protocol.model.InboxEvent
import dev.nodeterm.protocol.model.InboxKind
import dev.nodeterm.protocol.model.InboxNotificationText
import dev.nodeterm.protocol.model.OnScreen
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * Notifications for "an agent needs you" / "an agent finished".
 *
 * The iOS app gets these as APNs pushes fanned out by the nodeterm backend (src/core/push-notify.ts).
 * That backend has no Android (FCM) leg, so this app cannot be woken the same way. What it does
 * instead, honestly: checked about every 15 minutes in the background, and live for the computer
 * whose screen is open. Both are the same [announce], run on every fresh listing of a computer
 * (HostSession.refreshNow): the periodic WorkManager check (Android's floor is 15 minutes) lists
 * each paired computer, and the app re-lists the computer on screen every 8 s (audit A73). Other
 * computers are not polled, so their notifications come from the background check only. What the
 * user is looking at ([OnScreen]) is recorded as seen instead of announced. A real push leg is
 * backend work.
 */
object InboxNotifier {
    private const val CH_ATTENTION = "attention"
    private const val CH_DONE = "done"
    private const val WORK = "nodeterm.inbox"

    /** This phone will actually SHOW our notifications: the app-level switch in system settings,
     *  which on Android 13+ also reflects the runtime POST_NOTIFICATIONS permission (audit A21). */
    fun canPost(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CH_ATTENTION, context.getString(R.string.channel_attention), NotificationManager.IMPORTANCE_HIGH)
                .apply { description = context.getString(R.string.channel_attention_desc) }
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_DONE, context.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = context.getString(R.string.channel_done_desc) }
        )
    }

    fun schedule(context: Context, enabled: Boolean) {
        val wm = WorkManager.getInstance(context)
        if (!enabled) {
            wm.cancelUniqueWork(WORK)
            return
        }
        val req = PeriodicWorkRequestBuilder<InboxWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /**
     * Announce the events of a fresh listing of [host] not announced before, except what [onScreen]
     * says the user is looking at: those are recorded as seen (audit A73). Returns how many were
     * posted.
     */
    fun announce(context: Context, host: PairedHost, snapshot: ProjectsSnapshot, onScreen: OnScreen): Int {
        val graph = NodetermApp.graph(context)
        // The switch, and whether the system will show it (A21): with either off nothing is claimed,
        // but what is on screen is still recorded as seen, so turning them on later does not
        // announce what the user already looked at.
        val permitted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val notify = graph.hosts.notificationsEnabled && canPost(context) && permitted
        // Decided and recorded in one locked step (SeenLog, audits A48/A73): unresolved, younger than
        // the announce window, not on screen, and never announced, read or shown on this phone.
        val fresh = graph.hosts.claimLive(snapshot.status?.inbox?.events.orEmpty(), onScreen, notify)
        if (fresh.isEmpty()) return 0
        val nm = NotificationManagerCompat.from(context)
        val showDetails = graph.hosts.notificationDetails
        for (ev in fresh.takeLast(5)) {
            nm.notify("${host.id}:${ev.id}".hashCode(), build(context, host, snapshot, ev, showDetails))
        }
        return fresh.size
    }

    /**
     * The event's own text (the command, file or question, the agent's last message) is left out
     * unless the user opted in: Android shows a notification's full content on a secure lock screen
     * under its default setting, and a public version changes that only for users who hide sensitive
     * content (audit A52). The words are [InboxNotificationText]'s; the public version is always set.
     */
    private fun build(
        context: Context,
        host: PairedHost,
        snapshot: ProjectsSnapshot,
        ev: InboxEvent,
        showDetails: Boolean
    ): android.app.Notification {
        val node = snapshot.findNode(ev.nodeId)?.second
        val session = snapshot.statusOf(ev.nodeId)?.name?.takeIf { it.isNotBlank() } ?: node?.title
        val words = InboxNotificationText.of(ev, session, host.name, showDetails)
        val channel = if (ev.kind == InboxKind.DONE) CH_DONE else CH_ATTENTION
        val open = PendingIntent.getActivity(
            context,
            host.id.hashCode(),
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_HOST_ID, host.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(words.publicTitle)
            .setContentText(words.publicText)
            .setWhen(ev.ts)
            .build()
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(words.title)
            .setContentText(words.text)
            .setSubText(host.name)
            .setWhen(ev.ts)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
        words.bigText?.let { builder.setStyle(NotificationCompat.BigTextStyle().bigText(it)) }
        return builder.build()
    }
}

class InboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = NodetermApp.graph(applicationContext)
        // Nothing could be shown: do not dial every computer every 15 minutes for it (audit A21).
        if (!graph.hosts.notificationsEnabled || !InboxNotifier.canPost(applicationContext)) return Result.success()
        for (host in graph.hosts.hosts.value) {
            val session = graph.connections.session(host.id)
            val watched = session.isWatched
            // BACKGROUND: never a first relay handshake — that would raise the desktop's approval
            // dialog with nobody at the phone to compare the code (audit A05). A listing that arrives
            // announces its new events itself (HostSession.refreshNow → InboxNotifier.announce, the
            // path the live refresh takes too, audit A73); a failed one has nothing new to announce.
            withTimeoutOrNull(45_000) { session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND) }
            // Don't hold a socket open in the background for a screen nobody is looking at.
            if (!watched && !session.isWatched) session.disconnect()
        }
        return Result.success()
    }
}
