package dev.nodeterm.android.notify

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.nodeterm.android.AppGraph
import dev.nodeterm.android.NodetermApp
import dev.nodeterm.protocol.host.InboxNotificationActions
import dev.nodeterm.protocol.host.InboxNotificationActions.Outcome
import dev.nodeterm.protocol.host.InboxNotificationActions.Request
import dev.nodeterm.protocol.host.RelayApprovalGate
import kotlinx.coroutines.CancellationException

/**
 * An answer given from an Inbox notification (audit A25): Approve, Deny or a question's option, as
 * [InboxNotificationActions.plan] put them on the notification.
 *
 * The tap arrives here, in a receiver the system starts for this app only (it is not exported, and
 * the action's PendingIntent is explicit and immutable). The receiver does nothing slow: it takes the
 * actions off the notification ("Approving…"), so a second tap cannot send a second answer, and hands
 * the answer to [InboxActionWorker] as expedited work, which may connect for as long as a dial takes.
 * One answer per event is in flight at a time (unique work, KEEP).
 *
 * Android 12 and later ask for the unlock before they send an answering action
 * (`setAuthenticationRequired`); Android 11 and lower send it from a locked screen, so the receiver
 * refuses a locked phone itself and the notification says to unlock.
 */
class InboxActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val request = Request.decode(intent.getStringExtra(InboxNotifier.EXTRA_REQUEST)) ?: return
        if (!request.action.answers) return
        if (Build.VERSION.SDK_INT < 31 && context.getSystemService(KeyguardManager::class.java)?.isDeviceLocked == true) {
            InboxNotifier.settle(context, request, Outcome.LOCKED)
            return
        }
        InboxNotifier.sending(context, request)
        val work = OneTimeWorkRequestBuilder<InboxActionWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(Data.Builder().putString(InboxActionWorker.KEY_REQUEST, request.encode()).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(request.workName, ExistingWorkPolicy.KEEP, work)
    }
}

/**
 * Sends one answer from a notification and says on the notification how it went.
 *
 * It connects to that computer the way the background check does, never making a FIRST relay
 * handshake: the user tapped, but is not looking at the app, so nobody would compare the approval
 * code the desktop shows (RelayApprovalGate, audit A05). A connection already open is reused; else
 * the SSH leg or a relay that has already approved this phone; else the notification says to open
 * the app, which connects as the user. The answer is [dev.nodeterm.protocol.host.QuickActions]',
 * with its re-checks, through [InboxNotificationActions.perform]. It is never retried: one that may
 * have arrived is reported as unconfirmed, and a second `1` would land in whatever the pane shows by
 * then.
 */
class InboxActionWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val request = Request.decode(inputData.getString(KEY_REQUEST)) ?: return Result.success()
        val graph = NodetermApp.graph(applicationContext)
        val outcome = try {
            if (graph.hosts.get(request.hostId) == null) Outcome.NOT_PAIRED else answer(graph, request)
        } catch (e: CancellationException) {
            // Stopped by the system mid-way: whether the answer arrived is not known.
            InboxNotifier.settle(applicationContext, request, Outcome.UNCONFIRMED)
            throw e
        }
        InboxNotifier.settle(applicationContext, request, outcome)
        return Result.success()
    }

    private suspend fun answer(graph: AppGraph, request: Request): Outcome {
        val session = graph.connections.session(request.hostId)
        val watched = session.isWatched
        try {
            if (session.connection == null && !session.reachableQuietly()) return Outcome.NOT_APPROVED
            return InboxNotificationActions.perform(
                request.action,
                request.event,
                connect = { session.ensureConnected(RelayApprovalGate.Trigger.BACKGROUND) },
                viaRelay = { session.viaRelay(RelayApprovalGate.Trigger.BACKGROUND) }
            )
        } finally {
            // Don't hold a socket open in the background for a screen nobody is looking at.
            if (!watched && !session.isWatched) session.disconnect()
        }
    }

    /** Android 11 and lower run expedited work as a foreground service, which needs a notification. */
    override suspend fun getForegroundInfo(): ForegroundInfo = InboxNotifier.sendingForeground(applicationContext)

    companion object {
        const val KEY_REQUEST = "request"
    }
}
