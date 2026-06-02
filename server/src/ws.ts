/**
 * WebSocket control & event channel (`/ws`).
 *
 * Displays connect to receive {@link FrameEvent}s in real time (replacing the
 * original `checkPeriod` polling). Controllers (admin, cast senders) send
 * {@link ControlMessage}s to drive the frame.
 */

import type { FastifyInstance } from 'fastify';
import type { ControlMessage, FrameEvent } from '@4kframe/shared';
import { hub } from './hub.js';
import { getConfig, setConfig } from './store.js';
import { cast, next, previous, progress, getCurrent, refresh, setPaused } from './slideshow.js';
import * as auth from './auth.js';

export async function registerWs(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const authed = auth.isAuthed(req.headers.cookie);
    const send = (event: FrameEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Bridge hub events to this client.
    const off = hub.onEvent(send);

    // Send current state on connect.
    send({ type: 'config', config: getConfig() });
    const current = getCurrent();
    if (current.length) send({ type: 'show', items: current, interactive: false });

    socket.on('message', async (raw: Buffer) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (auth.authRequired() && !authed) return;

      switch (msg.type) {
        case 'progress': progress(); break;
        case 'next': next(); break;
        case 'previous': previous(); break;
        case 'pause': setPaused(true); break;
        case 'resume': setPaused(false); break;
        case 'cast': await cast(msg.id); break;
        case 'config': {
          // Accept either a typed partial or the loose string payload.
          const cfg = getConfig();
          const updated = { ...cfg, ...(msg.patch as object) };
          await setConfig(updated as typeof cfg);
          refresh();
          hub.emitEvent({ type: 'config', config: getConfig() });
          break;
        }
      }
    });

    socket.on('close', off);
  });
}
