#!/usr/bin/env python3
"""
dz-grocery-dataset — build an open dataset of Algerian grocery products.

Source types (configured in sources.json):
  openfoodfacts  Open Food Facts public API, filtered to products sold in Algeria
                 -> barcodes, brands, French/Arabic names, images (no prices)
  woocommerce    Any WooCommerce shop, via its public Store API (clean JSON, prices)
  shopify        Any Shopify shop, via /products.json
  html           Any other shop, via CSS selectors you define (+ optional JSON-LD)

Usage:
  python scraper.py                           # run all enabled sources, then merge
  python scraper.py --only openfoodfacts      # run just one source
  python scraper.py --merge-only              # rebuild final files from data/raw/
  python scraper.py --detect https://shop.dz  # check robots.txt + what platform a site runs
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import asdict, dataclass, fields
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional
from urllib import robotparser
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

log = logging.getLogger("dzgrocery")

# Put your real repo URL and a contact email here. Open Food Facts requires an
# identifying User-Agent, and shop owners appreciate knowing who is crawling them.
USER_AGENT = "DZGroceryDataset/0.1 (+https://github.com/YOUR_USERNAME/dz-grocery-dataset; YOUR_EMAIL)"
TODAY = date.today().isoformat()

# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #

@dataclass
class Product:
    product_name: str
    source: str
    product_name_ar: str = ""
    barcode: str = ""
    brand: str = ""
    primary_category: str = ""
    sub_category: str = ""
    source_category: str = ""      # the category label as the source wrote it
    price_dzd: Optional[float] = None
    image_url: str = ""
    product_url: str = ""
    scraped_date: str = TODAY


COLUMNS = [
    "barcode", "product_name", "product_name_ar", "brand",
    "primary_category", "sub_category", "source_category",
    "price_dzd", "image_url", "product_url", "source", "scraped_date",
]

# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

_EASTERN_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def clean(value) -> str:
    """Unescape HTML entities and collapse whitespace."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", html.unescape(str(value))).strip()


def normalize(text: str) -> str:
    """Lowercase and strip accents/harakat so 'Café' == 'cafe'. Arabic letters are kept."""
    decomposed = unicodedata.normalize("NFKD", (text or "").casefold())
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


def has_arabic(text: str) -> bool:
    return bool(re.search(r"[\u0600-\u06FF]", text or ""))


def parse_price(raw) -> Optional[float]:
    """'1 250,00 DA' -> 1250.0 | '250 دج' -> 250.0 | '1.250 DA' -> 1250.0 | '12.50' -> 12.5"""
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).translate(_EASTERN_DIGITS)
    match = re.search(r"\d[\d\s\u00a0\u202f.,]*", text)
    if not match:
        return None
    num = re.sub(r"[\s\u00a0\u202f]", "", match.group())
    if "," in num and "." in num:            # both present: the last one is the decimal mark
        if num.rfind(",") > num.rfind("."):
            num = num.replace(".", "").replace(",", ".")
        else:
            num = num.replace(",", "")
    elif "," in num:
        head, _, tail = num.rpartition(",")
        num = head.replace(",", "") + ("." + tail if len(tail) in (1, 2) else tail)
    elif "." in num:
        head, _, tail = num.rpartition(".")
        if len(tail) == 3 and head:          # '1.250' is a thousands separator in DZ
            num = head.replace(".", "") + tail
        else:
            num = head.replace(".", "") + "." + tail
    try:
        return round(float(num), 2)
    except ValueError:
        return None


def valid_barcode(raw) -> str:
    """Return the code if it is a GTIN-8/12/13/14 with a correct check digit, else ''."""
    code = re.sub(r"\D", "", str(raw or "").translate(_EASTERN_DIGITS))
    if len(code) not in (8, 12, 13, 14):
        return ""
    digits = [int(c) for c in code]
    check = digits.pop()
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return code if (10 - total % 10) % 10 == check else ""

# --------------------------------------------------------------------------- #
# Category normalisation (French / Arabic / English keywords)
# Order matters: specific rules first ("savon à l'huile d'olive" is soap, not oil;
# "chocolat au lait" is chocolate, not milk). Extend this list freely.
# --------------------------------------------------------------------------- #

CATEGORY_RULES = [
    # Non-food first, so "huile essentielle" / "savon à l'huile" never land in food
    ("Animalerie", "Animalerie", ["animalerie", "animaux", "croquette", "litiere", "nourriture chat", "nourriture chien"]),
    ("Maison & bricolage", "Électroménager & cuisine", ["electromenager", "robot multifonction", "friteuse", "mixeur", "blender", "bouilloire", "grille pain", "fer a repasser", "aspirateur", "cocotte", "poele", "casserole", "marmite", "ustensile", "articles maison"]),
    ("Maison & bricolage", "Outillage & électricité", ["outillage", "perceuse", "tournevis", "cle a cliquet", "douille", "marteau", "pince", "lampe led", "ampoule", "rallonge", "multiprise", "detecteur de tension", "electricite", "accessoire et consommable"]),
    ("Maison & bricolage", "Déco & divers", ["deco", "decoration", "porte cle", "bougie", "pochon", "contenant", "contenants vides", "sac reutilisable", "gourde"]),
    ("Hygiène & beauté", "Bébé", ["couche", "couches bebe", "lingette", "diaper", "bebe", "liniment", "biberon", "bledine", "حفاضات"]),
    ("Hygiène & beauté", "Hygiène féminine", ["serviette hygienique", "protege slip", "protege dessous", "femme"]),
    ("Hygiène & beauté", "Cheveux", ["cheveux", "cheuveux", "capillaire", "bonnet en satin", "scrunchie", "brosse demelante", "coiffure"]),
    ("Hygiène & beauté", "Santé & compléments", ["complement alimentaire", "complements alimentaires", "supplement", "vitamine", "magnesium", "phyto"]),
    ("Hygiène & beauté", "Hygiène corporelle", ["savon", "gel douche", "shampooing", "shampoing", "dentifrice", "brosse a dents", "deodorant", "shampoo", "anti-transpirant", "antitranspirant", "mousse a raser", "rasoir"]),
    ("Hygiène & beauté", "Soins & cosmétiques", ["cosmetique", "cosmetiques", "eau micellaire", "serum", "masque", "demaquillant", "aloe vera", "huile essentielle", "huile vegetale", "hydrolat", "argile", "gommage", "beaute", "soin", "soins", "lotion", "tonique", "repulsif", "visage", "corps", "beauty", "gua sha", "derma roller", "صابون", "شامبو", "معجون اسنان"]),
    ("Entretien", "Papier & emballage", ["papier hygienique", "essuie-tout", "essuie tout", "mouchoir", "aluminium", "film transparent", "film alimentaire", "sac poubelle", "torchon"]),
    ("Entretien", "Accessoires ménage", ["balai", "seau", "serpilliere", "eponge", "peau de chamois", "accessoires de menage", "insecticide", "insecticides"]),
    ("Entretien", "Lessive & ménage", ["lessive", "javel", "detergent", "liquide vaisselle", "nettoyant", "assouplissant", "bloc wc", "desodorisant", "toilet cleaning", "جافيل", "منظف", "مسحوق غسيل"]),
    # Food: specific before generic ("chocolat au lait" is chocolate, not milk)
    ("Épicerie sucrée", "Pâtisserie & desserts", ["patisserie", "chantilly", "levure chimique", "sucre vanille", "pistoles", "pate de dattes", "nappage", "gelatine", "arome", "colorant alimentaire", "preparation pour", "creme patissiere", "brownie", "vanille", "maizena"]),
    ("Épicerie sucrée", "Chocolat & confiserie", ["chocolat", "chocolate", "bonbon", "confiserie", "confectionerie", "pate a tartiner", "spread", "halwa", "halva", "caramel", "nougat", "barre", "douceurs", "شوكولا", "حلوى", "حلوة"]),
    ("Épicerie sucrée", "Biscuits & gâteaux", ["biscuit", "biscuiterie", "gaufrette", "gaufre", "galette", "gateau", "cookie", "madeleine", "cake", "croissant", "بسكويت", "كعك"]),
    ("Épicerie sucrée", "Confiture & miel", ["confiture", "jam", "miel", "honey", "pollen", "propolis", "gelee royale", "مربى", "عسل"]),
    ("Épicerie sucrée", "Céréales & petit-déjeuner", ["cereale", "granola", "muesli", "corn flakes", "flocon d'avoine", "flocons d'avoine"]),
    ("Boissons", "Eau", ["eau minerale", "eau de source", "water", "مياه معدنية", "ماء معدني"]),
    ("Boissons", "Jus & sodas", ["jus", "juice", "nectar", "soda", "boisson", "gazeuse", "gazouz", "sirop", "cola", "pepsi", "sprite", "fanta", "mirinda", "hamoud", "limonade", "energisante", "energy drink", "beverage", "عصير", "مشروب"]),
    ("Épicerie", "Café & thé", ["cafe", "coffee", "the vert", "the noir", "tea", "infusion", "tisane", "herboristerie", "verveine", "camomille", "chicoree", "قهوة", "شاي"]),
    ("Produits laitiers", "Fromage", ["fromage", "cheese", "camembert", "gruyere", "jben", "cheddar", "caciocavallo", "tomme", "valencay", "cendre", "mozzarella", "ricotta", "feta", "burrata", "emmental", "edam", "bouhezza", "gouda", "parmesan", "maasdam", "massdam", "brie", "comte", "raclette", "roquefort", "coeurembert", "جبن", "فرماج"]),
    ("Produits laitiers", "Yaourt & desserts lactés", ["yaourt", "yoghourt", "yogurt", "raib", "flan", "creme dessert", "pudding", "petit suisse", "petit-suisse", "dairy dessert", "رايب", "ياغورت"]),
    ("Produits laitiers", "Lait & lben", ["lait", "milk", "lben", "leben", "laiterie", "حليب", "لبن"]),
    ("Produits laitiers", "Beurre, crème & smen", ["beurre", "margarine", "butter", "smen", "creme fraiche", "dairy cream", "زبدة", "مارغرين", "سمن"]),
    ("Viandes & poissons", "Charcuterie & viande", ["charcuterie", "chorizo", "bacon", "jambon", "pastrami", "salami", "merguez", "cachir", "kachir", "bresaola", "saucisse", "viande", "poulet", "dinde"]),
    ("Épicerie", "Semoule & couscous", ["semoule", "couscous", "frik", "dchicha", "berkoukes", "سميد", "كسكس", "فريك", "دشيشة", "بركوكس"]),
    ("Épicerie", "Pâtes", ["pates", "spaghetti", "macaroni", "vermicelle", "tlitli", "rechta", "pasta", "coquillette", "coude", "nidi", "penne", "langue d'oiseau", "plomb", "torsade", "ravioli", "lasagne", "gnocchi", "linguine", "tagliatelle", "fusilli", "farfalle", "nouille", "trida", "تريدة", "معكرونة", "شعرية", "تليتلي", "رشتة"]),
    ("Épicerie", "Riz & légumineuses", ["riz", "rice", "lentille", "pois chiche", "haricot", "feve", "legumes secs", "أرز", "عدس", "حمص", "فاصوليا", "فول"]),
    ("Épicerie", "Fruits secs & noix", ["amande", "noix", "cajou", "pistache", "noisette", "cacahuete", "raisin sec", "pruneau", "datte", "figue seche", "abricot sec", "fruits secs", "تمر", "لوز"]),
    ("Épicerie", "Pain & biscottes", ["pain", "biscotte", "sourdough", "miche", "bread", "خبز"]),
    ("Épicerie", "Conserves & sauces", ["thon", "sardine", "maquereau", "تونة", "سردين"]),   # before oils: "thon à l'huile"
    ("Épicerie", "Huiles", ["huile", "oil", "زيت"]),
    ("Épicerie", "Farine & sucre", ["farine", "flour", "sucre", "sugar", "levure", "فرينة", "دقيق", "سكر", "خميرة"]),
    ("Épicerie", "Conserves & sauces", ["conserve", "concentre de tomate", "tomate", "thon", "sardine", "harissa", "hmiss", "mayonnaise", "مايوناز", "ketchup", "lacto-fermente", "confit", "pickle", "moutarde", "sauce", "cornichon", "olive", "legume", "canned", "طماطم", "تونة", "سردين", "هريسة", "زيتون"]),
    ("Viandes & poissons", "Produits de la mer", ["produits de la mer", "saumon", "crevette", "anchois", "poisson", "seafood"]),
    ("Épicerie", "Épices & condiments", ["epice", "sel", "poivre", "cumin", "ras el hanout", "paprika", "vinaigre", "vinaigrette", "condiment", "بهارات", "ملح", "فلفل", "كمون", "خل"]),
    ("Épicerie", "Coffrets & cadeaux", ["coffret", "box et cadeaux", "panier garni"]),
    ("Épicerie", "Autres produits d'épicerie", ["epicerie", "epicerie fine", "groceries", "snack", "snacks"]),
]


def _compile_rules():
    compiled = []
    for primary, sub, keywords in CATEGORY_RULES:
        patterns = []
        for kw in keywords:
            kw_n = re.escape(normalize(kw))
            if has_arabic(kw):
                patterns.append(kw_n)  # substring match handles ال / و / ب prefixes
            else:
                patterns.append(rf"(?<!\w){kw_n}(?:s|x)?(?!\w)")  # whole word, simple plural
        compiled.append((primary, sub, re.compile("|".join(patterns))))
    return compiled


_RULES = _compile_rules()


def categorize(product: Product):
    """Try the product name first, then the source's own category label."""
    for text in (product.product_name, product.product_name_ar, product.source_category):
        norm = normalize(text)
        if not norm:
            continue
        for primary, sub, pattern in _RULES:
            if pattern.search(norm):
                return primary, sub
    return "Non classé", product.source_category

# --------------------------------------------------------------------------- #
# Polite HTTP: robots.txt, rate limiting, retries, backs off instead of fighting blocks
# --------------------------------------------------------------------------- #

class PoliteSession:
    def __init__(self, delay: float = 2.0, respect_robots: bool = True,
                 timeout: int = 25, max_retries: int = 3):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "fr-DZ,fr;q=0.9,ar;q=0.8,en;q=0.7",
        })
        self.delay = delay
        self.respect_robots = respect_robots
        self.timeout = timeout
        self.max_retries = max_retries
        self._robots: Dict[str, robotparser.RobotFileParser] = {}
        self._host_delay: Dict[str, float] = {}
        self._next_ok: Dict[str, float] = {}
        self.last_status: Optional[int] = None   # HTTP status of the last response, for adapters

    def _robots_for(self, url: str) -> robotparser.RobotFileParser:
        parts = urlparse(url)
        base = f"{parts.scheme}://{parts.netloc}"
        if base not in self._robots:
            rp = robotparser.RobotFileParser()
            try:
                r = self.session.get(base + "/robots.txt", timeout=self.timeout)
                if r.status_code == 200:
                    rp.parse(r.text.splitlines())
                elif r.status_code in (401, 403):
                    rp.disallow_all = True
                else:
                    rp.allow_all = True
            except requests.RequestException:
                rp.allow_all = True
            crawl_delay = rp.crawl_delay(USER_AGENT) if not (rp.allow_all or rp.disallow_all) else None
            self._host_delay[parts.netloc] = max(self.delay, float(crawl_delay or 0))
            if crawl_delay:
                log.info("robots.txt asks for a %ss crawl delay on %s", crawl_delay, parts.netloc)
            self._robots[base] = rp
        return self._robots[base]

    def allowed(self, url: str) -> bool:
        if not self.respect_robots:
            return True
        return self._robots_for(url).can_fetch(USER_AGENT, url)

    def _wait(self, host: str):
        pause = self._next_ok.get(host, 0) - time.monotonic()
        if pause > 0:
            time.sleep(pause)

    def get(self, url: str, **kwargs) -> Optional[requests.Response]:
        if not self.allowed(url):
            log.warning("robots.txt disallows %s, skipping", url)
            return None
        host = urlparse(url).netloc
        delay = self._host_delay.get(host, self.delay)
        self.last_status = None
        for attempt in range(1, self.max_retries + 1):
            self._wait(host)
            try:
                r = self.session.get(url, timeout=self.timeout, **kwargs)
            except requests.RequestException as exc:
                log.warning("Request failed (%s), attempt %d/%d: %s", type(exc).__name__, attempt, self.max_retries, url)
                self._next_ok[host] = time.monotonic() + delay * 2 ** attempt
                continue
            self._next_ok[host] = time.monotonic() + delay
            self.last_status = r.status_code
            if r.status_code == 429 or r.status_code >= 500:
                retry_after = r.headers.get("Retry-After", "")
                backoff = float(retry_after) if retry_after.isdigit() else delay * 2 ** attempt * 5
                log.warning("HTTP %d, backing off %.0fs: %s", r.status_code, backoff, url)
                self._next_ok[host] = time.monotonic() + backoff
                continue
            if r.status_code == 403:
                log.error("HTTP 403 (blocked) on %s. Stopping here; the site doesn't want this traffic.", url)
                return None
            if r.status_code >= 400:
                log.debug("HTTP %d: %s", r.status_code, url)
                return None
            return r
        return None


def json_or_none(response: Optional[requests.Response]):
    if response is None:
        return None
    try:
        return response.json()
    except ValueError:
        return None

# --------------------------------------------------------------------------- #
# Source adapters: each yields Product objects
# --------------------------------------------------------------------------- #

OFF_FIELDS = ("code,product_name,product_name_fr,product_name_ar,product_name_en,"
              "brands,categories,image_front_url,image_url")


def _off_login(http: PoliteSession) -> bool:
    """Log in with OFF_USERNAME / OFF_PASSWORD (free account). OFF serves only the first
    10 search pages (1,000 products) to anonymous clients since 2026."""
    user, password = os.environ.get("OFF_USERNAME"), os.environ.get("OFF_PASSWORD")
    if not (user and password):
        return False
    try:
        r = http.session.post("https://world.openfoodfacts.org/cgi/session.pl",
                              data={"user_id": user, "password": password, ".submit": "Sign-in"},
                              timeout=http.timeout)
    except requests.RequestException as exc:
        log.warning("Open Food Facts login failed: %s", exc)
        return False
    logged_in = r.ok and any(c.name == "session" for c in http.session.cookies)
    log.info("Open Food Facts login %s for %s", "OK" if logged_in else "FAILED", user)
    return logged_in


def source_openfoodfacts(http: PoliteSession, cfg: dict) -> Iterator[Product]:
    url = cfg.get("api_url", "https://world.openfoodfacts.org/api/v2/search")
    page_size = 100
    failures = 0
    _off_login(http)
    for page in range(1, cfg.get("max_pages", 500) + 1):
        data = json_or_none(http.get(url, params={
            "countries_tags": "en:algeria", "fields": OFF_FIELDS,
            "page_size": page_size, "page": page,
        }))
        if data is None and http.last_status == 401:
            log.warning("[%s] Open Food Facts stops serving anonymous clients after page %d. Set "
                        "OFF_USERNAME / OFF_PASSWORD (free account) to get the rest.", cfg["name"], page - 1)
            break
        if data is None:   # the OFF search API often answers 503: skip the page, don't end the run
            failures += 1
            log.warning("[%s] page %d failed (%d in a row)", cfg["name"], page, failures)
            if failures >= 5:
                break
            continue
        failures = 0
        if not data.get("products"):
            break
        for item in data["products"]:
            name = clean(item.get("product_name_fr") or item.get("product_name") or item.get("product_name_en"))
            name_ar = clean(item.get("product_name_ar"))
            if not name and not name_ar:
                continue
            code = valid_barcode(item.get("code"))
            categories = [c.strip() for c in (item.get("categories") or "").split(",") if c.strip()]
            yield Product(
                product_name=name or name_ar,
                product_name_ar=name_ar if has_arabic(name_ar) else "",
                barcode=code,
                brand=clean((item.get("brands") or "").split(",")[0]),
                source_category=clean(categories[-1]) if categories else "",
                image_url=item.get("image_front_url") or item.get("image_url") or "",
                product_url=f"https://world.openfoodfacts.org/product/{code}" if code else "",
                source=cfg["name"],
            )
        total = int(data.get("count") or 0)
        log.info("[%s] page %d done (%d/%d)", cfg["name"], page, min(page * page_size, total), total)
        if page * page_size >= total:
            break


def _woo_brand(item: dict) -> str:
    brands = item.get("brands") or []
    if brands and isinstance(brands[0], dict):
        return clean(brands[0].get("name"))
    for attr in item.get("attributes") or []:
        if normalize(attr.get("name", "")) in ("marque", "brand", "العلامة", "العلامة التجارية"):
            terms = attr.get("terms") or []
            if terms:
                return clean(terms[0].get("name"))
    return ""


def source_woocommerce(http: PoliteSession, cfg: dict) -> Iterator[Product]:
    base = cfg["base_url"].rstrip("/")
    endpoint = f"{base}/wp-json/wc/store/v1/products"
    warned_currency = False
    for page in range(1, cfg.get("max_pages", 1000) + 1):
        response = http.get(endpoint, params={"per_page": 100, "page": page})
        items = json_or_none(response)
        if not items or not isinstance(items, list):
            break
        for item in items:
            prices = item.get("prices") or {}
            minor = int(prices.get("currency_minor_unit") or 0)
            raw_price = prices.get("price")
            price = int(raw_price) / 10 ** minor if str(raw_price or "").isdigit() else None
            price = price or None   # bundles / variable products report 0
            currency = (prices.get("currency_code") or "DZD").upper()
            if currency != "DZD":
                if not warned_currency:
                    log.warning("[%s] prices are in %s, not DZD; dropping prices", cfg["name"], currency)
                    warned_currency = True
                price = None
            categories = [clean(c.get("name")) for c in item.get("categories") or []]
            images = item.get("images") or []
            name = clean(item.get("name"))
            yield Product(
                product_name=name,
                product_name_ar=name if has_arabic(name) else "",
                barcode=valid_barcode(item.get("sku")),
                brand=_woo_brand(item),
                source_category=categories[0] if categories else cfg.get("category", ""),
                price_dzd=price,
                image_url=images[0].get("src", "") if images else "",
                product_url=item.get("permalink", ""),
                source=cfg["name"],
            )
        total_pages = int(response.headers.get("X-WP-TotalPages") or page)
        log.info("[%s] page %d/%d done", cfg["name"], page, total_pages)
        if page >= total_pages:
            break


def source_shopify(http: PoliteSession, cfg: dict) -> Iterator[Product]:
    base = cfg["base_url"].rstrip("/")
    for page in range(1, cfg.get("max_pages", 200) + 1):
        data = json_or_none(http.get(f"{base}/products.json", params={"limit": 250, "page": page}))
        if not data or not data.get("products"):
            break
        for item in data["products"]:
            variant = (item.get("variants") or [{}])[0]
            images = item.get("images") or []
            name = clean(item.get("title"))
            yield Product(
                product_name=name,
                product_name_ar=name if has_arabic(name) else "",
                barcode=valid_barcode(variant.get("barcode") or variant.get("sku")),
                brand=clean(item.get("vendor")),
                source_category=clean(item.get("product_type")) or cfg.get("category", ""),
                price_dzd=parse_price(variant.get("price")),
                image_url=images[0].get("src", "") if images else "",
                product_url=f"{base}/products/{item.get('handle', '')}",
                source=cfg["name"],
            )
        log.info("[%s] page %d done", cfg["name"], page)


def extract_jsonld_product(soup: BeautifulSoup) -> dict:
    """Find a schema.org Product block (many shops embed one, often with gtin13 + price)."""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (ValueError, TypeError):
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                types = node.get("@type")
                types = types if isinstance(types, list) else [types]
                if "Product" in types:
                    return node
                if isinstance(node.get("@graph"), list):
                    stack.extend(node["@graph"])
    return {}


def _apply_jsonld(product: Product, node: dict):
    if not node:
        return
    for key in ("gtin13", "gtin", "gtin8", "gtin12", "gtin14", "sku"):
        code = valid_barcode(node.get(key))
        if code:
            product.barcode = product.barcode or code
            break
    brand = node.get("brand")
    if isinstance(brand, dict):
        brand = brand.get("name")
    product.brand = product.brand or clean(brand)
    offers = node.get("offers")
    offers = offers[0] if isinstance(offers, list) and offers else offers
    if isinstance(offers, dict) and product.price_dzd is None:
        if str(offers.get("priceCurrency", "DZD")).upper() == "DZD":
            product.price_dzd = parse_price(offers.get("price") or offers.get("lowPrice"))
    image = node.get("image")
    if isinstance(image, list) and image:
        image = image[0]
    if isinstance(image, dict):
        image = image.get("url")
    product.image_url = product.image_url or (image or "")
    product.source_category = product.source_category or clean(node.get("category"))


def _select_text(el, selector: Optional[str]) -> str:
    if not selector:
        return ""
    found = el.select_one(selector)
    return clean(found.get_text(" ")) if found else ""


def _select_image(el, selector: Optional[str], page_url: str) -> str:
    img = el.select_one(selector or "img")
    if not img:
        return ""
    for attr in ("data-src", "data-lazy-src", "data-original", "src"):
        value = img.get(attr)
        if value and not value.startswith("data:"):
            return urljoin(page_url, value)
    srcset = img.get("srcset") or img.get("data-srcset")
    return urljoin(page_url, srcset.split(",")[0].split()[0]) if srcset else ""


def source_html(http: PoliteSession, cfg: dict) -> Iterator[Product]:
    # "categories": {"label": "listing url with {page}"} scrapes several category
    # listings and records each label as source_category; otherwise one listing_url.
    listings = cfg.get("categories") or {cfg.get("category", ""): cfg["listing_url"]}
    for label, listing_url in listings.items():
        yield from _html_listing(http, cfg, listing_url, label)


def _html_listing(http: PoliteSession, cfg: dict, listing_url: str, label: str) -> Iterator[Product]:
    sel = cfg["selectors"]
    start = cfg.get("start_page", 1)
    previous_page_names = None
    for page in range(start, start + cfg.get("max_pages", 50)):
        url = listing_url.format(page=page)
        response = http.get(url)
        if response is None:
            break
        soup = BeautifulSoup(response.text, "html.parser")
        cards = soup.select(sel["card"])
        if not cards:
            break
        names = [_select_text(c, sel.get("name")) for c in cards]
        if names == previous_page_names:   # some sites repeat the last page forever
            break
        previous_page_names = names
        for card, name in zip(cards, names):
            if not name:
                continue
            link_el = card.select_one(sel["link"]) if sel.get("link") else card.find("a", href=True)
            link = urljoin(url, link_el["href"]) if link_el and link_el.get("href") else ""
            product = Product(
                product_name=name,
                product_name_ar=name if has_arabic(name) else "",
                brand=_select_text(card, sel.get("brand")),
                source_category=label,
                price_dzd=parse_price(_select_text(card, sel.get("price"))),
                image_url=_select_image(card, sel.get("image"), url),
                product_url=link,
                source=cfg["name"],
            )
            if cfg.get("follow_product_pages") and link:
                detail = http.get(link)
                if detail is not None:
                    _apply_jsonld(product, extract_jsonld_product(BeautifulSoup(detail.text, "html.parser")))
            yield product
        log.info("[%s] %s page %d done (%d cards)", cfg["name"], label or "listing", page, len(cards))


ADAPTERS: Dict[str, Callable[[PoliteSession, dict], Iterator[Product]]] = {
    "openfoodfacts": source_openfoodfacts,
    "woocommerce": source_woocommerce,
    "shopify": source_shopify,
    "html": source_html,
}

# --------------------------------------------------------------------------- #
# Storage + merge
# --------------------------------------------------------------------------- #

_FIELD_NAMES = {f.name for f in fields(Product)}


def save_raw(products: List[Product], path: Path):
    with path.open("w", encoding="utf-8") as fh:
        for p in products:
            fh.write(json.dumps(asdict(p), ensure_ascii=False) + "\n")


def load_raw(raw_dir: Path) -> List[Product]:
    products = []
    for path in sorted(raw_dir.glob("*.jsonl")):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    data = json.loads(line)
                    products.append(Product(**{k: v for k, v in data.items() if k in _FIELD_NAMES}))
    return products


def slugify(text: str) -> str:
    """'Hygiène & beauté' -> 'hygiene-beaute' (safe file name)."""
    return re.sub(r"[^a-z0-9]+", "-", normalize(text)).strip("-") or "autre"


def write_csv(path: Path, rows: List[Product]):
    # utf-8-sig so Excel displays Arabic correctly when the CSV is double-clicked
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        for p in rows:
            row = asdict(p)
            row["price_dzd"] = "" if p.price_dzd is None else p.price_dzd
            writer.writerow({c: row[c] for c in COLUMNS})


def write_json(path: Path, rows: List[Product]):
    with path.open("w", encoding="utf-8") as fh:
        json.dump([{c: asdict(p)[c] for c in COLUMNS} for p in rows], fh, ensure_ascii=False, indent=2)


def merge(raw_dir: Path, out_dir: Path, reference_source: str = "openfoodfacts"):
    products = load_raw(raw_dir)
    if not products:
        log.warning("No raw data in %s; nothing to merge.", raw_dir)
        return

    # 1. De-duplicate within each source (same barcode, or same name if no barcode)
    unique: Dict[tuple, Product] = {}
    for p in products:
        key = (p.source, p.barcode or normalize(p.product_name))
        if key not in unique:
            unique[key] = p
        else:  # fill gaps in the first copy from the duplicate
            kept = unique[key]
            for f in ("product_name_ar", "brand", "image_url", "source_category", "barcode"):
                if not getattr(kept, f) and getattr(p, f):
                    setattr(kept, f, getattr(p, f))
            if kept.price_dzd is None:
                kept.price_dzd = p.price_dzd
    rows = list(unique.values())

    # 2. Enrich shop rows from Open Food Facts via barcode (Arabic name, brand, image)
    reference = {p.barcode: p for p in rows if p.source == reference_source and p.barcode}
    enriched = 0
    for p in rows:
        ref = reference.get(p.barcode)
        if ref is not None and ref is not p:
            for f in ("product_name_ar", "brand", "image_url"):
                if not getattr(p, f) and getattr(ref, f):
                    setattr(p, f, getattr(ref, f))
                    enriched += 1

    # 3. Normalise categories (re-run on every merge, so improving the rules needs no re-scrape)
    for p in rows:
        p.primary_category, p.sub_category = categorize(p)

    rows.sort(key=lambda p: (p.primary_category, p.sub_category, normalize(p.product_name), p.source))
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "grocery_products.csv", rows)
    write_json(out_dir / "grocery_products.json", rows)

    # One file per primary category, in both formats: data/csv/<category>.csv, data/json/<category>.json
    by_category: Dict[str, List[Product]] = {}
    for p in rows:
        by_category.setdefault(p.primary_category, []).append(p)
    for fmt, writer in (("csv", write_csv), ("json", write_json)):
        fmt_dir = out_dir / fmt
        fmt_dir.mkdir(exist_ok=True)
        for stale in fmt_dir.glob(f"*.{fmt}"):   # categories can disappear when rules change
            stale.unlink()
        for category, items in by_category.items():
            writer(fmt_dir / f"{slugify(category)}.{fmt}", items)

    per_source: Dict[str, int] = {}
    for p in rows:
        per_source[p.source] = per_source.get(p.source, 0) + 1
    metadata = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_products": len(rows),
        "with_price": sum(p.price_dzd is not None for p in rows),
        "with_barcode": sum(bool(p.barcode) for p in rows),
        "with_arabic_name": sum(bool(p.product_name_ar) for p in rows),
        "uncategorized": sum(p.primary_category == "Non classé" for p in rows),
        "per_source": per_source,
        "per_category": {
            category: {"products": len(items), "file": f"{slugify(category)}.csv / .json"}
            for category, items in sorted(by_category.items())
        },
        "columns": COLUMNS,
        "note": "Prices are a snapshot at scraped_date and change often. See README for licence and attribution.",
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("Wrote %d products (%d with price, %d with barcode, %d fields enriched from OFF) to %s",
             len(rows), metadata["with_price"], metadata["with_barcode"], enriched, out_dir)

# --------------------------------------------------------------------------- #
# --detect helper
# --------------------------------------------------------------------------- #

def detect(url: str):
    http = PoliteSession(delay=1.0)
    parts = urlparse(url if "://" in url else "https://" + url)
    base = f"{parts.scheme}://{parts.netloc}"
    print(f"Site: {base}")
    print(f"  robots.txt allows homepage: {http.allowed(base + '/')}")
    print(f"  robots.txt allows /wp-json/: {http.allowed(base + '/wp-json/wc/store/v1/products')}")
    print(f"  robots.txt allows /products.json: {http.allowed(base + '/products.json')}")

    woo = json_or_none(http.get(base + "/wp-json/wc/store/v1/products", params={"per_page": 1}))
    if isinstance(woo, list):
        print('  -> WooCommerce Store API works. Use: {"type": "woocommerce", "base_url": "%s"}' % base)
        return
    shop = json_or_none(http.get(base + "/products.json", params={"limit": 1}))
    if isinstance(shop, dict) and "products" in shop:
        print('  -> Shopify detected. Use: {"type": "shopify", "base_url": "%s"}' % base)
        return
    home = http.get(base + "/")
    if home is not None:
        soup = BeautifulSoup(home.text, "html.parser")
        generator = soup.find("meta", attrs={"name": "generator"})
        if generator:
            print(f"  generator meta tag: {generator.get('content')}")
    print('  -> No JSON API found. Use {"type": "html"} and write CSS selectors (inspect a product card in DevTools).')
    print("     Tip: set follow_product_pages=true if product pages embed JSON-LD (barcodes!).")

# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Build an open dataset of Algerian grocery products.")
    ap.add_argument("--config", default="sources.json", help="sources config file (default: sources.json)")
    ap.add_argument("--out", default="data", help="output directory (default: data)")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="run only these sources (even if disabled)")
    ap.add_argument("--delay", type=float, help="override seconds between requests for every source")
    ap.add_argument("--max-pages", type=int, help="cap pages per source (handy for a quick test run)")
    ap.add_argument("--merge-only", action="store_true", help="skip scraping; rebuild outputs from data/raw")
    ap.add_argument("--detect", metavar="URL", help="inspect a site: robots.txt + platform detection")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    if args.detect:
        detect(args.detect)
        return

    out_dir = Path(args.out)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    if not args.merge_only:
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        sources = [s for s in config["sources"]
                   if (s["name"] in args.only if args.only else s.get("enabled", True))]
        if not sources:
            log.warning("No sources selected. Enable some in %s or use --only.", args.config)
        for src in sources:
            adapter = ADAPTERS.get(src.get("type"))
            if adapter is None:
                log.error("Unknown source type %r for %s", src.get("type"), src["name"])
                continue
            if args.max_pages:
                src = {**src, "max_pages": args.max_pages}
            http = PoliteSession(delay=args.delay or src.get("delay", 2.0),
                                 respect_robots=src.get("respect_robots", True),
                                 max_retries=src.get("max_retries", 3))
            log.info("=== %s (%s) ===", src["name"], src["type"])
            collected: List[Product] = []
            interrupted = False
            try:
                for product in adapter(http, src):
                    collected.append(product)
            except KeyboardInterrupt:
                interrupted = True
                log.warning("Interrupted: saving %d products collected so far", len(collected))
            except Exception:
                log.exception("Source %s crashed after %d products; saving partial results", src["name"], len(collected))
            if collected:   # never overwrite a good previous run with an empty one
                save_raw(collected, raw_dir / f"{src['name']}.jsonl")
                log.info("[%s] saved %d products", src["name"], len(collected))
            else:
                log.warning("[%s] got 0 products; keeping any previous raw file", src["name"])
            if interrupted:
                break

    merge(raw_dir, out_dir)


if __name__ == "__main__":
    main()
