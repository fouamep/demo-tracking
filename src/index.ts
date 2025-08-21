// src/index.ts
import express, { type Request, type Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { Server, type Socket } from "socket.io";
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

// CORS: keep "*" for demos; restrict in prod via env if needed.
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);
app.use(express.json());

// Simple health/hello
app.get("/healthz", (_req: Request, res: Response) => res.send("ok"));
app.get("/", (_req: Request, res: Response) =>
  res.json({ service: "delivery-realtime", ok: true })
);

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// In-memory state
const orders = new Map<string, Order>();
const lastLocationByOrder = new Map<string, Omit<LocationPing, "orderId">>();

// Simple REST to fetch all orders (useful for reloads/inspect)
app.get("/orders", (_req: Request, res: Response) => {
  res.json([...orders.values()]);
});

io.on("connection", (socket: Socket) => {
  const role = (socket.handshake.query.role as string) || "guest";

  // Admin joins "admins" to get global broadcasts
  if (role === "admin") {
    socket.join("admins");
    socket.emit("orders:snapshot", [...orders.values()]);
  }

  // Couriers join a private room they specify later
  socket.on("courier:join", (courierId: string) => {
    if (!courierId) return;
    socket.join(`courier:${courierId}`);
  });

  // Web wants to watch a single order room
  socket.on("order:watch", (orderId: string) => {
    if (!orderId) return;
    socket.join(`order:${orderId}`);
    const loc = lastLocationByOrder.get(orderId);
    if (loc) socket.emit("location:delta", { orderId, ...loc });
  });

  socket.on(
    "order:create",
    (payload: Omit<Order, "id" | "status" | "createdAt">) => {
      if (
        !payload ||
        typeof payload.customerName !== "string" ||
        typeof payload.address !== "string" ||
        typeof payload.lat !== "number" ||
        typeof payload.lng !== "number"
      ) {
        return;
      }

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
      if (!o || !courierId) return;
      o.courierId = courierId;
      o.status = o.status === "READY_FOR_PICKUP" ? "ASSIGNED" : o.status;
      orders.set(orderId, o);

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

    io.to(`order:${ping.orderId}`).emit("location:delta", ping);
    io.to("admins").emit("location:delta", ping);
  });

  // Delete an order
  socket.on("order:delete", ({ orderId }: { orderId: string }) => {
    if (!orders.has(orderId)) return;

    orders.delete(orderId);
    lastLocationByOrder.delete(orderId);

    io.to("admins").emit("order:deleted", { id: orderId });
    io.to(`order:${orderId}`).emit("order:deleted", { id: orderId });
    io.to("admins").emit("orders:snapshot", [...orders.values()]);
  });

  socket.on("disconnect", () => {
    // no-op
  });
});

// Prefer a numeric port for Node's listen()
const PORT = Number(process.env.PORT) || 4001;
server.listen(PORT, () => {
  console.log(`Realtime server listening on :${PORT}`);
});
