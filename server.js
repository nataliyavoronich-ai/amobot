// ============================================================
// Сервер бота: приём вебхуков от amoMessenger + доступ к amoCRM
// ============================================================
// Доступ к amoCRM теперь работает через ДОЛГОСРОЧНЫЙ ТОКЕН
// (взят на странице интеграции в amoCRM, кнопка "Сгенерировать
// токен"), поэтому никакого обмена кодами (OAuth) не нужно.
//
// Обязательные переменные окружения (заданы в Render → Environment):
//   AMOCRM_TOKEN  — долгосрочный токен из amoCRM
//   AMOCRM_DOMAIN — адрес аккаунта, например vashafirma.amocrm.ru
// ============================================================

const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Храним последние 20 полученных от amoMessenger запросов в памяти,
// чтобы можно было посмотреть их прямо в браузере.
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

// -----------------------------------------------------------
// Небольшой помощник для обращений к amoCRM API.
// -----------------------------------------------------------
async function amocrmRequest(pathAndQuery) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_TOKEN;

  if (!domain || !token) {
    throw new Error("Не заданы AMOCRM_DOMAIN или AMOCRM_TOKEN в Environment на Render");
  }

  const response = await fetch(`https://${domain}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const err = new Error(`amoCRM ответила с ошибкой ${response.status}`);
    err.details = data;
    throw err;
  }

  return data;
}

// -----------------------------------------------------------
// Проверка, что сервер вообще жив.
// -----------------------------------------------------------
app.get("/", (req, res) => {
  res.send("OK. Сервер бота запущен и работает.");
});

// -----------------------------------------------------------
// Проверка связи с amoCRM: показывает название и ID аккаунта,
// если токен и домен настроены верно.
// Откройте в браузере: https://ваш-адрес.onrender.com/debug/amocrm-test
// -----------------------------------------------------------
app.get("/debug/amocrm-test", async (req, res) => {
  try {
    const account = await amocrmRequest("/api/v4/account");
    res.json({
      status: "Связь с amoCRM работает!",
      account_name: account.name,
      account_id: account.id,
      subdomain: account.subdomain,
    });
  } catch (err) {
    console.error("Ошибка проверки связи с amoCRM:", err.details || err.message);
    res.status(500).json({
      status: "Ошибка связи с amoCRM",
      message: err.message,
      details: err.details || null,
    });
  }
});

// -----------------------------------------------------------
// Сюда нужно указать URL вебхука в настройках бота amoMessenger
// (developers.amo.tm).
// Адрес: https://ваш-адрес-на-render.onrender.com/webhook/amomessenger
// -----------------------------------------------------------
app.post("/webhook/amomessenger", (req, res) => {
  console.log("=== Получен запрос от amoMessenger ===");
  console.log(JSON.stringify(req.body, null, 2));

  storeRequest(req);

  res.status(200).json({ ok: true, received: true });
});

// -----------------------------------------------------------
// Открыв эту страницу, можно посмотреть последние запросы,
// которые прислал amoMessenger.
// -----------------------------------------------------------
app.get("/debug/last", (req, res) => {
  res.json(lastRequests);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
