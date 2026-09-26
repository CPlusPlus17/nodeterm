package androidx.work
import android.content.Context
import java.util.concurrent.TimeUnit
abstract class CoroutineWorker(appContext: Context, params: WorkerParameters) : ListenableWorker(appContext, params) {
    abstract suspend fun doWork(): Result
}
inline fun <reified W : ListenableWorker> PeriodicWorkRequestBuilder(repeatInterval: Long, repeatIntervalTimeUnit: TimeUnit): PeriodicWorkRequest.Builder =
    PeriodicWorkRequest.Builder(W::class.java, repeatInterval, repeatIntervalTimeUnit)
