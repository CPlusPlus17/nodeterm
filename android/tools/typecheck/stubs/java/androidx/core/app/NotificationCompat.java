package androidx.core.app;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
public class NotificationCompat {
  public static final int VISIBILITY_PUBLIC = Notification.VISIBILITY_PUBLIC;
  public static final int VISIBILITY_PRIVATE = Notification.VISIBILITY_PRIVATE;
  public static final int VISIBILITY_SECRET = Notification.VISIBILITY_SECRET;
  public abstract static class Style {}
  public static class BigTextStyle extends Style { public BigTextStyle bigText(CharSequence cs) { return this; } }
  public static class Builder {
    public Builder(Context context, String channelId) {}
    public Builder setSmallIcon(int icon) { return this; }
    public Builder setContentTitle(CharSequence title) { return this; }
    public Builder setContentText(CharSequence text) { return this; }
    public Builder setStyle(Style style) { return this; }
    public Builder setSubText(CharSequence text) { return this; }
    public Builder setWhen(long when) { return this; }
    public Builder setAutoCancel(boolean autoCancel) { return this; }
    public Builder setContentIntent(PendingIntent intent) { return this; }
    public Builder setVisibility(int visibility) { return this; }
    public Builder setPublicVersion(Notification n) { return this; }
    public Notification build() { return null; }
  }
}
