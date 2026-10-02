package androidx.work;
import android.content.Context;
public abstract class ListenableWorker {
  public ListenableWorker(Context appContext, WorkerParameters workerParams) {}
  public final Context getApplicationContext() { return null; }
  public final Data getInputData() { return null; }
  public abstract static class Result { public static Result success() { return null; } public static Result retry() { return null; } }
}
