import { DB, Op } from './crdt.ts'

const db = new DB()

type Client = { ws: WebSocket; peer: number }
const clients: (Client | null)[] = [null]

const encode_clients = () => clients.map(c => c && c.peer).filter(Boolean) as number[]

export type Msg =
  | { ping: number }
  | { pong: number }
  | { join: number }
  | { leave: number }
  | { clients: number[], peer: number }
  | { snapshot: ReturnType<DB['snapshot']> }
  | { update: Op[] }
  | { error: string }

const emit = function (ws: WebSocket, obj: Msg) {
  ws.send(JSON.stringify(obj))
}

const broadcast = function (obj: Msg, { exclude }: { exclude?: number } = {}) {
  const message = JSON.stringify(obj)
  clients.forEach(c => { if (c && c.peer && c.peer !== exclude) c.ws.send(message) })
}

const onopen = function (this: WebSocket) {
  const peer = clients.length
  broadcast({ join: peer })

  clients.push({ ws: this, peer })
  this.onclose = onclose
  this.onmessage = onmessage

  emit(this, { peer, clients: encode_clients() })
  emit(this, { snapshot: db.snapshot() })
}

const onmessage = function (this: WebSocket, ev: MessageEvent) {
  // console.log('>>', ev.data)

  const client = clients.find((c) => c && c.ws === this)
  if (client == null) {
    console.warn('got message from disposed client, wtf!?')
    return emit(this, { error: 'disconnected' })
  }

  if (ev.data && typeof ev.data === 'string') {
    let msg: Msg | undefined
    try { msg = JSON.parse(ev.data) }
    catch (err) {
      console.warn(err + '')
      console.warn('The above error occurs on decoding', ev.data)
      emit(this, { error: 'failed to parse message' })
    }

    if (msg && 'ping' in msg) {
      return emit(this, { pong: msg.ping })
    }

    if (msg && 'update' in msg) {
      msg.update.forEach(op => db.apply(op, client.peer))
      return broadcast(msg, { exclude: client.peer })
    }
  }

  // Unknown message
  emit(this, { error: 'unknown message' })
}

const onclose = function (this: WebSocket) {
  this.onclose = null
  const index = clients.findIndex((c) => c && c.ws === this)
  if (index >= 0) {
    const { peer } = clients[index]!
    delete clients[index]

    broadcast({ leave: peer })
  }
}

Deno.serve({ port: 3000 }, function handler(req) {
  if (req.headers.get('upgrade') != 'websocket') {
    return new Response(null, { status: 501 })
  }

  const { socket, response } = Deno.upgradeWebSocket(req, { protocol: 'json' })
  socket.onopen = onopen

  return response
})
