# 🇩🇿 Algerian Grocery Products Dataset

An open dataset of grocery products sold in Algeria (names in French and Arabic, brands, barcodes, categories, prices in DZD, image URLs), plus the scraper that builds it.

**Files:**

```
data/
├── grocery_products.csv / .json   everything in one file
├── metadata.json                  counts per source and per category
├── csv/<category>.csv             one file per category (Excel-friendly, UTF-8 BOM)
├── json/<category>.json           the same split, as JSON
└── raw/<source>.jsonl             raw scrape output, one file per source
```

Categories: `epicerie`, `epicerie-sucree`, `produits-laitiers`, `boissons`, `viandes-poissons`, `hygiene-beaute`, `entretien`, `maison-bricolage`, `animalerie`, and `non-classe` for rows no rule matched. Each file still carries `sub_category`, so it can be filtered further.

## Schema

| column | description |
|---|---|
| `barcode` | EAN/GTIN, check-digit validated (Algerian products start with `613`) |
| `product_name` | Name as listed (usually French) |
| `product_name_ar` | Arabic name when available |
| `brand` | Brand |
| `primary_category` / `sub_category` | Normalized categories (e.g. `Épicerie` / `Semoule & couscous`) |
| `source_category` | Original category label from the source |
| `price_dzd` | Price in DZD at `scraped_date` (empty for Open Food Facts rows) |
| `image_url` | Link to the image (images are not stored in this repo) |
| `product_url` | Product page |
| `source` | Where the row came from |
| `scraped_date` | Date of collection. **Prices change often; treat them as a snapshot.** |

The same product can appear once per source, so you can compare prices across stores. Join on `barcode`.

## Sources

| source | site | what it adds | method |
|---|---|---|---|
| `openfoodfacts` | [world.openfoodfacts.org](https://world.openfoodfacts.org) | ~7,400 products sold in Algeria: barcodes, brands, FR/AR names | public API |
| `superette-dz` | [superette-dz.com](https://superette-dz.com) | ~1,450 supermarket products with prices (Alger) | WooCommerce Store API |
| `areej-market` | [areej.store](https://areej.store/categorie-produit/market/) | supérette products with prices (Draria / Aïn Benian) | HTML (market category only) |
| `maison-khazana` | [maisonkhazana.dz](https://www.maisonkhazana.dz/shop) | Algerian terroir products: cheese, oils, honey, spices | HTML (Odoo) |
| `ecomarket-dz` | [ecomarket-dz.com](https://www.ecomarket-dz.com) | natural / organic products (also some cosmetics) | WooCommerce Store API |
| `lamiellee` | [lamiellee.com.dz](https://lamiellee.com.dz) | Algerian honey and hive products | WooCommerce Store API |

Checked but not used (October 2026): **Jumia / Jumia Food** left Algeria in February 2026; **Yassir Market** (ex-Uno) sells through its app only; **Courses Net** disallows all crawlers in robots.txt (it is in `sources.json`, disabled). Other dead or blocked sites are listed under `_researched_but_not_usable` in `sources.json`.

## Build it yourself

```bash
pip install -r requirements.txt
python scraper.py --only openfoodfacts --max-pages 2   # quick test
python scraper.py                                      # all enabled sources
python scraper.py --detect https://some-shop.dz        # how to add a new shop
python scraper.py --merge-only                         # re-categorize without re-scraping
```

Before running, set `USER_AGENT` in `scraper.py` to your repo URL and a contact email.

Open Food Facts serves only the first 1,000 search results to anonymous clients ("due to heavy abuse from robots"). To get all ~7,400 Algerian products, create a free account at [openfoodfacts.org](https://world.openfoodfacts.org) and pass it via environment variables:

```bash
OFF_USERNAME=your_user OFF_PASSWORD=your_password python scraper.py --only openfoodfacts
```

### Adding a shop
1. `python scraper.py --detect https://shop.dz` checks robots.txt and tells you if it is WooCommerce, Shopify, or plain HTML.
2. Add an entry to `sources.json` (copy one of the examples) and set `"enabled": true`.
3. For HTML shops, inspect a product card in your browser's DevTools and fill in the CSS selectors. To scrape several category pages and keep the shop's labels, use `"categories": {"Label": "https://shop.dz/cat/page/{page}"}` instead of `listing_url` (see `maison-khazana`).

Categories are assigned by keyword rules (French/Arabic/English) in `CATEGORY_RULES`. PRs adding keywords are welcome.

## Collection rules
- robots.txt is respected, requests are rate-limited, and the scraper stops on HTTP 403 instead of trying to get around blocks.
- Only factual product data and image *links* are collected. No images, descriptions, or reviews are copied.
- If a shop owner wants their store removed, open an issue and it will be removed.

## License
- **Data:** [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Required because part of the data comes from [Open Food Facts](https://world.openfoodfacts.org) (© Open Food Facts contributors). Derived datasets must keep the same license and attribution.
- **Code:** MIT.
- Product images remain the property of their owners.
