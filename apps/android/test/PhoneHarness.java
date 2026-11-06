// Owns: driving the APK's own relay classes from a host JVM for the relay interop harness (PC ↔ phone through the meeting server).
// B-078: pairing is the PC's connect request – the harness prints the code and waits until the PC accepts.
// Never: substitutes for a real Android device test – no WebView, no Android networking stack.
package com.teydralab.autark.android;

import com.teydralab.autark.android.relay.Json;
import com.teydralab.autark.android.relay.PhoneConnection;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Map;

public final class PhoneHarness {
    public static void main(String[] args) throws Exception {
        if (args.length >= 4 && args[0].equals("pair")) {
            try {
                PhoneConnection.Paired paired = PhoneConnection.pair(args[1], args[2], "Harness phone", new PhoneConnection.Pairing(),
                        (code, pcName) -> System.out.println(Json.write(Json.map("code", code, "pcName", pcName))));
                Files.write(Paths.get(args[3]), Json.write(Json.map("relay", paired.relay, "seed", paired.seed, "deviceId", paired.deviceId,
                        "token", paired.token, "pcs", Json.parse(paired.pcsJson()))).getBytes(StandardCharsets.UTF_8));
                System.out.println(Json.write(Json.map("ok", true, "deviceId", paired.deviceId, "pc", paired.pcs.get(0).fingerprint, "pcName", paired.pcs.get(0).name)));
            } catch (java.io.IOException error) {
                System.out.println(Json.write(Json.map("ok", false, "error", error.getMessage())));
            }
            return;
        }
        if (args.length >= 4 && args[0].equals("run")) {
            Map<String, Object> saved = Json.object(new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8));
            PhoneConnection.Paired paired = new PhoneConnection.Paired(Json.str(saved, "relay"), Json.str(saved, "seed"), Json.str(saved, "deviceId"),
                    Json.str(saved, "token"), PhoneConnection.Paired.pcsOf(saved.get("pcs")));
            PhoneConnection connection = new PhoneConnection(paired, (text, connected) ->
                    System.out.println(Json.write(Json.map("status", text, "connected", connected))));
            String origin = connection.start(Integer.parseInt(args[2]), args[3]);
            System.out.println(Json.write(Json.map("origin", origin, "phone", connection.self())));
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                if (line.equals("nudge")) connection.nudge();
                if (line.equals("streams")) System.out.println(Json.write(Json.map("streams", connection.openStreams())));
                if (line.equals("stop")) break;
            }
            connection.stop();
            return;
        }
        System.err.println("usage: pair <relay> <remoteId> <file> | run <file> <port> <gate>");
        System.exit(2);
    }
}
