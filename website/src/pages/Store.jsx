import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useScroll, useTransform } from 'framer-motion';
import { Icon } from '../components/Icon';
import { Badge, Button, EmptyState, ErrorState, Img, Skeleton } from '../components/ui';
import { ProductCard } from '../components/Catalog';
import { ProductModal } from '../components/ProductModal';
import { useI18n } from '../state/i18n';
import { useCart } from '../state/cart';
import { useLocation2 } from '../state/location';
import { useAsync, useDebounced, useSlow } from '../lib/hooks';
import { catalog } from '../lib/services';
import { localPhone, money, openNow, toLatLng } from '../lib/format';

const LiveMap = lazy(() => import('../components/Maps').then((m) => ({ default: m.LiveMap })));

function Hours({ vendor }) {
  const { t } = useI18n();
  const today = new Date().getDay();
  if (!vendor.openingHours?.length) return <p className="text-sm text-ink-soft">{t('store.allDay')}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {t('days').map((day, d) => {
        const slots = vendor.openingHours.filter((h) => h.day === d);
        return (
          <li key={d} className={`flex justify-between rounded-xl px-3 py-1.5 ${d === today ? 'bg-leaf-tint font-bold text-forest' : 'text-ink-soft'}`}>
            <span>{day}</span>
            <span className="num">{slots.length ? slots.map((s) => `${s.from}–${s.to}`).join(' · ') : t('store.closedToday')}</span>
          </li>
        );
      })}
    </ul>
  );
}

const PAGE_SIZE = 24;

/**
 * Products for one menu tab (or one search), fetched a page at a time and
 * kept per tab, so going back to a tab is instant and a store with thousands
 * of products never ships them all at once.
 */
function useMenuProducts(vendorId, section, q) {
  const [store, setStore] = useState({});
  const inflight = useRef(new Set());
  // The store id is part of the key, so another store's cache never leaks in.
  const key = q ? `${vendorId}|q:${q}` : section ? `${vendorId}|s:${section}` : null;

  const load = useCallback(
    async (k, page) => {
      const tag = `${k}#${page}`;
      if (!k || inflight.current.has(tag)) return;
      inflight.current.add(tag);
      setStore((s) => ({
        ...s,
        [k]: { items: [], page: 0, hasMore: false, total: 0, ...s[k], loading: true, error: null },
      }));
      try {
        const kind = k.slice(k.indexOf('|') + 1);
        const query = kind.startsWith('q:') ? { q: kind.slice(2) } : { section: kind.slice(2) };
        const res = await catalog.products(vendorId, { ...query, page, limit: PAGE_SIZE });
        setStore((s) => {
          const prev = page === 1 ? [] : s[k]?.items ?? [];
          const seen = new Set(prev.map((p) => p.id));
          const items = [...prev, ...res.items.filter((p) => !seen.has(p.id))];
          return { ...s, [k]: { items, page, hasMore: res.hasMore, total: res.total, loading: false, error: null } };
        });
      } catch (error) {
        setStore((s) => ({ ...s, [k]: { ...s[k], loading: false, error } }));
      } finally {
        inflight.current.delete(tag);
      }
    },
    [vendorId],
  );

  const current = key ? store[key] : null;
  useEffect(() => {
    if (key && !current) load(key, 1);
  }, [key, current, load]);

  const state = current ?? { items: [], page: 0, hasMore: false, total: 0, loading: Boolean(key), error: null };
  return {
    ...state,
    key,
    loadMore: () => {
      if (current?.hasMore && !current.loading) load(key, current.page + 1);
    },
    retry: () => load(key, (current?.page ?? 0) + 1),
  };
}

/** Fires `onVisible` whenever the bottom of the list scrolls into view. */
function LoadMoreSentinel({ onVisible, disabled }) {
  const ref = useRef(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (disabled || !ref.current) return undefined;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && cb.current(), { rootMargin: '600px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return <div ref={ref} aria-hidden="true" className="h-1" />;
}

function SectionTabs({ sections, active, dimmed, onPick }) {
  const bar = useRef(null);
  // Keep the chosen tab visible inside the horizontal bar.
  useEffect(() => {
    const el = bar.current?.querySelector(`[data-tab="${active}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [active]);
  return (
    <div ref={bar} className={`scrollbar-none flex gap-1.5 overflow-x-auto transition-opacity ${dimmed ? 'opacity-50' : ''}`} role="tablist">
      {sections.map((s) => {
        const on = !dimmed && active === s.id;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={on}
            data-tab={s.id}
            onClick={() => onPick(s.id)}
            className={`relative shrink-0 rounded-full px-4 py-2 text-sm font-bold transition-colors ${on ? 'text-white' : 'bg-white text-ink-soft shadow-card hover:text-forest'}`}
          >
            {on && <motion.span layoutId="menu-tab" className="absolute inset-0 rounded-full bg-forest" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <span className="relative inline-flex items-center gap-1.5">
              {s.name}
              <span className={`num rounded-full px-1.5 text-xs ${on ? 'bg-white/20' : 'bg-forest/10'}`}>{s.productCount}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function Store() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { position } = useLocation2();
  const cart = useCart();
  const vendor = useAsync(() => catalog.vendor(id, position), [id]);
  const sections = useAsync(() => catalog.sections(id), [id]);
  const slow = useSlow(vendor.loading);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const menuTop = useRef(null);

  // The open tab lives in the URL (?section=…), so refresh and back keep it.
  const [params, setParams] = useSearchParams();
  const tabs = sections.data ?? [];
  const requested = params.get('section');
  const active = tabs.some((s) => s.id === requested) ? requested : tabs[0]?.id ?? null;
  const products = useMenuProducts(id, active, q.length >= 2 ? q : '');
  const searching = q.length >= 2;

  const heroRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const coverY = useTransform(scrollYProgress, [0, 1], ['0%', '30%']);
  const coverScale = useTransform(scrollYProgress, [0, 1], [1, 1.15]);

  // A tab shows only its own products. If the reader had scrolled deep into
  // the previous one, bring them back to the top of the menu — never further down.
  const pickSection = (sid) => {
    setQuery('');
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('section', sid);
      return next;
    }, { replace: true });
    const top = menuTop.current ? menuTop.current.getBoundingClientRect().top + window.scrollY - 80 : 0;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'smooth' });
  };
  const activeTab = tabs.find((s) => s.id === active);

  if (vendor.error) {
    const notFound = vendor.error?.response?.status === 404;
    return notFound ? (
      <EmptyState icon="store" title={t('store.notFound')} action={<Link to="/stores"><Button>{t('cart.browse')}</Button></Link>} />
    ) : (
      <ErrorState error={vendor.error} onRetry={vendor.reload} />
    );
  }

  const v = vendor.data;
  const isOpen = v ? openNow(v) : true;
  const storePoint = v ? toLatLng(v.location) : null;
  const inCart = cart.cart.vendor?.id === id ? cart.count : 0;

  return (
    <div className="pb-10">
      <div ref={heroRef} className="container-x pt-2">
        <div className="relative h-64 overflow-hidden rounded-[2.5rem] md:h-80">
          {v ? (
            <motion.div style={{ y: coverY, scale: coverScale }} className="absolute inset-0">
              <Img image={v.cover ?? v.logo} ratio={21 / 9} width={1600} className="h-full w-full" fallback="store" />
            </motion.div>
          ) : (
            <Skeleton className="absolute inset-0 rounded-none" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-forest-deep/80 via-forest-deep/20 to-transparent" />
          <Link
            to="/stores"
            className="absolute start-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/90 text-forest shadow backdrop-blur transition hover:scale-105"
            aria-label={t('common.back')}
          >
            <Icon name="chevron" className="h-5 w-5 rotate-180" />
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="relative -mt-20 mx-3 rounded-4xl bg-white p-5 shadow-lift md:mx-8 md:p-7"
        >
          {!v ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
              {slow && <p className="text-sm font-bold text-ink-muted">{t('common.waking')}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-5 md:flex-row md:items-center">
              <motion.div
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 14, delay: 0.2 }}
                className="-mt-16 h-24 w-24 shrink-0 overflow-hidden rounded-3xl bg-white p-1.5 shadow-lift ring-4 ring-white md:mt-0"
              >
                <Img image={v.logo} ratio={1} width={200} className="h-full w-full rounded-2xl" fallback="store" />
              </motion.div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-3xl font-extrabold md:text-4xl">{v.name}</h1>
                  <Badge tone={isOpen ? 'leaf' : 'tomato'} pulse={isOpen}>{isOpen ? t('stores.open') : t('stores.closed')}</Badge>
                </div>
                {v.description && <p className="mt-1 text-ink-soft">{v.description}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {v.ratingCount > 0 && (
                    <span className="chip num cursor-default">
                      <Icon name="star" filled className="h-4 w-4 text-tangerine" />
                      {Number(v.rating).toFixed(1)} <span className="text-ink-muted">({t('stores.reviews', { n: v.ratingCount })})</span>
                    </span>
                  )}
                  <span className="chip num cursor-default">
                    <Icon name="clock" className="h-4 w-4 text-leaf" />
                    {t('stores.prep', { min: v.prepTimeMin, max: v.prepTimeMax })}
                  </span>
                  <span className="chip num cursor-default">
                    <Icon name="bike" className="h-4 w-4 text-leaf" />
                    {t('stores.deliveryFee', { amount: money(v.deliveryFeeCentimes, lang) })}
                  </span>
                  {v.minOrderCentimes > 0 && (
                    <span className="chip num cursor-default">
                      <Icon name="bag" className="h-4 w-4 text-leaf" />
                      {t('stores.minOrder', { amount: money(v.minOrderCentimes, lang) })}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </motion.div>
        <AnimatePresence>
          {v && !isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mx-3 mt-4 flex items-center gap-3 rounded-2xl bg-tangerine-soft px-4 py-3 font-bold text-tangerine md:mx-8"
            >
              <Icon name="clock" />
              {t('store.closedBanner')}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="container-x mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
        <div ref={menuTop} className="min-w-0">
          <div className="sticky top-[68px] z-20 -mx-4 bg-cream/90 px-4 py-3 backdrop-blur-xl">
            <label className="mb-3 flex items-center gap-3 rounded-2xl bg-white px-4 shadow-card focus-within:ring-4 focus-within:ring-leaf/20">
              <Icon name="search" className="h-5 w-5 text-ink-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('store.searchMenu')}
                className="h-12 flex-1 bg-transparent outline-none placeholder:text-ink-muted"
              />
            </label>
            {sections.loading ? (
              <div className="flex gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-9 w-24 rounded-full" />)}</div>
            ) : (
              <SectionTabs sections={tabs} active={active} dimmed={searching} onPick={pickSection} />
            )}
          </div>

          {sections.error ? (
            <ErrorState error={sections.error} onRetry={sections.reload} />
          ) : !sections.loading && tabs.length === 0 ? (
            <EmptyState icon="burger" title={t('store.emptyMenu')} />
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.section
                key={products.key ?? 'loading'}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22 }}
                className="pt-6"
              >
                <h2 className="mb-4 flex items-center gap-3 text-2xl font-extrabold">
                  <span className="h-8 w-1.5 rounded-full bg-leaf" />
                  {searching ? t('store.resultsFor', { q }) : activeTab?.name}
                  {!products.loading || products.items.length ? (
                    <span className="num text-base font-bold text-ink-muted">{searching ? products.total : activeTab?.productCount}</span>
                  ) : null}
                </h2>

                {products.error && products.items.length === 0 ? (
                  <ErrorState error={products.error} onRetry={products.retry} />
                ) : products.loading && products.items.length === 0 ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-36 rounded-3xl" />)}
                  </div>
                ) : products.items.length === 0 ? (
                  <EmptyState icon="search" title={searching ? t('stores.noResults') : t('store.emptyMenu')} />
                ) : (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      {products.items.map((p) => (
                        <ProductCard key={p.id} product={p} onOpen={setSelected} />
                      ))}
                    </div>
                    {products.hasMore && (
                      <div className="mt-6 flex flex-col items-center gap-2">
                        <LoadMoreSentinel onVisible={products.loadMore} disabled={products.loading || Boolean(products.error)} />
                        <Button variant="soft" loading={products.loading} onClick={products.loadMore}>
                          {t('store.loadMore', { shown: products.items.length, total: products.total })}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </motion.section>
            </AnimatePresence>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          {v && (
            <>
              <div className="card p-5">
                <h3 className="mb-3 text-lg font-bold">{t('store.info')}</h3>
                <p className="flex gap-2 text-sm text-ink-soft">
                  <Icon name="pin" className="h-5 w-5 shrink-0 text-leaf" />
                  {v.addressText}
                </p>
                {v.phone && (
                  <a href={`tel:${v.phone}`} className="num mt-3 flex items-center gap-2 text-sm font-bold text-forest hover:underline">
                    <Icon name="phone" className="h-5 w-5 text-leaf" />
                    {localPhone(v.phone)}
                  </a>
                )}
                {storePoint && (
                  <div className="mt-4">
                    <Suspense fallback={<Skeleton className="h-44 rounded-4xl" />}>
                      <LiveMap store={storePoint} className="h-44" />
                    </Suspense>
                  </div>
                )}
              </div>
              <div className="card p-5">
                <h3 className="mb-3 text-lg font-bold">{t('store.hours')}</h3>
                <Hours vendor={v} />
              </div>
            </>
          )}
        </aside>
      </div>

      {/* A floating "view cart" pill while this store's items are in the cart. */}
      <AnimatePresence>
        {inCart > 0 && (
          <motion.button
            type="button"
            onClick={cart.open}
            initial={{ y: 120, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 120, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="fixed inset-x-4 bottom-24 z-30 mx-auto flex max-w-md items-center justify-between rounded-3xl bg-forest px-5 py-4 text-white shadow-lift md:bottom-8"
          >
            <span className="flex items-center gap-3 font-bold">
              <span className="num grid h-8 w-8 place-items-center rounded-full bg-white/15">{inCart}</span>
              {t('cart.checkout')}
            </span>
            <span className="num font-display text-lg font-bold">{money(cart.subtotal, lang)}</span>
          </motion.button>
        )}
      </AnimatePresence>

      {v && <ProductModal product={selected} vendor={v} onClose={() => setSelected(null)} />}
    </div>
  );
}
