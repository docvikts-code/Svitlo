package com.docvikts.svitlo;

import android.util.Base64;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class PoweronClient {
    static String encode(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }

    public Object get(String path, String key) throws Exception {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api-poweron.toe.com.ua/api" + path).openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/ld+json, application/json");
        if (key != null) connection.setRequestProperty("X-debug-key", key);
        try {
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("Сервіс обленерго: HTTP " + status);
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int length;
                while ((length = stream.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                    if (bytes.size() + length > 4 * 1024 * 1024) throw new IllegalStateException("Надто велика відповідь обленерго");
                    bytes.write(buffer, 0, length);
                }
                return new JSONTokener(bytes.toString("UTF-8")).nextValue();
            }
        } finally { connection.disconnect(); }
    }

    public JSONObject load(JSONObject address, String date, long now) throws Exception {
        String city = address.getString("cityId"), street = address.getString("streetId"), house = address.getString("house");
        JSONObject response = (JSONObject) get("/pw-accounts/building-groups?cityId=" + encode(city)
            + "&streetId=" + encode(street) + "&buildingNames=" + encode(house), null);
        List<String> groups = ScheduleLogic.groups(response);
        JSONObject schedules = new JSONObject();
        if (!groups.isEmpty()) {
            String addressKey = city + "/" + street + "/" + house;
            String key = Base64.encodeToString(addressKey.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            StringBuilder path = new StringBuilder("/a_gpv_g?after=").append(encode(date + "T00:00:00+00:00"))
                .append("&before=").append(encode(ScheduleLogic.addDays(date, 1) + "T00:00:00+00:00"))
                .append("&time=").append(encode(addressKey.replace("/", "")));
            for (String group : groups) path.append("&group%5B%5D=").append(encode(group));
            schedules = ScheduleLogic.parse(get(path.toString(), key), groups, date);
        }
        return new JSONObject().put("date", date).put("fetchedAt", now).put("stale", false).put("schedules", schedules);
    }
}
