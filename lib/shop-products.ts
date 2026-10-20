/**
 * Which pendant each of the Shopify store's photo products is, so the
 * customer page (app/try) draws the right style and shows the right shape
 * without asking. Keyed by the product's handle on shoptruetribute.com.
 * A product not listed here gets a style picker instead.
 */

import type { CategoryId } from './pendant-categories';
import type { DesignType } from './pendant-geometry';
import type { ShapeId } from './pendant-shapes';

export interface ShopProduct {
  category: CategoryId;
  designType: DesignType;
  /** For a shaped pendant: which shape. */
  shape: ShapeId;
}

const cut = (category: CategoryId): ShopProduct => ({ category, designType: 'edge-cut', shape: 'round' });
const shaped = (category: CategoryId, shape: ShapeId): ShopProduct => ({ category, designType: 'standard', shape });

export const SHOP_PRODUCTS: Record<string, ShopProduct> = {
  'photo-dollar': cut('face'),
  'halfsize-photo-pendant': cut('half-size'),
  'fullsize-photo-pendant': cut('full-size'),
  'couple-photo-pendant': cut('couple'),
  'family-photo-pendant': cut('family'),
  'pet-pendant': cut('pet'),
  'round-shape-photo-pendant': shaped('round', 'round'),
  'oval-shape-photo-pendant': shaped('oval', 'oval'),
  'vertical-oval-shape-photo-pendant': shaped('oval', 'oval'),
  'heart-shape-photo-pendant': shaped('heart', 'heart'),
  'full-size-heart-pendant': shaped('heart', 'heart'),
  'octaganol-shape-pendant': shaped('round', 'octagon'),
  'bar-pendant': shaped('half-size', 'bar'),
};

/** The styles a customer can pick from when the product is not listed. */
export const PICKABLE: { label: string; product: ShopProduct }[] = [
  { label: 'Face', product: cut('face') },
  { label: 'Half size', product: cut('half-size') },
  { label: 'Full size', product: cut('full-size') },
  { label: 'Couple', product: cut('couple') },
  { label: 'Family', product: cut('family') },
  { label: 'Pet', product: cut('pet') },
  { label: 'Round', product: shaped('round', 'round') },
  { label: 'Heart', product: shaped('heart', 'heart') },
];

/** The metal a variant is, from its title ("Gold / 4g", "Gold-plated / ."): gold-plated is shown as gold. */
export function metalOf(variantTitle: string | null | undefined): 'gold' | 'silver' {
  return /gold/i.test(variantTitle ?? '') ? 'gold' : 'silver';
}
