// ============================================================
// Сервер бота: приём вебхуков от amoMessenger + доступ к amoCRM
// ============================================================
// Доступ к amoCRM работает через ДОЛГОСРОЧНЫЙ ТОКЕН (взят на
// странице интеграции в amoCRM), без обмена кодами (OAuth).
//
// Обязательные переменные окружения (Render → Environment):
//   AMOCRM_TOKEN  — долгосрочный токен из amoCRM
//   AMOCRM_DOMAIN — адрес аккаунта, например vashafirma.amocrm.ru
//
// Для RPA-виджета (боты в заявках) понадобится ещё:
//   AMO_WIDGET_SECRET — секретный ключ приложения, которым подписываются
//     вебхуки (secret_key из настроек приложения на developers.amo.tm).
//     Пока не проверено на реальных вебхуках — уточните точное название
//     параметра у ТП, если подпись не будет сходиться.
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

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

// Текст кнопок главного меню бота (п.3 ТЗ)
const MAIN_MENU_BUTTONS = [
  "Подтвердить замер",
  "Провести замер",
  "Загрузить фотоотчет",
  "Внести правки",
];

// ВАЖНО: в присланной документации домен API бота указан по-разному —
// то api.amo.tm, то api.amo.io. Здесь по умолчанию используется amo.tm
// (по аналогии с id.amo.tm, который у нас уже рабочий). Если запросы
// будут падать с ошибкой соединения/404 — переключите на api.amo.io
// через переменную окружения AMO_BOT_API_BASE.
const AMO_BOT_API_BASE = process.env.AMO_BOT_API_BASE || "https://api.amo.tm";

// Сессии в памяти: какие замеры были показаны пользователю в рамках
// конкретной заявки (request_id), чтобы при нажатии кнопки с номером
// договора понять, о каком замере речь (п.7 ТЗ). Живёт, пока не
// перезапустится сервер.
const requestSessions = new Map();

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
// Помощники для работы с датами по московскому времени (UTC+3).
// -----------------------------------------------------------
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
// Текст с деталями ОДНОГО замера (п.7 ТЗ: каждое значение с новой строки).
// -----------------------------------------------------------
function formatMeasurementDetail(m) {
  return [
    `Дата замера: ${m.measure_date ?? "—"}`,
    `Время замера: ${m.measure_time ?? "—"}`,
    `Адрес замера: ${m.measure_address ?? "—"}`,
    `Продукт: ${m.product ?? "—"}`,
    `Имя клиента: ${m.client_name ?? "—"}`,
    `№ телефона: ${m.client_phones.join(", ") || "—"}`,
    `№ договора: ${m.contract_number ?? "—"}`,
    `Ссылка на сделку: ${m.lead_link}`,
  ].join("\n");
}

// -----------------------------------------------------------
// Проверка, что сервер вообще жив.
// -----------------------------------------------------------
app.get("/", (req, res) => {
  res.send("OK. Сервер бота запущен и работает.");
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


// ============================================================
// РАЗДЕЛ: RPA-ВИДЖЕТ ДЛЯ КОНСТРУКТОРА БОТА ("Боты в заявках")
// ============================================================
// Это ДРУГОЙ механизм, чем OAuth-приложение выше: сюда amo сама
// передаёт управление, когда цепочка бота в конструкторе доходит
// до нашего виджета. Виджет нужно зарегистрировать через чат ТП
// (самостоятельная регистрация пока не работает по документации).
//
// СТАТУС: каркас. API отправки сообщений от бота и API возврата
// управления в документации, присланной пользователем, не описаны —
// как только появятся эти детали, здесь нужно будет дописать
// реальную отправку кнопок и вызов "вернуть управление".
// ============================================================

// -----------------------------------------------------------
// Проверка подписи запроса от amo (по алгоритму из документации):
// 1. Берём все параметры, сортируем по названию ключа
// 2. Исключаем сам параметр signature
// 3. Склеиваем в строку вида key1value1key2value2...
// 4. Считаем HMAC этой строки с секретом приложения
// 5. Сравниваем со значением signature
// ПРИМЕЧАНИЕ: алгоритм хеширования и точное имя секрета в документации
// не уточнены до конца ("Из параметра signature определить алгоритм
// шифрования") — здесь по умолчанию используется sha256. Если подписи
// не будут совпадать на реальных запросах, это первое, что нужно
// перепроверить у ТП.
function verifyAmoSignature(params, secret) {
  if (!params || !params.signature || !secret) return false;

  const { signature, ...rest } = params;
  const sortedKeys = Object.keys(rest).sort();
  const baseString = sortedKeys.map((key) => `${key}${rest[key]}`).join("");

  const expected = crypto.createHmac("sha256", secret).update(baseString).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) {
    return false; // разная длина строк и т.п.
  }
}

// -----------------------------------------------------------
// Токен доступа к API бота amo — тот же, что сохранился при установке
// приложения через /oauth/amomessenger/callback.
// -----------------------------------------------------------
function getAmoMessengerAccessToken() {
  const tokens = loadJsonFile(AMOMESSENGER_TOKENS_FILE);
  return tokens ? tokens.access_token : null;
}

// -----------------------------------------------------------
// Отправить сообщение от имени бота (с кнопками или без).
// buttonTexts — массив строк, каждая строка = текст одной кнопки.
// -----------------------------------------------------------
async function sendBotMessage({ botId, requestId, text, buttonTexts, receiverUserId }) {
  const accessToken = getAmoMessengerAccessToken();
  if (!accessToken) {
    throw new Error("Нет сохранённого токена приложения amoMessenger — приложение не установлено");
  }

  const payload = {
    text,
    receiver: { user_id: receiverUserId },
  };

  if (buttonTexts && buttonTexts.length) {
    payload.reply_markup = {
      inline_keyboard: {
        buttons: buttonTexts.map((t) => ({ text: t })),
      },
    };
  }

  const response = await fetch(
    `${AMO_BOT_API_BASE}/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Ошибка отправки сообщения ботом:", response.status, data);
    throw new Error(`sendMessage вернул ошибку ${response.status}`);
  }

  return data;
}

// -----------------------------------------------------------
// Вернуть управление обратно amo (return_code: "success" / "error").
// ПРИМЕЧАНИЕ: в этой версии не вызывается автоматически — пока не
// решено, в какой именно момент сценарий должен считаться завершённым
// (дальше по ТЗ появятся ещё шаги). Функция готова, вызвать можно
// в нужном месте по мере усложнения бота.
// -----------------------------------------------------------
async function returnControlToAmo({ botId, requestId, returnCode }) {
  const accessToken = getAmoMessengerAccessToken();
  if (!accessToken) {
    throw new Error("Нет сохранённого токена приложения amoMessenger — приложение не установлено");
  }

  const response = await fetch(
    `${AMO_BOT_API_BASE}/v1.3/bots/${botId}/request/${requestId}/returnControl`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ return_code: returnCode }),
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    console.error("Ошибка возврата управления:", response.status, data);
    throw new Error(`returnControl вернул ошибку ${response.status}`);
  }
}

// -----------------------------------------------------------
// Достаём из тела вебхука всё нужное независимо от типа события
// (rpa_bot_control_transferred / rpa_bot_income_message имеют
// одинаковую структуру, только ключ в _embedded разный).
// -----------------------------------------------------------
function extractRpaEvent(body) {
  const eventType = body && body.event_type;
  if (!eventType || !body._embedded || !body._embedded[eventType]) {
    return null;
  }

  const eventBody = body._embedded[eventType];
  const embedded = eventBody._embedded || {};
  const request = embedded.request || {};
  const incomeMessage = embedded.income_message || {};

  return {
    eventType,
    botId: eventBody.bot_id,
    widgetId: eventBody.widget_id,
    requestId: request.id,
    receiverUserId: (incomeMessage.author && incomeMessage.author.user_id) || request.author_id,
    incomingText: incomeMessage.text || null,
  };
}

// -----------------------------------------------------------
// Экран настроек виджета. Когда администратор добавляет виджет
// в цепочку бота в конструкторе, amo делает iframe-запрос сюда —
// нужно вернуть HTML интерфейса настроек. Пока это заглушка с
// подключением JS SDK; сюда позже добавим селект для выбора поля
// "Инженер" (как в исходном ТЗ), через amoSDK.elements().
// -----------------------------------------------------------
app.get("/widget/settings", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <script src="https://js.amo.tm/v1/sdk.js"></script>
      </head>
      <body style="font-family: sans-serif; padding: 10px;">
        <p>Настройки виджета (в разработке).</p>
        <script>
          const amoSDK = window.AmoSDK();
          // TODO: здесь будет селект для выбора поля "Инженер"
          // и сохранение через amoSDK.setInputValues(...)
        </script>
      </body>
    </html>
  `);
});

// -----------------------------------------------------------
// Вебхук RPA-виджета: сюда приходят и "передача управления"
// (rpa_bot_control_transferred), и "входящее сообщение от
// пользователя" (rpa_bot_income_message) — тип события смотрим
// в поле event_type.
// URL для регистрации виджета (сообщить в ТП):
//   https://amobot-cpck.onrender.com/webhook/rpa
// -----------------------------------------------------------
app.post("/webhook/rpa", async (req, res) => {
  console.log("=== RPA-виджет: получен запрос от amo ===");
  console.log(JSON.stringify(req.body, null, 2));
  storeRequest(req);

  // Отвечаем amo сразу, чтобы не ждать наших запросов к amoCRM —
  // вся дальнейшая работа с ботом идёт уже "в фоне" через API бота.
  res.status(200).json({ ok: true });

  const event = extractRpaEvent(req.body);
  if (!event) {
    console.log("Не удалось разобрать событие вебхука (неизвестная структура).");
    return;
  }

  // Подпись пока только логируем, не блокируем обработку — чтобы
  // сначала убедиться, что реальный формат подписи совпадает с тем,
  // что описано в документации. Когда подтвердится — можно будет
  // отклонять запросы с неверной подписью через return.
  const secret = process.env.AMO_WIDGET_SECRET;
  if (secret) {
    console.log("Подпись запроса корректна?", verifyAmoSignature(req.body, secret));
  }

  const { eventType, botId, requestId, receiverUserId, incomingText } = event;

  if (!botId || !requestId || !receiverUserId) {
    console.log("В событии не хватает botId/requestId/receiverUserId — пропускаем.", event);
    return;
  }

  try {
    if (eventType === "rpa_bot_control_transferred") {
      // п.3 ТЗ: показываем главное меню с 4 кнопками
      await sendBotMessage({
        botId,
        requestId,
        receiverUserId,
        text: "Выберите задачу для выполнения",
        buttonTexts: MAIN_MENU_BUTTONS,
      });
      return;
    }

    if (eventType !== "rpa_bot_income_message") {
      console.log("Неизвестный тип события:", eventType);
      return;
    }

    // Дальше — обработка входящих сообщений/нажатий кнопок
    const session = requestSessions.get(requestId);

    // Случай 1: пользователь нажал кнопку с номером договора из уже
    // показанного списка замеров -> показываем детали (п.7 ТЗ)
    if (session && session.measurements) {
      const chosen = session.measurements.find(
        (m) => String(m.contract_number) === String(incomingText)
      );
      if (chosen) {
        await sendBotMessage({
          botId,
          requestId,
          receiverUserId,
          text: formatMeasurementDetail(chosen),
        });
        return;
      }
    }

    // Случай 2: пользователь нажал "Подтвердить замер" (пп.4-6 ТЗ)
    if (incomingText === "Подтвердить замер") {
      const measurements = await buildMeasurementsList();

      if (measurements.length === 0) {
        await sendBotMessage({
          botId,
          requestId,
          receiverUserId,
          text: "На выбранный период замеров не найдено.",
        });
        return;
      }

      requestSessions.set(requestId, { measurements });

      await sendBotMessage({
        botId,
        requestId,
        receiverUserId,
        text: formatMessageText(measurements),
        buttonTexts: measurements.map((m) => String(m.contract_number ?? "—")),
      });
      return;
    }

    // Случай 3: остальные пункты меню — пока не реализованы по ТЗ
    if (MAIN_MENU_BUTTONS.includes(incomingText)) {
      await sendBotMessage({
        botId,
        requestId,
        receiverUserId,
        text: "Этот сценарий пока в разработке.",
      });
      return;
    }

    console.log("Сообщение не распознано как известная команда:", incomingText);
  } catch (err) {
    console.error("Ошибка обработки события бота:", err.message);
    try {
      await sendBotMessage({
        botId,
        requestId,
        receiverUserId,
        text: "Произошла ошибка при обработке запроса. Попробуйте ещё раз позже.",
      });
    } catch (e) {
      console.error("Не удалось даже отправить сообщение об ошибке:", e.message);
    }
  }
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
