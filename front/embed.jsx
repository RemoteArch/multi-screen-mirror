

const { useEffect, useRef } = React;
const { HubWsClient, WrtcBinaryChannel, Vp8Decoder } = await loadModule("utils.js");

export default function Emdeb() {
    const canvasRef = useRef(null);
    const wsRef = useRef(null);

    const lastAdminIdRef = useRef(null);

    const recvChunksRef = useRef(0);
    const recvBytesRef = useRef(0);

    const rtcRef = useRef(null);
    const rtcPeerIdRef = useRef(null);
    const rtcOpenRef = useRef(false);
    const rtcSignalHandlerRef = useRef(null);

    const videoRef = useRef(null);
    const decoderRef = useRef(null);
    const frameCountRef = useRef(0);

    const drawPlaceholder = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        console.log("[embed] draw placeholder");

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "14px sans-serif";
        ctx.fillText("EMDEB (WebCodecs)", 12, 24);
    };

    const resizeCanvasToDisplaySize = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const nextW = Math.max(1, Math.floor(rect.width * dpr));
        const nextH = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== nextW || canvas.height !== nextH) {
            console.log("[embed] resize", { nextW, nextH, dpr });
            canvas.width = nextW;
            canvas.height = nextH;
        }
    };

    const infosPayload = () => {
        return {
            role: "emdeb",
            ts: Date.now(),
            userAgent: navigator.userAgent,
            rtc: {
                peerId: rtcPeerIdRef.current,
                open: rtcOpenRef.current,
            },
            stream: {
                recvChunks: recvChunksRef.current,
                recvBytes: recvBytesRef.current,
                decodedFrames: frameCountRef.current,
                mode: "WebCodecs",
            },
        };
    };

    const sendInfosBroadcast = () => {
        try {
            wsRef.current?.sendJsonBroadcast("infos", infosPayload());
        } catch {}
    };

    const sendInfosTo = (to) => {
        try {
            wsRef.current?.sendJsonTo(to, "infos", infosPayload());
        } catch {}
    };

    const stopRtc = () => {
        console.log("[rtc] stop");
        try { rtcRef.current?.close?.(); } catch {}
        rtcRef.current = null;
        rtcPeerIdRef.current = null;
        rtcOpenRef.current = false;
        
        if (decoderRef.current) {
            try { decoderRef.current.close(); } catch {}
            decoderRef.current = null;
        }
        
        sendInfosBroadcast();
    };

    const ensureDecoder = () => {
        if (decoderRef.current) return;

        console.log("[decoder] initializing Vp8Decoder");

        const decoder = new Vp8Decoder({
            onFrame: (bitmap) => {
                const canvas = canvasRef.current;
                if (!canvas) {
                    try { bitmap.close(); } catch {}
                    return;
                }
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    try { bitmap.close(); } catch {}
                    return;
                }

                try {
                    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                } catch {}
                frameCountRef.current++;
                try { bitmap.close(); } catch {}
            },
            onError: (e) => {
                console.error("[decoder] fatal error", e);
                decoderRef.current = null;
            },
        });

        decoderRef.current = decoder;
        decoder.start().catch((e) => {
            console.error("[decoder] start failed", e);
            decoderRef.current = null;
        });
    };

    const decodeChunk = (ab) => {
        ensureDecoder();
        const decoder = decoderRef.current;
        if (!decoder) return;

        if (!ab || ab.byteLength < 1) return;
        const data = new Uint8Array(ab);

        // VP8 uncompressed frame tag: bit0 = 0 (keyframe) / 1 (interframe)
        const isInter = (data[0] & 0x01) === 1;
        const type = isInter ? "delta" : "key";

        // Timestamp: monotone local (microseconds-like)
        const ts = frameCountRef.current + 1;

        try {
            decoder.decode({
                type,
                timestamp: ts,
                data,
            }).catch((e) => {
                console.warn("[decoder] decode rejected", e?.name || "Error", e?.message || String(e));
            });
        } catch (e) {
            console.warn("[decoder] decode error", e.message);
            if (e.message.includes("key frame")) {
                frameCountRef.current = 0; // Reset to try to sync on next key
            }
        }
    };

    useEffect(() => {
        const onResize = () => resizeCanvasToDisplaySize();
        window.addEventListener("resize", onResize);

        resizeCanvasToDisplaySize();

        const ws = new HubWsClient({
            urlBase: "wss://wshnklvucl.zen-apps.com/ws",
            room: "screen-mirror",
            onStatus: (s) => {
                console.log("[ws]", s?.type, s?.detail || "");
            },
        });
        wsRef.current = ws;

        ws.onJson((msg) => {
            if (msg?.action === "infos_req") {
                if (msg?.from == null) return;
                lastAdminIdRef.current = msg.from;
                console.log("[ws] infos_req from", msg.from);
                sendInfosTo(msg.from);
                return;
            }

            if (msg?.action === "rtc") {
                if (msg?.from == null) return;

                const peerId = msg.from;
                console.log("[ws] rtc signal from", peerId, msg?.data?.type || "");

                // (re)start responder when first rtc arrives or peer changes
                if (!rtcRef.current || rtcPeerIdRef.current !== peerId) {
                    stopRtc();
                    rtcPeerIdRef.current = peerId;

                    const channel = new WrtcBinaryChannel({
                        sendSignal: (signal) => {
                            console.log("[rtc] sendSignal", signal?.type || "", signal);
                            ws.sendJsonTo(peerId, "rtc", signal);
                        },
                        onSignal: (handler) => {
                            console.log("[rtc] onSignal subscribed");
                            rtcSignalHandlerRef.current = handler;
                            return () => {};
                        },
                    });

                    rtcRef.current = channel;
                    rtcOpenRef.current = false;

                    channel.onBinary((buf) => {
                        try {
                            recvChunksRef.current += 1;
                            recvBytesRef.current += buf?.byteLength || 0;
                        } catch {}
                        // console.log("[rtc] binary", { size: buf?.byteLength || 0, chunks: recvChunksRef.current, bytes: recvBytesRef.current });
                        decodeChunk(buf);
                    });

                    channel.start(false).then(() => {
                        rtcOpenRef.current = true;
                        console.log("[rtc] open");
                        sendInfosBroadcast();
                    }).catch(() => {
                        console.warn("[rtc] start failed");
                        stopRtc();
                    });
                }

                // IMPORTANT: deliver the current rtc signal too (first offer often arrives here)
                try {
                    console.log("[rtc] deliver signal", msg?.data?.type || "", msg?.data);
                    rtcSignalHandlerRef.current?.(msg.data);
                } catch {}

                // Signal message will be consumed via onSignal subscription
                return;
            }
        });

        ws.connect().catch(() => {});

        return () => {
            window.removeEventListener("resize", onResize);
            stopRtc();
            try { wsRef.current?.close(); } catch {}
            wsRef.current = null;
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block" }}
        />
    );
}
