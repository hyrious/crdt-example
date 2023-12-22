// Shared CRDT core in both server and client, which is a last-write-wins map of maps.
// i.e. { [id]: { [key]: value } }

export type Value = unknown
export type Clock = { peer: number, timestamp: number }

export type Op = { id: string, key: string, value: Value } & Clock
export type Field = { value: Value } & Clock
export type Observer = (ev: { op: Op, origin: unknown, oldValue?: Value }) => void

export const local = 0

export class DB {
  onpeer?: (peer: number) => void

  _peer = 0
  _rows = new Map<string, Map<string, Field>>()
  _observers = new Set<Observer>()

  get peer() { return this._peer }
  set peer(peer: number) { this._peer = peer; this.onpeer && this.onpeer(peer) }

  get connected() { return this._peer !== 0 }

  get ids() { return this._rows.keys() }

  iter(id: string) { return this._rows.get(id) }

  get(id: string, key: string) {
    const row = this._rows.get(id)
    const field = row && row.get(key)
    return field && field.value
  }

  set(id: string, key: string, value: Value = null) {
    const op: Op = { id, key, value, peer: this._peer, timestamp: Date.now() }
    const row = this._rows.get(id)
    const field = row && row.get(key)
    if (field) {
      op.timestamp = Math.max(op.timestamp, field.timestamp + 1)
    }
    this.apply(op, local)
  }

  // Server: db.afterApply(({ op, origin }) => { broadcast(op, { exclude: origin }) })
  //         db.apply(op, op.peer)
  // Client: db.afterApply(({ op, origin }) => { if (origin == local) send(op) })
  //         db.apply(op, remote)
  apply(op: Op, origin: unknown) {
    let row = this._rows.get(op.id)
    if (row == null) {
      row = new Map
      this._rows.set(op.id, row)
    }
    const field = row.get(op.key)
    if (!field || field.timestamp < op.timestamp || (field.timestamp === op.timestamp && field.peer < op.peer)) {
      row.set(op.key, { value: op.value, peer: op.peer, timestamp: op.timestamp })
    }
    for (const observer of this._observers) {
      observer({ op, origin, oldValue: field && field.value })
    }
  }

  afterApply(observer: Observer): () => void {
    this._observers.add(observer)
    return () => this._observers.delete(observer)
  }

  snapshot() {
    const snapshot: { [id: string]: { [key: string]: Field } } = Object.create(null)
    this._rows.forEach((row, id) => {
      const raw = snapshot[id] = Object.create(null)
      row.forEach((field, key) => { raw[key] = field })
    })
    return snapshot
  }
}

export interface UndoRedoOptions {
  filter?: (op: Op) => boolean | undefined
}

export type UndoRedoOp = { id: string, key: string, value: Value }

export class UndoRedo {
  undoHistory: UndoRedoOp[][] = []
  redoHistory: UndoRedoOp[][] = []

  _isBusy = false
  _pending: UndoRedoOp[] = []
  _depth = 0

  dispose: () => void

  constructor(readonly db: DB, { filter }: UndoRedoOptions = {}) {
    this.dispose = db.afterApply(({ op, origin, oldValue }) => {
      if (origin === local && !this._isBusy && (!filter || filter(op))) {
        this._pending.push({ id: op.id, key: op.key, value: oldValue })
        this._commit()
      }
    })
  }

  batch(callback: () => void) {
    this._depth++
    callback()
    this._depth--
    this._commit()
  }

  undo() {
    const top = this.undoHistory.pop()
    if (top) this.redoHistory.push(this._apply(top))
  }

  redo() {
    const top = this.redoHistory.pop()
    if (top) this.undoHistory.push(this._apply(top))
  }

  _commit() {
    if (this._depth === 0) {
      this.undoHistory.push(this._pending)
      this.redoHistory = []
      this._pending = []
    }
  }

  _apply(changes: UndoRedoOp[]) {
    const modified: UndoRedoOp[] = []
    this._isBusy = true
    for (const { id, key, value } of changes) {
      modified.push({ id, key, value: this.db.get(id, key) })
      this.db.set(id, key, value)
    }
    this._isBusy = false
    return modified.reverse()
  }
}
