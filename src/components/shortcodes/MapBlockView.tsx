import { Navigation } from 'lucide-react';

import {
  MEDIA_UUID_PATTERN,
  directionsUrl,
  mediaFileUrl,
} from '@/cms/core/shortcodes/media-blocks';

/**
 * `[map]`: a map picture from the media library, the place's name and address,
 * and a Directions link that opens Google Maps in a new tab.
 *
 * No iframe and no remote tiles (see `media-blocks.ts`) — the picture is
 * whatever the owner uploaded, a screenshot of the map usually. The image is
 * decorative (`alt=""`): the caption beside it carries the same information.
 */
export function MapBlockView({
  image,
  title,
  address,
  lat,
  lng,
  labels,
}: {
  image: string;
  title: string;
  address?: string;
  lat?: string;
  lng?: string;
  labels: { directions: string; directionsTo: string; newTab: string };
}) {
  const name = title.trim();
  if (!name || !MEDIA_UUID_PATTERN.test(image)) return null;
  const href = directionsUrl({ lat, lng, address });
  const place = address?.trim();

  return (
    <figure className="border-border-soft my-6 overflow-hidden rounded-sm border bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element -- a CMS media route, not a static asset */}
      <img src={mediaFileUrl(image)} alt="" loading="lazy" className="w-full object-cover" />
      <figcaption className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-display text-midnight-navy text-base font-semibold">{name}</p>
          {place ? <p className="font-body text-text-muted text-sm">{place}</p> : null}
        </div>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${labels.directionsTo} ${name} (${labels.newTab})`}
            className="bg-midnight-navy text-soft-pearl hover:bg-midnight-navy/90 focus-visible:ring-midnight-navy inline-flex items-center gap-2 self-start rounded-sm px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            <Navigation className="h-4 w-4" aria-hidden />
            <span>{labels.directions}</span>
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}
