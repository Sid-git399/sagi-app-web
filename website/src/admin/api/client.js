import { http } from '../../lib/api';

/**
 * The admin panel shares the website's HTTP client: one session, one token
 * refresh, one base URL. Admin endpoints unwrap `r.data.data` themselves.
 */
export const api = http;

export function apiErrorMessage(err) {
  const data = err?.response?.data;
  const detail = Array.isArray(data?.details) && data.details[0]?.message;
  return detail || data?.message || err?.message || 'حدث خطأ غير متوقع';
}
