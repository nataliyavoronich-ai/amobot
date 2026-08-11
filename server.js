const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const lastRequests = [];
const MAX_STORED = 20;

function storeRequest(req) {
  lastRequests.unshift({
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    query: req.query,
    body: req.body,
  });
  if (lastRequests.length > MAX_STORED) {
    lastRequests.pop();
  }
}

app.get("/", (req, res) => {
  res.send("OK. Сервер бота запущен и работает.");
});

app.post("/webhook/amomessenger", (req, res) => {
  console.log("=== Получен запрос от amoMessenger ===");
  console.log(JSON.stringify(req.body, null, 2));

  storeRequest(req);

  res.status(200).json({ ok: true, received: true });
});

app.get("/debug/last", (req, res) => {
  res.json(lastRequests);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
