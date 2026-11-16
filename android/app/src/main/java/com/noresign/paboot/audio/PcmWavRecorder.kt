package com.noresign.paboot.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

data class RecordedAudio(val wav: ByteArray, val durationMs: Long)

/**
 * 用 [AudioRecord] 录 16 kHz 单声道 16-bit PCM，停止时补 WAV 头。
 *
 * minSdk 24，MediaRecorder 的 Ogg/Opus 要 API 29，所以走 AudioRecord；录音有 60s 上限，
 * 超时通过 [start] 的 onMaxDuration 通知调用方停止。所有方法都应在主线程调用，
 * 读 PCM 与电平计算在独立线程。
 */
class PcmWavRecorder(
    private val sampleRate: Int = WavEncoder.SAMPLE_RATE,
    private val maxDurationMs: Int = 60_000,
) {
    private val lock = Any()
    private val pcm = ByteArrayOutputStream()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var recorder: AudioRecord? = null
    private var worker: Thread? = null
    @Volatile private var capturing = false

    fun start(onLevel: (Float) -> Unit, onMaxDuration: () -> Unit): Boolean {
        if (capturing) return false
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) return false
        val bufferBytes = max(minBuffer * 2, (sampleRate / 5) * 2)
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            )
        } catch (_: Exception) {
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return false
        }

        synchronized(lock) { pcm.reset() }
        capturing = true
        recorder = record
        try {
            record.startRecording()
        } catch (_: Exception) {
            finish(keep = false)
            return false
        }

        // 16-bit mono: bytes per second = sampleRate * 2.
        val maxBytes = sampleRate.toLong() * 2 * maxDurationMs / 1000
        worker = Thread {
            val buffer = ShortArray(bufferBytes / 2)
            var total = 0L
            while (capturing) {
                val read = record.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                val bytes = ByteArray(read * 2)
                var sum = 0.0
                for (index in 0 until read) {
                    val sample = buffer[index].toInt()
                    bytes[index * 2] = (sample and 0xff).toByte()
                    bytes[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
                    sum += sample.toDouble() * sample
                }
                synchronized(lock) {
                    if (!capturing) break
                    pcm.write(bytes)
                    total += bytes.size
                }

                val rms = sqrt(sum / read)
                val db = 20 * log10(max(rms, 1.0) / 32768.0)
                val level = ((db + 60.0) / 60.0).coerceIn(0.0, 1.0).toFloat()
                mainHandler.post { if (capturing) onLevel(level) }

                if (total >= maxBytes) {
                    capturing = false
                    try {
                        record.stop()
                    } catch (_: Exception) {
                        // already stopped
                    }
                    mainHandler.post { onMaxDuration() }
                    break
                }
            }
        }.also {
            it.name = "paboot-voice-recorder"
            it.isDaemon = true
            it.start()
        }
        return true
    }

    /** 停止并返回 WAV；没有有效数据时返回 null。可重复调用。 */
    fun stop(): RecordedAudio? {
        val data = finish(keep = true) ?: return null
        return RecordedAudio(
            wav = WavEncoder.encode(data, sampleRate),
            durationMs = WavEncoder.durationMs(data.size, sampleRate),
        )
    }

    /** 停止并丢弃本次录音。 */
    fun cancel() {
        finish(keep = false)
    }

    private fun finish(keep: Boolean): ByteArray? {
        if (!capturing && worker == null && recorder == null) return null
        capturing = false
        try {
            recorder?.stop()
        } catch (_: Exception) {
            // already stopped / never started
        }
        worker?.join(1_500)
        worker = null
        try {
            recorder?.release()
        } catch (_: Exception) {
            // ignore
        }
        recorder = null
        val data = synchronized(lock) { pcm.toByteArray().also { pcm.reset() } }
        return if (keep && data.isNotEmpty()) data else null
    }
}
