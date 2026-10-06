import { useTranslations } from 'next-intl';

import { ProductCard, type ProductCardData } from '@/components/shop/ProductCard';

/**
 * "You may also like" under a product: the editor's picks, or other products
 * from its category (see `getRelatedProducts`). Renders nothing when there is
 * nothing to show — an empty heading is worse than no section.
 */
export function RelatedProducts({ products, locale }: { products: ProductCardData[]; locale: string }) {
  const t = useTranslations('shop');
  if (products.length === 0) return null;

  return (
    <section className="mt-16 max-w-7xl" aria-labelledby="related-products-heading">
      <h2 id="related-products-heading" className="mb-6 font-display text-2xl font-semibold text-midnight-navy">
        {t('related')}
      </h2>
      <ul className="grid grid-cols-2 gap-6 sm:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.slug} product={product} locale={locale} listId="related" />
        ))}
      </ul>
    </section>
  );
}
