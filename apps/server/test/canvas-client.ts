import { setTimeout as sleep } from 'node:timers/promises';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/** A minimal y-websocket client: what the editor's provider does, without an editor. */
export class CanvasClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly socket: WebSocket;
  readonly synced: Promise<void>;
  readonly closed: Promise<number>;

  constructor(base: string, id: string, cookie: string) {
    this.socket = new WebSocket(`${base.replace('http', 'ws')}/canvas/${id}`, { headers: { cookie } });
    this.socket.binaryType = 'arraybuffer';
    this.closed = new Promise((resolve) => this.socket.once('close', (code) => resolve(code)));
    let markSynced: () => void = () => {};
    let failSync: (error: Error) => void = () => {};
    this.synced = new Promise((resolve, reject) => {
      markSynced = resolve;
      failSync = reject;
    });
    this.socket.once('unexpected-response', (_req, res) => failSync(new Error(`refused: ${res.statusCode}`)));
    this.socket.once('error', (error) => failSync(error));
    this.socket.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    this.socket.on('message', (data: ArrayBuffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
        if (encoding.length(encoder) > 1) this.socket.send(encoding.toUint8Array(encoder));
        if (step === syncProtocol.messageYjsSyncStep2) markSynced();
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
      }
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || this.socket.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'remote' || this.socket.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.socket.send(encoding.toUint8Array(encoder));
    });
  }

  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment('default');
  }

  /** Append a paragraph, the way the editor would write one. */
  addParagraph(text: string): void {
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text);
    paragraph.insert(0, [run]);
    this.fragment.insert(this.fragment.length, [paragraph]);
  }

  text(): string {
    return this.fragment
      .toArray()
      .map((node) => (node instanceof Y.XmlElement ? node.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : '')).join('') : ''))
      .join('\n');
  }

  /** Disconnect; the awareness timer is stopped too so the test process can exit. */
  close(): void {
    this.socket.close();
    this.awareness.destroy();
  }
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error('condition not met in time');
}

