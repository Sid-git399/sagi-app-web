import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useSocketEvent } from '../../lib/socket';
import { useToast } from '../../state/toast';
import { chime, readPrefs, systemNotify } from '../../pages/OrderNotifier';

const NAV = [
  { to: '/admin', label: 'لوحة التحكم', end: true },
  { to: '/admin/orders', label: 'الطلبات', live: true },
  { to: '/admin/categories', label: 'الفئات' },
  { to: '/admin/vendors', label: 'المتاجر' },
  { to: '/admin/products', label: 'المنتجات' },
  { to: '/admin/offers', label: 'العروض' },
  { to: '/admin/vouchers', label: 'القسائم' },
  { to: '/admin/agents', label: 'السائقون' },
  { to: '/admin/customers', label: 'العملاء' },
  { to: '/admin/analytics', label: 'الإحصائيات' },
  { to: '/admin/settings', label: 'الإعدادات' },
];

/** What the shop's answer means for the admin's next step. */
const SHOP_ANSWERS = {
  'sent_to_vendor>preparing': (code) => `المتجر قبل الطلب #${code} وبدأ التحضير`,
  'sent_to_vendor>confirmed': (code) => `المتجر رفض الطلب #${code} — راجع السبب`,
  'preparing>ready': (code) => `الطلب #${code} جاهز — أسنده إلى سائق`,
};

function alert(toast, title, body = '') {
  toast.info(body ? `${title} — ${body}` : title);
  if (readPrefs().sound) chime();
  systemNotify(title, body);
}

export default function AdminShell() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const onOrders = location.pathname.startsWith('/admin/orders');

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (onOrders) setUnseen(0);
  }, [onOrders]);

  // The admin is the dispatcher: new orders and every shop answer ring here,
  // whichever admin page is open.
  useSocketEvent('order:new', (order) => {
    alert(toast, 'طلب جديد', order?.code ? `#${order.code} · ${order.vendor?.name ?? ''}` : '');
    if (!onOrders) setUnseen((n) => n + 1);
  });
  useSocketEvent('order:status', (p) => {
    const message = SHOP_ANSWERS[`${p?.from}>${p?.to}`];
    if (!message) return;
    alert(toast, message(p.code));
    if (!onOrders) setUnseen((n) => n + 1);
  });

  const nav = (
    <nav className="flex-1 space-y-1 overflow-y-auto p-3">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-bold transition ${
              isActive ? 'bg-brand text-white' : 'text-ink-soft hover:bg-black/5'
            }`
          }
        >
          {item.label}
          {item.live && unseen > 0 && (
            <span className="num grid h-6 min-w-6 place-items-center rounded-full bg-tangerine px-1.5 text-xs text-white">{unseen}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const footer = (
    <div className="border-t border-black/5 p-3">
      <div className="mb-2 truncate px-2 text-xs font-semibold text-ink-muted">
        {user?.fullName} · <span className="num">{user?.phone}</span>
      </div>
      <button onClick={logout} className="w-full rounded-xl px-4 py-2.5 text-start text-sm font-bold text-red-600 hover:bg-red-50">
        تسجيل الخروج
      </button>
    </div>
  );

  const brand = (
    <div className="flex items-center gap-2 border-b border-black/5 px-5 py-4">
      <img src="/brand/logo-mark.png" alt="" className="h-9 w-9 rounded-lg object-contain" />
      <span className="text-lg font-black">لوحة ساجي</span>
    </div>
  );

  return (
    <div dir="rtl" lang="ar" className="flex min-h-screen overflow-x-hidden bg-canvas">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-l border-black/5 bg-white lg:flex">
        {brand}
        {nav}
        {footer}
      </aside>

      {/* Phone / tablet drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <button type="button" aria-label="إغلاق" className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl">
            {brand}
            {nav}
            {footer}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-black/5 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="relative grid h-10 w-10 place-items-center rounded-xl bg-black/5"
            aria-label="القائمة"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            {unseen > 0 && <span className="absolute -end-1 -top-1 h-3 w-3 rounded-full bg-tangerine ring-2 ring-white" />}
          </button>
          <img src="/brand/logo-mark.png" alt="" className="h-8 w-8 rounded-lg object-contain" />
          <span className="font-black">لوحة ساجي</span>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
