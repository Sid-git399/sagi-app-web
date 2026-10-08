import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { logger } from '../config/logger';
import { verifyAccessToken } from '../modules/auth/token.service';
import { User, type Role } from '../modules/users/user.model';
import { Order } from '../modules/orders/order.model';
import { Vendor } from '../modules/vendors/vendor.model';
import { bindIo } from './emitter';
import { CLIENT_EVENTS, rooms } from './events';
import { recordLocation } from '../modules/agents/agent.service';

interface SocketUser {
  id: string;
  role: Role;
}

/** Server-side throttle so a chatty phone cannot flood the location pipeline. */
const LOCATION_MIN_INTERVAL_MS = 5_000;
const lastLocationAt = new Map<string, number>();

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    // Same policy as the REST API: every origin is allowed.
    cors: { origin: true, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.replace('Bearer ', '') ?? undefined);
      if (!token) return next(new Error('unauthorized'));

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).select('_id role isBlocked').lean();
      if (!user || user.isBlocked) return next(new Error('unauthorized'));

      (socket.data as { user: SocketUser }).user = { id: String(user._id), role: user.role as Role };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: SocketUser }).user;

    if (user.role === 'admin') socket.join(rooms.admin);
    if (user.role === 'agent') socket.join(rooms.agent(user.id));
    socket.join(rooms.customer(user.id));
    if (user.role === 'vendor') {
      // A shop account hears about orders for the shop it owns, nothing else.
      // Not awaited, so the handlers below are attached before any client event.
      void Vendor.findOne({ owner: user.id })
        .select('_id')
        .lean()
        .then((shop) => {
          if (shop) socket.join(rooms.vendor(String(shop._id)));
        })
        .catch((err) => logger.warn({ err, userId: user.id }, 'Failed to join vendor room'));
    }

    logger.debug({ userId: user.id, role: user.role }, 'Socket connected');

    // Joining an order room is authorised against the order itself.
    socket.on(CLIENT_EVENTS.joinOrder, async (orderId: unknown) => {
      if (typeof orderId !== 'string') return;
      const order = await Order.findById(orderId).select('customer agent').lean();
      if (!order) return;
      const allowed =
        user.role === 'admin' ||
        String(order.customer) === user.id ||
        String(order.agent ?? '') === user.id;
      if (allowed) socket.join(rooms.order(orderId));
    });

    socket.on(CLIENT_EVENTS.leaveOrder, (orderId: unknown) => {
      if (typeof orderId === 'string') socket.leave(rooms.order(orderId));
    });

    socket.on(CLIENT_EVENTS.agentLocationUpdate, async (payload: unknown) => {
      if (user.role !== 'agent') return;
      const data = payload as { lat?: number; lng?: number; heading?: number; speed?: number; battery?: number };
      if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') return;

      const last = lastLocationAt.get(user.id) ?? 0;
      if (Date.now() - last < LOCATION_MIN_INTERVAL_MS) return;
      lastLocationAt.set(user.id, Date.now());

      try {
        await recordLocation(user.id, {
          lat: data.lat,
          lng: data.lng,
          heading: data.heading,
          speed: data.speed,
          battery: data.battery,
        });
      } catch (err) {
        logger.warn({ err, agentId: user.id }, 'Failed to record socket location');
      }
    });

    socket.on('disconnect', () => {
      lastLocationAt.delete(user.id);
    });
  });

  bindIo(io);
  return io;
}
