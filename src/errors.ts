/**
 * Every client-visible failure carries a stable machine-readable `code`. HTTP status
 * gives the category (400 malformed, 404 missing, 409 conflicts with current state,
 * 422 well-formed but semantically unusable); `code` tells the client what to do.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface StockShortfall {
  productId: string;
  requested: number;
  available: number;
}

export interface PriceChange {
  productId: string;
  quotedUnitPriceCents: number;
  currentUnitPriceCents: number;
}

export const errors = {
  validation: (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details),
  cartNotFound: (cartId: string) => new AppError(404, 'CART_NOT_FOUND', `Cart ${cartId} does not exist`),
  orderNotFound: (orderId: string) => new AppError(404, 'ORDER_NOT_FOUND', `Order ${orderId} does not exist`),
  productNotFound: (productId: string) =>
    new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} does not exist`, { productId }),
  itemNotInCart: (productId: string) =>
    new AppError(404, 'ITEM_NOT_IN_CART', `Product ${productId} is not in this cart`, { productId }),
  itemAlreadyInCart: (productId: string) =>
    new AppError(409, 'ITEM_ALREADY_IN_CART', `Product ${productId} is already in this cart; use PATCH to change its quantity`, { productId }),
  cartNotOpen: (cartId: string, orderId: string | null) =>
    new AppError(409, 'CART_NOT_OPEN', `Cart ${cartId} has been checked out and can no longer be modified`, { orderId }),
  cartAlreadyCheckedOut: (cartId: string, orderId: string) =>
    new AppError(409, 'CART_ALREADY_CHECKED_OUT', `Cart ${cartId} was already checked out with different parameters`, { orderId }),
  cartEmpty: (cartId: string) => new AppError(422, 'CART_EMPTY', `Cart ${cartId} has no items`),
  insufficientStock: (shortfalls: StockShortfall[]) =>
    new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough inventory for one or more items', { items: shortfalls }),
  priceChanged: (changes: PriceChange[]) =>
    new AppError(409, 'PRICE_CHANGED', 'Prices changed since items were added; review the cart and re-confirm the affected items', { items: changes }),
  couponNotFound: (code: string) => new AppError(422, 'COUPON_NOT_FOUND', `Coupon ${code} does not exist`, { couponCode: code }),
  couponAlreadyRedeemed: (code: string) =>
    new AppError(409, 'COUPON_ALREADY_REDEEMED', `Coupon ${code} has already been redeemed`, { couponCode: code }),
  noEligibleMilestone: (details: unknown) =>
    new AppError(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached yet', details),
};
