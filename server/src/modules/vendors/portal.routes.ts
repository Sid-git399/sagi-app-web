import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import { ApiError } from '../../utils/ApiError';
import { destroyImage } from '../../config/cloudinary';
import { idParams } from '../orders/order.schema';
import { Order, type OrderDoc } from '../orders/order.model';
import * as orderService from '../orders/order.service';
import type { OrderStatus } from '../orders/order.state';
import { buildPage, skipFor } from '../../utils/pagination';
import type { FilterQuery } from 'mongoose';
import { MenuSection, Vendor, type VendorDoc } from './vendor.model';
import { Product } from '../products/product.model';
import { menuSectionSchema } from './vendor.schema';
import { createProductSchema, reorderSchema } from '../admin/admin.schema';
import type { Request } from 'express';

/**
 * The shop owner's portal.
 *
 * A vendor signs in and manages their own menu — sections, products, prices
 * and availability — and answers the orders the admin sends them: accept,
 * decline, mark ready. Fees, delivery area and driver assignment stay with the
 * admin, so none of that is exposed here.
 *
 * Every route resolves the caller's own shop first and scopes the query to it;
 * an id in the URL is never trusted on its own.
 */
export const vendorPortalRouter = Router();

vendorPortalRouter.use(requireAuth, requireRole('vendor'));

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The shop this user owns, or 403 if the account is not linked to one yet. */
async function myVendor(req: Request): Promise<VendorDoc> {
  const vendor = await Vendor.findOne({ owner: req.user!.sub });
  if (!vendor) {
    throw new ApiError(403, 'FORBIDDEN', 'هذا الحساب غير مرتبط بأي متجر');
  }
  return vendor;
}

// ── my shop ─────────────────────────────────────────────────────────────────

vendorPortalRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    return ok(res, vendor.toJSON());
  }),
);

/**
 * The only shop-level field a vendor controls: whether they are accepting
 * orders right now. Fees, minimum order, prep time and the pickup point are
 * set by the admin per shop — a vendor cannot touch its own delivery pricing.
 */
vendorPortalRouter.patch(
  '/me',
  validate({ body: z.object({ isOpen: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    vendor.isOpen = req.body.isOpen as boolean;
    await vendor.save();
    return ok(res, vendor.toJSON(), 'تم تحديث حالة المتجر');
  }),
);

// ── sections ────────────────────────────────────────────────────────────────

vendorPortalRouter.get(
  '/sections',
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const items = await MenuSection.find({ vendor: vendor._id }).sort({ sortOrder: 1 });
    return ok(res, items.map((s) => s.toJSON()));
  }),
);

vendorPortalRouter.post(
  '/sections',
  validate({ body: menuSectionSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const doc = await MenuSection.create({ ...req.body, vendor: vendor._id });
    return created(res, doc.toJSON(), 'تمت إضافة القسم');
  }),
);

vendorPortalRouter.patch(
  '/sections/:id',
  validate({ params: idParams, body: menuSectionSchema.partial() }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    // Scoped by vendor as well as id: one shop cannot rename another's section.
    const doc = await MenuSection.findOneAndUpdate(
      { _id: req.params.id, vendor: vendor._id },
      { $set: req.body },
      { new: true },
    );
    if (!doc) throw ApiError.notFound('القسم غير موجود');
    return ok(res, doc.toJSON(), 'تم تحديث القسم');
  }),
);

vendorPortalRouter.delete(
  '/sections/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const doc = await MenuSection.findOneAndDelete({ _id: req.params.id, vendor: vendor._id });
    if (!doc) throw ApiError.notFound('القسم غير موجود');
    // Products outlive their section — they just become unsectioned.
    await Product.updateMany(
      { section: doc._id, vendor: vendor._id },
      { $set: { section: null } },
    );
    return ok(res, null, 'تم حذف القسم');
  }),
);

// ── products ────────────────────────────────────────────────────────────────

const portalProductsQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  section: z.union([z.literal('none'), z.string().regex(/^[0-9a-fA-F]{24}$/)]).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  q: z.string().trim().max(80).optional(),
});

/**
 * With `page`, one page of products plus per-status counts — what a shop with
 * thousands of products needs. Without it, the full array (older clients).
 */
vendorPortalRouter.get(
  '/products',
  validate({ query: portalProductsQuery }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const { page, limit, section, status, q } = req.query as unknown as z.infer<typeof portalProductsQuery>;

    if (!page) {
      const items = await Product.find({ vendor: vendor._id }).sort({ sortOrder: 1, createdAt: -1 });
      return ok(res, items.map((p) => p.toJSON()));
    }

    const scope: Record<string, unknown> = { vendor: vendor._id };
    if (section) scope.section = section === 'none' ? null : section;
    if (q) scope.name = new RegExp(escapeRegex(q), 'i');
    const filter = status ? { ...scope, status } : scope;

    const [docs, total, byStatus] = await Promise.all([
      Product.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(skipFor(page, limit)).limit(limit),
      Product.countDocuments(filter),
      Product.aggregate<{ _id: string; n: number }>([
        { $match: scope },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);
    const counts = Object.fromEntries(byStatus.map((c) => [c._id, c.n]));
    return ok(res, { ...buildPage(docs.map((d) => d.toJSON()), page, limit, total), counts });
  }),
);

vendorPortalRouter.post(
  '/products',
  // `vendor` comes from the session, never the body — omit it so a payload
  // naming someone else's shop cannot be smuggled through.
  validate({ body: createProductSchema.omit({ vendor: true }) }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    // A shop never publishes directly: the product enters the review queue and
    // only an admin can approve it. Status is forced here so a crafted body
    // cannot ship an approved product.
    const doc = await Product.create({
      ...req.body,
      vendor: vendor._id,
      status: 'pending',
      rejectionReason: null,
      reviewedBy: null,
      reviewedAt: null,
      submittedAt: new Date(),
    });
    return created(res, doc.toJSON(), 'تم إرسال المنتج للمراجعة');
  }),
);

vendorPortalRouter.patch(
  '/products/:id',
  validate({
    params: idParams,
    body: createProductSchema.omit({ vendor: true }).partial(),
  }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const existing = await Product.findOne({ _id: req.params.id, vendor: vendor._id });
    if (!existing) throw ApiError.notFound('المنتج غير موجود');

    // Replacing the image deletes the asset it replaces, as the admin route does.
    const nextImage = req.body.image as { publicId?: string } | null | undefined;
    if (
      nextImage !== undefined &&
      existing.image?.publicId &&
      existing.image.publicId !== nextImage?.publicId
    ) {
      await destroyImage(existing.image.publicId);
    }

    // Editing an approved product pulls it back into review — the shop cannot
    // get a change in front of customers without an admin seeing it. Toggling
    // availability alone is exempt: that is stock management, not new content.
    const contentKeys = Object.keys(req.body).filter((k) => k !== 'isAvailable' && k !== 'sortOrder');
    const needsReview = contentKeys.length > 0;

    const doc = await Product.findOneAndUpdate(
      { _id: req.params.id, vendor: vendor._id },
      {
        $set: {
          ...req.body,
          ...(needsReview
            ? {
                status: 'pending',
                rejectionReason: null,
                reviewedBy: null,
                reviewedAt: null,
                submittedAt: new Date(),
              }
            : {}),
        },
      },
      { new: true },
    );
    return ok(
      res,
      doc!.toJSON(),
      needsReview ? 'تم إرسال التعديل للمراجعة' : 'تم تحديث المنتج',
    );
  }),
);

vendorPortalRouter.delete(
  '/products/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const doc = await Product.findOneAndDelete({ _id: req.params.id, vendor: vendor._id });
    if (!doc) throw ApiError.notFound('المنتج غير موجود');
    if (doc.image?.publicId) await destroyImage(doc.image.publicId);
    return ok(res, null, 'تم حذف المنتج');
  }),
);

vendorPortalRouter.post(
  '/products/reorder',
  validate({ body: reorderSchema }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const items = req.body.items as { id: string; sortOrder: number }[];
    await Product.bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: { _id: item.id, vendor: vendor._id },
          update: { $set: { sortOrder: item.sortOrder } },
        },
      })),
    );
    return ok(res, null);
  }),
);

// ── orders ──────────────────────────────────────────────────────────────────
//
// The admin confirms an order with the customer, then sends it here. The shop
// accepts (-> preparing) or declines with a reason (-> back to the admin as
// `confirmed`), then marks it ready; the admin dispatches a driver from there.

const INCOMING: OrderStatus[] = ['sent_to_vendor'];
const IN_PROGRESS: OrderStatus[] = ['preparing', 'ready', 'assigned', 'accepted'];

/**
 * What a shop sees of an order: what to make and when. The customer's phone,
 * address and the delivery money stay with the admin and the driver.
 */
function vendorView(order: OrderDoc) {
  const o = order.toJSON() as Record<string, any>;
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    deliveryType: o.deliveryType,
    items: o.items,
    subtotalCentimes: o.subtotalCentimes,
    customerNote: o.customerNote ?? null,
    customerName: o.customer?.fullName ?? null,
    agent: o.agent && typeof o.agent === 'object' ? { fullName: o.agent.fullName } : null,
    createdAt: o.createdAt,
    sentToVendorAt: o.sentToVendorAt ?? null,
    vendorAcceptedAt: o.vendorAcceptedAt ?? null,
    readyAt: o.readyAt ?? null,
    pickedUpAt: o.pickedUpAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    vendorRejectedReason: o.vendorRejectedReason ?? null,
    cancelledReason: o.cancelledReason ?? null,
  };
}

const VENDOR_POPULATE = [
  { path: 'customer', select: 'fullName' },
  { path: 'agent', select: 'fullName' },
];

/** Loads one of this shop's orders, or 404 — another shop's id is simply not found. */
async function myOrder(req: Request) {
  const vendor = await myVendor(req);
  const order = await Order.findOne({ _id: req.params.id, vendor: vendor._id });
  if (!order) throw ApiError.notFound('الطلب غير موجود');
  return order;
}

async function vendorOrderJson(orderId: string) {
  const full = await Order.findById(orderId).populate(VENDOR_POPULATE);
  return vendorView(full!);
}

const portalOrdersQuery = z.object({
  scope: z.enum(['incoming', 'active', 'history']).default('incoming'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

vendorPortalRouter.get(
  '/orders',
  validate({ query: portalOrdersQuery }),
  asyncHandler(async (req, res) => {
    const vendor = await myVendor(req);
    const { scope, page, limit } = req.query as unknown as z.infer<typeof portalOrdersQuery>;

    let filter: FilterQuery<OrderDoc>;
    let sort: Record<string, 1 | -1>;
    if (scope === 'incoming') {
      filter = { vendor: vendor._id, status: { $in: INCOMING } };
      sort = { sentToVendorAt: 1, createdAt: 1 }; // first come, first served
    } else if (scope === 'active') {
      filter = { vendor: vendor._id, status: { $in: IN_PROGRESS } };
      sort = { vendorAcceptedAt: 1, createdAt: 1 };
    } else {
      // Everything that reached this shop and has since left its hands.
      filter = {
        vendor: vendor._id,
        sentToVendorAt: { $ne: null },
        status: { $nin: [...INCOMING, ...IN_PROGRESS] },
      };
      sort = { sentToVendorAt: -1 };
    }

    const [docs, total, incoming, active] = await Promise.all([
      Order.find(filter).sort(sort).skip(skipFor(page, limit)).limit(limit).populate(VENDOR_POPULATE),
      Order.countDocuments(filter),
      Order.countDocuments({ vendor: vendor._id, status: { $in: INCOMING } }),
      Order.countDocuments({ vendor: vendor._id, status: { $in: IN_PROGRESS } }),
    ]);
    return ok(res, {
      ...buildPage(docs.map(vendorView), page, limit, total),
      counts: { incoming, active },
    });
  }),
);

vendorPortalRouter.get(
  '/orders/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const order = await myOrder(req);
    return ok(res, await vendorOrderJson(String(order._id)));
  }),
);

vendorPortalRouter.post(
  '/orders/:id/accept',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const order = await myOrder(req);
    await orderService.transition(String(order._id), 'preparing', {
      actorId: req.user!.sub,
      actorRole: 'vendor',
      note: 'قبله المتجر',
    });
    return ok(res, await vendorOrderJson(String(order._id)), 'تم قبول الطلب');
  }),
);

vendorPortalRouter.post(
  '/orders/:id/reject',
  validate({
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3, 'سبب الرفض مطلوب').max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const order = await myOrder(req);
    await orderService.transition(String(order._id), 'confirmed', {
      actorId: req.user!.sub,
      actorRole: 'vendor',
      note: req.body.reason as string,
    });
    return ok(res, await vendorOrderJson(String(order._id)), 'تم رفض الطلب وإبلاغ الإدارة');
  }),
);

vendorPortalRouter.post(
  '/orders/:id/ready',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const order = await myOrder(req);
    await orderService.transition(String(order._id), 'ready', {
      actorId: req.user!.sub,
      actorRole: 'vendor',
      note: 'الطلب جاهز للاستلام',
    });
    return ok(res, await vendorOrderJson(String(order._id)), 'الطلب جاهز — الإدارة سترسل السائق');
  }),
);
