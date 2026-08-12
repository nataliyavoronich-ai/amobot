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
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

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
// Вебхук от amoMessenger.
// -----------------------------------------------------------
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
