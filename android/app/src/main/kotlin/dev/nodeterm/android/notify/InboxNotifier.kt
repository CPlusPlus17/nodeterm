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
import dev.nodeterm.protocol.model.PairedHost
import dev.nodeterm.protocol.model.ProjectsSnapshot
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * Notifications for "an agent needs you" / "an agent finished".
 *
 * The iOS app gets these as APNs pushes fanned out by the nodeterm backend (src/core/push-notify.ts).
 * That backend has no Android (FCM) leg, so this app cannot be woken the same way. What it does
 * instead, honestly: a periodic WorkManager check (Android's floor is 15 minutes) that reads each
 * paired computer's Inbox and raises a local notification for events it has not announced yet — plus
 * the in-app 8 s refresh while a computer's screen is open. A real push leg is backend work.
 */
object InboxNotifier {
    private const val CH_ATTENTION = "attention"
    private const val CH_DONE = "done"
    private const val WORK = "nodeterm.inbox"

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

    /** Announce events not announced before. Returns how many were posted. */
    fun announce(context: Context, host: PairedHost, snapshot: ProjectsSnapshot): Int {
        val graph = NodetermApp.graph(context)
        if (!graph.hosts.notificationsEnabled) return 0
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return 0
        val seen = graph.hosts.seenEvents()
        val fresh = snapshot.status?.inbox?.events.orEmpty().filter { ev ->
            ev.id !in seen && !ev.resolved && System.currentTimeMillis() - ev.ts < 6 * 3_600_000L
        }
        if (fresh.isEmpty()) return 0
        val nm = NotificationManagerCompat.from(context)
        for (ev in fresh.takeLast(5)) {
            nm.notify("${host.id}:${ev.id}".hashCode(), build(context, host, snapshot, ev))
        }
        graph.hosts.markSeen(fresh.map { it.id })
        return fresh.size
    }

    private fun build(context: Context, host: PairedHost, snapshot: ProjectsSnapshot, ev: InboxEvent): android.app.Notification {
        val node = snapshot.findNode(ev.nodeId)?.second
        val nodeTitle = snapshot.statusOf(ev.nodeId)?.name ?: node?.title ?: "Session"
        val headline = when (ev.kind) {
            InboxKind.APPROVAL, InboxKind.QUESTION -> "Needs you — $nodeTitle"
            InboxKind.DONE -> "Completed — $nodeTitle"
        }
        val open = PendingIntent.getActivity(
            context,
            host.id.hashCode(),
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_HOST_ID, host.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(context, if (ev.kind == InboxKind.DONE) CH_DONE else CH_ATTENTION)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(headline)
            .setContentText(ev.title + (ev.detail?.let { " — $it" } ?: ""))
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOfNotNull(ev.title, ev.detail).joinToString("\n")))
            .setSubText(host.name)
            .setWhen(ev.ts)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
    }
}

class InboxWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = NodetermApp.graph(applicationContext)
        for (host in graph.hosts.hosts.value) {
            val session = graph.connections.session(host.id)
            val watched = session.isWatched
            // BACKGROUND: never a first relay handshake — that would raise the desktop's approval
            // dialog with nobody at the phone to compare the code (audit A05).
            withTimeoutOrNull(45_000) { session.refreshNow(RelayApprovalGate.Trigger.BACKGROUND) }
            InboxNotifier.announce(applicationContext, host, session.snapshot.value)
            // Don't hold a socket open in the background for a screen nobody is looking at.
            if (!watched && !session.isWatched) session.disconnect()
        }
        return Result.success()
    }
}
