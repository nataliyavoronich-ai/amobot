// ============================================================
// Сервер бота: приём вебхуков от amoMessenger + доступ к amoCRM
// ============================================================
// Доступ к amoCRM работает через ДОЛГОСРОЧНЫЙ ТОКЕН (взят на
// странице интеграции в amoCRM), без обмена кодами (OAuth).
//
// Обязательные переменные окружения (Render → Environment):
//   AMOCRM_TOKEN  — долгосрочный токен из amoCRM
//   AMOCRM_DOMAIN — адрес аккаунта, например vashafirma.amocrm.ru
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// -----------------------------------------------------------
// ЛОВИМ АБСОЛЮТНО ВСЕ входящие запросы (любой путь, любой метод),
// чтобы увидеть, что реально присылает виджет конструктора ботов.
// Это временная мера для отладки — потом можно убрать.
// -----------------------------------------------------------
app.use((req, res, next) => {
  storeRequest(req);
  next();
});

// Файл, куда сохраняем токен бота amoMessenger после установки.
const AMOMESSENGER_TOKENS_FILE = path.join(__dirname, "amomessenger_tokens.json");

function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------
// НАСТРОЙКИ ИЗ ТЗ — если ID полей/типа задачи изменятся, править тут
// ------------------------------------------------------------------
const TASK_TYPE_ID = 2746005; // Тип задачи "Подтв. замер(и)"

const FIELD_IDS = {
  contractNumber: 412776, // № договора
  measureDate: 175370,    // Дата замера
  measureTime: 413828,    // Время замера
  measureAddress: 175412, // Адрес замера
  product: 172572,        // Продукт
};

// Храним последние 20 полученных от amoMessenger запросов в памяти.
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
// Помощник для обращений к amoCRM API.
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

  if (response.status === 204) return null; // amoCRM отвечает так, если ничего не найдено

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const err = new Error(`amoCRM ответила с ошибкой ${response.status}`);
    err.details = data;
    throw err;
  }

  return data;
}

// -----------------------------------------------------------
// Помощник для обращений к API amoMessenger (отправка сообщений,
// возврат управления и т.д.) — используем токен, полученный после
// установки бота через OAuth.
// -----------------------------------------------------------
async function amoMessengerRequest(method, pathAndQuery, body) {
  const tokens = loadJsonFile(AMOMESSENGER_TOKENS_FILE);
  if (!tokens || !tokens.access_token) {
    throw new Error("Нет сохранённого токена amoMessenger — сначала нужно установить бота (OAuth).");
  }

  const response = await fetch(`https://api.amo.tm${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const err = new Error(`amoMessenger API ответила с ошибкой ${response.status}`);
    err.details = data;
    throw err;
  }

  return data;
}

function sendBotMessage(botId, requestId, text, buttonTexts, receiverUserId) {
  const body = { text, receiver: { user_id: receiverUserId } };
  if (buttonTexts && buttonTexts.length > 0) {
    body.reply_markup = {
      inline_keyboard: { buttons: buttonTexts.map((t) => ({ text: t })) },
    };
  }
  return amoMessengerRequest("POST", `/v1.3/bots/${botId}/request/${requestId}/sendMessage`, body);
}

function returnControl(botId, requestId, returnCode) {
  return amoMessengerRequest(
    "POST",
    `/v1.3/bots/${botId}/request/${requestId}/returnControl`,
    { return_code: returnCode }
  );
}

// Здесь временно храним, какие замеры показали конкретной заявке,
// чтобы при нажатии кнопки понять, какой именно замер выбрали.
// (Хранится в памяти сервера — обнулится при перезапуске.)
const activeRequests = new Map(); // requestId -> { botId, measurements }


function moscowShiftedNow() {
  return new Date(Date.now() + 3 * 3600 * 1000);
}

function startOfMoscowDay(daysOffset) {
  const shifted = moscowShiftedNow();
  shifted.setUTCDate(shifted.getUTCDate() + daysOffset);
  shifted.setUTCHours(0, 0, 0, 0);
  return Math.floor((shifted.getTime() - 3 * 3600 * 1000) / 1000);
}

function endOfMoscowDay(daysOffset) {
  const shifted = moscowShiftedNow();
  shifted.setUTCDate(shifted.getUTCDate() + daysOffset);
  shifted.setUTCHours(23, 59, 59, 999);
  return Math.floor((shifted.getTime() - 3 * 3600 * 1000) / 1000);
}

// Возвращает диапазон [from, to] в unix-времени согласно правилу из ТЗ:
//  - до 18:00: с вчера 00:00 по сегодня 23:59
//  - после 18:00: с вчера 00:00 по завтра 23:59
// ВАЖНО: это моя интерпретация формулировки из ТЗ (там было указано
// как два отдельных условия) — если логика должна быть другой, скажите,
// поправим именно эту функцию.
function getDateRange() {
  const moscowHour = moscowShiftedNow().getUTCHours();
  const from = startOfMoscowDay(-1);
  const to = moscowHour < 18 ? endOfMoscowDay(0) : endOfMoscowDay(1);
  return { from, to, moscowHour };
}

function formatFieldValue(value, dateOnly = false) {
  // Если значение похоже на unix-таймстамп (дата/время из amoCRM) — форматируем.
  if (typeof value === "number" && value > 1000000000) {
    const d = new Date(value * 1000);
    return dateOnly
      ? d.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })
      : d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  }
  return value;
}

function getCustomFieldValue(entity, fieldId, dateOnly = false) {
  if (!entity.custom_fields_values) return null;
  const field = entity.custom_fields_values.find((f) => f.field_id === fieldId);
  if (!field || !field.values || !field.values[0]) return null;
  return formatFieldValue(field.values[0].value, dateOnly);
}

// Аккуратно собирает адрес сделки без риска задвоить "/"
function leadLink(leadId) {
  const domain = (process.env.AMOCRM_DOMAIN || "").replace(/\/+$/, "");
  return `https://${domain}/leads/detail/${leadId}`;
}

// -----------------------------------------------------------
// Получить задачи нужного типа за нужный период.
// -----------------------------------------------------------
async function fetchMeasurementTasks() {
  const { from, to } = getDateRange();
  const data = await amocrmRequest(
    `/api/v4/tasks?filter[task_type]=${TASK_TYPE_ID}&filter[complete_till][from]=${from}&filter[complete_till][to]=${to}&limit=250`
  );
  return (data && data._embedded && data._embedded.tasks) || [];
}

// -----------------------------------------------------------
// Получить сделки по списку ID (плюс привязанные контакты).
// -----------------------------------------------------------
async function fetchLeadsByIds(ids) {
  if (ids.length === 0) return [];
  const idsQuery = ids.map((id) => `filter[id][]=${id}`).join("&");
  const data = await amocrmRequest(`/api/v4/leads?${idsQuery}&with=contacts&limit=250`);
  return (data && data._embedded && data._embedded.leads) || [];
}

// -----------------------------------------------------------
// Получить имя и телефон контакта.
// -----------------------------------------------------------
async function fetchContactInfo(contactId) {
  const contact = await amocrmRequest(`/api/v4/contacts/${contactId}`);
  if (!contact) return { name: null, phones: [] };

  const phones = [];
  if (contact.custom_fields_values) {
    const phoneField = contact.custom_fields_values.find((f) => f.field_code === "PHONE");
    if (phoneField && phoneField.values) {
      phoneField.values.forEach((v) => phones.push(v.value));
    }
  }
  return { name: contact.name, phones };
}

// -----------------------------------------------------------
// Собрать итоговый список замеров с нужными полями (п.6 ТЗ).
// -----------------------------------------------------------
async function buildMeasurementsList() {
  const tasks = await fetchMeasurementTasks();

  const leadIds = [
    ...new Set(tasks.filter((t) => t.entity_type === "leads").map((t) => t.entity_id)),
  ];

  const leads = await fetchLeadsByIds(leadIds);

  const results = [];
  for (const lead of leads) {
    let contactInfo = { name: null, phones: [] };
    const embeddedContacts = (lead._embedded && lead._embedded.contacts) || [];
    const mainContact = embeddedContacts.find((c) => c.is_main) || embeddedContacts[0];
    if (mainContact) {
      contactInfo = await fetchContactInfo(mainContact.id);
    }

    results.push({
      lead_id: lead.id,
      lead_link: leadLink(lead.id),
      contract_number: getCustomFieldValue(lead, FIELD_IDS.contractNumber),
      measure_date: getCustomFieldValue(lead, FIELD_IDS.measureDate, true),
      measure_time: getCustomFieldValue(lead, FIELD_IDS.measureTime),
      measure_address: getCustomFieldValue(lead, FIELD_IDS.measureAddress),
      product: getCustomFieldValue(lead, FIELD_IDS.product),
      client_name: contactInfo.name,
      client_phones: contactInfo.phones,
    });
  }

  return results;
}

// -----------------------------------------------------------
// Собрать текст сообщения бота (п.6 ТЗ: каждая сделка с новой
// строки, значения полей в одну строку).
// -----------------------------------------------------------
function formatMessageText(measurements) {
  return measurements
    .map((m) => {
      return [
        `№ договора: ${m.contract_number ?? "—"}`,
        `Дата замера: ${m.measure_date ?? "—"}`,
        `Время замера: ${m.measure_time ?? "—"}`,
        `Адрес замера: ${m.measure_address ?? "—"}`,
        `Продукт: ${m.product ?? "—"}`,
        `Имя клиента: ${m.client_name ?? "—"}`,
        `Телефон: ${m.client_phones.join(", ") || "—"}`,
        `Ссылка: ${m.lead_link}`,
      ].join("; ");
    })
    .join("\n");
}

// -----------------------------------------------------------
// Проверка, что сервер вообще жив.
// -----------------------------------------------------------
app.get("/", (req, res) => {
  res.send("OK. Сервер бота запущен и работает.");
});

// -----------------------------------------------------------
// Настройки виджета (открывается как iframe при добавлении
// виджета в конструктор бота). Нам не нужно ничего настраивать —
// просто подтверждаем, что виджет готов к работе.
// -----------------------------------------------------------
app.post("/", (req, res) => {
  console.log("=== Открыта настройка виджета (iframe) ===");
  console.log(JSON.stringify(req.body, null, 2));
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; padding: 16px;">
  <p>Виджет «Отчёт инженеров» готов к работе. Дополнительных настроек не требуется.</p>
  <script src="https://js.amo.tm/v1/sdk.js"></script>
  <script>
    try {
      var amoSDK = window.AmoSDK();
      amoSDK.setInputValues({ ready: 'true' });
    } catch (e) {
      console.error('SDK error', e);
    }
  </script>
</body>
</html>`);
});

// -----------------------------------------------------------
// Проверка связи с amoCRM.
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
    res.status(500).json({ status: "Ошибка связи с amoCRM", message: err.message, details: err.details || null });
  }
});

// -----------------------------------------------------------
// ГЛАВНАЯ ТЕСТОВАЯ СТРАНИЦА для пунктов 5-6 из ТЗ.
// Откройте: https://ваш-адрес.onrender.com/debug/tasks-test
// -----------------------------------------------------------
app.get("/debug/tasks-test", async (req, res) => {
  try {
    const { from, to, moscowHour } = getDateRange();
    const measurements = await buildMeasurementsList();
    res.json({
      status: "OK",
      current_moscow_hour: moscowHour,
      date_range: {
        from: new Date(from * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }),
        to: new Date(to * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }),
      },
      found_count: measurements.length,
      measurements: measurements,
      message_preview: formatMessageText(measurements),
    });
  } catch (err) {
    console.error("Ошибка построения списка замеров:", err.details || err.message);
    res.status(500).json({ status: "Ошибка", message: err.message, details: err.details || null });
  }
});

// -----------------------------------------------------------
// Установка бота amoMessenger: сюда придёт code после того,
// как вы нажмёте кнопку установки бота в amoMessenger.
// Обмен кода на токен идёт на id.amo.tm (это отдельная система
// авторизации amoMessenger, не путать с amoCRM).
// -----------------------------------------------------------
app.get("/oauth/amomessenger/callback", async (req, res) => {
  const { code } = req.query;

  console.log("=== Запрос на установку бота amoMessenger ===");
  console.log("code:", code);

  if (!code) {
    return res.status(400).send("Не хватает параметра code. Проверьте, что переход был сделан кнопкой установки бота.");
  }

  const CLIENT_ID = process.env.AMOMESSENGER_CLIENT_ID;
  const CLIENT_SECRET = process.env.AMOMESSENGER_CLIENT_SECRET;
  const REDIRECT_URI = process.env.AMOMESSENGER_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res
      .status(500)
      .send("На сервере не заданы AMOMESSENGER_CLIENT_ID / AMOMESSENGER_CLIENT_SECRET / AMOMESSENGER_REDIRECT_URI в Environment на Render.");
  }

  try {
    const tokenResponse = await fetch("https://id.amo.tm/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.log("Ошибка обмена кода на токен amoMessenger:", tokenData);
      return res.status(500).send("amoMessenger отклонила обмен кода на токен. Подробности в логах сервера на Render.");
    }

    saveJsonFile(AMOMESSENGER_TOKENS_FILE, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      obtained_at: new Date().toISOString(),
    });

    console.log("Бот amoMessenger успешно установлен, токены сохранены.");
    res.send("Готово! Бот amoMessenger успешно установлен. Можно закрыть эту страницу.");
  } catch (err) {
    console.error("Ошибка при установке бота amoMessenger:", err);
    res.status(500).send("Произошла ошибка при установке. Подробности в логах сервера на Render.");
  }
});

app.get("/debug/amomessenger-token", (req, res) => {
  const tokens = loadJsonFile(AMOMESSENGER_TOKENS_FILE);
  if (!tokens) {
    return res.json({ status: "Токен ещё не сохранён. Установка бота ещё не выполнена." });
  }
  res.json({
    status: "Токен найден",
    access_token_preview: tokens.access_token ? tokens.access_token.slice(0, 15) + "..." : null,
    obtained_at: tokens.obtained_at,
  });
});


// -----------------------------------------------------------
// Вебхук от amoMessenger — сюда приходят все события, включая
// главные для нас: "нам передали управление виджетом" и
// "пользователь написал сообщение, пока управление у нас".
// -----------------------------------------------------------
app.post("/webhook/amomessenger", async (req, res) => {
  const body = req.body;
  const eventType = body.event_type;

  console.log("=== Вебхук amoMessenger, событие:", eventType, "===");

  try {
    if (eventType === "rpa_bot_control_transferred") {
      await handleControlTransferred(body);
    } else if (eventType === "rpa_bot_income_message") {
      await handleIncomeMessage(body);
    }
  } catch (err) {
    console.error("Ошибка обработки вебхука:", err.details || err.message);
  }

  res.status(200).json({ ok: true });
});

// Нам передали управление — запрашиваем замеры в amoCRM и
// показываем список с кнопками.
async function handleControlTransferred(body) {
  const payload = body._embedded.rpa_bot_control_transferred;
  const botId = payload.bot_id;
  const request = payload._embedded.request;
  const requestId = request.id;
  const receiverUserId = request.author_id;

  const measurements = await buildMeasurementsList();

  if (measurements.length === 0) {
    await sendBotMessage(botId, requestId, "На сегодня замеров не найдено.", null, receiverUserId);
    await returnControl(botId, requestId, "success");
    return;
  }

  activeRequests.set(requestId, { botId, measurements });

  const listText = formatMessageText(measurements);
  const buttonTexts = measurements.map((m) => m.contract_number || String(m.lead_id));

  await sendBotMessage(
    botId,
    requestId,
    "Замеры на сегодня:\n\n" + listText + "\n\nВыберите замер:",
    buttonTexts,
    receiverUserId
  );
  // Управление НЕ возвращаем — ждём, какую кнопку нажмёт пользователь.
}

// Пользователь нажал одну из кнопок (пришло как обычное сообщение).
async function handleIncomeMessage(body) {
  const payload = body._embedded.rpa_bot_income_message;
  const botId = payload.bot_id;
  const request = payload._embedded.request;
  const requestId = request.id;
  const receiverUserId = request.author_id;
  const messageText = (payload._embedded.income_message && payload._embedded.income_message.text) || "";

  const session = activeRequests.get(requestId);
  if (!session) {
    // Мы не ждали сообщений по этой заявке — ничего не делаем.
    return;
  }

  const chosen = session.measurements.find((m) => (m.contract_number || String(m.lead_id)) === messageText.trim());

  if (!chosen) {
    await sendBotMessage(
      botId,
      requestId,
      "Не нашёл такой замер. Нажмите одну из кнопок выше.",
      null,
      receiverUserId
    );
    return; // управление оставляем себе, ждём повторную попытку
  }

  const detailText = [
    `Дата замера: ${chosen.measure_date ?? "—"}`,
    `Время замера: ${chosen.measure_time ?? "—"}`,
    `Адрес замера: ${chosen.measure_address ?? "—"}`,
    `Продукт: ${chosen.product ?? "—"}`,
    `Имя клиента: ${chosen.client_name ?? "—"}`,
    `Телефон: ${chosen.client_phones.join(", ") || "—"}`,
    `№ договора: ${chosen.contract_number ?? "—"}`,
    `Ссылка: ${chosen.lead_link}`,
  ].join("\n");

  await sendBotMessage(botId, requestId, detailText, null, receiverUserId);

  activeRequests.delete(requestId);
  await returnControl(botId, requestId, "success");
}

app.get("/debug/last", (req, res) => {
  res.json(lastRequests);
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
