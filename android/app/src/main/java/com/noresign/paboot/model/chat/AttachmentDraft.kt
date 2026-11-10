package com.noresign.paboot.model.chat

import android.net.Uri

/** One image picked in the composer, before or after its upload completes. */
data class AttachmentDraft(
    val localId: String,
    val remoteId: String? = null,
    val previewUri: Uri? = null,
    val uploading: Boolean = false,
    val error: String? = null,
)
