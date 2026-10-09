// A practice app for developing the web reader: a library desk. Not part of
// the sealed benchmark; written by the memory team, so never used to measure.
//   node server.mjs [port]
import http from "node:http"

const port = Number(process.argv[2] ?? 5190)
const TOKEN = "practice"
let state

const seed = () => ({
  books: [
    { id: 101, title: "The Quiet Harbor", status: "in" },
    { id: 102, title: "Maps of the North", status: "in" },
    { id: 103, title: "Small Engines", status: "in" },
    { id: 104, title: "A Year of Soups", status: "in" },
    { id: 105, title: "Glass and Iron", status: "out" },
    { id: 106, title: "Winter Gardens", status: "out" }
  ],
  members: [
    { id: 7, name: "Ines Varga", overdue: false },
    { id: 8, name: "Tomas Reed", overdue: true },
    { id: 9, name: "Lena Ortiz", overdue: false }
  ],
  loans: [{ id: 501, book: 105, member: 9, renewed: 0, sms: false, fees: 0 }, { id: 502, book: 106, member: 7, renewed: 0, sms: false, fees: 0 }],
  log: []
})
state = seed()

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>
<nav aria-label="Main"><a href="/">Desk</a> <a href="/books">Books</a> <a href="/members">Members</a> <a href="/loans">Loans</a></nav>
<main><h1>${title}</h1>${body}</main></body></html>`

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

const form = (req) => new Promise((resolve) => {
  let b = ""
  req.on("data", (d) => (b += d))
  req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(b))))
})

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  const send = (code, html) => { res.writeHead(code, { "content-type": "text/html" }); res.end(html) }
  const redirect = (to) => { res.writeHead(303, { location: to }); res.end() }
  if (url.pathname === "/__admin/reset" && url.searchParams.get("token") === TOKEN) { state = seed(); res.end("ok"); return }
  if (url.pathname === "/__admin/state" && url.searchParams.get("token") === TOKEN) { res.end(JSON.stringify(state)); return }
  if (url.pathname === "/") return send(200, page("Front desk", "<p>Welcome to the desk.</p>"))
  if (url.pathname === "/books") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase()
    const rows = state.books.filter((b) => b.title.toLowerCase().includes(q)).map((b) => `<li><a href="/books/${b.id}">${esc(b.title)}</a> (${b.status === "in" ? "on shelf" : "on loan"})</li>`).join("")
    return send(200, page("Books", `<form role="search" aria-label="Find a book"><label>Title <input name="q" value="${esc(q)}"></label><button>Search</button></form><ul aria-label="Results">${rows}</ul>`))
  }
  const book = /^\/books\/(\d+)$/.exec(url.pathname)
  if (book) {
    const b = state.books.find((x) => x.id === Number(book[1]))
    if (!b) return send(404, page("Not found", ""))
    const err = url.searchParams.get("error")
    const dialog = url.searchParams.get("checkout") === "1"
      ? `<dialog open aria-label="Check out"><form method="post" action="/books/${b.id}/checkout"><label>Member number <input name="member"></label><label>Loan length <select name="weeks"><option value="2">2 weeks</option><option value="4" selected>4 weeks</option></select></label><label><input type="checkbox" name="sms" checked> Send SMS reminder</label><button name="go" value="cancel">Cancel</button> <button name="go" value="ok">Confirm checkout</button></form></dialog>`
      : ""
    return send(200, page(esc(b.title), `${err ? `<p role="alert">${esc(err)}</p>` : ""}<p>Status: ${b.status === "in" ? "on shelf" : "on loan"}</p><section aria-label="Actions"><a href="/books/${b.id}?checkout=1">Check out</a></section>${dialog}`))
  }
  const co = /^\/books\/(\d+)\/checkout$/.exec(url.pathname)
  if (co && req.method === "POST") {
    const f = await form(req)
    const b = state.books.find((x) => x.id === Number(co[1]))
    if (f.go !== "ok") return redirect(`/books/${b.id}`)
    const m = state.members.find((x) => x.id === Number(f.member))
    if (!m) return redirect(`/books/${b.id}?checkout=1&error=${encodeURIComponent("No member with that number.")}`)
    if (m.overdue) return redirect(`/books/${b.id}?error=${encodeURIComponent("This member has an overdue loan and can't borrow until it is returned.")}`)
    b.status = "out"
    state.loans.push({ id: 500 + state.loans.length + 1, book: b.id, member: m.id, renewed: 0, sms: f.sms === "on", weeks: Number(f.weeks ?? 4), fees: 0 })
    return redirect(`/books/${b.id}`)
  }
  if (url.pathname === "/members") {
    const rows = state.members.map((m) => `<tr><td>${m.id}</td><td>${esc(m.name)}</td></tr>`).join("")
    return send(200, page("Members", `<table aria-label="Members"><tr><th>Number</th><th>Name</th></tr>${rows}</table>`))
  }
  if (url.pathname === "/loans") {
    const rows = state.loans.map((l) => {
      const b = state.books.find((x) => x.id === l.book)
      const m = state.members.find((x) => x.id === l.member)
      return `<li>${esc(b.title)} to ${esc(m.name)} <details><summary>More</summary><form method="post" action="/loans/${l.id}/renew"><label><input type="checkbox" name="fee" checked> Charge renewal fee ($1)</label> <button>Renew</button></form></details></li>`
    }).join("")
    return send(200, page("Loans", `<ul aria-label="Open loans">${rows}</ul>`))
  }
  const rn = /^\/loans\/(\d+)\/renew$/.exec(url.pathname)
  if (rn && req.method === "POST") {
    const l = state.loans.find((x) => x.id === Number(rn[1]))
    const f = await form(req)
    if (l) {
      l.renewed++
      if (f.fee === "on") l.fees++
    }
    return redirect("/loans")
  }
  send(404, page("Not found", ""))
}).listen(port)
