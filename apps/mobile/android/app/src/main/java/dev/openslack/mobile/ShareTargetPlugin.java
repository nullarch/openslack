package dev.openslack.mobile;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * Text and files shared to the app from another app (the share sheet:
 * ACTION_SEND and ACTION_SEND_MULTIPLE). The web client asks for them with
 * take() when it starts, and hears "shareReceived" while it runs; it then
 * lets the person choose where to send them.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
    private static final int MAX_BYTES = 20 * 1024 * 1024;
    private static final int MAX_FILES = 10;
    private JSObject pending;

    @Override
    public void load() {
        pending = read(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject shared = read(intent);
        if (shared != null) {
            pending = null;
            notifyListeners("shareReceived", shared, true);
        }
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = pending != null ? pending : new JSObject();
        pending = null;
        call.resolve(result);
    }

    private JSObject read(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return null;
        JSObject shared = new JSObject();
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text != null) shared.put("text", subject != null && !text.contains(subject) ? subject + "\n" + text : text);
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            if (files.length() >= MAX_FILES) break;
            JSObject file = file(uri, intent.getType());
            if (file != null) files.put(file);
        }
        if (files.length() > 0) shared.put("files", files);
        // Handled once: turning the phone must not share it again.
        intent.setAction(null);
        return shared;
    }

    private JSObject file(Uri uri, String fallbackType) {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BYTES) return null;
                out.write(buffer, 0, read);
            }
            String name = "shared";
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) name = cursor.getString(0);
            }
            String type = getContext().getContentResolver().getType(uri);
            JSObject file = new JSObject();
            file.put("name", name);
            file.put("type", type != null ? type : (fallbackType != null ? fallbackType : "application/octet-stream"));
            file.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            return file;
        } catch (Exception error) {
            return null;
        }
    }
}
