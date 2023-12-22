import { DB, Op, local } from "../crdt.ts";
import { clients_, notify_clients_change } from "./clients.ts";
import { val } from "./val.ts";

export const ws = new WebSocket('ws://localhost:3000', 'json');
ws.binaryType = 'arraybuffer';

export const emit = function (ws: WebSocket, obj: import('../server.ts').Msg) {
  ws.send(JSON.stringify(obj));
};

/** WebSocket.readyState, does not mean the database is connected */
export const readyState$ = val(ws.readyState, set => {
  const update = () => set(ws.readyState);
  ws.addEventListener('open', update);
  ws.addEventListener('close', update);
  ws.addEventListener('error', update);
  return () => {
    ws.removeEventListener('open', update);
    ws.removeEventListener('close', update);
    ws.removeEventListener('error', update);
  };
});

let set_ping: (value: number) => void
export const ping$ = val(0, set => {
  set_ping = set
})

let heartbeat = 0
const ping = () => {
  if (ws.readyState === WebSocket.OPEN) {
    emit(ws, { ping: Date.now() })
  } else {
    clearInterval(heartbeat)
  }
}

readyState$.subscribe(state => {
  if (state === WebSocket.OPEN) {
    clearInterval(heartbeat)
    heartbeat = setInterval(ping, 10_000)
    ping()
  }
})

export const websocket = (db: DB) => {
  ws.addEventListener('message', function (ev) {
    // console.log('>>', ev.data)
    if (ev.data && typeof ev.data === 'string') {
      let msg: import('../server.ts').Msg | undefined;
      try { msg = JSON.parse(ev.data); }
      catch (err) { console.warn(err + ''); console.warn('The above error occurs on decoding', ev.data); }

      if (msg && 'pong' in msg) {
        set_ping(Date.now() - msg.pong)
      }

      let clients_changed = false;
      if (msg && 'join' in msg) {
        clients_.add(msg.join);
        clients_changed = true;
      }
      if (msg && 'leave' in msg) {
        clients_.delete(msg.leave);
        clients_changed = true;
      }
      if (msg && 'clients' in msg) {
        clients_.clear();
        msg.clients.forEach(c => clients_.add(c));
        db.peer = msg.peer;
        clients_changed = true;
      }
      clients_changed && notify_clients_change();

      if (msg && 'snapshot' in msg) {
        for (const id in msg.snapshot) {
          const row = msg.snapshot[id];
          for (const key in row) {
            const field = row[key];
            db.apply({ id, key, ...field }, 'snapshot');
          }
        }
      }

      if (msg && 'update' in msg) {
        msg.update.forEach(op => db.apply(op, 'remote'));
      }

      if (msg && 'error' in msg) {
        console.warn('Server error:', msg.error);
      }
    }
  });

  const pending: Op[] = []
  db.afterApply(({ op, origin }) => {
    if (origin === local) {
      if (db.connected) {
        if (pending.length > 0) {
          pending.forEach(op => { op.peer = db.peer })
          emit(ws, { update: pending })
          pending.length = 0
        }
        emit(ws, { update: [op] })
      }
      else {
        pending.push(op)
      }
    }
  })
}
