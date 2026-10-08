import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, Reorder, motion } from 'framer-motion';
import { Icon } from '../components/Icon';
import { Badge, Button, Confirm, EmptyState, ErrorState, Field, IconButton, Img, Input, Modal, Segmented, Skeleton, Spinner, Switch, Textarea } from '../components/ui';
import { useI18n } from '../state/i18n';
import { useToast } from '../state/toast';
import { useAsync, useDebounced } from '../lib/hooks';
import { useSocketEvent } from '../lib/socket';
import { portal, uploads } from '../lib/services';
import { errorInfo } from '../lib/api';
import { dateTime, money } from '../lib/format';

const STATUS_TONE = { pending: 'tangerine', approved: 'leaf', rejected: 'tomato' };

/** Strips server-only fields so the body passes the strict product schema. */
function toBody(p) {
  return {
    name: p.name.trim(),
    description: p.description.trim() || undefined,
    priceCentimes: Math.round(Number(p.price || 0) * 100),
    section: p.section || null,
    image: p.image ? { url: p.image.url, publicId: p.image.publicId, ...(p.image.width ? { width: p.image.width } : {}), ...(p.image.height ? { height: p.image.height } : {}) } : null,
    isAvailable: p.isAvailable,
    options: p.options
      .filter((o) => o.name.trim() && o.values.some((v) => v.name.trim()))
      .map((o) => ({
        name: o.name.trim(),
        type: o.type,
        isRequired: o.isRequired,
        values: o.values.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), priceDeltaCentimes: Math.round(Number(v.delta || 0) * 100) })),
      })),
  };
}

function fromProduct(p) {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    price: p ? String((p.priceCentimes ?? 0) / 100) : '',
    section: p?.section?.id ?? p?.section ?? '',
    image: p?.image ?? null,
    isAvailable: p?.isAvailable ?? true,
    options: (p?.options ?? []).map((o) => ({
      key: Math.random(),
      name: o.name,
      type: o.type,
      isRequired: o.isRequired,
      values: o.values.map((v) => ({ key: Math.random(), name: v.name, delta: String((v.priceDeltaCentimes ?? 0) / 100) })),
    })),
  };
}

function ImagePicker({ image, onChange }) {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const pick = async (file) => {
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    try {
      onChange(await uploads.image(file, { folder: 'products' }));
    } catch (e) {
      toast.error(errorText(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <span className="label">{t('portal.image')}</span>
      <motion.button
        type="button"
        whileHover={{ scale: 1.01 }}
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files?.[0]);
        }}
        className="group relative block aspect-square w-40 overflow-hidden rounded-3xl border-2 border-dashed border-leaf/40 bg-cream"
      >
        {preview && busy ? (
          <img src={preview} alt="" className="h-full w-full object-cover opacity-60" />
        ) : image ? (
          <Img image={image} ratio={1} width={320} className="h-full w-full" />
        ) : (
          <span className="flex h-full flex-col items-center justify-center gap-2 text-forest">
            <Icon name="upload" className="h-8 w-8" />
            <span className="text-sm font-bold">{t('portal.uploadImage')}</span>
          </span>
        )}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-white/50 text-forest">
            <Spinner />
          </span>
        )}
        {image && !busy && (
          <span className="absolute inset-x-0 bottom-0 bg-forest-deep/70 py-1.5 text-center text-xs font-bold text-white opacity-0 transition group-hover:opacity-100">
            {t('portal.changeImage')}
          </span>
        )}
      </motion.button>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}

function OptionsEditor({ options, onChange }) {
  const { t } = useI18n();
  const update = (key, patch) => onChange(options.map((o) => (o.key === key ? { ...o, ...patch } : o)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label !mb-0">{t('portal.options')}</span>
        <Button
          type="button"
          size="sm"
          variant="soft"
          icon="plus"
          onClick={() => onChange([...options, { key: Math.random(), name: '', type: 'single', isRequired: false, values: [{ key: Math.random(), name: '', delta: '0' }] }])}
        >
          {t('portal.optionAdd')}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {options.map((o) => (
          <motion.div
            key={o.key}
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-3 overflow-hidden rounded-3xl border border-ink/10 bg-cream/50"
          >
            <div className="space-y-3 p-4">
              <div className="flex gap-2">
                <Input value={o.name} onChange={(e) => update(o.key, { name: e.target.value })} placeholder={t('portal.optionName')} maxLength={60} />
                <IconButton icon="trash" label={t('common.delete')} variant="ghost" className="!text-tomato" onClick={() => onChange(options.filter((x) => x.key !== o.key))} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Segmented size="sm" value={o.type} onChange={(v) => update(o.key, { type: v })} options={[{ value: 'single', label: t('portal.single') }, { value: 'multi', label: t('portal.multi') }]} />
                <label className="flex items-center gap-2 text-sm font-bold">
                  <Switch checked={o.isRequired} onChange={(v) => update(o.key, { isRequired: v })} label={t('portal.optionRequired')} />
                  {t('portal.optionRequired')}
                </label>
              </div>
              {o.values.map((v) => (
                <div key={v.key} className="flex gap-2">
                  <Input
                    value={v.name}
                    onChange={(e) => update(o.key, { values: o.values.map((x) => (x.key === v.key ? { ...x, name: e.target.value } : x)) })}
                    placeholder={t('portal.valueName')}
                    maxLength={60}
                  />
                  <Input
                    type="number"
                    min="0"
                    value={v.delta}
                    onChange={(e) => update(o.key, { values: o.values.map((x) => (x.key === v.key ? { ...x, delta: e.target.value } : x)) })}
                    placeholder={t('portal.valueDelta')}
                    className="num w-28"
                    dir="ltr"
                  />
                  <IconButton
                    icon="x"
                    label={t('common.delete')}
                    variant="ghost"
                    disabled={o.values.length <= 1}
                    onClick={() => update(o.key, { values: o.values.filter((x) => x.key !== v.key) })}
                  />
                </div>
              ))}
              {o.values.length < 20 && (
                <button
                  type="button"
                  onClick={() => update(o.key, { values: [...o.values, { key: Math.random(), name: '', delta: '0' }] })}
                  className="flex items-center gap-1.5 text-sm font-bold text-forest hover:underline"
                >
                  <Icon name="plus" className="h-4 w-4" /> {t('portal.valueAdd')}
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ProductEditor({ open, product, sections, onClose, onSaved }) {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState(() => fromProduct(product));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [lastKey, setLastKey] = useState(null);

  // Re-seed whenever a different product (or "new") is opened.
  const key = open ? product?.id ?? 'new' : null;
  if (key !== lastKey) {
    setLastKey(key);
    if (open) {
      setForm(fromProduct(product));
      setTried(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const invalid = !form.name.trim() || form.price === '' || Number(form.price) < 0;

  const save = async () => {
    setTried(true);
    if (invalid) {
      toast.error(t('portal.invalid'));
      return;
    }
    setBusy(true);
    try {
      const body = toBody(form);
      const saved = product ? await portal.updateProduct(product.id, body) : await portal.createProduct(body);
      toast.success(saved.status === 'pending' ? t('portal.submitted') : t('portal.saved'));
      onSaved(saved);
      onClose();
    } catch (e) {
      const info = errorInfo(e);
      toast.error(info.details?.[0]?.message ?? errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={product ? t('portal.productEdit') : t('portal.productNew')}
      footer={<Button size="lg" className="w-full" loading={busy} onClick={save} icon="send">{product ? t('common.save') : t('portal.submitted')}</Button>}
    >
      <div className="space-y-5 p-6">
        <p className="flex items-start gap-2 rounded-2xl bg-tangerine-soft p-3 text-sm font-bold text-tangerine">
          <Icon name="info" className="h-5 w-5 shrink-0" /> {t('portal.reviewNotice')}
        </p>
        {product?.status === 'rejected' && product.rejectionReason && (
          <p className="rounded-2xl bg-red-50 p-3 text-sm font-bold text-tomato">{t('portal.rejectedWhy', { reason: product.rejectionReason })}</p>
        )}
        <div className="flex flex-col gap-5 sm:flex-row">
          <ImagePicker image={form.image} onChange={(image) => setForm((f) => ({ ...f, image }))} />
          <div className="flex-1 space-y-4">
            <Field label={t('portal.name')} error={tried && !form.name.trim() ? t('portal.invalid') : null}>
              <Input value={form.name} onChange={set('name')} maxLength={80} invalid={tried && !form.name.trim()} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('portal.price')}>
                <Input type="number" min="0" value={form.price} onChange={set('price')} className="num" dir="ltr" invalid={tried && form.price === ''} />
              </Field>
              <Field label={t('portal.section')}>
                <select value={form.section} onChange={set('section')} className="field">
                  <option value="">{t('portal.noSection')}</option>
                  {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
            </div>
          </div>
        </div>
        <Field label={`${t('portal.description')} (${t('common.optional')})`}>
          <Textarea value={form.description} onChange={set('description')} maxLength={400} />
        </Field>
        <label className="flex items-center justify-between rounded-2xl bg-cream px-4 py-3 font-bold">
          {t('portal.available')}
          <Switch checked={form.isAvailable} onChange={(v) => setForm((f) => ({ ...f, isAvailable: v }))} label={t('portal.available')} />
        </label>
        <OptionsEditor options={form.options} onChange={(options) => setForm((f) => ({ ...f, options }))} />
      </div>
    </Modal>
  );
}

function Sections({ sections, onChanged }) {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await portal.createSection({ name: name.trim(), sortOrder: sections.length });
      setName('');
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const move = async (index, dir) => {
    const other = sections[index + dir];
    const self = sections[index];
    if (!other) return;
    try {
      await Promise.all([
        portal.updateSection(self.id, { sortOrder: index + dir }),
        portal.updateSection(other.id, { sortOrder: index }),
      ]);
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const rename = async () => {
    if (!editing?.name.trim()) return;
    try {
      await portal.updateSection(editing.id, { name: editing.name.trim() });
      setEditing(null);
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <section className="card p-5">
      <h2 className="mb-4 text-xl font-bold">{t('portal.sections')}</h2>
      <form onSubmit={add} className="mb-4 flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('portal.sectionName')} maxLength={60} />
        <Button type="submit" icon="plus" loading={busy} disabled={!name.trim()} aria-label={t('portal.sectionNew')} />
      </form>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {sections.map((s, i) => (
            <motion.li key={s.id} layout initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex items-center gap-1 rounded-2xl bg-cream p-2">
              {editing?.id === s.id ? (
                <form
                  className="flex flex-1 gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename();
                  }}
                >
                  <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={60} className="field !py-2" />
                  <IconButton icon="check" label={t('common.save')} variant="primary" type="submit" />
                </form>
              ) : (
                <>
                  <span className="flex-1 truncate px-2 font-bold">{s.name}</span>
                  <IconButton icon="up" label={t('portal.moveUp')} variant="ghost" size="h-8 w-8" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="down" label={t('portal.moveDown')} variant="ghost" size="h-8 w-8" disabled={i === sections.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="pencil" label={t('common.edit')} variant="ghost" size="h-8 w-8" onClick={() => setEditing({ id: s.id, name: s.name })} />
                  <IconButton icon="trash" label={t('common.delete')} variant="ghost" size="h-8 w-8" className="!text-tomato" onClick={() => setDeleting(s)} />
                </>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <Confirm
        open={Boolean(deleting)}
        danger
        title={t('portal.sectionDeleteConfirm')}
        text={deleting?.name}
        confirmLabel={t('common.delete')}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await portal.deleteSection(deleting.id);
            setDeleting(null);
            onChanged();
          } catch (err) {
            toast.error(errorText(err));
          }
        }}
      />
    </section>
  );
}

function ProductRow({ product, section, onEdit, onDelete, onToggle, draggable = false }) {
  const { t, lang } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-3xl bg-white p-3 shadow-card">
      {draggable && (
        <span className="cursor-grab px-1 text-ink/30 active:cursor-grabbing" aria-hidden="true">
          <Icon name="grip" className="h-5 w-5" strokeWidth={3} />
        </span>
      )}
      <Img image={product.image} ratio={1} width={140} className="h-16 w-16 shrink-0 rounded-2xl" fallback="burger" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-bold">{product.name}</p>
          <Badge tone={STATUS_TONE[product.status] ?? 'ink'} pulse={product.status === 'pending'}>{t(`portal.${product.status ?? 'approved'}`)}</Badge>
        </div>
        <p className="num text-sm text-ink-muted">
          {money(product.priceCentimes, lang)}
          {section && ` · ${section.name}`}
          {product.options?.length > 0 && ` · ${product.options.length} ${t('portal.options')}`}
        </p>
        {product.status === 'rejected' && product.rejectionReason && (
          <p className="line-clamp-1 text-xs font-bold text-tomato">{t('portal.rejectedWhy', { reason: product.rejectionReason })}</p>
        )}
        {product.status === 'pending' && <p className="text-xs text-ink-muted">{t('portal.pendingHint')}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch checked={product.isAvailable} onChange={() => onToggle(product)} label={t('portal.available')} />
        <IconButton icon="pencil" label={t('common.edit')} variant="ghost" onClick={() => onEdit(product)} />
        <IconButton icon="trash" label={t('common.delete')} variant="ghost" className="!text-tomato" onClick={() => onDelete(product)} />
      </div>
    </div>
  );
}

/** A list that loads a page at a time; `fetchPage(page)` resolves to a server Page. */
function usePagedList(fetchPage, deps) {
  const [state, setState] = useState({ items: [], page: 0, hasMore: false, total: 0, loading: true, error: null, extra: {} });
  const seq = useRef(0);
  const load = useCallback(
    async (page) => {
      const id = page === 1 ? ++seq.current : seq.current;
      setState((s) => ({ ...s, loading: true, error: null, ...(page === 1 ? { items: [] } : {}) }));
      try {
        const { items, hasMore, total, ...extra } = await fetchPage(page);
        if (id !== seq.current) return;
        setState((s) => {
          const prev = page === 1 ? [] : s.items;
          const seen = new Set(prev.map((x) => x.id));
          return { items: [...prev, ...items.filter((x) => !seen.has(x.id))], page, hasMore, total, loading: false, error: null, extra };
        });
      } catch (error) {
        if (id === seq.current) setState((s) => ({ ...s, loading: false, error }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    load(1);
  }, [load]);
  const setItems = useCallback((updater) => setState((s) => ({ ...s, items: updater(s.items) })), []);
  return {
    ...state,
    reload: () => load(1),
    loadMore: () => state.hasMore && !state.loading && load(state.page + 1),
    setItems,
  };
}

function minutesSince(value) {
  return value ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)) : 0;
}

/** Re-renders every 30s so "x min ago" stays honest. */
function useTick(ms = 30_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const QUICK_REASONS = ['outOfStock', 'tooBusy', 'closingSoon'];

function RejectDialog({ order, onClose, onDone }) {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState(null);
  if ((order?.id ?? null) !== lastId) {
    setLastId(order?.id ?? null);
    setReason('');
  }
  const submit = async () => {
    if (reason.trim().length < 3) return;
    setBusy(true);
    try {
      const updated = await portal.rejectOrder(order.id, reason.trim());
      toast.success(t('portal.orders.rejectedDone'));
      onDone(updated);
      onClose();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(order)}
      onClose={onClose}
      title={t('portal.orders.rejectTitle', { code: order?.code ?? '' })}
      footer={
        <Button size="lg" variant="danger" className="w-full" loading={busy} disabled={reason.trim().length < 3} onClick={submit} icon="x">
          {t('portal.orders.reject')}
        </Button>
      }
    >
      <div className="space-y-4 p-6">
        <p className="text-sm text-ink-soft">{t('portal.orders.rejectHint')}</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(t(`portal.orders.reasons.${r}`))} className="chip">
              {t(`portal.orders.reasons.${r}`)}
            </button>
          ))}
        </div>
        <Field label={t('portal.orders.reason')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

function VendorOrderCard({ order, onChanged, onReject }) {
  const { t, lang, errorText } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const count = order.items.reduce((n, i) => n + i.qty, 0);
  const waiting = minutesSince(order.sentToVendorAt ?? order.createdAt);
  const declined = order.status === 'confirmed' && order.vendorRejectedReason;

  const act = async (kind) => {
    setBusy(kind);
    try {
      const updated = kind === 'accept' ? await portal.acceptOrder(order.id) : await portal.readyOrder(order.id);
      toast.success(kind === 'accept' ? t('portal.orders.acceptedDone') : t('portal.orders.readyDone'));
      onChanged(updated);
    } catch (e) {
      toast.error(errorText(e));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const tone = order.status === 'sent_to_vendor' ? 'tangerine' : order.status === 'cancelled' || declined ? 'tomato' : 'leaf';
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={`overflow-hidden rounded-4xl bg-white shadow-card ${order.status === 'sent_to_vendor' ? 'ring-2 ring-tangerine/50' : ''}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-ink/5 p-5">
        <div className="min-w-0 flex-1">
          <p className="num font-display text-2xl font-bold">#{order.code}</p>
          <p className="text-sm text-ink-muted">
            {order.customerName && `${order.customerName} · `}
            <span className="num">{dateTime(order.sentToVendorAt ?? order.createdAt, lang)}</span>
          </p>
        </div>
        {order.deliveryType === 'vip' && <Badge tone="forest">VIP</Badge>}
        <Badge tone={tone} pulse={order.status === 'sent_to_vendor'}>
          {declined ? t('portal.orders.declined') : t(`status.${order.status}`)}
        </Badge>
      </header>

      <div className="space-y-3 p-5">
        <ul className="space-y-2">
          {order.items.map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="num grid h-8 min-w-8 place-items-center rounded-xl bg-leaf-tint px-2 font-black text-forest">{item.qty}×</span>
              <span className="min-w-0 flex-1 pt-1">
                <span className="font-bold">{item.nameSnapshot}</span>
                {item.selectedOptions?.length > 0 && (
                  <span className="block text-sm text-ink-muted">{item.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(' · ')}</span>
                )}
              </span>
              <span className="num pt-1 text-sm font-bold text-ink-soft">{money(item.lineTotalCentimes, lang)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between rounded-2xl bg-cream px-4 py-3">
          <span className="font-bold">{t('portal.orders.items', { n: count })}</span>
          <span className="num font-display text-lg font-bold text-forest">{money(order.subtotalCentimes, lang)}</span>
        </div>
        {order.customerNote && (
          <p className="rounded-2xl bg-tangerine-soft p-3 text-sm">
            <span className="font-bold">{t('driver.note')}:</span> {order.customerNote}
          </p>
        )}
        {declined && <p className="rounded-2xl bg-red-50 p-3 text-sm font-bold text-tomato">{t('portal.orders.youDeclined', { reason: order.vendorRejectedReason })}</p>}
        {order.status === 'cancelled' && order.cancelledReason && (
          <p className="rounded-2xl bg-red-50 p-3 text-sm font-bold text-tomato">{order.cancelledReason}</p>
        )}
        {['ready', 'assigned', 'accepted'].includes(order.status) && (
          <p className="flex items-center gap-2 rounded-2xl bg-leaf-tint p-3 text-sm font-bold text-forest">
            <Icon name="bike" className="h-5 w-5" />
            {order.agent?.fullName ? t('portal.orders.driverComing', { name: order.agent.fullName }) : t('portal.orders.waitingDriver')}
          </p>
        )}
      </div>

      {order.status === 'sent_to_vendor' && (
        <footer className="flex flex-wrap items-center gap-3 border-t border-ink/5 bg-cream/50 p-4">
          <span className="num me-auto flex items-center gap-1.5 text-sm font-bold text-tangerine">
            <Icon name="clock" className="h-4 w-4" />
            {t('portal.orders.waitingFor', { n: waiting })}
          </span>
          <Button variant="outline" icon="x" disabled={Boolean(busy)} onClick={() => onReject(order)}>
            {t('portal.orders.reject')}
          </Button>
          <Button icon="check" loading={busy === 'accept'} disabled={Boolean(busy)} onClick={() => act('accept')}>
            {t('portal.orders.accept')}
          </Button>
        </footer>
      )}
      {order.status === 'preparing' && (
        <footer className="border-t border-ink/5 bg-cream/50 p-4">
          <Button variant="leaf" size="lg" className="w-full" icon="package" loading={busy === 'ready'} onClick={() => act('ready')}>
            {t('portal.orders.markReady')}
          </Button>
        </footer>
      )}
    </motion.article>
  );
}

function PortalOrders({ onCounts }) {
  const { t } = useI18n();
  useTick();
  const [scope, setScope] = useState('incoming');
  const [rejecting, setRejecting] = useState(null);
  const list = usePagedList((page) => portal.orders(scope, page), [scope]);
  const counts = list.extra.counts ?? {};

  useEffect(() => {
    if (list.extra.counts) onCounts(list.extra.counts);
  }, [list.extra.counts, onCounts]);

  // Any change to one of our orders — a new one from the admin, a driver
  // picking one up, a cancellation — refreshes the list we are looking at.
  useSocketEvent('vendor:order', () => list.reload());

  // An answered order leaves "incoming" at once; the server list catches up.
  const changed = (updated) => {
    if (updated) list.setItems((items) => items.filter((o) => o.id !== updated.id || scope === 'active'));
    list.reload();
  };

  return (
    <section>
      <div className="scrollbar-none -mx-4 mb-5 overflow-x-auto px-4">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'incoming', label: t('portal.orders.incoming'), icon: 'bell', badge: counts.incoming ?? 0 },
            { value: 'active', label: t('portal.orders.active'), icon: 'flame', badge: counts.active ?? 0 },
            { value: 'history', label: t('portal.orders.history'), icon: 'history' },
          ]}
        />
      </div>

      {list.error && list.items.length === 0 ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.loading && list.items.length === 0 ? (
        <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-64 rounded-4xl" />)}</div>
      ) : list.items.length === 0 ? (
        <div className="card">
          <EmptyState icon="receipt" title={t(`portal.orders.empty.${scope}`)} text={scope === 'incoming' ? t('portal.orders.emptyHint') : undefined} />
        </div>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <AnimatePresence initial={false}>
              {list.items.map((o) => (
                <VendorOrderCard key={o.id} order={o} onChanged={changed} onReject={setRejecting} />
              ))}
            </AnimatePresence>
          </div>
          {list.hasMore && (
            <div className="mt-6 text-center">
              <Button variant="soft" loading={list.loading} onClick={list.loadMore}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}
      <RejectDialog order={rejecting} onClose={() => setRejecting(null)} onDone={changed} />
    </section>
  );
}

function PortalProducts() {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const sections = useAsync(() => portal.sections(), []);
  const [section, setSection] = useState('all');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [editing, setEditing] = useState(undefined);
  const [deleting, setDeleting] = useState(null);
  const orderRef = useRef(null);

  const list = usePagedList(
    (page) =>
      portal.products({
        page,
        limit: 30,
        section: section === 'all' ? undefined : section,
        status: filter === 'all' ? undefined : filter,
        q: q || undefined,
      }),
    [section, filter, q],
  );
  const counts = list.extra.counts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const sectionById = useMemo(() => new Map((sections.data ?? []).map((s) => [s.id, s])), [sections.data]);

  // Dragging sets menu order, which is per section: only offer it on one
  // section's full, unfiltered list.
  const canReorder = section !== 'all' && filter === 'all' && !q;

  // Availability alone never re-enters review on the server — it's stock, not content.
  const toggleProduct = async (p) => {
    list.setItems((items) => items.map((x) => (x.id === p.id ? { ...x, isAvailable: !x.isAvailable } : x)));
    try {
      await portal.updateProduct(p.id, { isAvailable: !p.isAvailable });
    } catch (e) {
      toast.error(errorText(e));
      list.reload();
    }
  };

  // The ref holds the latest order so the drop saves exactly what is on screen.
  const reorder = (next) => {
    orderRef.current = next;
    list.setItems(() => next);
  };
  const persistOrder = async () => {
    const items = orderRef.current;
    if (!items) return;
    orderRef.current = null;
    try {
      await portal.reorderProducts(items.map((p, i) => ({ id: p.id, sortOrder: i })));
    } catch (e) {
      toast.error(errorText(e));
      list.reload();
    }
  };

  const row = (p) => (
    <ProductRow product={p} section={sectionById.get(p.section?.id ?? p.section)} onEdit={setEditing} onDelete={setDeleting} onToggle={toggleProduct} draggable={canReorder} />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-extrabold">
            {t('portal.products')} <span className="num text-base text-ink-muted">({totalAll})</span>
          </h2>
          <Button icon="plus" onClick={() => setEditing(null)}>{t('portal.productNew')}</Button>
        </div>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-1 items-center gap-3 rounded-2xl bg-white px-4 shadow-card focus-within:ring-4 focus-within:ring-leaf/20">
            <Icon name="search" className="h-5 w-5 text-ink-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('portal.searchProducts')} className="h-11 flex-1 bg-transparent outline-none placeholder:text-ink-muted" />
          </label>
          <select value={section} onChange={(e) => setSection(e.target.value)} className="field sm:w-56" aria-label={t('portal.section')}>
            <option value="all">{t('portal.allSections')}</option>
            {(sections.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="none">{t('portal.noSection')}</option>
          </select>
        </div>

        <div className="scrollbar-none -mx-4 mb-4 overflow-x-auto px-4">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('portal.filterAll'), badge: totalAll },
              { value: 'pending', label: t('portal.pending'), badge: counts.pending ?? 0 },
              { value: 'approved', label: t('portal.approved'), badge: counts.approved ?? 0 },
              { value: 'rejected', label: t('portal.rejected'), badge: counts.rejected ?? 0 },
            ]}
          />
        </div>

        {list.error && list.items.length === 0 ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : list.loading && list.items.length === 0 ? (
          <div className="space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-3xl" />)}</div>
        ) : list.items.length === 0 ? (
          <div className="card"><EmptyState icon="burger" title={t('portal.empty')} action={<Button icon="plus" onClick={() => setEditing(null)}>{t('portal.productNew')}</Button>} /></div>
        ) : (
          <>
            {canReorder ? (
              <Reorder.Group axis="y" values={list.items} onReorder={reorder} className="space-y-3">
                {list.items.map((p) => (
                  <Reorder.Item key={p.id} value={p} onDragEnd={persistOrder} whileDrag={{ scale: 1.03, boxShadow: '0 24px 48px -16px rgba(14,77,43,.35)' }} className="list-none rounded-3xl">
                    {row(p)}
                  </Reorder.Item>
                ))}
              </Reorder.Group>
            ) : (
              <div className="space-y-3">
                {list.items.map((p) => <div key={p.id}>{row(p)}</div>)}
              </div>
            )}
            <p className="num mt-4 text-center text-sm text-ink-muted">{t('portal.showing', { shown: list.items.length, total: list.total })}</p>
            {list.hasMore && (
              <div className="mt-3 text-center">
                <Button variant="soft" loading={list.loading} onClick={list.loadMore}>{t('common.loadMore')}</Button>
              </div>
            )}
          </>
        )}
      </section>
      <aside className="lg:sticky lg:top-24 lg:self-start">
        {sections.loading ? <Skeleton className="h-64 rounded-3xl" /> : <Sections sections={sections.data ?? []} onChanged={() => { sections.reload(); list.reload(); }} />}
      </aside>

      <ProductEditor
        open={editing !== undefined}
        product={editing ?? null}
        sections={sections.data ?? []}
        onClose={() => setEditing(undefined)}
        onSaved={() => list.reload()}
      />
      <Confirm
        open={Boolean(deleting)}
        danger
        title={t('portal.deleteConfirm', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await portal.deleteProduct(deleting.id);
            list.setItems((items) => items.filter((x) => x.id !== deleting.id));
            setDeleting(null);
          } catch (e) {
            toast.error(errorText(e));
          }
        }}
      />
    </div>
  );
}

export default function Portal() {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const shop = useAsync(() => portal.me(), []);
  const [togglingShop, setTogglingShop] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'products' ? 'products' : 'orders';
  const [orderCounts, setOrderCounts] = useState({});

  if (shop.error) {
    const forbidden = shop.error?.response?.status === 403;
    return forbidden ? <EmptyState icon="store" title={t('portal.notLinked')} /> : <ErrorState error={shop.error} onRetry={shop.reload} />;
  }

  const toggleShop = async (isOpen) => {
    setTogglingShop(true);
    try {
      shop.setData(await portal.setOpen(isOpen));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setTogglingShop(false);
    }
  };

  const s = shop.data;
  return (
    <div className="container-x pb-12 pt-6">
      <motion.div
        layout
        className={`relative overflow-hidden rounded-[2.5rem] p-6 text-white shadow-lift transition-colors duration-700 md:p-8 ${s?.isOpen ? 'bg-forest' : 'bg-ink-soft'}`}
      >
        {!s ? (
          <Skeleton className="h-20 bg-white/10" />
        ) : (
          <div className="relative flex flex-wrap items-center gap-5">
            <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 14 }} className="h-20 w-20 overflow-hidden rounded-3xl bg-white p-1.5">
              <Img image={s.logo} ratio={1} width={160} className="h-full w-full rounded-2xl" fallback="store" />
            </motion.div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white/70">{t('portal.title')}</p>
              <h1 className="truncate text-3xl font-extrabold md:text-4xl">{s.name}</h1>
              <p className="text-sm text-white/80">{s.isOpen ? t('portal.openHint') : t('portal.closedHint')}</p>
            </div>
            <div className="flex items-center gap-3 rounded-full bg-white/10 py-2 pe-2 ps-5 backdrop-blur">
              <span className="font-bold">{s.isOpen ? t('portal.open') : t('portal.closed')}</span>
              <Switch checked={s.isOpen} onChange={toggleShop} disabled={togglingShop} size="lg" label={t('portal.open')} />
            </div>
          </div>
        )}
      </motion.div>

      <div className="mt-8 mb-6">
        <Segmented
          value={tab}
          onChange={(v) => setParams(v === 'orders' ? {} : { tab: v }, { replace: true })}
          options={[
            { value: 'orders', label: t('portal.orders.title'), icon: 'receipt', badge: orderCounts.incoming || undefined },
            { value: 'products', label: t('portal.products'), icon: 'package' },
          ]}
        />
      </div>

      {tab === 'orders' ? <PortalOrders onCounts={setOrderCounts} /> : <PortalProducts />}
    </div>
  );
}
