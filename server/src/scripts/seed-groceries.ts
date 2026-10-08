/* eslint-disable no-console */
/**
 * Seeds the Algerian grocery dataset (dz-grocery-dataset) into every shop
 * whose category identifies it as a grocery.
 *
 *   npm run seed:groceries                       # add missing products
 *   npm run seed:groceries -- --reset            # drop previously seeded products first
 *   npm run seed:groceries -- --file <path>      # dataset JSON (default: ../dz-grocery-dataset/data/grocery_products.json)
 *   npm run seed:groceries -- --no-verify        # skip the image reachability check
 *   npm run seed:groceries -- --dry-run          # report what would be seeded, write nothing
 *
 * A row is seeded only if it has a name, a price, a real category and a
 * picture. Pictures are checked over the network unless --no-verify: dead
 * links and AVIF files (which Flutter cannot decode) count as "no picture".
 *
 * Images stay hot-linked to the source shop. Their publicId carries the
 * `external:` prefix so destroyImage() never sends them to Cloudinary, and it
 * doubles as the marker that makes re-runs idempotent: an existing product
 * with the same key in the same shop is left untouched (shop edits survive).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { Category } from '../modules/categories/category.model';
import { MenuSection, Vendor } from '../modules/vendors/vendor.model';
import { Product } from '../modules/products/product.model';

export const SEED_PUBLIC_ID_PREFIX = 'external:dz-grocery/';

interface DatasetRow {
  barcode: string;
  product_name: string;
  product_name_ar: string;
  brand: string;
  primary_category: string;
  sub_category: string;
  price_dzd: number | null;
  image_url: string;
  source: string;
}

/** Dataset category → menu section (Arabic, like the rest of the catalogue). */
const SECTIONS: Record<string, { name: string; order: number }> = {
  'Épicerie': { name: 'مواد غذائية أساسية', order: 0 },
  'Épicerie sucrée': { name: 'حلويات وبسكويت', order: 1 },
  'Produits laitiers': { name: 'ألبان وأجبان', order: 2 },
  'Boissons': { name: 'مشروبات', order: 3 },
  'Viandes & poissons': { name: 'لحوم وأسماك', order: 4 },
  'Hygiène & beauté': { name: 'نظافة وتجميل', order: 5 },
  'Entretien': { name: 'مواد التنظيف', order: 6 },
  'Maison & bricolage': { name: 'المنزل والأدوات', order: 7 },
  'Animalerie': { name: 'مستلزمات الحيوانات', order: 8 },
};

/** A shop is a grocery if its category says so, in any of the app's languages. */
const GROCERY_ICON_KEYS = ['grocery', 'supermarket', 'market'];
const GROCERY_NAME = /[ée]picerie|sup[ée]rette|supermarch[ée]|alimentation|grocer|market|بقالة|مواد غذائية|سوبر ?ماركت/i;

function parseArgs(argv: string[]) {
  const fileIdx = argv.indexOf('--file');
  return {
    file: path.resolve(
      fileIdx >= 0 && argv[fileIdx + 1]
        ? argv[fileIdx + 1]!
        : path.join(__dirname, '../../../dz-grocery-dataset/data/grocery_products.json'),
    ),
    reset: argv.includes('--reset'),
    verify: !argv.includes('--no-verify'),
    dryRun: argv.includes('--dry-run'),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Stable per-product key, so re-runs recognise what they already seeded. */
function rowKey(row: DatasetRow): string {
  const basis = row.barcode || `${row.source}|${row.product_name.trim().toLowerCase()}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** True when the URL answers with an image Flutter and browsers can all decode. */
async function imageIsUsable(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0', Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
        signal: AbortSignal.timeout(15_000),
      });
      await res.body?.cancel();
      const type = res.headers.get('content-type') ?? '';
      return res.ok && type.startsWith('image/') && !type.includes('avif');
    } catch {
      // one retry for transient network errors
    }
  }
  return false;
}

async function verifyImages(urls: string[], concurrency = 16): Promise<Set<string>> {
  const usable = new Set<string>();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++]!;
      if (await imageIsUsable(url)) usable.add(url);
      if (++done % 250 === 0) console.info(`  … checked ${done}/${urls.length} images`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return usable;
}

async function loadRows(file: string, verify: boolean) {
  const raw = JSON.parse(await readFile(file, 'utf8')) as DatasetRow[];

  const skipped = { noName: 0, noPrice: 0, noCategory: 0, noImage: 0, badImage: 0, duplicate: 0 };
  const seen = new Set<string>();
  const candidates: (DatasetRow & { key: string })[] = [];

  for (const row of raw) {
    const name = row.product_name?.trim();
    if (!name) { skipped.noName++; continue; }
    if (!(typeof row.price_dzd === 'number' && row.price_dzd > 0)) { skipped.noPrice++; continue; }
    if (!SECTIONS[row.primary_category]) { skipped.noCategory++; continue; }
    const image = row.image_url?.trim();
    if (!image || !isHttpUrl(image) || /\.avif(\?|$)/i.test(image)) { skipped.noImage++; continue; }

    const key = rowKey(row);
    if (seen.has(key)) { skipped.duplicate++; continue; }
    seen.add(key);
    candidates.push({ ...row, product_name: name, image_url: image, key });
  }

  let rows = candidates;
  if (verify) {
    const urls = [...new Set(candidates.map((r) => r.image_url))];
    console.info(`→ Checking ${urls.length} image links (use --no-verify to skip)`);
    const usable = await verifyImages(urls);
    rows = candidates.filter((r) => usable.has(r.image_url));
    skipped.badImage = candidates.length - rows.length;
  }

  return { total: raw.length, rows, skipped };
}

async function findGroceryVendors() {
  const categories = await Category.find({
    $or: [{ iconKey: { $in: GROCERY_ICON_KEYS } }, { nameFr: GROCERY_NAME }, { nameAr: GROCERY_NAME }],
  });
  if (!categories.length) return { categories, vendors: [] };
  const vendors = await Vendor.find({ category: { $in: categories.map((c) => c._id) } });
  return { categories, vendors };
}

async function sectionFor(vendorId: Types.ObjectId, name: string, order: number, dryRun: boolean) {
  const existing = await MenuSection.findOne({ vendor: vendorId, name });
  if (existing || dryRun) return existing?._id ?? null;
  const created = await MenuSection.create({ vendor: vendorId, name, sortOrder: 100 + order });
  return created._id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.info(`→ Reading ${args.file}`);
  const { total, rows, skipped } = await loadRows(args.file, args.verify);
  console.info(`  ${rows.length} of ${total} rows are seedable`, skipped);
  if (!rows.length) throw new Error('No seedable rows — check the dataset path.');

  // Group by section, ordered by sub-category then name so similar items sit together.
  const bySection = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySection.get(row.primary_category) ?? [];
    list.push(row);
    bySection.set(row.primary_category, list);
  }
  for (const list of bySection.values()) {
    list.sort((a, b) => a.sub_category.localeCompare(b.sub_category) || a.product_name.localeCompare(b.product_name));
  }

  await connectDb();
  const { host, port, name: dbName } = mongoose.connection;
  console.info(`→ Database: ${host}:${port}/${dbName}  (set MONGO_URI to target another one)`);
  const { categories, vendors } = await findGroceryVendors();
  console.info(`→ Grocery categories: ${categories.map((c) => c.nameFr).join(', ') || 'none'}`);
  console.info(`→ Grocery shops: ${vendors.length}`);
  if (!vendors.length) {
    console.warn('  No shop is in a grocery category — nothing to seed.');
    return;
  }

  for (const vendor of vendors) {
    if (args.reset && !args.dryRun) {
      const removed = await Product.deleteMany({
        vendor: vendor._id,
        'image.publicId': { $regex: `^${SEED_PUBLIC_ID_PREFIX}` },
      });
      if (removed.deletedCount) console.info(`  ${vendor.name}: removed ${removed.deletedCount} previously seeded`);
    }

    const existing = new Set<string>(
      await Product.distinct('image.publicId', {
        vendor: vendor._id,
        'image.publicId': { $regex: `^${SEED_PUBLIC_ID_PREFIX}` },
      }),
    );
    const alreadyThere = rows.filter((r) => existing.has(`${SEED_PUBLIC_ID_PREFIX}${r.key}`)).length;

    let inserted = 0;
    for (const [category, list] of bySection) {
      const section = SECTIONS[category]!;
      const sectionId = await sectionFor(vendor._id, section.name, section.order, args.dryRun);
      if (args.dryRun) {
        inserted += list.filter((r) => !existing.has(`${SEED_PUBLIC_ID_PREFIX}${r.key}`)).length;
        continue;
      }

      const ops = list.map((row, i) => {
        const publicId = `${SEED_PUBLIC_ID_PREFIX}${row.key}`;
        const description = [row.brand, row.sub_category !== category ? row.sub_category : '']
          .filter(Boolean)
          .join(' · ');
        return {
          updateOne: {
            filter: { vendor: vendor._id, 'image.publicId': publicId },
            update: {
              $setOnInsert: {
                vendor: vendor._id,
                section: sectionId,
                name: row.product_name,
                description: description || undefined,
                // Leaf paths, not `image: {...}` — the filter already seeds
                // image.publicId on insert and a whole-object set would clash.
                'image.url': row.image_url,
                'image.publicId': publicId,
                priceCentimes: Math.round(row.price_dzd! * 100),
                isAvailable: true,
                sortOrder: i,
                options: [],
                // Seed data represents an already-reviewed catalogue.
                status: 'approved' as const,
                submittedAt: new Date(),
              },
            },
            upsert: true as const,
          },
        };
      });
      const result = await Product.bulkWrite(ops, { ordered: false });
      inserted += result.upsertedCount;
    }
    console.info(
      `  ${vendor.name}: ${args.dryRun ? 'would insert' : 'inserted'} ${inserted} new, ` +
        `${alreadyThere} already there (kept as-is)`,
    );
  }

  console.info(args.dryRun ? '✓ Dry run complete — nothing written' : '✓ Grocery seed complete');
}

main()
  .catch((err) => {
    console.error('Grocery seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
