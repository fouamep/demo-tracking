import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";

type OrderStatus =
  | "CREATED"
  | "PREPARING"
  | "READY_FOR_PICKUP"
  | "ASSIGNED"
  | "EN_ROUTE"
  | "DELIVERED";

interface Order {
  id: string;
  customerName: string;
  address: string;
  lat: number;
  lng: number;
  status: OrderStatus;
  courierId?: string;
  createdAt: number;
}

interface LocationPing {
  orderId: string;
  courierId: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  ts: number;
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// In-memory state
const orders = new Map<string, Order>();
const lastLocationByOrder = new Map<string, Omit<LocationPing, "orderId">>();

// Simple REST to fetch all orders (useful for SSR or reloads)
app.get("/orders", (_req, res) => {
  res.json([...orders.values()]);
});

io.on("connection", (socket) => {
  const role = (socket.handshake.query.role as string) || "guest";

  // Admin joins "admins" to get global broadcasts
  if (role === "admin") {
    socket.join("admins");
    socket.emit("orders:snapshot", [...orders.values()]);
  }

  // Couriers join a private room they specify later
  socket.on("courier:join", (courierId: string) => {
    socket.join(`courier:${courierId}`);
  });

  // Web wants to watch a single order room
  socket.on("order:watch", (orderId: string) => {
    socket.join(`order:${orderId}`);
    const loc = lastLocationByOrder.get(orderId);
    if (loc) socket.emit("location:delta", { orderId, ...loc });
  });

  socket.on(
    "order:create",
    (payload: Omit<Order, "id" | "status" | "createdAt">) => {
      const id = uuid();
      const order: Order = {
        id,
        customerName: payload.customerName,
        address: payload.address,
        lat: payload.lat,
        lng: payload.lng,
        status: "CREATED",
        createdAt: Date.now(),
      };
      orders.set(id, order);
      io.to("admins").emit("order:created", order);
      // Also provide full snapshot to keep UI simple
      io.to("admins").emit("orders:snapshot", [...orders.values()]);
    }
  );

  socket.on(
    "order:status",
    ({ orderId, status }: { orderId: string; status: OrderStatus }) => {
      const o = orders.get(orderId);
      if (!o) return;
      o.status = status;
      orders.set(orderId, o);
      io.to("admins").emit("order:updated", o);
      io.to(`order:${orderId}`).emit("order:updated", o);
    }
  );

  socket.on(
    "order:assign",
    ({ orderId, courierId }: { orderId: string; courierId: string }) => {
      const o = orders.get(orderId);
      if (!o) return;
      o.courierId = courierId;
      o.status = o.status === "READY_FOR_PICKUP" ? "ASSIGNED" : o.status;
      orders.set(orderId, o);

      // Notify the courier and watchers
      io.to(`courier:${courierId}`).emit("order:assigned", o);
      io.to("admins").emit("order:updated", o);
      io.to(`order:${orderId}`).emit("order:updated", o);
    }
  );

  socket.on("location:update", (ping: LocationPing) => {
    const o = orders.get(ping.orderId);
    if (!o) return;

    lastLocationByOrder.set(ping.orderId, {
      courierId: ping.courierId,
      lat: ping.lat,
      lng: ping.lng,
      heading: ping.heading,
      speed: ping.speed,
      ts: ping.ts,
    });

    // Rebroadcast to viewers of this order + admins
    io.to(`order:${ping.orderId}`).emit("location:delta", ping);
    io.to("admins").emit("location:delta", ping);
  });

  // Delete an order
  socket.on("order:delete", ({ orderId }: { orderId: string }) => {
    const existed = orders.has(orderId);
    if (!existed) return;

    orders.delete(orderId);
    lastLocationByOrder.delete(orderId);

    // notify admins + watchers of this order
    io.to("admins").emit("order:deleted", { id: orderId });
    io.to(`order:${orderId}`).emit("order:deleted", { id: orderId });

    // keep UIs in sync simply
    io.to("admins").emit("orders:snapshot", [...orders.values()]);
  });

  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 4001;
server.listen(PORT, () => {
  console.log(`Realtime server listening on :${PORT}`);
});
