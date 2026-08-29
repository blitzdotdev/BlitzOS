import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { peekAvatarBlobUrl, resolveAvatarBlobUrl } from '@/lib/avatar-cache';

/**
 * Resolve a remote avatar URL to a locally-persisted blob URL when one is
 * available, falling back to the raw URL while the blob loads.
 *
 * Coupled to `avatar-cache` on purpose — every src is routed through the
 * avatar CacheStorage bucket (URL-keyed, CORS-mode fetch). Use it for
 * avatars (e.g. GitHub owner avatars), NOT arbitrary images, or you'll
 * pollute the avatar cache with non-avatar URLs.
 *
 * Tuned for GitHub owner avatars, whose host answers with
 * `cache-control: max-age=300` — i.e. the browser HTTP cache drops them
 * after five minutes, so on a poor connection they vanish and re-request
 * on every render. Routing them through `avatar-cache` gives a durable copy
 * that paints offline.
 *
 * Strategy — prefer the blob, fall back to the raw URL while it loads:
 *   - Memory hit (2nd+ mount this session, or rehydrated from CacheStorage
 *     at startup): return the blob synchronously → paints instantly, no
 *     network, works offline. Revalidate in the background and swap only if
 *     the remote changed.
 *   - Memory miss: return the raw URL now (good network serves it from HTTP
 *     cache) and kick off a cache-first load. When it resolves (from
 *     CacheStorage in ~ms, or the network) we swap to the blob. Rejected the
 *     `UserAvatar` "never swap" approach here: these avatars are frequently
 *     NOT in the HTTP cache (short max-age), so the blob is the first
 *     *reliable* paint, not a flicker — and the swap is what makes a cached
 *     avatar reappear when the live request is failing on a bad connection.
 *
 * Returns `undefined` when there is no usable src so callers can render
 * their own fallback. A CORS/network failure is swallowed: the raw URL
 * stays on screen and the next mount retries.
 */
export function useCachedAvatarSrc(src?: string | null): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => peekAvatarBlobUrl(src) ?? null);

  useEffect(() => {
    let cancelled = false;

    const cached = peekAvatarBlobUrl(src);
    if (cached != null) {
      setBlobUrl(cached);
      // Already showing the cached blob; revalidate and swap only on change.
      void resolveAvatarBlobUrl(src, {
        onUpdate: (updated) => {
          if (!cancelled) setBlobUrl(updated);
        },
      }).catch(() => {
        // Keep showing the cached blob.
      });
    } else {
      // Drop any stale blob from a previous `src` so we don't show the
      // wrong avatar while the new one loads.
      setBlobUrl(null);
      if (src != null) {
        void resolveAvatarBlobUrl(src, {
          onUpdate: (updated) => {
            if (!cancelled) setBlobUrl(updated);
          },
        })
          .then((resolved) => {
            if (!cancelled && typeof resolved === 'string') {
              setBlobUrl(resolved);
            }
          })
          .catch(() => {
            // Keep showing the raw URL; cache stays empty so we retry later.
          });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [src]);

  return blobUrl ?? src ?? undefined;
}

export type CachedAvatarImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
};

/**
 * Drop-in `<img>` replacement for CORS-fetchable avatars (e.g. GitHub
 * owner avatars), served from the local avatar blob cache so they survive
 * a poor connection and stop re-hitting the network on every render.
 *
 * Degrades to a plain `<img>` with the raw URL when the host isn't
 * CORS-fetchable. Scope it to avatars — it routes every src through the
 * avatar cache (see `useCachedAvatarSrc`). Callers keep their own
 * truthiness guard for the empty-src fallback.
 */
export function CachedAvatarImg({ src, ...rest }: CachedAvatarImgProps) {
  const resolved = useCachedAvatarSrc(src);
  if (resolved == null) return null;
  return <img src={resolved} {...rest} />;
}
