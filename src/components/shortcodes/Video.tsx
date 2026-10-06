import { getTranslations } from 'next-intl/server';

import { VideoBlockView } from './VideoBlockView';

/** `[video]` on the public page: the view, labelled in the page's language. */
export async function Video({
  url = '',
  title = '',
  image = '',
}: {
  url?: string;
  title?: string;
  image?: string;
}) {
  const [t, links] = await Promise.all([getTranslations('blocks'), getTranslations('links')]);
  return (
    <VideoBlockView
      url={url}
      title={title}
      image={image}
      labels={{ play: t('video.play'), newTab: links('newTab') }}
    />
  );
}
