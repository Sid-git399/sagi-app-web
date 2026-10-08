import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import * as service from './vendor.service';
import { menuProductsQuerySchema, vendorGetQuerySchema, vendorListQuerySchema } from './vendor.schema';
import { idParams } from '../orders/order.schema';

export const vendorRouter = Router();

vendorRouter.get(
  '/',
  validate({ query: vendorListQuerySchema }),
  asyncHandler(async (req, res) => ok(res, await service.listVendors(req.query as never))),
);

vendorRouter.get(
  '/:id',
  validate({ params: idParams, query: vendorGetQuerySchema }),
  asyncHandler(async (req, res) => {
    const { lat, lng } = req.query as unknown as { lat?: number; lng?: number };
    const origin = lat !== undefined && lng !== undefined ? { lat, lng } : null;
    return ok(res, await service.getVendor(req.params.id, origin));
  }),
);

vendorRouter.get(
  '/:id/menu',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => ok(res, await service.getMenu(req.params.id))),
);

/** Menu tabs: sections with approved-product counts (no products). */
vendorRouter.get(
  '/:id/sections',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => ok(res, await service.getMenuSections(req.params.id))),
);

/** One page of products: `?section=<id|other>` or `?q=` across the shop. */
vendorRouter.get(
  '/:id/products',
  validate({ params: idParams, query: menuProductsQuerySchema }),
  asyncHandler(async (req, res) =>
    ok(res, await service.listMenuProducts(req.params.id, req.query as never)),
  ),
);
