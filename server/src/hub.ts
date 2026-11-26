/**
 * In-process pub/sub hub bridging the slideshow engine, the WebSocket layer and the
 * REST routes. Displays subscribe to {@link FrameEvent}s; controllers publish
 * {@link ControlMessage}s.
 */

import { EventEmitter } from 'node:events';
import type { FrameEvent } from '@4kframe/shared';

class FrameHub extends EventEmitter {
  /** Broadcast an event to all connected displays/controllers. */
  emitEvent(event: FrameEvent): void {
    // Serialize lazily once per emission, not once per connected socket.
    let serialized: string | undefined;
    this.emit('event', event, () => serialized ??= JSON.stringify(event));
  }

  onEvent(listener: (event: FrameEvent, serialize: () => string) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const hub = new FrameHub();
