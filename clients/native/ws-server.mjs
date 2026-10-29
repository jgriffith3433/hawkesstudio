// A minimal WebSocket server (RFC 6455) for the native playtest transport: one path, one client, text frames.
// No dependencies, so the reference runner is a single `node` away. Spec: hawkesstudio/docs/playtest.md
// ("The native transport").

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 1024 * 1024; // the spec's 1 MiB per message

export const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One frame with FIN set. Servers send unmasked; pass a 4-byte mask to encode like a client (tests). */
export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = null) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, Buffer.from(mask), masked]);
}

export class ProtocolError extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.code = code;
  }
}

/**
 * Turns bytes into whole messages: unmasks, joins fragments, lets control frames through between fragments.
 * push() returns [{ opcode, payload }] for each complete message or control frame; throws ProtocolError.
 */
export class FrameReader {
  constructor({ maxMessage = MAX_MESSAGE, requireMask = true } = {}) {
    this.maxMessage = maxMessage;
    this.requireMask = requireMask;
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts, size } while a fragmented message is open
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const frame = this.#next();
      if (!frame) return out;
      const msg = this.#assemble(frame);
      if (msg) out.push(msg);
    }
  }

  #next() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    if (b[0] & 0x70) throw new ProtocolError('reserved bits set');
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessage)) throw new ProtocolError('message too big', 1009);
      len = Number(big);
      off = 10;
    }
    if (len > this.maxMessage) throw new ProtocolError('message too big', 1009);
    if (this.requireMask && !masked) throw new ProtocolError('client frames must be masked');
    const maskOff = off;
    if (masked) off += 4;
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (masked) {
      const key = b.subarray(maskOff, maskOff + 4);
      const plain = Buffer.alloc(len);
      for (let i = 0; i < len; i++) plain[i] = payload[i] ^ key[i & 3];
      payload = plain;
    } else {
      payload = Buffer.from(payload);
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  #assemble({ fin, opcode, payload }) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new ProtocolError('bad control frame');
      return { opcode, payload };
    }
    if (opcode === OP.cont) {
      if (!this.fragments) throw new ProtocolError('continuation without a start');
      const f = this.fragments;
      f.parts.push(payload);
      f.size += payload.length;
      if (f.size > this.maxMessage) throw new ProtocolError('message too big', 1009);
      if (!fin) return null;
      this.fragments = null;
      return { opcode: f.opcode, payload: Buffer.concat(f.parts) };
    }
    if (opcode !== OP.text && opcode !== OP.binary) throw new ProtocolError(`unknown opcode ${opcode}`);
    if (this.fragments) throw new ProtocolError('new message inside a fragmented one');
    if (fin) return { opcode, payload };
    this.fragments = { opcode, parts: [payload], size: payload.length };
    return null;
  }
}

/** One accepted client. Events: 'text' (string), 'binary' (Buffer), 'close' ({ code, reason, clean }). */
export class Connection extends EventEmitter {
  constructor(socket, { maxMessage = MAX_MESSAGE, head = null } = {}) {
    super();
    this.socket = socket;
    this.reader = new FrameReader({ maxMessage });
    this.closed = false;
    this.closeSent = false;
    this.closeReceived = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.#finish(this.closeReceived?.code ?? 1006, this.closeReceived?.reason ?? '', !!this.closeReceived));
    // Bytes the client sent right behind its handshake; handled once listeners are attached.
    if (head?.length) queueMicrotask(() => this.#onData(head));
  }

  get open() {
    return !this.closed && !this.closeSent;
  }

  send(text) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(OP.text, Buffer.from(String(text), 'utf8')));
    return true;
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      try { this.socket.write(encodeFrame(OP.close, p)); } catch {}
    }
    // The client answers with its own close frame; don't wait forever for it.
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  #onData(chunk) {
    let msgs;
    try {
      msgs = this.reader.push(chunk);
    } catch (e) {
      this.close(e.code ?? 1002, e.message);
      return;
    }
    for (const m of msgs) {
      if (m.opcode === OP.text) this.emit('text', m.payload.toString('utf8'));
      else if (m.opcode === OP.binary) this.emit('binary', m.payload);
      else if (m.opcode === OP.ping) this.socket.write(encodeFrame(OP.pong, m.payload));
      else if (m.opcode === OP.close) {
        const code = m.payload.length >= 2 ? m.payload.readUInt16BE(0) : 1005;
        this.closeReceived = { code, reason: m.payload.subarray(2).toString('utf8') };
        if (!this.closeSent) {
          this.closeSent = true;
          try { this.socket.write(encodeFrame(OP.close, m.payload.subarray(0, 2))); } catch {}
        }
        this.socket.end();
      }
    }
  }

  #finish(code, reason, clean) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason, clean });
  }
}

/**
 * Listens on host:port (0 = a free port) for exactly one client on `/<token>`. Other paths get 404, a second
 * client 409. onConnection(conn) runs for the one accepted client. Resolves { port, url, close() }.
 */
export function listen({ token, host = '127.0.0.1', port = 0, onConnection, maxMessage = MAX_MESSAGE }) {
  if (!token) throw new Error('listen needs a token');
  let taken = false;
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only\n');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket, head) => {
    const refuse = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== `/${token}`) return refuse(404, 'Not Found');
    if (taken) return refuse(409, 'Conflict');
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
      return refuse(400, 'Bad Request');
    }
    taken = true;
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    onConnection?.(new Connection(socket, { maxMessage, head }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `ws://${host}:${actual}/${token}`,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
