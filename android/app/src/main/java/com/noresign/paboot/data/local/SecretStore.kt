package com.noresign.paboot.data.local

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.tencent.mmkv.MMKV
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 应用私密配置（目前只有语音识别的 DeepSeek key）。
 *
 * 用 Android Keystore 里的 AES/GCM 密钥加密后再落 MMKV：MMKV 里只有密文，
 * 备份/换机导致密钥失效时直接丢弃旧值，让设置页重新要 key。
 */
object SecretStore {

    private const val KEY_ALIAS = "paboot.secrets.v1"
    private const val ASR_KEY = "deepseek_asr_api_key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    private val kv: MMKV by lazy { MMKV.defaultMMKV() }

    /** 用户在「模型 Provider」页填写的 DeepSeek API Key，仅用于语音识别。 */
    var asrApiKey: String?
        get() = readEncrypted(ASR_KEY)
        set(value) = writeEncrypted(ASR_KEY, value)

    fun hasAsrApiKey(): Boolean = !asrApiKey.isNullOrBlank()

    @Synchronized
    private fun writeEncrypted(name: String, value: String?) {
        if (value.isNullOrBlank()) {
            kv.removeValueForKey(name)
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
        kv.encode(name, packed)
    }

    @Synchronized
    private fun readEncrypted(name: String): String? {
        val packed = kv.decodeString(name) ?: return null
        return try {
            val bytes = Base64.decode(packed, Base64.NO_WRAP)
            if (bytes.size <= IV_BYTES) {
                kv.removeValueForKey(name)
                return null
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(GCM_TAG_BITS, bytes.copyOfRange(0, IV_BYTES)),
            )
            String(cipher.doFinal(bytes.copyOfRange(IV_BYTES, bytes.size)), Charsets.UTF_8)
        } catch (_: Exception) {
            // Keystore 密钥失效或密文损坏：丢掉旧值，不要每次读取都抛异常。
            kv.removeValueForKey(name)
            null
        }
    }

    @Synchronized
    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
