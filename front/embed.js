const { HubWsClient, WrtcBinaryChannel, Vp8Decoder } = await import("./utils.js");

let canvas = null;
let ws = null;
let rtc = null;

let lastAdminId = null;
let recvChunks = 0;
let recvBytes = 0;
let rtcPeerId = null;
let rtcOpen = false;

let video = null;
let mediaSource = null;
let sourceBuffer = null;
let appendQueue = [];
let drawRaf = null;

let vp8Decoder = null;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.display = "block";
  document.body.appendChild(canvas);
}

function drawPlaceholder() {
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
  ctx.fillText("EMDEB", 12, 24);
}

function resizeCanvasToDisplaySize() {
  ensureCanvas();
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const nextW = Math.max(1, Math.floor(rect.width * dpr));
  const nextH = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== nextW || canvas.height !== nextH) {
    console.log("[embed] resize", { nextW, nextH, dpr });
    canvas.width = nextW;
    canvas.height = nextH;
    drawPlaceholder();
  }
}

function infosPayload() {
  return {
    role: "emdeb",
    ts: Date.now(),
    userAgent: navigator.userAgent,
    rtc: {
      peerId: rtcPeerId,
      open: rtcOpen,
    },
    stream: {
      recvChunks,
      recvBytes,
      queue: appendQueue.length,
      mse: {
        readyState: mediaSource?.readyState ?? null,
        sourceBuffer: !!sourceBuffer,
        updating: !!sourceBuffer?.updating,
      },
      video: {
        readyState: video?.readyState ?? null,
        paused: video?.paused ?? null,
      },
    },
  };
}

function sendInfosBroadcast() {
  try {
    ws?.sendJsonBroadcast("infos", infosPayload());
  } catch {}
}

function sendInfosTo(to) {
  try {
    ws?.sendJsonTo(to, "infos", infosPayload());
  } catch {}
}

function stopRtc() {
  console.log("[rtc] stop");
  rtcPeerId = null;
  rtcOpen = false;
  sendInfosBroadcast();
}

function ensureMediaPipeline() {
  if (video && mediaSource) return;
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  video.src = url;
  mediaSource.addEventListener("sourceopen", () => {
    try {
      console.log("[mse] sourceopen");
      const mime = 'video/webm;codecs="vp8,opus"';
      const sb = mediaSource.addSourceBuffer(mime);
      sb.mode = "sequence";
      sourceBuffer = sb;
      const q0 = appendQueue;
      if (!sb.updating && q0.length > 0) {
        console.log("[mse] append initial", { len: q0[0]?.byteLength || 0, queue: q0.length });
        try { sb.appendBuffer(q0.shift()); } catch {}
      }
      sb.addEventListener("updateend", () => {
        const q = appendQueue;
        console.log("[mse] updateend", { queue: q.length });
        if (!sb.updating && q.length > 0) {
          try { sb.appendBuffer(q.shift()); } catch {}
        }
      });
    } catch {}
  });
}

function enqueueChunk(ab) {
  const sb = sourceBuffer;
  if (!sb) {
    appendQueue.push(ab);
    return;
  }
  if (sb.updating || appendQueue.length > 0) {
    appendQueue.push(ab);
    console.log("[mse] queue push", { size: ab?.byteLength || 0, queue: appendQueue.length });
    return;
  }
  try {
    sb.appendBuffer(ab);
    console.log("[mse] append", { size: ab?.byteLength || 0 });
  } catch {
    appendQueue.push(ab);
    console.log("[mse] append error -> queued", { size: ab?.byteLength || 0, queue: appendQueue.length });
  }
}

function startDrawingToCanvas() {
  if (drawRaf) return;
  const tick = () => {
    drawRaf = requestAnimationFrame(tick);
    if (!canvas || !video) return;
    if (video.readyState < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {}
  };
  drawRaf = requestAnimationFrame(tick);
}

function ensureVp8Decoder() {
  if (vp8Decoder) return;
  ensureCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  vp8Decoder = new Vp8Decoder({
    onFrame: (bitmap) => {
      try {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } catch {}
      try {
        bitmap.close();
      } catch {}
    },
    onStatus: (s, d) => console.log("[vp8dec]", s, d || ""),
    onError: (e) => console.warn("[vp8dec] error", e),
  });

  vp8Decoder.start().catch((e) => console.warn("[vp8dec] start failed", e));
}

function tryDecodeVp8Packet(buf) {
  // Format attendu (simple):
  // [0] = 0x4b ('K') keyframe | 0x44 ('D') delta
  // [1..8] = timestamp uint64be (optionnel, 0 si inconnu)
  // [9..] = VP8 bitstream
  //
  // Si ce format ne matche pas, on renvoie false et on laisse l'ancien pipeline.
  if (!buf || buf.byteLength < 10) return false;
  const u8 = new Uint8Array(buf);
  const t = u8[0];
  if (t !== 0x4b && t !== 0x44) return false;

  ensureVp8Decoder();
  if (!vp8Decoder) return false;

  let ts = 0;
  try {
    const dv = new DataView(buf);
    ts = Number(dv.getBigUint64(1, false));
  } catch {
    ts = 0;
  }

  const data = new Uint8Array(buf, 9);
  vp8Decoder
    .decode({
      type: t === 0x4b ? "key" : "delta",
      timestamp: ts,
      data,
    })
    .catch(() => {});

  return true;
}

function start() {
  const onResize = () => resizeCanvasToDisplaySize();
  window.addEventListener("resize", onResize);
  resizeCanvasToDisplaySize();

  ws = new HubWsClient({
    urlBase: "wss://wshnklvucl.zen-apps.com/ws",
    room: "screen-mirror",
    onStatus: (s) => {
      console.log("[ws]", s?.type, s?.detail || "");
    },
  });

  ws.onJson((msg) => {
    if (msg?.action === "infos_req") {
      if (msg?.from == null) return;
      lastAdminId = msg.from;
       console.log("[ws] infos_req from", msg.from);
      sendInfosTo(msg.from);
      return;
    }

    if (msg?.action === "rtc") {
      if (msg?.from == null) return;
      const peerId = msg.from;
      console.log("[ws] rtc signal from", peerId, msg?.data?.type || "");

      if (!rtc || rtcPeerId !== peerId) {
        stopRtc();
        rtcPeerId = peerId;

        const channel = new WrtcBinaryChannel({
          sendSignal: (signal) => {
            console.log("[rtc] sendSignal", signal?.type || "", signal);
            ws.sendJsonTo(peerId, "rtc", signal);
          },
          onSignal: (handler) => {
            console.log("[rtc] onSignal subscribed");
            return () => {};
          },
        });

        rtc = channel;
        rtcOpen = false;

        channel.onBinary((buf) => {
          try {
            recvChunks += 1;
            recvBytes += buf?.byteLength || 0;
          } catch {}
          console.log("[rtc] binary", { size: buf?.byteLength || 0, chunks: recvChunks, bytes: recvBytes });

          // Nouveau chemin: si le chunk correspond à une frame VP8 "raw",
          // on décode et on dessine directement sur le canvas.
          if (tryDecodeVp8Packet(buf)) return;

          // Fallback: ancien pipeline WebM via MediaSource.
          ensureMediaPipeline();
          enqueueChunk(buf);
          startDrawingToCanvas();
        });

        channel.start(false).then(() => {
          rtcOpen = true;
          console.log("[rtc] open");
          sendInfosBroadcast();
        }).catch(() => {
          console.warn("[rtc] start failed");
          stopRtc();
        });
      }

      try {
        console.log("[rtc] deliver signal", msg?.data?.type || "", msg?.data);
        rtc?._handleSignal?.(msg.data);
      } catch {}
      return;
    }
  });

  ws.connect().catch(() => {});

  window.addEventListener("beforeunload", () => {
    window.removeEventListener("resize", onResize);
    if (drawRaf) {
      cancelAnimationFrame(drawRaf);
      drawRaf = null;
    }
    stopRtc();
    try {
      if (video) {
        try { URL.revokeObjectURL(video.src); } catch {}
      }
    } catch {}
    video = null;
    mediaSource = null;
    sourceBuffer = null;
    appendQueue = [];
    try { vp8Decoder?.close(); } catch {}
    vp8Decoder = null;
    try { ws?.close(); } catch {}
    ws = null;
  });
}

start();
