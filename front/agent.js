const { HubWsClient , WrtcBinaryChannel , HtmlVp8Capture } = await import("./utils.js");

function startAgent() {

    let capture = null;
    let rtc = null;
    let rtcTargetId = null;
    let rtcOpen = false;
    let lastAdminId = null;

    let lastCmd = null;

    const execLogs = [];
    const pushLog = (level, message, detail) => {
        return;
        try {
            execLogs.push({ ts: Date.now(), level: String(level || "info"), message: String(message || ""), detail: detail ?? null });
            if (execLogs.length > 200) execLogs.splice(0, execLogs.length - 200);
        } catch {}
    };

    let sentChunks = 0;
    let sentBytes = 0;

    const agentInfos = () => {
        return {
            role: "agent",
            ts: Date.now(),
            userAgent: navigator.userAgent,
            lastCmd,
            logs: execLogs,
            capture: {
                recording: !!capture?.isRecording?.() || false,
            },
            rtc: {
                targetId: rtcTargetId,
                open: rtcOpen,
            },
            stream: {
                sentChunks,
                sentBytes,
            },
        };
    };

    const ws = new HubWsClient({
        urlBase: "wss://wshnklvucl.zen-apps.com/ws",
        room: "screen-mirror",
        onStatus: (s) => console.log("[ws]", s),
    });

    const sendInfosTo = (to) => {
        try {
            if (to != null) ws.sendJsonTo(to, "infos", agentInfos());
            else ws.sendJsonBroadcast("infos", agentInfos());
        } catch {}
    };

    const describeError = (err) => {
        if (!err) return { name: "", message: "" };
        const name = String(err?.name || "Error");
        const message = String(err?.message || err);
        const stack = typeof err?.stack === "string" ? err.stack : "";
        return { name, message, stack };
    };

    const replyCmd = ({ to, reqType, ok, error, extra } = {}) => {
        try {
            if (to == null) return;
            const e = error ? describeError(error) : null;
            const payload = {
                type: reqType,
                ok: !!ok,
                error: e ? e.message : "",
                errorName: e ? e.name : "",
                errorStack: e ? e.stack : "",
                ts: Date.now(),
                ...extra,
            };

            lastCmd = payload;

            // On renvoie le résultat via infos (et pas via un message dédié)
            try {
                ws.sendJsonTo(to, "infos", agentInfos());
            } catch {}
        } catch {}
    };

    const setRtcOpen = (open) => {
        rtcOpen = !!open;
    };

    const stopRtc = () => {
        console.log("[rtc] stop");
        pushLog("info", "rtc_stop");
        try { rtc?.close?.(); } catch {}
        rtc = null;
        rtcTargetId = null;
        setRtcOpen(false);
    };

    const stopCapture = async () => {
        console.log("[capture] stop");
        pushLog("info", "capture_stop");
        try {
            if (capture) {
                await capture.stop();
            }
        } catch {}
        capture = null;
    };

    const startCapture = async () => {
        if (capture?.isRecording?.()) return;
        console.log("[capture] start");
        pushLog("info", "capture_start");

        const captureRoot = document.querySelector?.("[data-html-capture]") || document.body;
        pushLog("info", "capture_root", {
            tagName: captureRoot?.tagName || "",
            id: captureRoot?.id || "",
            className: captureRoot?.className || "",
        });

        capture = new HtmlVp8Capture({
            frameRate: 10,
            pixelRatio: 1,
            onStatus: (s) => {
                console.log("[capture] status", s);
                pushLog("info", "capture_status", s);
            },
            onError: (e) => {
                console.error("[capture] error", e);
                pushLog("error", "capture_error", { name: e?.name || "Error", message: e?.message || String(e) });
            },
        });

        await capture.start({
            element: captureRoot,
            onChunk: async (chunk) => {
                if (!rtcOpen || !rtc) return;
                try {
                    const data = chunk?.data;
                    if (!(data instanceof Uint8Array)) return;

                    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

                    try {
                        sentChunks += 1;
                        sentBytes += ab.byteLength;
                    } catch {}

                    console.log("[rtc] send binary", { size: ab.byteLength, chunks: sentChunks, bytes: sentBytes });
                    await rtc.sendBinary(ab);
                } catch {}
            },
        });
    };

    const connectToEmbed = async (targetId) => {
        if (targetId == null) return;
        if (rtcTargetId === targetId && rtcOpen) return;
        console.log("[rtc] connecting to embed", targetId);
        pushLog("info", "rtc_connect", { targetId });

        stopRtc();
        rtcTargetId = targetId;
        rtcOpen = false;

        const channel = new WrtcBinaryChannel({
            sendSignal: (signal) => {
                console.log("[rtc] sendSignal", signal?.type || "", signal);
                ws.sendJsonTo(targetId, "rtc", signal);
            },
            onSignal: (handler) => {
                console.log("[rtc] onSignal subscribed to", targetId);
                return ws.onJson((msg) => {
                    if (msg?.action !== "rtc") return;
                    if (msg?.from !== targetId) return;
                    console.log("[rtc] deliver signal from", targetId, msg?.data?.type || "");
                    handler(msg.data);
                });
            },
        });

        rtc = channel;

        try {
            await channel.start(true);
            setRtcOpen(true);
            console.log("[rtc] open to", targetId);
            pushLog("info", "rtc_open", { targetId });
        } catch (e) {
            console.warn("[rtc] start failed to", targetId, e);
            pushLog("error", "rtc_start_failed", { targetId, name: e?.name || "Error", message: e?.message || String(e) });
            stopRtc();
        }
    };

    ws.onJson((msg) => {
        if (msg?.action === "infos_req") {
            try {
                ws.sendJsonTo(msg.from, "infos", agentInfos());
            } catch (e) {
                console.error("Failed to reply to infos:", e);
            }
            return;
        }

        if (msg?.action === "cmd") {
            lastAdminId = msg.from;
            pushLog("info", "cmd_recv", msg?.data);

            const type = msg?.data?.type;
            if (type === "start_capture") {
                startCapture()
                    .then(() => {
                        console.log("[cmd] start_capture ok");
                        pushLog("info", "cmd_start_capture_ok");
                        replyCmd({ to: msg.from, reqType: type, ok: true });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] start_capture failed", d.name, d.message, d.stack);
                        pushLog("error", "cmd_start_capture_failed", d);
                        replyCmd({ to: msg.from, reqType: type, ok: false, error: e });
                    });
                return;
            }
            if (type === "stop_capture") {
                stopCapture()
                    .then(() => {
                        console.log("[cmd] stop_capture ok");
                        pushLog("info", "cmd_stop_capture_ok");
                        replyCmd({ to: msg.from, reqType: type, ok: true });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] stop_capture failed", d.name, d.message, d.stack);
                        pushLog("error", "cmd_stop_capture_failed", d);
                        replyCmd({ to: msg.from, reqType: type, ok: false, error: e });
                    });
                return;
            }
            if (type === "connect_embed") {
                connectToEmbed(msg?.data?.targetId)
                    .then(() => {
                        console.log("[cmd] connect_embed ok", msg?.data?.targetId);
                        pushLog("info", "cmd_connect_embed_ok", { targetId: msg?.data?.targetId });
                        replyCmd({ to: msg.from, reqType: type, ok: true, extra: { targetId: msg?.data?.targetId } });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] connect_embed failed", d.name, d.message, d.stack);
                        pushLog("error", "cmd_connect_embed_failed", d);
                        replyCmd({ to: msg.from, reqType: type, ok: false, error: e, extra: { targetId: msg?.data?.targetId } });
                    });
                return;
            }

            if (type === "disconnect_embed") {
                try {
                    stopRtc();
                    replyCmd({ to: msg.from, reqType: type, ok: true });
                } catch (e) {
                    replyCmd({ to: msg.from, reqType: type, ok: false, error: e });
                }
                return;
            }

            return;
        }

        console.log(msg);
    });

    ws.connect().catch((e) => console.error("WS connect failed:", e));
}

const params = new URLSearchParams(window.location.search);
const captureParam = params.get("capture");
const LS_KEY = "agent_autostart_capture";

if (captureParam === "true") {
    localStorage.setItem(LS_KEY, "true");
    startAgent();
} else if (captureParam === "false") {
    localStorage.removeItem(LS_KEY);
} else if (localStorage.getItem(LS_KEY) === "true") {
    startAgent();
}
