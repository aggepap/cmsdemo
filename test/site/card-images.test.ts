/**
 * The core's listing cards serve images through `next/image` (Review 2).
 *
 * `BookingCard` and `ProductCard` used a plain `<img>` on the full upload, so a
 * grid of cards downloaded every original at full size. `next/image` serves a
 * width that fits the card, as WebP/AVIF.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

for (const file of ['src/components/booking/BookingCard.tsx', 'src/components/shop/ProductCard.tsx']) {
  describe(file, () => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

    test('uses next/image with sizes, not a plain img', () => {
      assert.match(src, /import Image from 'next\/image'/);
      assert.doesNotMatch(src, /<img[\s>]/);
      assert.match(src, /<Image[\s\S]*?sizes=/);
    });
  });
}
