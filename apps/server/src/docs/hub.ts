import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { WebSocket, WebSocketServer } from 'ws';
import { isSameOrigin } from '../api/http.ts';
import type { Kernel } from '../app.ts';
import { addActivity } from '../attention/activity.ts';
import { authenticate } from '../core/auth.ts';
import { canAccessFile, getFile } from '../core/files.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import type { Ctx } from '../ctx.ts';
import { accessOf, canWrite, emitDocChanged, getDoc, reindex, type DocRow } from './access.ts';
import { FIELD, fragmentToPlain, mentionedUsers } from './markdown.ts';

/**
 * Live canvases. Each open canvas is a Yjs document held in memory while
 * anyone has it open (or an API call is editing it). Browsers connect over the
 * y-websocket protocol at `/canvas/<id>`: sync step 1/2 and updates carry the
 * document, awareness carries cursors and names. Every update is stored as it
 * arrives; the stored updates are merged into one when they pile up, and a
 * version is kept at most every few minutes of editing.
 *
 * With several processes, people editing one canvas may be connected to
 * different ones: each process stores the updates it receives and passes them,
 * and cursor changes, to the others, which apply them to their copy of the
 * document if they have it open. Compaction merges what is stored, never just
 * one process's copy.
 *
 * Read-only viewers receive updates but anything they send is dropped.
 * Sockets closed for good use 44xx codes (4403 access removed, 4404 deleted),
 * which the y-websocket client treats as final and does not retry.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const COMPACT_AFTER = 200;
const FLUSH_MS = 600;
const VERSION_EVERY_S = Number(process.env.CANVAS_VERSION_EVERY_S ?? 300);
const IDLE_UNLOAD_MS = 60_000;

interface Connection {
  socket: WebSocket;
  userId: string;
  awarenessIds: Set<number>;
}

interface Room {
  id: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<Connection>;
  pending: number;
  flushTimer: NodeJS.Timeout | null;
  unloadTimer: NodeJS.Timeout | null;
  lastEditor: string;
  /** Everyone who changed the canvas since the last flush. */
  editors: Set<string>;
  changedSinceVersion: boolean;
}

/** Who made a change: a socket connection, a user id for API edits, or another process. */
type Origin = Connection | { api: string } | 'load' | 'remote';

export class CanvasHub {
  private readonly ctx: Ctx;
  private readonly rooms = new Map<string, Room>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  install(kernel: Kernel): void {
    kernel.upgrades.push(this.handleUpgrade);
    kernel.onClose.push(() => this.close());
    const { instances } = this.ctx;
    instances.on('canvas.update', (body) => {
      const { doc, update } = body as { doc: string; update: string };
      const room = this.rooms.get(doc);
      if (room) Y.applyUpdate(room.doc, Buffer.from(update, 'base64'), 'remote');
    });
    instances.on('canvas.awareness', (body) => {
      const { doc, update } = body as { doc: string; update: string };
      const room = this.rooms.get(doc);
      if (room) awarenessProtocol.applyAwarenessUpdate(room.awareness, Buffer.from(update, 'base64'), 'remote');
    });
    instances.on('canvas.drop', (body) => this.drop((body as { doc: string }).doc, false));
    instances.on('canvas.recheck', (body) => this.recheck((body as { doc: string }).doc, false));
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────

  /** The live document for a canvas, loading it from storage if needed. */
  room(id: string): Room {
    let room = this.rooms.get(id);
    if (room) {
      if (room.unloadTimer) clearTimeout(room.unloadTimer);
      room.unloadTimer = null;
      return room;
    }
    const doc = new Y.Doc({ gc: true });
    const rows = this.ctx.db.all<{ data: Uint8Array }>('SELECT data FROM canvas_updates WHERE doc_id = ? ORDER BY id', id);
    if (rows.length) {
      doc.transact(() => {
        for (const row of rows) Y.applyUpdate(doc, row.data, 'load');
      }, 'load');
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    room = { id, doc, awareness, connections: new Set(), pending: rows.length, flushTimer: null, unloadTimer: null, lastEditor: '', editors: new Set(), changedSinceVersion: false };
    const current = room;
    doc.on('update', (update: Uint8Array, origin: Origin) => this.onUpdate(current, update, origin));
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (origin && typeof origin === 'object' && 'awarenessIds' in origin) {
        const connection = origin as Connection;
        for (const id of added) connection.awarenessIds.add(id);
        for (const id of removed) connection.awarenessIds.delete(id);
      }
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      this.broadcast(current, encoding.toUint8Array(encoder), null);
      if (origin !== 'remote') this.ctx.instances.publish('canvas.awareness', { doc: id, update: Buffer.from(update).toString('base64') });
    });
    this.rooms.set(id, room);
    this.scheduleUnload(room);
    return room;
  }

  /** Apply a change made through the API (Markdown edits, version restore) as `userId`. */
  edit(id: string, userId: string, change: (fragment: Y.XmlFragment, doc: Y.Doc) => void): void {
    const room = this.room(id);
    room.doc.transact(() => change(room.doc.getXmlFragment(FIELD), room.doc), { api: userId });
    this.flush(room);
  }

  fragment(id: string): Y.XmlFragment {
    return this.room(id).doc.getXmlFragment(FIELD);
  }

  /** Forget a deleted canvas: close its sockets and drop it from memory, in every process. */
  drop(id: string, everywhere = true): void {
    if (everywhere) this.ctx.instances.publish('canvas.drop', { doc: id });
    const room = this.rooms.get(id);
    if (!room) return;
    for (const connection of room.connections) connection.socket.close(4404, 'canvas deleted');
    this.unload(room);
  }

  /** Re-check open connections after access changed, in every process; close those that may no longer open the canvas. */
  recheck(id: string, everywhere = true): void {
    if (everywhere) this.ctx.instances.publish('canvas.recheck', { doc: id });
    const room = this.rooms.get(id);
    const doc = getDoc(this.ctx, id, 'canvas');
    if (!room) return;
    for (const connection of room.connections) {
      if (!doc || !accessOf(this.ctx, doc, connection.userId)) connection.socket.close(4403, 'access removed');
    }
  }

  private onUpdate(room: Room, update: Uint8Array, origin: Origin): void {
    if (origin === 'load') return;
    if (origin === 'remote') {
      // Stored and flushed by the process that received it; only pass it to the people connected here.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(room, encoding.toUint8Array(encoder), null);
      return;
    }
    this.ctx.instances.publish('canvas.update', { doc: room.id, update: Buffer.from(update).toString('base64') });
    const userId = typeof origin === 'object' && 'api' in origin ? origin.api : (origin as Connection).userId;
    this.ctx.db.run('INSERT INTO canvas_updates (doc_id, data, user_id, created) VALUES (?, ?, ?, ?)', room.id, update, userId, nowSeconds());
    room.pending += 1;
    room.lastEditor = userId;
    room.editors.add(userId);
    room.changedSinceVersion = true;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(room, encoding.toUint8Array(encoder), typeof origin === 'object' && 'socket' in origin ? origin : null);
    if (room.flushTimer) clearTimeout(room.flushTimer);
    room.flushTimer = setTimeout(() => this.flush(room), FLUSH_MS);
    room.flushTimer.unref();
  }

  /**
   * After a burst of edits: refresh the searchable text, tell people newly
   * mentioned, keep a version now and then, compact stored updates, and let
   * everyone with access know the canvas changed.
   */
  flush(room: Room): void {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    room.flushTimer = null;
    const doc = getDoc(this.ctx, room.id, 'canvas');
    if (!doc) return;
    const fragment = room.doc.getXmlFragment(FIELD);
    const plain = fragmentToPlain(fragment).slice(0, 200_000);
    const editor = room.lastEditor || doc.updated_by;
    this.ctx.db.run('UPDATE docs SET plain = ?, updated = ?, updated_by = ? WHERE id = ?', plain, nowSeconds(), editor, doc.id);
    reindex(this.ctx, doc.id);

    for (const userId of mentionedUsers(fragment)) {
      if (userId === editor) continue;
      const fresh = this.ctx.db.run('INSERT OR IGNORE INTO canvas_mentions (doc_id, user_id) VALUES (?, ?)', doc.id, userId).changes;
      if (fresh && accessOf(this.ctx, doc, userId)) {
        addActivity(this.ctx, userId, { kind: 'canvas_mention', channel: doc.id, ts: '0', actor: editor });
      }
    }

    this.trackImages(doc.id, fragment, [...room.editors]);
    room.editors.clear();

    if (room.changedSinceVersion) {
      const last = this.ctx.db.get<{ created: number }>('SELECT max(created) AS created FROM canvas_versions WHERE doc_id = ?', doc.id);
      if (!last?.created || nowSeconds() - last.created >= VERSION_EVERY_S) this.saveVersion(doc.id, editor, '');
    }

    if (room.pending > COMPACT_AFTER) this.compact(room);
    emitDocChanged(this.ctx, { ...doc, plain }, 'content', { updated_by: editor });
  }

  /**
   * Remember which uploaded files the canvas shows, so its readers may load
   * them. A file counts only once everyone who just edited could read it
   * already: pasting a link to someone else's file grants nothing.
   */
  private trackImages(docId: string, fragment: Y.XmlFragment, editors: string[]): void {
    const ids = new Set<string>();
    const visit = (node: Y.XmlElement | Y.XmlFragment): void => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === 'image') {
          const match = /\/files-(?:pri|tmb)\/[A-Z0-9]+-(F[A-Z0-9]+)\//.exec(String(child.getAttribute('src') ?? ''));
          if (match) ids.add(match[1]!);
        } else visit(child);
      }
    };
    visit(fragment);
    const known = new Set(this.ctx.db.all<{ file_id: string }>('SELECT file_id FROM doc_files WHERE doc_id = ?', docId).map((row) => row.file_id));
    for (const id of known) if (!ids.has(id)) this.ctx.db.run('DELETE FROM doc_files WHERE doc_id = ? AND file_id = ?', docId, id);
    for (const id of ids) {
      if (known.has(id)) continue;
      const file = getFile(this.ctx, id);
      if (!file || !editors.length || !editors.every((userId) => canAccessFile(this.ctx, file, userId))) continue;
      this.ctx.db.run('INSERT OR IGNORE INTO doc_files (doc_id, file_id) VALUES (?, ?)', docId, id);
    }
  }

  /** Keep the current state as a version people can look at and restore. */
  saveVersion(id: string, userId: string, label: string): string {
    const room = this.room(id);
    const doc = getDoc(this.ctx, id, 'canvas');
    const versionId = newId('V');
    this.ctx.db.run(
      'INSERT INTO canvas_versions (id, doc_id, title, state, created, created_by, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
      versionId,
      id,
      doc?.title ?? '',
      Y.encodeStateAsUpdate(room.doc),
      nowSeconds(),
      userId,
      label.slice(0, 120),
    );
    room.changedSinceVersion = false;
    return versionId;
  }

  /**
   * Replace the many stored updates with one, keeping the document identical.
   * Built from what is stored, under the write lock: another process may have
   * stored an update this copy has not applied yet.
   */
  compact(room: Room): void {
    this.ctx.db.tx(() => {
      const rows = this.ctx.db.all<{ id: number; data: Uint8Array }>('SELECT id, data FROM canvas_updates WHERE doc_id = ? ORDER BY id', room.id);
      if (rows.length < 2) return;
      const doc = new Y.Doc({ gc: true });
      doc.transact(() => {
        for (const row of rows) Y.applyUpdate(doc, row.data);
      });
      const merged = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      this.ctx.db.run('DELETE FROM canvas_updates WHERE doc_id = ? AND id <= ?', room.id, rows.at(-1)!.id);
      this.ctx.db.run('INSERT INTO canvas_updates (doc_id, data, user_id, created) VALUES (?, ?, ?, ?)', room.id, merged, room.lastEditor, nowSeconds());
    });
    room.pending = 1;
  }

  private scheduleUnload(room: Room): void {
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.unloadTimer = setTimeout(() => {
      if (room.connections.size === 0) this.unload(room);
    }, IDLE_UNLOAD_MS);
    room.unloadTimer.unref();
  }

  private unload(room: Room): void {
    if (room.flushTimer) this.flush(room);
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(room.id);
  }

  private close(): void {
    for (const room of [...this.rooms.values()]) {
      for (const connection of room.connections) connection.socket.terminate();
      this.unload(room);
    }
    this.wss.close();
  }

  // ── Sockets ───────────────────────────────────────────────────────────────

  private handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    const match = /^\/canvas\/([A-Z0-9]+)$/.exec(url.pathname);
    if (!match) return false;
    const { actor } = authenticate(this.ctx, req, undefined);
    const doc = getDoc(this.ctx, match[1], 'canvas');
    if (!isSameOrigin(req) || !actor || actor.kind !== 'session' || !doc || !accessOf(this.ctx, doc, actor.userId)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, doc, actor.userId));
    return true;
  };

  private accept(socket: WebSocket, doc: DocRow, userId: string): void {
    socket.binaryType = 'arraybuffer';
    const room = this.room(doc.id);
    const connection: Connection = { socket, userId, awarenessIds: new Set() };
    room.connections.add(connection);

    socket.on('message', (data: ArrayBuffer | Buffer) => {
      try {
        this.receive(room, connection, new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      } catch (error) {
        console.error('[canvas] bad message', error);
      }
    });
    const closed = (): void => {
      if (!room.connections.delete(connection)) return;
      awarenessProtocol.removeAwarenessStates(room.awareness, [...connection.awarenessIds], null);
      if (room.connections.size === 0) {
        if (room.flushTimer) this.flush(room);
        this.scheduleUnload(room);
      }
    };
    socket.on('close', closed);
    socket.on('error', closed);

    // Start the sync: our state vector, then everyone's cursors.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    this.send(connection, encoding.toUint8Array(encoder));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      this.send(connection, encoding.toUint8Array(aw));
    }
  }

  private receive(room: Room, connection: Connection, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const step = decoding.peekVarUint(decoder);
      if (step === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection);
      } else {
        // Step 2 and updates change the document: only for people who may edit.
        const doc = getDoc(this.ctx, room.id, 'canvas');
        if (!doc || !canWrite(accessOf(this.ctx, doc, connection.userId))) return;
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection);
      }
      if (encoding.length(encoder) > 1) this.send(connection, encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), connection);
    } else if (type === MESSAGE_QUERY_AWARENESS) {
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
      this.send(connection, encoding.toUint8Array(encoder));
    }
  }

  private send(connection: Connection, data: Uint8Array): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(data, (error) => {
      if (error) connection.socket.terminate();
    });
  }

  private broadcast(room: Room, data: Uint8Array, except: Connection | null): void {
    for (const connection of room.connections) if (connection !== except) this.send(connection, data);
  }

  /** How many people have a canvas open right now (for tests and the API). */
  viewers(id: string): number {
    return this.rooms.get(id)?.connections.size ?? 0;
  }
}
