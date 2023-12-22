/// <reference lib="dom" />
import { DB, local } from './crdt.ts';
import { ping$, websocket } from "./lib/socket.ts";
import { clients$ } from './lib/clients.ts'

const db = new DB()
websocket(db)

console.time('connect')
// You do not have to wait for the connection, it's totally working offline
db.onpeer = () => { if (db.connected) console.timeEnd('connect') }

Object.assign(window, { db })

const $ = (s: string) => document.getElementById(s)!

ping$.subscribe(ping => { $('ping').textContent = ping + '' })

// Counter: { [random key]: 1 }
{
  const get = () => db.iter('counter')?.size || 0
  db.afterApply(({ op }) => { if (op.id === 'counter') $('counter').textContent = get() + '' })
  $('counter').onclick = () => db.set('counter', Math.random().toString(36).slice(2), 1)
}

// Board: <svg> { [random key]: the "d" of <path> }
{
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', dark.matches ? '#fff' : '#000')
  svg.setAttribute('stroke-width', '2')
  dark.addEventListener('change', ev => svg.setAttribute('stroke', ev.matches ? '#fff' : '#000'))
  $('board').appendChild(svg)

  // init
  db.iter('board')?.forEach((curve, key) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute('d', curve.value as string)
    path.dataset.key = key
    svg.appendChild(path)
  })

  // update
  let pid: string | undefined

  type Point = { readonly x: number; readonly y: number };

  const paths = new Map<string, {
    points: Point[],
    path: SVGPathElement,
    timestamp: number,
  }>()
  const drawn = new Set<string>()

  const read = (ev: PointerEvent): Point => {
    const { left, top } = svg.getBoundingClientRect()
    return { x: (ev.clientX - left) | 0, y: (ev.clientY - top) | 0 }
  }

  const M = ({ x, y }: Point) => `M${x},${y}`;
  const L = ({ x, y }: Point) => `L${x},${y}`;
  const Q = (c: Point, { x, y }: Point) => `Q${c.x},${c.y} ${x},${y}`;
  const mid = (p1: Point, p2: Point): Point => ({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });

  const render = (points: Point[]) => {
    const last = points.length - 1;
    let def = M(points[0]) + L(mid(points[0], points[1]));
    for (let i = 1; i < last; ++i) {
      def += Q(points[i], mid(points[i], points[i + 1]));
    }
    def += L(points[last]);
    return def
  }

  const ondraw = (pid: string, point: Point, timestamp: number) => {
    let item = paths.get(pid)
    if (!item) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      paths.set(pid, item = { points: [], path, timestamp })
      path.dataset.key = pid
      svg.appendChild(path)
    }
    item.points.push(point)
    item.path.setAttribute('d', item.points.length >= 2 ? render(item.points) : '')
    item.timestamp = timestamp
  }

  const ondrawend = (pid: string, _timestamp: number) => {
    const item = paths.get(pid)
    if (!item) return
    if (item.points.length < 2) {
      item.path.remove()
    } else {
      drawn.add(pid)
      db.set('board', pid, item.path.getAttribute('d'))
    }
    paths.delete(pid)
  }

  svg.onpointerdown = ev => {
    if (!ev.isPrimary) return
    svg.setPointerCapture(ev.pointerId)
    pid = Math.random().toString(36).slice(2)
    ondraw(pid, read(ev), ev.timeStamp)
  }

  svg.onpointermove = ev => {
    if (ev.isPrimary && pid) ondraw(pid, read(ev), ev.timeStamp)
  }

  svg.onpointerup = svg.onpointerleave = ev => {
    if (pid) { ondrawend(pid, ev.timeStamp); pid = void 0 }
  }

  db.afterApply(({ op, origin }) => {
    if (op.id !== 'board') return
    const pid = op.key
    const d = op.value as string
    if (drawn.has(pid)) return
    drawn.add(pid)
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute('d', d)
    path.dataset.key = pid
    // https://css-tricks.com/svg-line-animation-works/
    if (origin !== 'snapshot') {
      const style = document.createElement('style')
      const length = path.getTotalLength()
      style.textContent = `path[data-key="${pid}"] { stroke-dasharray: ${length}; stroke-dashoffset: ${length}; animation: dash-${pid} ${length / 1000}s linear forwards; }
      @keyframes dash-${pid} { to { stroke-dashoffset: 0; } }`
      document.head.appendChild(style)
      setTimeout(() => style.remove(), 1001)
    }
    svg.appendChild(path)
  })
}

// Todo: { `todo-[random key]`: { text, pos, done } }
{
  // https://madebyevan.com/algos/crdt-fractional-indexing/
  const insert = (before: string, after: string): string => {
    const minDigit = '0'.charCodeAt(0)
    const maxDigit = '9'.charCodeAt(0)

    let foundDifference = false
    let result = ''
    let i = 0

    while (true) {
      const digitBefore = i < before.length ? before.charCodeAt(i) : minDigit
      const digitAfter = !foundDifference && i < after.length ? after.charCodeAt(i) : maxDigit + 1 // exclusive

      const pick = (digitBefore + digitAfter) >>> 1
      result += String.fromCharCode(pick)

      if (pick <= digitBefore) {
        if (digitBefore < digitAfter) {
          foundDifference = true
        }
        i += 1
        continue
      }

      let jitter = Math.floor(Math.random() * 0x1000)
      while (jitter > 0) {
        const base = maxDigit - minDigit + 1
        const mod = jitter % base
        jitter = (jitter - mod) / base
        result += String.fromCharCode(minDigit + mod)
      }
      return result
    }
  }

  const makeSorted = () => {
    const ordered: { id: string, pos: string }[] = []
    for (const id of db.ids) {
      if (id.startsWith('todo-')) {
        const pos = db.get(id, 'pos') as string
        // If pos is null, it means the item is deleted
        if (pos) ordered.push({ id, pos })
      }
    }
    return ordered.sort((a, b) => {
      if (a.pos < b.pos) return -1
      if (a.pos > b.pos) return 1
      if (a.id < b.id) return -1
      if (a.id > b.id) return 1
      return 0
    })
  }

  let sorted = makeSorted()

  // init
  const render = (sorted: { id: string, pos: string }[]) => sorted.forEach(({ id, pos }) => {
    const li = document.createElement('li')
    li.id = id
    li.dataset.pos = pos
    li.innerHTML = `<input type="checkbox"><input type="text"><button>&times;</button>`
    const [checkbox, input] = li.querySelectorAll('input') as unknown as HTMLInputElement[]
    checkbox.onchange = () => db.set(id, 'done', checkbox.checked)
    checkbox.checked = db.get(id, 'done') as boolean
    input.onchange = () => db.set(id, 'text', input.value.trim())
    input.value = db.get(id, 'text') as string
    li.querySelector('button')!.onclick = () => db.set(id, 'pos', null)
    li.draggable = true
    li.ondragstart = (ev) => {
      ev.dataTransfer!.effectAllowed = 'move'
      setTimeout(() => li.classList.add('dragging'))
    }
    li.ondragend = () => li.classList.remove('dragging')
    $('todo-list').appendChild(li)
  })
  render(sorted)

  // update
  const makePos = (at: number) => {
    const prev = at > 0 ? sorted[at - 1].pos : ''
    const next = at < sorted.length ? sorted[at].pos : ''
    return insert(prev, next)
  }

  const input = $('todo-input') as HTMLInputElement
  input.onchange = () => {
    const text = input.value.trim()
    if (text) {
      const id = 'todo-' + Math.random().toString(36).slice(2);
      db.set(id, 'text', text)
      db.set(id, 'pos', makePos(sorted.length))
      db.set(id, 'done', false)
      input.value = ''
    }
  }

  $('todo-list').ondragenter = ev => ev.preventDefault()
  $('todo-list').ondragover = ev => {
    ev.preventDefault()
    const dragging = $('todo-list').querySelector('.dragging')
    if (dragging) {
      const nextSibling = Array.from($('todo-list').querySelectorAll('li')).find(li => {
        const { top, height } = li.getBoundingClientRect()
        return ev.clientY <= top + height / 2
      })
      $('todo-list').insertBefore(dragging, nextSibling || null)
    }
  }
  $('todo-list').ondrop = ev => {
    ev.preventDefault()
    const dragging = $('todo-list').querySelector('.dragging') as HTMLLIElement
    if (dragging) {
      const oldIndex = sorted.findIndex(({ id }) => id === dragging.id)
      const newIndex = Array.from($('todo-list').querySelectorAll('li')).indexOf(dragging)
      if (oldIndex !== newIndex)
        db.set(dragging.id, 'pos', makePos(oldIndex < newIndex ? newIndex + 1 : newIndex))
    }
  }

  db.afterApply(({ op }) => {
    if (op.id.startsWith('todo-')) {
      if (op.key === 'pos') {
        sorted = makeSorted()
        $('todo-list').textContent = ''
        render(sorted)
      } else {
        const li = $(op.id)
        if (li) {
          if (op.key === 'text') {
            (li.querySelector('input')!.nextElementSibling as HTMLInputElement).value = op.value as string
          } else if (op.key === 'done') {
            li.querySelector('input')!.checked = op.value as boolean
          }
        }
      }
    }
  })
}

// Editor: { quill-cursors: { [peer]: data }, quill: { [random key]: op } }
declare const Quill: any
declare const QuillCursors: any
{
  Quill.register("modules/cursors", QuillCursors);
  // from uint8array-extras
  const toUint8Array = (base64: string) => {
    return Uint8Array.from(atob(base64), x => x.codePointAt(0)!)
  }

  const toBase64 = (array: Uint8Array) => {
    if (array.byteLength < 65535) {
      return btoa(String.fromCodePoint.apply(String, array))
    } else {
      let base64 = ''
      for (const a of array) base64 += String.fromCodePoint(a)
      return btoa(base64)
    }
  }

  const connect = (Y: any, doc: any) => {
    db.iter('quill')?.forEach(update => {
      if (update.value) {
        Y.applyUpdate(doc, toUint8Array(update.value as string), 'remote')
      }
    })

    doc.on('update', (update, origin) => {
      if (origin !== 'remote') {
        db.set('quill', Math.random().toString(36).slice(2), toBase64(update))
        if ((db.iter('quill')?.size || 0) > 200) {
          const key = Math.random().toString(36).slice(2)
          const val = toBase64(Y.encodeStateAsUpdate(doc))
          db.set('quill', key, val)
          // Array.from() has copied the keys, so it is safe to iter and delete
          Array.from(db.iter('quill')!.keys()).forEach(k => {
            if (k !== key) db.set('quill', k, null)
          })
        }
      }
    })

    db.afterApply(({ op, origin }) => {
      if (origin !== local && op.id === 'quill' && op.value) {
        Y.applyUpdate(doc, toUint8Array(op.value as string), 'remote')
      }
    })
  }

  const setupEditor = async () => {
    // @ts-ignore
    const Y = await import("https://esm.sh/yjs@13.6.10")
    // @ts-ignore
    const { QuillBinding } = await import("https://esm.sh/y-quill@0.1.5")

    const doc = new Y.Doc()
    const text = doc.getText('quill')
    connect(Y, doc)

    const editor = new Quill($('editor'), {
      modules: {
        cursors: true,
        history: { userOnly: true }
      },
      placeholder: 'Hello, world!',
    })
    const cursors = editor.getModule('cursors')
    const binding = new QuillBinding(text, editor)

    // Cursors: { [peer]: cursor }
    const timers = new Map<string, number>()
    const colors = ["#E02020", "#F7B500", "#6DD400", "#32C5FF",
                    "#0091FF", "#6236FF", "#B620E0", "#6D7278"]
    const refresh_cursors = () => {
      db.iter('quill-cursors')?.forEach(({ value }, peer) => {
        if (+peer === db.peer) {
          return update_cursor(null, peer)
        }
        if (!clients$.value.has(+peer)) {
          Promise.resolve().then(() => {
            if (db.get('quill-cursors', peer))
              db.set('quill-cursors', peer, null)
          })
          return update_cursor(null, peer)
        }
        const user = { name: peer, color: colors[+peer % colors.length] }
        update_cursor({ user, cursor: value as UserCursor }, peer)
      })
    }
    editor.on('editor-change', (_1: unknown, _2: unknown, _3: unknown, origin: string) => {
      const sel = editor.getSelection()
      if (origin === 'silent') return
      const cursor = db.get('quill-cursors', db.peer + '')
      if (sel === null) {
        if (cursor) db.set('quill-cursors', db.peer + '', null)
      } else {
        const anchor = Y.createRelativePositionFromTypeIndex(text, sel.index);
        const head = Y.createRelativePositionFromTypeIndex(text, sel.index + sel.length);
        if (!cursor || JSON.stringify(cursor) !== JSON.stringify({ anchor, head }))
          db.set('quill-cursors', db.peer + '', { anchor, head });
      }
      refresh_cursors()
    })
    db.afterApply(({ op, origin }) => {
      if (origin !== local && op.id === 'quill-cursors') refresh_cursors()
    })
    clients$.subscribe(refresh_cursors)
    type UserInfo = { name?: string; color?: string };
    type UserCursor = { anchor: unknown; head: unknown };
    interface CursorAware {
      user?: UserInfo | null;
      cursor?: UserCursor | null;
    }
    const update_cursor = (aw: CursorAware | null, peer: string) => {
      try {
        if (aw && aw.cursor) {
          const user = aw.user || {}
          const color = user.color || '#ffa500'
          const name = user.name || `User: ${peer}`
          const cursor = cursors.createCursor(peer, name, color);
          const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(aw.cursor.anchor), doc);
          const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(aw.cursor.head), doc);
          if (anchor && head && anchor.type === text) {
            const range = {
              index: anchor.index,
              length: head.index - anchor.index,
            };
            if (
              !cursor.range ||
              range.index !== cursor.range.index ||
              range.length !== cursor.range.length
            ) {
              cursors.moveCursor(peer, range);
              let timer = timers.get(peer) || 0;
              if (timer) clearTimeout(timer);
              cursor.toggleFlag(true);
              timer = setTimeout(() => cursor.toggleFlag(false), 3000);
              timers.set(peer, timer);
            }
          }
        } else {
          cursors.removeCursor(peer)
        }
      } catch (err) {
        console.error(err)
      }
    }
  }

  setupEditor().catch(console.error)
}
