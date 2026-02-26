const { HubWsClient , WrtcBinaryChannel , Vp8Capture } = await import("./utils.js");

function startAgent() {

    let capture = null;
    let rtc = null;
    let rtcTargetId = null;
    let rtcOpen = false;
    let lastAdminId = null;

    let sentChunks = 0;
    let sentBytes = 0;

    const agentInfos = () => {
        return {
            role: "agent",
            ts: Date.now(),
            userAgent: navigator.userAgent,
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
            ws.sendJsonTo(to, "cmd_result", {
                type: reqType,
                ok: !!ok,
                error: e ? e.message : "",
                errorName: e ? e.name : "",
                errorStack: e ? e.stack : "",
                ts: Date.now(),
                ...extra,
            });
        } catch {}
    };

    const setRtcOpen = (open) => {
        rtcOpen = !!open;
    };

    const stopRtc = () => {
        console.log("[rtc] stop");
        try { rtc?.close?.(); } catch {}
        rtc = null;
        rtcTargetId = null;
        setRtcOpen(false);
    };

    const stopCapture = async () => {
        console.log("[capture] stop");
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

        capture = new Vp8Capture({
            onStatus: (s) => console.log("[capture] status", s),
            onError: (e) => console.error("[capture] error", e),
        });

        await capture.start({
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
        } catch (e) {
            console.warn("[rtc] start failed to", targetId, e);
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

            const type = msg?.data?.type;
            if (type === "start_capture") {
                startCapture()
                    .then(() => {
                        console.log("[cmd] start_capture ok");
                        replyCmd({ to: msg.from, reqType: type, ok: true });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] start_capture failed", d.name, d.message, d.stack);
                        replyCmd({ to: msg.from, reqType: type, ok: false, error: e });
                    });
                return;
            }
            if (type === "stop_capture") {
                stopCapture()
                    .then(() => {
                        console.log("[cmd] stop_capture ok");
                        replyCmd({ to: msg.from, reqType: type, ok: true });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] stop_capture failed", d.name, d.message, d.stack);
                        replyCmd({ to: msg.from, reqType: type, ok: false, error: e });
                    });
                return;
            }
            if (type === "connect_embed") {
                connectToEmbed(msg?.data?.targetId)
                    .then(() => {
                        console.log("[cmd] connect_embed ok", msg?.data?.targetId);
                        replyCmd({ to: msg.from, reqType: type, ok: true, extra: { targetId: msg?.data?.targetId } });
                    })
                    .catch((e) => {
                        const d = describeError(e);
                        console.error("[cmd] connect_embed failed", d.name, d.message, d.stack);
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

startAgent()
