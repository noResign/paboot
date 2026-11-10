import { useEffect, useState } from 'react';
import { attachmentBytes } from '../../ipc/client';

const cache = new Map<string, string>();

interface Props {
  ids: string[];
}

/** User-message images: fetched once per id and rendered as thumbnails. */
export function AttachmentThumbs({ ids }: Props) {
  const key = ids.join('|');
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(ids.filter((id) => cache.has(id)).map((id) => [id, cache.get(id)!])),
  );
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (id) => {
        const res = await attachmentBytes(id);
        if (!res.ok || !res.data || !res.contentType) return;
        const blob = new Blob([res.data.buffer as ArrayBuffer], { type: res.contentType });
        const url = URL.createObjectURL(blob);
        cache.set(id, url);
        return [id, url] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      if (Object.keys(next).length > 0) setUrls((current) => ({ ...current, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (ids.length === 0) return null;
  return (
    <>
      <div className="msg-attachments">
        {ids.map((id) =>
          urls[id] ? (
            <button
              type="button"
              className="msg-attachment"
              key={id}
              onClick={() => setOpen(urls[id]!)}
              title="查看大图"
            >
              <img src={urls[id]} alt="" />
            </button>
          ) : (
            <span className="msg-attachment is-loading" key={id} />
          ),
        )}
      </div>
      {open && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <img src={open} alt="" />
        </div>
      )}
    </>
  );
}
