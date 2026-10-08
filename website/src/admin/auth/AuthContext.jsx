import { useAuth as useSiteAuth } from '../../state/auth';

/**
 * The admin signs in through the website's own login; the site's route guard
 * already limits /admin to the admin role. This keeps the shape the admin
 * pages were written against.
 */
export function useAuth() {
  const { user, logout } = useSiteAuth();
  return { user, loading: false, logout };
}
