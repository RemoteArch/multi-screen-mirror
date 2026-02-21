import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

class H264ChunkedScreenEncoder(
    private val projection: MediaProjection,
    private val width: Int,
    private val height: Int,
    private val dpi: Int,
    private val chunkMs: Long = 2000,              // ✅ durée chunk (ex: 2000ms)
    private val bitrate: Int = 2_000_000,          // ✅ moins lourd (720p: 1.5–3 Mbps)
    private val fps: Int = 30,
    private val iFrameIntervalSec: Int = 2,        // ✅ keyframe toutes les 2s
    private val onChunk: (chunk: ByteArray, startPtsUs: Long, endPtsUs: Long) -> Unit,
    private val onError: (Throwable) -> Unit = {}
) {
    private var codec: MediaCodec? = null
    private var vDisplay: VirtualDisplay? = null
    @Volatile private var running = false

    // SPS/PPS en Annex-B (00 00 00 01 ...)
    @Volatile private var configAnnexB: ByteArray? = null

    fun start() {
        if (running) return
        running = true

        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, iFrameIntervalSec)

                // Compat web/stream (baseline)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)

                // Si dispo, VBR (sinon Android ignore)
                if (android.os.Build.VERSION.SDK_INT >= 21) {
                    setInteger(
                        MediaFormat.KEY_BITRATE_MODE,
                        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
                    )
                }
            }

            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            }

            val surface = codec!!.createInputSurface()

            vDisplay = projection.createVirtualDisplay(
                "H264ChunkedScreenEncoder",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                surface,
                null,
                null
            )

            codec!!.start()
            thread(name = "h264-drain") { drainLoop() }
        } catch (t: Throwable) {
            running = false
            onError(t)
            safeRelease()
        }
    }

    fun stop() {
        running = false
        safeRelease()
    }

    private fun drainLoop() {
        val c = codec ?: return
        val info = MediaCodec.BufferInfo()

        val chunkBuffer = ByteArrayOutputStream(512 * 1024)
        var chunkStartPtsUs: Long = -1L
        var lastPtsUs: Long = -1L

        fun maybeStartChunk(ptsUs: Long) {
            if (chunkStartPtsUs < 0) {
                chunkStartPtsUs = ptsUs
                // ✅ préfixe SPS/PPS au début de chaque chunk (important pour décoder)
                configAnnexB?.let { chunkBuffer.write(it) }
            }
        }

        fun flushChunkIfNeeded(force: Boolean, isKeyFrame: Boolean, ptsUs: Long) {
            if (chunkStartPtsUs < 0) return
            val durationUs = ptsUs - chunkStartPtsUs
            val needFlush = force || (durationUs >= chunkMs * 1000 && isKeyFrame)

            if (needFlush && chunkBuffer.size() > 0) {
                val bytes = chunkBuffer.toByteArray()
                val start = chunkStartPtsUs
                val end = ptsUs
                chunkBuffer.reset()
                chunkStartPtsUs = -1L
                onChunk(bytes, start, end)
            }
        }

        try {
            while (running) {
                val index = c.dequeueOutputBuffer(info, 10_000)

                when {
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        // Récupère SPS/PPS (csd-0, csd-1) et convertit en Annex-B
                        val fmt = c.outputFormat
                        val csd0 = fmt.getByteBuffer("csd-0")
                        val csd1 = fmt.getByteBuffer("csd-1")
                        val sps = csd0?.let { bb ->
                            val arr = ByteArray(bb.remaining()); bb.get(arr); arr
                        }
                        val pps = csd1?.let { bb ->
                            val arr = ByteArray(bb.remaining()); bb.get(arr); arr
                        }
                        configAnnexB = buildAnnexBConfig(sps, pps)
                    }

                    index >= 0 -> {
                        val out = c.getOutputBuffer(index)
                        if (out != null && info.size > 0) {
                            out.position(info.offset)
                            out.limit(info.offset + info.size)

                            val avcc = ByteArray(info.size)
                            out.get(avcc)

                            val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                            val isKeyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0

                            lastPtsUs = info.presentationTimeUs

                            // Si c'est du "codec config" envoyé en buffer, on l'ignore ici
                            if (!isConfig) {
                                maybeStartChunk(info.presentationTimeUs)

                                // Convertit AVCC (length + NAL) -> Annex-B (00 00 00 01 + NAL)
                                val annexB = avccToAnnexB(avcc)
                                chunkBuffer.write(annexB)

                                // ✅ flush seulement sur keyframe après chunkMs (chunk "complet")
                                flushChunkIfNeeded(force = false, isKeyFrame = isKeyFrame, ptsUs = info.presentationTimeUs)
                            }
                        }
                        c.releaseOutputBuffer(index, false)
                    }
                }
            }
        } catch (t: Throwable) {
            onError(t)
        } finally {
            // flush final (même si pas sur keyframe)
            if (chunkBuffer.size() > 0 && lastPtsUs >= 0 && chunkStartPtsUs >= 0) {
                onChunk(chunkBuffer.toByteArray(), chunkStartPtsUs, lastPtsUs)
            }
            safeRelease()
        }
    }

    private fun safeRelease() {
        try { vDisplay?.release() } catch (_: Throwable) {}
        vDisplay = null

        try { codec?.stop() } catch (_: Throwable) {}
        try { codec?.release() } catch (_: Throwable) {}
        codec = null
    }

    // Construit SPS/PPS en Annex-B : [startcode+sps][startcode+pps]
    private fun buildAnnexBConfig(sps: ByteArray?, pps: ByteArray?): ByteArray? {
        if (sps == null && pps == null) return null
        val out = ByteArrayOutputStream()
        val sc = byteArrayOf(0, 0, 0, 1)
        if (sps != null) { out.write(sc); out.write(sps) }
        if (pps != null) { out.write(sc); out.write(pps) }
        return out.toByteArray()
    }

    /**
     * Convertit un buffer AVCC en Annex-B.
     * AVCC = [len][NAL][len][NAL]...
     * len = 4 bytes big-endian
     */
    private fun avccToAnnexB(avcc: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(avcc.size + 64)
        val sc = byteArrayOf(0, 0, 0, 1)
        var i = 0
        while (i + 4 <= avcc.size) {
            val len = ((avcc[i].toInt() and 0xFF) shl 24) or
                    ((avcc[i + 1].toInt() and 0xFF) shl 16) or
                    ((avcc[i + 2].toInt() and 0xFF) shl 8) or
                    (avcc[i + 3].toInt() and 0xFF)
            i += 4
            if (len <= 0 || i + len > avcc.size) break
            out.write(sc)
            out.write(avcc, i, len)
            i += len
        }
        return out.toByteArray()
    }
}