import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEATS = 8;

function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function cleanSeats(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(Number).filter((seat) => {
    if (!Number.isInteger(seat) || seat < 1 || seat > MAX_SEATS || seen.has(seat)) return false;
    seen.add(seat);
    return true;
  });
}

function emptyRoom() {
  return {
    created: false,
    owner: "",
    open: [],
    board: {},
    lead: 0,
    turn: 0,
    controlMode: "anyone",
    managerUid: "",
    managerSeat: 1,
    mystery: "",
    diceHistory: [],
    updatedAt: Date.now()
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "eldritch-room-relay" });
    const code = cleanCode(url.pathname.split("/").filter(Boolean).pop());
    if (!code) return json({ ok: false, error: "room code required" }, 400);
    const stub = env.ROOMS.getByName(code);
    return stub.fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.room = emptyRoom();
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.room = Object.assign(emptyRoom(), (await this.ctx.storage.get("room")) || {});
    });
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({
        ok: true,
        created: this.room.created,
        open: this.room.open,
        players: Object.keys(this.room.board).length
      });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid: "", viewer: false });
    server.send(JSON.stringify(this.stateMessage()));
    return new Response(null, { status: 101, webSocket: client });
  }

  stateMessage() {
    const taken = {};
    Object.keys(this.room.board || {}).forEach((key) => {
      const player = this.room.board[key];
      if (player) taken[Number(key) + 1] = player.name || "사용중";
    });
    return {
      type: "roomState",
      created: this.room.created,
      open: this.room.open,
      board: this.room.board,
      taken,
      lead: this.room.lead,
      turn: this.room.turn,
      controlMode: this.room.controlMode || "anyone",
      managerUid: this.room.managerUid || this.room.owner || "",
      managerSeat: this.room.managerSeat || 1,
      mystery: this.room.mystery || "",
      diceHistory: this.room.diceHistory || [],
      updatedAt: this.room.updatedAt,
      server: "durable-object"
    };
  }

  send(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch (_) {}
  }

  broadcast(message, except = null) {
    const body = JSON.stringify(message);
    this.ctx.getWebSockets().forEach((socket) => {
      if (socket === except) return;
      try { socket.send(body); } catch (_) {}
    });
  }

  seatOwner(seat) {
    const player = this.room.board[String(seat - 1)];
    return player && player.uid ? player.uid : "";
  }

  validateSeats(seats, uid) {
    const none = seats.find((seat) => !this.room.open.includes(seat));
    if (none) return { type: "deny", reason: "none", seat: none, uid };
    const busy = seats.find((seat) => {
      const owner = this.seatOwner(seat);
      return owner && owner !== uid;
    });
    if (busy) return { type: "deny", reason: "busy", seat: busy, uid };
    return null;
  }

  canManage(uid) {
    const mode = this.room.controlMode || "anyone";
    if (mode === "anyone") return true;
    if (mode === "manager") return uid === (this.seatOwner(this.room.managerSeat || 1) || this.room.managerUid || this.room.owner);
    return uid === this.seatOwner((this.room.lead || 0) + 1);
  }

  async persist() {
    this.room.updatedAt = Date.now();
    await this.ctx.storage.put("room", this.room);
    await this.ctx.storage.setAlarm(this.room.updatedAt + ROOM_TTL_MS);
  }

  async webSocketMessage(ws, raw) {
    await this.ready;
    let message;
    try { message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch (_) { return; }
    if (!message || typeof message !== "object") return;
    const uid = String(message.uid || message.from || "").slice(0, 80);
    const attachment = ws.deserializeAttachment() || { uid: "", viewer: false };
    if (uid && attachment.uid !== uid) {
      attachment.uid = uid;
      ws.serializeAttachment(attachment);
    }

    if (message.type === "create") {
      const open = cleanSeats(message.open);
      if (!open.length) return this.send(ws, { type: "deny", reason: "none", seat: 1, uid });
      if (this.room.created && this.room.owner !== uid) {
        this.send(ws, { type: "exists", uid });
        return;
      }
      if (!this.room.created) {
        this.room = emptyRoom();
        this.room.created = true;
        this.room.owner = uid;
        this.room.managerUid = uid;
        this.room.managerSeat = Math.max(1, Math.min(MAX_SEATS, Number(message.managerSeat) || 1));
        this.room.controlMode = ["anyone", "lead", "manager"].includes(message.controlMode) ? message.controlMode : "anyone";
        this.room.open = open;
        this.room.lead = open[0] - 1;
        this.room.turn = this.room.lead;
        await this.persist();
      }
      this.send(ws, { type: "created", uid, open: this.room.open });
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "hello") {
      this.send(ws, this.stateMessage());
      return;
    }

    if (!this.room.created) {
      this.send(ws, { type: "missing", uid });
      return;
    }

    if (message.type === "viewer") {
      attachment.viewer = true;
      ws.serializeAttachment(attachment);
      this.send(ws, this.stateMessage());
      return;
    }

    if (message.type === "claim") {
      const seats = cleanSeats(message.seats);
      const denied = this.validateSeats(seats, uid);
      if (denied) return this.send(ws, denied);
      attachment.uid = uid;
      attachment.seats = seats;
      ws.serializeAttachment(attachment);
      this.send(ws, { type: "ok", uid, seats });
      return;
    }

    if (message.type === "snap" && message.data) {
      const data = message.data;
      const seat = Number(data.seat);
      const denied = this.validateSeats([seat], uid || data.uid);
      if (denied) return this.send(ws, denied);
      data.uid = uid || String(data.uid || "").slice(0, 80);
      data.seat = seat;
      data.t = Date.now();
      this.room.board[String(seat - 1)] = data;
      if (seat === (this.room.managerSeat || 1)) this.room.managerUid = data.uid;
      if (data.dice && !data.dice.rolling && data.dice.eventId) {
        this.room.diceHistory = this.room.diceHistory || [];
        const eventKey = data.uid + ":" + data.dice.eventId;
        if (!this.room.diceHistory.some((item) => item.key === eventKey)) {
          this.room.diceHistory.push({ key: eventKey, uid: data.uid, seat, name: data.name || "조사자", dice: data.dice, t: data.t });
          if (this.room.diceHistory.length > 100) this.room.diceHistory.splice(0, this.room.diceHistory.length - 100);
        }
      }
      await this.persist();
      this.send(ws, { type: "ok", uid: data.uid, seats: [seat] });
      this.broadcast({ type: "snap", data });
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "leave") {
      const seats = cleanSeats(message.seats);
      Object.keys(this.room.board).forEach((key) => {
        const player = this.room.board[key];
        const seat = Number(key) + 1;
        if ((uid && player && player.uid === uid) || seats.includes(seat)) delete this.room.board[key];
      });
      await this.persist();
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "lead") {
      if (!this.canManage(uid)) return this.send(ws, { type: "deny", reason: "permission", action: "lead", uid });
      this.room.lead = Math.max(0, Math.min(MAX_SEATS - 1, Number(message.seat) || 0));
      this.room.turn = Math.max(0, Math.min(MAX_SEATS - 1, Number(message.turn) || 0));
      await this.persist();
      this.broadcast({ type: "lead", seat: this.room.lead, turn: this.room.turn });
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "swap") {
      if (!this.canManage(uid)) return this.send(ws, { type: "deny", reason: "permission", action: "swap", uid });
      const a = Number(message.a), b = Number(message.b);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < MAX_SEATS && b < MAX_SEATS && a !== b) {
        const first = this.room.board[String(a)];
        const second = this.room.board[String(b)];
        if (second) { second.seat = a + 1; this.room.board[String(a)] = second; } else delete this.room.board[String(a)];
        if (first) { first.seat = b + 1; this.room.board[String(b)] = first; } else delete this.room.board[String(b)];
        if (this.room.lead === a) this.room.lead = b; else if (this.room.lead === b) this.room.lead = a;
        if (this.room.turn === a) this.room.turn = b; else if (this.room.turn === b) this.room.turn = a;
        if (this.room.managerSeat === a + 1) this.room.managerSeat = b + 1; else if (this.room.managerSeat === b + 1) this.room.managerSeat = a + 1;
        await this.persist();
      }
      this.broadcast(message);
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "boardEdit") {
      if (!this.canManage(uid)) return this.send(ws, { type: "deny", reason: "permission", action: "boardEdit", uid });
      this.broadcast(message, ws);
      return;
    }

    if (message.type === "mystery") {
      if (!this.canManage(uid)) return this.send(ws, { type: "deny", reason: "permission", action: "mystery", uid });
      this.room.mystery = String(message.value || "").slice(0, 1200);
      await this.persist();
      this.broadcast(this.stateMessage());
      return;
    }

    if (message.type === "roomConfig") {
      if (uid !== (this.seatOwner(this.room.managerSeat || 1) || this.room.managerUid || this.room.owner)) return this.send(ws, { type: "deny", reason: "permission", action: "roomConfig", uid });
      if (["anyone", "lead", "manager"].includes(message.controlMode)) this.room.controlMode = message.controlMode;
      this.room.managerSeat = Math.max(1, Math.min(MAX_SEATS, Number(message.managerSeat) || this.room.managerSeat || 1));
      const nextManager = this.seatOwner(this.room.managerSeat);
      if (nextManager) this.room.managerUid = nextManager;
      await this.persist();
      this.broadcast(this.stateMessage());
      return;
    }
  }

  async alarm() {
    await this.ready;
    const idleFor = Date.now() - (this.room.updatedAt || 0);
    if (idleFor < ROOM_TTL_MS) {
      await this.ctx.storage.setAlarm(Date.now() + (ROOM_TTL_MS - idleFor));
      return;
    }
    this.ctx.getWebSockets().forEach((socket) => {
      try { socket.close(1001, "room expired"); } catch (_) {}
    });
    await this.ctx.storage.deleteAll();
    this.room = emptyRoom();
  }
}
