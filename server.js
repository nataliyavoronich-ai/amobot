// ============================================================
// Сервер бота: приём вебхуков от amoMessenger + доступ к amoCRM
// ============================================================
// Доступ к amoCRM теперь работает через ДОЛГОСРОЧНЫЙ ТОКЕН
// (взят на странице интеграции в amoCRM, кнопка "Сгенерировать
// токен"), поэтому никакого обмена кодами (OAuth) не нужно.
//
// Обязательные переменные окружения (заданы в Render → Environment):
//   AMOCRM_TOKEN            — долгосрочный токен из amoCRM
//   AMOCRM_DOMAIN           — адрес аккаунта, например vashafirma.amocrm.ru
//
// Переменные для OAuth-приложения amoMessenger (нужны, чтобы бот
// вообще смог установиться пользователем):
//   AMOMESSENGER_CLIENT_ID     — Client ID вашего приложения (developers.amo.tm)
//   AMOMESSENGER_CLIENT_SECRET — Client Secret вашего приложения
//
// В настройках приложения (developers.amo.tm → ваше приложение →
// раздел "OAuth авторизация") нужно указать Redirect URL:
//   https://amobot-cpck.onrender.com/amo_authorization
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
// Храним токен, который наше приложение получит после установки
// пользователем через amoMessenger (OAuth). Пока храним в памяти —
// после каждого перезапуска сервера на Render его нужно будет
// получить заново (переустановкой приложения). Для боевой версии
// это стоит сохранять в базу/файл, но для теста этого достаточно.
// -----------------------------------------------------------
let appToken = null; // { access_token, refresh_token, expires_at, user_uuid, company_uuid, client_uuid }

// -----------------------------------------------------------
// OAuth: сюда amo перенаправит пользователя после того, как он
// разрешит установку приложения, передав параметр ?code=...
// Redirect URL в настройках приложения должен быть:
//   https://amobot-cpck.onrender.com/amo_authorization
// -----------------------------------------------------------
app.get("/amo_authorization", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Нет параметра code в запросе. Установка не удалась.");
  }

  const clientId = process.env.AMOMESSENGER_CLIENT_ID;
  const clientSecret = process.env.AMOMESSENGER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res
      .status(500)
      .send("На сервере не заданы AMOMESSENGER_CLIENT_ID / AMOMESSENGER_CLIENT_SECRET (Render → Environment).");
  }

  try {
    // Шаг 1. Меняем code на access_token
    const tokenResponse = await fetch("https://id.amo.tm/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://amobot-cpck.onrender.com/amo_authorization",
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("Ошибка обмена кода на токен:", tokenData);
      return res.status(500).send(
        `<pre>Ошибка при получении токена:\n${JSON.stringify(tokenData, null, 2)}</pre>`
      );
    }

    // Шаг 2. Узнаём, кто установил приложение (user_uuid, company_uuid, client_uuid)
    let context = {};
    try {
      const validateResponse = await fetch("https://id.amo.tm/oauth2/validate", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
      });
      context = await validateResponse.json();
    } catch (e) {
      console.error("Не удалось получить контекст токена:", e.message);
    }

    // Сохраняем всё в памяти сервера
    appToken = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in || 0) * 1000,
      user_uuid: context.user_uuid || null,
      company_uuid: context.company_uuid || null,
      client_uuid: context.client_uuid || null,
    };

    console.log("Приложение установлено, токен получен:", appToken);

    res.send(`
      <html>
        <body style="font-family: sans-serif;">
          <h3>Приложение успешно установлено ✅</h3>
          <p>Access Token: ${tokenData.access_token}</p>
          <p>Refresh Token: ${tokenData.refresh_token}</p>
          <p>Истекает через: ${tokenData.expires_in} сек.</p>
          <p>User Id: ${appToken.user_uuid}</p>
          <p>Company Id: ${appToken.company_uuid}</p>
          <p>Client Id: ${appToken.client_uuid}</p>
          <p>Это окно можно закрыть.</p>
          <script>setTimeout(function(){ window.close(); }, 15 * 1000);</script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Ошибка при установке приложения:", err.message);
    res.status(500).send(`<pre>Ошибка: ${err.message}</pre>`);
  }
});

// -----------------------------------------------------------
// Посмотреть, какой токен сейчас сохранён (после установки
// приложения). Откройте: https://ваш-адрес.onrender.com/debug/token
// -----------------------------------------------------------
app.get("/debug/token", (req, res) => {
  if (!appToken) {
    return res.json({ status: "Приложение ещё не установлено, токена нет." });
  }
  res.json(appToken);
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
