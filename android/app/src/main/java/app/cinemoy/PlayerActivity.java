package app.cinemoy;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Html;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.text.Cue;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native player (Media3 ExoPlayer). Hardware decoders handle H.264/HEVC/VP9/AV1; the Jellyfin FFmpeg
 * extension decodes audio the device can't (DTS, TrueHD, AC3/E-AC3…).
 *
 * Online subtitles (found by the engine) are drawn here rather than by ExoPlayer, so their timing
 * can be shifted live with the Sync control. Subtitles embedded in the video file still play
 * through ExoPlayer; one "Subtitles" menu lists both.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {
    public static final String EXTRA_REQUEST = "request";
    public static final String EXTRA_POSITION = "position";
    public static final String EXTRA_DURATION = "duration";
    public static final String EXTRA_ENDED = "ended";

    private static final float SYNC_STEP = 0.5f;
    // Left-to-right mark: keeps "فارسی · Provider · release" in reading order in menus.
    private static final String LTR = "‎";

    private ExoPlayer player;
    private PlayerView view;
    private SubtitleView subsView;
    private View topBar;
    private TextView titleView;
    private TextView statusView;
    private String statusUrl;
    private boolean ended;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService subsIo = Executors.newSingleThreadExecutor();

    /** An online subtitle offered by the engine. */
    private static final class OnlineSub {
        String cuesUrl, label, lang;
    }

    private final List<OnlineSub> online = new ArrayList<>();
    private int selectedOnline = -1;   // index into online, -1 = none
    private double[] cueStart = new double[0], cueEnd = new double[0];
    private CharSequence[] cueText = new CharSequence[0];
    private float delay;               // seconds; positive = subtitles later
    private String shownKey = "";
    private int loadToken;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_player);
        view = findViewById(R.id.player);
        subsView = findViewById(R.id.subs);
        topBar = findViewById(R.id.topBar);
        titleView = findViewById(R.id.title);
        statusView = findViewById(R.id.status);
        goFullscreen();

        JSONObject req;
        try {
            req = new JSONObject(getIntent().getStringExtra(EXTRA_REQUEST));
        } catch (Exception e) {
            finish();
            return;
        }
        String title = req.optString("title");
        String subtitle = req.optString("subtitle");
        titleView.setText(subtitle.isEmpty() ? title : title + "\n" + subtitle);
        statusUrl = req.optString("statusUrl");

        // Torrents can take a while to find peers: generous timeouts, and a bigger buffer.
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(60_000)
                .setReadTimeoutMs(60_000)
                .setAllowCrossProtocolRedirects(true);
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
                .setEnableDecoderFallback(true);
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(30_000, 120_000, 3_000, 10_000)
                .build();
        player = new ExoPlayer.Builder(this, renderers)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)))
                .setLoadControl(load)
                .build();
        view.setPlayer(player);
        view.setKeepScreenOn(true);
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility -> {
            titleView.setVisibility(visibility);
            topBar.setVisibility(visibility);
            updateStatusVisibility();
        });
        styleSubtitles(view.getSubtitleView());
        styleSubtitles(subsView);
        linkFocus();

        findViewById(R.id.subsBtn).setOnClickListener(v -> showSubtitleMenu());
        findViewById(R.id.syncBtn).setOnClickListener(v -> showSyncDialog());

        JSONArray list = req.optJSONArray("subtitles");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s == null || s.optString("cuesUrl").isEmpty()) continue;
            OnlineSub o = new OnlineSub();
            o.cuesUrl = s.optString("cuesUrl");
            o.lang = s.optString("lang");
            o.label = LTR + languageName(o.lang) + " · " + s.optString("label");
            online.add(o);
        }

        // Embedded subtitles in the preferred language play if no online one is chosen.
        String preferred = req.optString("preferredSubLang");
        if (!preferred.isEmpty()) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setPreferredTextLanguage(preferred)
                    .setSelectUndeterminedTextLanguage(false)
                    .build());
            for (int i = 0; i < online.size(); i++) {
                if (preferred.equals(online.get(i).lang)) { // the engine lists the best match first
                    selectOnline(i, true);
                    break;
                }
            }
        }

        MediaItem item = new MediaItem.Builder()
                .setUri(req.optString("url"))
                .setMediaMetadata(new MediaMetadata.Builder().setTitle(title).build())
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    ended = true;
                    finish();
                }
                updateStatusVisibility();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                showError(error);
            }
        });
        player.setMediaItem(item, Math.max(0, req.optLong("startMs")));
        player.prepare();
        player.setPlayWhenReady(true);
        pollStatus();
        renderSubtitles();
    }

    /** D-pad Up from the playback controls reaches the Subtitles / Sync buttons. */
    private void linkFocus() {
        int[] ids = {
                androidx.media3.ui.R.id.exo_play_pause, androidx.media3.ui.R.id.exo_prev,
                androidx.media3.ui.R.id.exo_next, androidx.media3.ui.R.id.exo_rew,
                androidx.media3.ui.R.id.exo_ffwd, androidx.media3.ui.R.id.exo_settings,
                androidx.media3.ui.R.id.exo_rew_with_amount, androidx.media3.ui.R.id.exo_ffwd_with_amount,
                androidx.media3.ui.R.id.exo_progress,
        };
        for (int id : ids) {
            View v = view.findViewById(id);
            if (v != null) v.setNextFocusUpId(R.id.subsBtn);
        }
        findViewById(R.id.subsBtn).setNextFocusDownId(androidx.media3.ui.R.id.exo_play_pause);
        findViewById(R.id.syncBtn).setNextFocusDownId(androidx.media3.ui.R.id.exo_play_pause);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Remote shortcuts: CC / Menu open the subtitle menu.
        if (keyCode == KeyEvent.KEYCODE_CAPTIONS || keyCode == KeyEvent.KEYCODE_MENU) {
            showSubtitleMenu();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ------------------------------------------------------------------ subtitles

    private void styleSubtitles(SubtitleView sv) {
        if (sv == null) return;
        sv.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * 1.3f);
        sv.setStyle(new CaptionStyleCompat(Color.WHITE, 0x66000000, Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, Typeface.DEFAULT_BOLD));
    }

    /** One list: Off, the online subtitles, then the ones embedded in the file. */
    private void showSubtitleMenu() {
        List<String> labels = new ArrayList<>();
        List<Runnable> actions = new ArrayList<>();
        int checked = 0;

        labels.add("Off");
        actions.add(() -> {
            selectOnline(-1, false);
            setEmbeddedText(null, -1);
        });
        for (int i = 0; i < online.size(); i++) {
            final int idx = i;
            if (i == selectedOnline) checked = labels.size();
            labels.add(online.get(i).label);
            actions.add(() -> selectOnline(idx, false));
        }
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                Format f = g.getTrackFormat(i);
                final int track = i;
                if (selectedOnline < 0 && g.isTrackSelected(i)) checked = labels.size();
                String name = f.label != null ? f.label : languageName(f.language == null ? "" : f.language);
                labels.add(LTR + "In video · " + (name.isEmpty() ? "Track " + (i + 1) : name));
                actions.add(() -> {
                    selectOnline(-1, false);
                    setEmbeddedText(g, track);
                });
            }
        }
        if (labels.size() == 1) {
            Toast.makeText(this, "No subtitles found for this video", Toast.LENGTH_LONG).show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Subtitles")
                .setSingleChoiceItems(labels.toArray(new String[0]), checked, (d, which) -> {
                    actions.get(which).run();
                    d.dismiss();
                })
                .setNeutralButton("Sync…", (d, w) -> showSyncDialog())
                .show();
    }

    /** group == null turns embedded subtitles off. */
    private void setEmbeddedText(Tracks.Group group, int track) {
        var p = player.getTrackSelectionParameters().buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT);
        if (group == null) p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
        else p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), track));
        player.setTrackSelectionParameters(p.build());
    }

    private void selectOnline(int index, boolean auto) {
        selectedOnline = index;
        cueStart = new double[0];
        cueEnd = new double[0];
        cueText = new CharSequence[0];
        shownKey = "";
        subsView.setCues(new ArrayList<>());
        final int token = ++loadToken;
        if (index < 0) return;
        setEmbeddedText(null, -1); // never show two subtitles at once
        final OnlineSub sub = online.get(index);
        subsIo.execute(() -> {
            try {
                JSONArray cues = new JSONObject(get(sub.cuesUrl, 30_000)).getJSONArray("cues");
                int n = cues.length();
                double[] s = new double[n], e = new double[n];
                CharSequence[] t = new CharSequence[n];
                for (int i = 0; i < n; i++) {
                    JSONObject c = cues.getJSONObject(i);
                    s[i] = c.optDouble("s");
                    e[i] = c.optDouble("e");
                    t[i] = styledText(c.optString("t"));
                }
                handler.post(() -> {
                    if (token != loadToken) return;
                    cueStart = s;
                    cueEnd = e;
                    cueText = t;
                    shownKey = "";
                    String name = sub.label.length() > 70 ? sub.label.substring(0, 70) + "…" : sub.label;
                    Toast.makeText(this, (auto ? "Subtitle: " : "") + name, Toast.LENGTH_SHORT).show();
                });
            } catch (Exception ex) {
                handler.post(() -> {
                    if (token != loadToken) return;
                    selectedOnline = -1;
                    Toast.makeText(this, "Subtitle failed to load", Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    /** Keeps <i>/<b>/<u> from the engine's cleaned text; everything else is literal. */
    private static CharSequence styledText(String t) {
        String html = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replaceAll("&lt;(/?)([ibu])&gt;", "<$1$2>")
                .replace("\n", "<br>");
        return Build.VERSION.SDK_INT >= 24 ? Html.fromHtml(html, Html.FROM_HTML_MODE_LEGACY) : Html.fromHtml(html);
    }

    /** Shows the cues active at (position − delay); runs ~12 times a second. */
    private void renderSubtitles() {
        if (player == null) return;
        double t = player.getCurrentPosition() / 1000.0 - delay;
        StringBuilder key = new StringBuilder();
        List<Cue> active = new ArrayList<>();
        int lo = 0, hi = cueStart.length - 1, idx = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (cueStart[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        for (int i = Math.max(0, idx - 7); i <= idx; i++) {
            if (cueEnd[i] > t) {
                key.append(i).append(',');
                active.add(new Cue.Builder().setText(cueText[i]).build());
            }
        }
        if (!key.toString().equals(shownKey)) {
            shownKey = key.toString();
            subsView.setCues(active);
        }
        handler.postDelayed(this::renderSubtitles, 80);
    }

    private void showSyncDialog() {
        if (selectedOnline < 0) {
            Toast.makeText(this, "Sync works with the online subtitles. Choose one in Subtitles first.", Toast.LENGTH_LONG).show();
            return;
        }
        float pad = getResources().getDisplayMetrics().density;
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding((int) (16 * pad), (int) (16 * pad), (int) (16 * pad), 0);
        Button earlier = new Button(this);
        Button later = new Button(this);
        TextView value = new TextView(this);
        earlier.setText("− 0.5s  earlier");
        later.setText("later  + 0.5s");
        earlier.setAllCaps(false);
        later.setAllCaps(false);
        value.setTextSize(20);
        value.setMinWidth((int) (90 * pad));
        value.setGravity(Gravity.CENTER);
        Runnable show = () -> value.setText(String.format(Locale.US, "%+.1fs", delay));
        show.run();
        earlier.setOnClickListener(v -> { delay = Math.round((delay - SYNC_STEP) * 10) / 10f; shownKey = ""; show.run(); });
        later.setOnClickListener(v -> { delay = Math.round((delay + SYNC_STEP) * 10) / 10f; shownKey = ""; show.run(); });
        row.addView(earlier);
        row.addView(value);
        row.addView(later);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Subtitle sync")
                .setMessage("If the text comes before the voices, press “later”. If it comes after, press “earlier”.")
                .setView(row)
                .setPositiveButton("Done", null)
                .setNeutralButton("Reset", null)
                .create();
        dialog.setOnShowListener(d -> {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> { delay = 0; shownKey = ""; show.run(); });
            later.requestFocus();
        });
        dialog.show();
    }

    private static String languageName(String code) {
        switch (code) {
            case "fa": case "fas": case "per": return "فارسی";
            case "en": case "eng": return "English";
            case "ar": case "ara": return "العربية";
            case "tr": case "tur": return "Türkçe";
            case "": return "";
            default:
                String name = new Locale(code).getDisplayLanguage();
                return name.isEmpty() ? code : name;
        }
    }

    // ------------------------------------------------------------------ status + errors

    private static String get(String url, int readTimeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(readTimeoutMs);
        try {
            if (c.getResponseCode() >= 400) throw new IOException("HTTP " + c.getResponseCode());
        } catch (IOException e) {
            c.disconnect();
            throw e;
        }
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    /** Peers and download speed from the engine, shown while buffering or when controls are up. */
    private void pollStatus() {
        if (statusUrl.isEmpty() || isFinishing()) return;
        io.execute(() -> {
            String text = null;
            try {
                JSONObject s = new JSONObject(get(statusUrl, 3000));
                if (!"idle".equals(s.optString("state"))) {
                    double speed = s.optDouble("downloadSpeed", 0);
                    text = String.format(Locale.US, "%d peers · %s",
                            s.optInt("peers"), speed > 1048576
                                    ? String.format(Locale.US, "%.1f MB/s", speed / 1048576)
                                    : String.format(Locale.US, "%d KB/s", Math.round(speed / 1024)));
                    if (s.optBoolean("lowDisk")) text += " · storage almost full";
                }
            } catch (Exception ignored) {
                // engine busy
            }
            final String t = text;
            handler.post(() -> {
                if (t != null) statusView.setText(t);
                updateStatusVisibility();
            });
        });
        handler.postDelayed(this::pollStatus, 1500);
    }

    private void updateStatusVisibility() {
        boolean buffering = player != null && player.getPlaybackState() != Player.STATE_READY;
        boolean show = statusView.getText().length() > 0 && (buffering || view.isControllerFullyVisible());
        statusView.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private void showError(PlaybackException error) {
        String msg = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                ? "This source could not be loaded (too few peers?). Try another source."
                : "Playback failed: " + error.getErrorCodeName();
        new AlertDialog.Builder(this)
                .setTitle("CineMoy")
                .setMessage(msg)
                .setPositiveButton("Close", (d, w) -> finish())
                .setOnCancelListener(d -> finish())
                .show();
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    public void finish() {
        if (player != null) {
            Intent result = new Intent();
            long dur = player.getDuration();
            result.putExtra(EXTRA_POSITION, player.getCurrentPosition());
            result.putExtra(EXTRA_DURATION, dur == C.TIME_UNSET ? 0 : dur);
            result.putExtra(EXTRA_ENDED, ended);
            setResult(RESULT_OK, result);
        }
        super.finish();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        subsIo.shutdownNow();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    private void goFullscreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }
}
