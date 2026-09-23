// Zero-dependency upload server: files are streamed via PUT /api/upload?path=<relative path>.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, "uploads");
fs.mkdirSync(ROOT, { recursive: true });

function safePath(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const full = path.resolve(ROOT, clean);
  if (!clean || (full !== ROOT && !full.startsWith(ROOT + path.sep))) return null;
  return full;
}

function listFiles(dir, base = "") {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(path.join(dir, e.name), rel));
    else out.push({ path: rel, size: fs.statSync(path.join(dir, e.name)).size });
  }
  return out;
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    return json(res, 200, listFiles(ROOT));
  }

  if (req.method === "PUT" && url.pathname === "/api/upload") {
    const target = safePath(url.searchParams.get("path"));
    if (!target) return json(res, 400, { error: "Некорректный путь" });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(target);
    req.pipe(out);
    out.on("finish", () => json(res, 200, { ok: true }));
    out.on("error", (err) => json(res, 500, { error: err.message }));
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/files") {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Upload server on :${PORT}`));
