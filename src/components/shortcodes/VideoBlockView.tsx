import { Play } from 'lucide-react';

import { MEDIA_UUID_PATTERN, mediaFileUrl, videoHref } from '@/cms/core/shortcodes/media-blocks';

/**
 * `[video]`: the site's own preview picture with a play mark, linking out to
 * the video in a new tab.
 *
 * Never an iframe and never the host's thumbnail — see `media-blocks.ts`. The
 * attributes were validated by the registry already; they are checked again
 * here because this is what writes the href, and an invalid one renders nothing
 * rather than a link somewhere unexpected.
 *
 * No VideoObject JSON-LD: Google requires `uploadDate` (and wants a
 * description), which a link to someone else's upload cannot honestly supply,
 * and the video's own page on YouTube/Vimeo already carries the markup.
 */
/** youtube / vimeo, from the (already validated) link. */
function videoProvider(href: string): string {
  const host = new URL(href).hostname.replace(/^www\./, '');
  return host === 'youtu.be' || host.endsWith('youtube.com') ? 'youtube' : host.endsWith('vimeo.com') ? 'vimeo' : host;
}

export function VideoBlockView({
  url,
  title,
  image,
  labels,
}: {
  url: string;
  title: string;
  image: string;
  labels: { play: string; newTab: string };
}) {
  const href = videoHref(url);
  const name = title.trim();
  if (!href || !name || !MEDIA_UUID_PATTERN.test(image)) return null;

  return (
    <figure className="my-6">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${labels.play}: ${name} (${labels.newTab})`}
        // Read by the analytics runtime for "video" custom events.
        data-cms-video-title={name}
        data-cms-video-url={href}
        data-cms-video-provider={videoProvider(href)}
        className="group focus-visible:ring-midnight-navy relative block overflow-hidden rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a CMS media route, not a static asset */}
        <img
          src={mediaFileUrl(image)}
          alt=""
          loading="lazy"
          className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <span
          aria-hidden
          className="bg-midnight-navy/80 text-soft-pearl group-hover:bg-midnight-navy absolute top-1/2 left-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-colors"
        >
          <Play className="ml-1 h-7 w-7" fill="currentColor" />
        </span>
      </a>
      <figcaption className="font-body text-text-primary mt-2 text-sm font-medium">
        {name}
      </figcaption>
    </figure>
  );
}
