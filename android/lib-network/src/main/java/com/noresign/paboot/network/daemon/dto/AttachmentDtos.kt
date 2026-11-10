package com.noresign.paboot.network.daemon.dto

import kotlinx.serialization.Serializable

/** `POST /api/attachments` — immutable image metadata. */
@Serializable
data class AttachmentDto(
    val id: String = "",
    val mediaType: String = "",
    val bytes: Long = 0,
    val width: Int = 0,
    val height: Int = 0,
    val sha256: String = "",
)
