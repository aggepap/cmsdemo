import { getTranslations } from 'next-intl/server';

import { MapBlockView } from './MapBlockView';

/**
 * `[map]` on the public page: the view, labelled in the page's language.
 * Named `MapBlock` so it does not shadow the global `Map`.
 */
export async function MapBlock({
  image = '',
  title = '',
  address = '',
  lat = '',
  lng = '',
}: {
  image?: string;
  title?: string;
  address?: string;
  lat?: string;
  lng?: string;
}) {
  const [t, links] = await Promise.all([getTranslations('blocks'), getTranslations('links')]);
  return (
    <MapBlockView
      image={image}
      title={title}
      address={address}
      lat={lat}
      lng={lng}
      labels={{
        directions: t('map.directions'),
        directionsTo: t('map.directionsTo'),
        newTab: links('newTab'),
      }}
    />
  );
}
