// ============================================================
// amoMessenger + amoCRM
// Версия 0.1
//
// Текущая задача:
// 1. Пользователь нажимает «Подтвердить замер».
// 2. Получаем задачи типа 2746005.
// 3. Определяем связанные сделки.
// 4. Оставляем только сделки, где:
//      Поле «Инженер» ID 203849
//      Значение «Марина Трафимова» ID 1059150
// 5. Показываем список замеров.
// 6. Под каждой выдачей создаём кнопки по № договора.
// 7. При нажатии кнопки показываем подробности сделки.
//
// Часовой пояс: Europe/Moscow
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------
// ЛОВИМ ВХОДЯЩИЕ ЗАПРОСЫ
// ------------------------------------------------------------

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

app.use((req, res, next) => {
  storeRequest(req);
  next();
});

// ------------------------------------------------------------
// ФАЙЛ ТОКЕНОВ amoMessenger
// ------------------------------------------------------------

const AMOMESSENGER_TOKENS_FILE = path.join(
  __dirname,
  "amomessenger_tokens.json"
);

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

// ============================================================
// НАСТРОЙКИ ПРОЕКТА
// ============================================================

// Тип задачи «Подтв. замер(и)»
const TASK_TYPE_ID = 2746005;

// Поле «Инженер»
const ENGINEER_FIELD_ID = 203849;

// ID значения «Марина Трафимова» в поле «Инженер»
const ENGINEER_ENUM_ID = 1059150;

// Название инженера — просто для удобства в сообщениях/логах
const ENGINEER_NAME = "Марина Трафимова";

// Поля сделки
const FIELD_IDS = {
  contractNumber: 412776, // № договора
  measureDate: 175370,    // Дата замера
  measureTime: 413828,    // Время замера
  measureAddress: 175412, // Адрес объекта
  product: 172572,        // Продукт
};

// Часовой пояс.
// По вашей просьбе оставляем Москву.
const TIME_ZONE = "Europe/Moscow";

// ------------------------------------------------------------
// Состояние активных запросов.
// Для первой версии храним в памяти.
// При перезапуске Render состояние очистится.
// Для тестовой версии это нормально.
// ------------------------------------------------------------

const activeRequests = new Map();

// ============================================================
// amoCRM API
// ============================================================

async function amocrmRequest(pathAndQuery) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_TOKEN;

  if (!domain) {
    throw new Error(
      "Не задана переменная AMOCRM_DOMAIN в Environment на Render."
    );
  }

  if (!token) {
    throw new Error(
      "Не задана переменная AMOCRM_TOKEN в Environment на Render."
    );
  }

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const url = `https://${cleanDomain}${pathAndQuery}`;

  console.log("amoCRM GET:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      `amoCRM ответила с ошибкой HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ============================================================
// amoMessenger API
// ============================================================

async function amoMessengerRequest(method, pathAndQuery, body) {
  const tokens = loadJsonFile(AMOMESSENGER_TOKENS_FILE);

  if (!tokens || !tokens.access_token) {
    throw new Error(
      "Нет сохранённого токена amoMessenger. Сначала установите бота."
    );
  }

  const response = await fetch(
    `https://api.amo.tm${pathAndQuery}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      `amoMessenger API ответила с ошибкой HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ============================================================
// Отправка сообщения пользователю
// ============================================================

async function sendBotMessage(
  botId,
  requestId,
  text,
  buttonTexts,
  receiverUserId
) {
  const body = {
    text,
    receiver: {
      user_id: receiverUserId,
    },
  };

  if (buttonTexts && buttonTexts.length > 0) {
    body.reply_markup = {
      inline_keyboard: {
        buttons: buttonTexts.map((text) => ({
          text: String(text),
        })),
      },
    };
  }

  console.log("Отправляем сообщение пользователю:");
  console.log(text);

  if (buttonTexts && buttonTexts.length > 0) {
    console.log("Кнопки:", buttonTexts);
  }

  return amoMessengerRequest(
    "POST",
    `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
    body
  );
}

// ============================================================
// Возвращение управления обратно Salesbot
// ============================================================

async function returnControl(botId, requestId, returnCode) {
  return amoMessengerRequest(
    "POST",
    `/v1.3/bots/${botId}/request/${requestId}/returnControl`,
    {
      return_code: returnCode,
    }
  );
}

// ============================================================
// ВРЕМЯ
// ============================================================

// Получаем текущую дату/время в Москве.
// Возвращается объект Date, который удобно использовать
// для расчётов UTC timestamp.

function moscowNow() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

// Получить timestamp для начала московского дня.
// offset = -1 → вчера
// offset = 0  → сегодня
// offset = 1  → завтра

function moscowDayTimestamp(offset, endOfDay = false) {
  const now = moscowNow();

  // Используем UTC-расчёт с фиксированным +03:00,
  // поскольку вы попросили оставить московское время.
  const date = new Date(
    Date.UTC(
      now.year,
      now.month - 1,
      now.day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0
    )
  );

  date.setUTCDate(date.getUTCDate() + offset);

  // Москва = UTC+3
  return Math.floor(
    (date.getTime() - 3 * 60 * 60 * 1000) / 1000
  );
}

// ============================================================
// Диапазон поиска задач
//
// ДО 18:00:
// вчера 00:00 → текущий момент
//
// ПОСЛЕ 18:00:
// сегодня 00:00 → завтра 23:59:59
// ============================================================

function getDateRange() {
  const now = moscowNow();

  let from;
  let to;

  if (now.hour < 18) {
    // Вчера с 00:00
    from = moscowDayTimestamp(-1, false);

    // Текущий момент
    const currentUtc = new Date();

    // Получаем текущие московские компоненты и превращаем
    // их в timestamp с учётом UTC+3.
    const currentMoscowAsUtc = Date.UTC(
      now.year,
      now.month - 1,
      now.day,
      now.hour,
      now.minute,
      now.second
    );

    to = Math.floor(
      (currentMoscowAsUtc - 3 * 60 * 60 * 1000) / 1000
    );
  } else {
    // Сегодня 00:00
    from = moscowDayTimestamp(0, false);

    // Завтра 23:59:59
    to = moscowDayTimestamp(1, true);
  }

  return {
    from,
    to,
    moscowHour: now.hour,
    moscowMinute: now.minute,
  };
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ПОЛЕЙ
// ============================================================

// Безопасное преобразование значения даты amoCRM
// в обычную дату России.

function formatDateField(value) {
  if (value === null || value === undefined) {
    return null;
  }

  let timestamp = null;

  if (typeof value === "number") {
    timestamp = value;
  } else if (
    typeof value === "string" &&
    /^\d+$/.test(value)
  ) {
    timestamp = Number(value);
  }

  if (timestamp !== null && timestamp > 1000000000) {
    return new Date(timestamp * 1000).toLocaleDateString(
      "ru-RU",
      {
        timeZone: TIME_ZONE,
      }
    );
  }

  return String(value);
}

// Получение первого значения поля.

function getRawCustomFieldValue(entity, fieldId) {
  if (!entity || !entity.custom_fields_values) {
    return null;
  }

  const field = entity.custom_fields_values.find(
    (item) => Number(item.field_id) === Number(fieldId)
  );

  if (!field || !field.values || field.values.length === 0) {
    return null;
  }

  return field.values[0];
}

// Получение обычного текста из поля.

function getCustomFieldText(entity, fieldId) {
  const item = getRawCustomFieldValue(entity, fieldId);

  if (!item) {
    return null;
  }

  // Например:
  // { value: "Окна", enum_id: 123 }
  if (item.value !== undefined && item.value !== null) {
    return String(item.value);
  }

  // Иногда может прийти enum_id без value.
  if (item.enum_id !== undefined) {
    return String(item.enum_id);
  }

  return null;
}

// Получение даты.

function getCustomFieldDate(entity, fieldId) {
  const item = getRawCustomFieldValue(entity, fieldId);

  if (!item) {
    return null;
  }

  return formatDateField(item.value);
}

// ============================================================
// Проверка инженера
// ============================================================

function isMarinaEngineer(lead) {
  const item = getRawCustomFieldValue(
    lead,
    ENGINEER_FIELD_ID
  );

  if (!item) {
    return false;
  }

  // Основной вариант для select:
  // { enum_id: 1059150, value: "Марина Трафимова" }

  if (
    item.enum_id !== undefined &&
    Number(item.enum_id) === Number(ENGINEER_ENUM_ID)
  ) {
    return true;
  }

  // Запасной вариант:
  // если amoCRM отдаст только текст.

  if (
    item.value !== undefined &&
    String(item.value).trim() === ENGINEER_NAME
  ) {
    return true;
  }

  return false;
}

// ============================================================
// Ссылка на сделку
// ============================================================

function leadLink(leadId) {
  const domain = (process.env.AMOCRM_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  return `https://${domain}/leads/detail/${leadId}`;
}

// ============================================================
// Получение задач
// ============================================================

// Получаем все задачи нужного типа в заданном диапазоне.
// Сделано с пагинацией, чтобы не ограничиваться первыми 250.

async function fetchMeasurementTasks() {
  const { from, to } = getDateRange();

  const allTasks = [];

  let page = 1;

  while (true) {
    const params = new URLSearchParams();

    params.set(
      "filter[task_type]",
      String(TASK_TYPE_ID)
    );

    params.set(
      "filter[complete_till][from]",
      String(from)
    );

    params.set(
      "filter[complete_till][to]",
      String(to)
    );

    params.set(
      "filter[is_completed]",
      "0"
    );

    params.set(
      "order[complete_till]",
      "asc"
    );

    params.set("limit", "250");
    params.set("page", String(page));

    const data = await amocrmRequest(
      `/api/v4/tasks?${params.toString()}`
    );

    const tasks =
      data &&
      data._embedded &&
      data._embedded.tasks
        ? data._embedded.tasks
        : [];

    allTasks.push(...tasks);

    if (
      tasks.length < 250 ||
      !data ||
      !data._page
    ) {
      break;
    }

    page++;
  }

  console.log(
    `Найдено задач типа ${TASK_TYPE_ID}:`,
    allTasks.length
  );

  return allTasks;
}

// ============================================================
// Получение сделок
// ============================================================

async function fetchLeadsByIds(ids) {
  if (!ids || ids.length === 0) {
    return [];
  }

  const uniqueIds = [
    ...new Set(
      ids
        .filter((id) => id !== null && id !== undefined)
        .map((id) => Number(id))
    ),
  ];

  const allLeads = [];

  // amoCRM позволяет передавать список ID.
// Чтобы запрос не стал слишком длинным, делаем пачки по 100.

  for (
    let start = 0;
    start < uniqueIds.length;
    start += 100
  ) {
    const chunk = uniqueIds.slice(
      start,
      start + 100
    );

    const params = new URLSearchParams();

    chunk.forEach((id) => {
      params.append(
        "filter[id][]",
        String(id)
      );
    });

    params.set("with", "contacts");
    params.set("limit", "250");

    const data = await amocrmRequest(
      `/api/v4/leads?${params.toString()}`
    );

    const leads =
      data &&
      data._embedded &&
      data._embedded.leads
        ? data._embedded.leads
        : [];

    allLeads.push(...leads);
  }

  return allLeads;
}

// ============================================================
// Получение контакта
// ============================================================

async function fetchContactInfo(contactId) {
  if (!contactId) {
    return {
      name: null,
      phones: [],
    };
  }

  const contact = await amocrmRequest(
    `/api/v4/contacts/${contactId}`
  );

  if (!contact) {
    return {
      name: null,
      phones: [],
    };
  }

  const phones = [];

  if (contact.custom_fields_values) {
    for (
      const field of contact.custom_fields_values
    ) {
      if (
        field.field_code === "PHONE" &&
        field.values
      ) {
        for (const value of field.values) {
          if (
            value.value !== undefined &&
            value.value !== null
          ) {
            phones.push(String(value.value));
          }
        }
      }
    }
  }

  return {
    name: contact.name || null,
    phones,
  };
}

// ============================================================
// СБОР ЗАМЕРОВ
// ============================================================

async function buildMeasurementsList() {
  // 1. Получаем задачи
  const tasks = await fetchMeasurementTasks();

  if (tasks.length === 0) {
    return [];
  }

  // 2. Из задач берём только задачи, привязанные к сделкам
  const leadIds = tasks
    .filter(
      (task) =>
        task.entity_type === "leads" &&
        task.entity_id
    )
    .map((task) => task.entity_id);

  const uniqueLeadIds = [
    ...new Set(leadIds),
  ];

  console.log(
    "Количество связанных сделок:",
    uniqueLeadIds.length
  );

  if (uniqueLeadIds.length === 0) {
    return [];
  }

  // 3. Получаем сделки
  const leads = await fetchLeadsByIds(
    uniqueLeadIds
  );

  console.log(
    "Получено сделок:",
    leads.length
  );

  // 4. Оставляем только сделки Марины
  const marinaLeads = leads.filter(
    isMarinaEngineer
  );

  console.log(
    `Сделок с инженером ${ENGINEER_NAME}:`,
    marinaLeads.length
  );

  // 5. Собираем итоговый список
  const results = [];

  for (const lead of marinaLeads) {
    let contactInfo = {
      name: null,
      phones: [],
    };

    const contacts =
      lead._embedded &&
      lead._embedded.contacts
        ? lead._embedded.contacts
        : [];

    // Сначала пытаемся взять основной контакт
    const mainContact =
      contacts.find(
        (contact) => contact.is_main === true
      ) ||
      contacts[0];

    if (mainContact) {
      contactInfo =
        await fetchContactInfo(
          mainContact.id
        );
    }

    results.push({
      lead_id: lead.id,

      lead_link: leadLink(
        lead.id
      ),

      contract_number:
        getCustomFieldText(
          lead,
          FIELD_IDS.contractNumber
        ),

      measure_date:
        getCustomFieldDate(
          lead,
          FIELD_IDS.measureDate
        ),

      measure_time:
        getCustomFieldText(
          lead,
          FIELD_IDS.measureTime
        ),

      measure_address:
        getCustomFieldText(
          lead,
          FIELD_IDS.measureAddress
        ),

      product:
        getCustomFieldText(
          lead,
          FIELD_IDS.product
        ),

      client_name:
        contactInfo.name,

      client_phones:
        contactInfo.phones,

      engineer:
        ENGINEER_NAME,
    });
  }

  return results;
}

// ============================================================
// Формирование списка для сообщения
// ============================================================

function formatMessageText(measurements) {
  return measurements
    .map((m) => {
      return [
        `№ договора: ${
          m.contract_number || "—"
        }`,

        `Дата замера: ${
          m.measure_date || "—"
        }`,

        `Время замера: ${
          m.measure_time || "—"
        }`,

        `Адрес объекта: ${
          m.measure_address || "—"
        }`,

        `Продукт: ${
          m.product || "—"
        }`,

        `Имя клиента: ${
          m.client_name || "—"
        }`,

        `№ телефона: ${
          m.client_phones &&
          m.client_phones.length
            ? m.client_phones.join(", ")
            : "—"
        }`,

        `Ссылка на сделку: ${
          m.lead_link
        }`,
      ].join("; ");
    })
    .join("\n");
}

// ============================================================
// Подробности одного выбранного замера
// ============================================================

function formatMeasurementDetails(measurement) {
  return [
    `Дата замера: ${
      measurement.measure_date || "—"
    }`,

    `Время замера: ${
      measurement.measure_time || "—"
    }`,

    `Адрес объекта: ${
      measurement.measure_address || "—"
    }`,

    `Продукт: ${
      measurement.product || "—"
    }`,

    `Имя клиента: ${
      measurement.client_name || "—"
    }`,

    `№ телефона: ${
      measurement.client_phones &&
      measurement.client_phones.length
        ? measurement.client_phones.join(", ")
        : "—"
    }`,

    `№ договора: ${
      measurement.contract_number || "—"
    }`,

    `Ссылка на сделку: ${
      measurement.lead_link
    }`,
  ].join("\n");
}

// ============================================================
// ГЛАВНАЯ ЛОГИКА
// ============================================================

// Пользователь передал управление нашему виджету.
// После этого мы получаем задачи и показываем список.

async function handleControlTransferred(body) {
  const payload =
    body._embedded &&
    body._embedded.rpa_bot_control_transferred;

  if (!payload) {
    console.log(
      "Нет rpa_bot_control_transferred в webhook."
    );
    return;
  }

  const botId = payload.bot_id;

  const request =
    payload._embedded &&
    payload._embedded.request;

  if (!request) {
    console.log(
      "В webhook нет request."
    );
    return;
  }

  const requestId = request.id;

  const receiverUserId =
    request.author_id;

  console.log(
    "Получено управление от Salesbot."
  );

  console.log(
    "botId:",
    botId
  );

  console.log(
    "requestId:",
    requestId
  );

  console.log(
    "receiverUserId:",
    receiverUserId
  );

  try {
    const measurements =
      await buildMeasurementsList();

    // Если ничего не нашли
    if (
      !measurements ||
      measurements.length === 0
    ) {
      const range =
        getDateRange();

      await sendBotMessage(
        botId,
        requestId,

        `Замеры для инженера ${ENGINEER_NAME} не найдены.`,

        null,

        receiverUserId
      );

      console.log(
        "Замеры не найдены."
      );

      console.log(
        "Диапазон:",
        new Date(
          range.from * 1000
        ).toLocaleString(
          "ru-RU",
          {
            timeZone:
              TIME_ZONE,
          }
        ),
        "→",
        new Date(
          range.to * 1000
        ).toLocaleString(
          "ru-RU",
          {
            timeZone:
              TIME_ZONE,
          }
        )
      );

      await returnControl(
        botId,
        requestId,
        "success"
      );

      return;
    }

    // Сохраняем список для обработки
    // нажатия кнопки.
    activeRequests.set(
      requestId,
      {
        botId,
        measurements,
      }
    );

    // Текст списка
    const listText =
      formatMessageText(
        measurements
      );

    // Кнопки = номера договоров
    const buttonTexts =
      measurements.map(
        (measurement) =>
          measurement.contract_number ||
          String(
            measurement.lead_id
          )
      );

    const message =
      `Замеры для инженера ${ENGINEER_NAME}:\n\n` +
      listText +
      "\n\nВыберите замер:";

    await sendBotMessage(
      botId,
      requestId,
      message,
      buttonTexts,
      receiverUserId
    );

    // Управление НЕ возвращаем.
    // Ждём нажатия кнопки.
  } catch (error) {
    console.error(
      "Ошибка при поиске замеров:",
      error.details ||
        error.message
    );

    await sendBotMessage(
      botId,
      requestId,
      "Произошла ошибка при получении замеров из amoCRM. Подробности есть в логах сервера.",
      null,
      receiverUserId
    );

    await returnControl(
      botId,
      requestId,
      "error"
    );
  }
}

// ============================================================
// Обработка нажатия кнопки
// ============================================================

async function handleIncomeMessage(body) {
  const payload =
    body._embedded &&
    body._embedded.rpa_bot_income_message;

  if (!payload) {
    return;
  }

  const botId =
    payload.bot_id;

  const request =
    payload._embedded &&
    payload._embedded.request;

  if (!request) {
    return;
  }

  const requestId =
    request.id;

  const receiverUserId =
    request.author_id;

  const incomeMessage =
    payload._embedded &&
    payload._embedded.income_message;

  const messageText =
    incomeMessage &&
    incomeMessage.text
      ? String(
          incomeMessage.text
        ).trim()
      : "";

  console.log(
    "Получено сообщение от пользователя:",
    messageText
  );

  const session =
    activeRequests.get(
      requestId
    );

  // Если сервер сейчас не ждёт
  // выбора замера
  if (!session) {
    console.log(
      "Для этого requestId нет активной сессии."
    );

    return;
  }

  // Ищем замер по тексту кнопки
  const chosen =
    session.measurements.find(
      (measurement) => {
        const buttonText =
          measurement.contract_number ||
          String(
            measurement.lead_id
          );

        return (
          buttonText ===
          messageText
        );
      }
    );

  // Если договор не найден
  if (!chosen) {
    await sendBotMessage(
      botId,
      requestId,

      "Не удалось определить выбранный замер. Пожалуйста, нажмите одну из кнопок выше.",

      session.measurements.map(
        (measurement) =>
          measurement.contract_number ||
          String(
            measurement.lead_id
          )
      ),

      receiverUserId
    );

    return;
  }

  // Формируем подробности
  const detailText =
    formatMeasurementDetails(
      chosen
    );

  await sendBotMessage(
    botId,
    requestId,
    detailText,
    null,
    receiverUserId
  );

  // После выбора замера
  // передаём управление обратно Salesbot.
  activeRequests.delete(
    requestId
  );

  await returnControl(
    botId,
    requestId,
    "success"
  );
}

// ============================================================
// WEBHOOK amoMessenger
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
    const body = req.body;

    const eventType =
      body.event_type;

    console.log(
      "================================================"
    );

    console.log(
      "Webhook amoMessenger:"
    );

    console.log(
      "event_type:",
      eventType
    );

    console.log(
      JSON.stringify(
        body,
        null,
        2
      )
    );

    console.log(
      "================================================"
    );

    // Сразу отвечаем amoMessenger,
    // чтобы webhook не ждал долгой обработки.
    res.status(200).json({
      ok: true,
    });

    try {
      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        await handleControlTransferred(
          body
        );
      } else if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        await handleIncomeMessage(
          body
        );
      } else {
        console.log(
          "Событие пока не обрабатывается:",
          eventType
        );
      }
    } catch (error) {
      console.error(
        "Ошибка обработки webhook:",
        error.details ||
          error.message
      );
    }
  }
);

// ============================================================
// ПРОВЕРКА РАБОТЫ СЕРВЕРА
// ============================================================

app.get("/", (req, res) => {
  res.send(
    "OK. Сервер amoMessenger + amoCRM запущен."
  );
});

// ============================================================
// ТЕСТ СВЯЗИ С amoCRM
// ============================================================

app.get(
  "/debug/amocrm-test",
  async (req, res) => {
    try {
      const account =
        await amocrmRequest(
          "/api/v4/account"
        );

      res.json({
        status:
          "Связь с amoCRM работает!",
        account_name:
          account.name,
        account_id:
          account.id,
        subdomain:
          account.subdomain,
      });
    } catch (error) {
      console.error(
        "Ошибка проверки amoCRM:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка связи с amoCRM",
        message:
          error.message,
        details:
          error.details ||
          null,
      });
    }
  }
);

// ============================================================
// ПРОВЕРКА ПОЛЯ ИНЖЕНЕР
//
// Откройте:
// /debug/engineer-field
//
// Здесь мы должны увидеть:
// поле 203849
// Марина Трафимова
// enum ID 1059150
// ============================================================

app.get(
  "/debug/engineer-field",
  async (req, res) => {
    try {
      const field =
        await amocrmRequest(
          `/api/v4/leads/custom_fields/${ENGINEER_FIELD_ID}`
        );

      const enums =
        field &&
        field.enums
          ? field.enums
          : [];

      const marina =
        enums.find(
          (item) =>
            Number(item.id) ===
            Number(
              ENGINEER_ENUM_ID
            )
        ) ||
        enums.find(
          (item) =>
            String(
              item.value
            ).trim() ===
            ENGINEER_NAME
        );

      res.json({
        status: "OK",

        field: {
          id: field.id,
          name: field.name,
          type: field.type,
        },

        expected_engineer: {
          name: ENGINEER_NAME,
          enum_id:
            ENGINEER_ENUM_ID,
        },

        found_engineer:
          marina || null,

        all_values:
          enums,
      });
    } catch (error) {
      console.error(
        "Ошибка получения поля Инженер:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status: "Ошибка",
        message:
          error.message,
        details:
          error.details ||
          null,
      });
    }
  }
);

// ============================================================
// ТЕСТ СДЕЛОК МАРИНЫ
//
// Откройте:
// /debug/marina-leads
//
// Показывает сделки, в которых:
// Инженер = Марина Трафимова
// ============================================================

app.get(
  "/debug/marina-leads",
  async (req, res) => {
    try {
      const params =
        new URLSearchParams();

      params.set(
        "filter[custom_fields_values][" +
          ENGINEER_FIELD_ID +
          "][]",
        String(
          ENGINEER_ENUM_ID
        )
      );

      params.set(
        "with",
        "contacts"
      );

      params.set(
        "limit",
        "250"
      );

      const data =
        await amocrmRequest(
          `/api/v4/leads?${params.toString()}`
        );

      const leads =
        data &&
        data._embedded &&
        data._embedded.leads
          ? data._embedded.leads
          : [];

      res.json({
        status: "OK",

        filter: {
          field_id:
            ENGINEER_FIELD_ID,

          engineer:
            ENGINEER_NAME,

          enum_id:
            ENGINEER_ENUM_ID,
        },

        found_count:
          leads.length,

        leads:
          leads.map(
            (lead) => ({
              id:
                lead.id,

              name:
                lead.name,

              contract_number:
                getCustomFieldText(
                  lead,
                  FIELD_IDS.contractNumber
                ),

              engineer:
                getCustomFieldText(
                  lead,
                  ENGINEER_FIELD_ID
                ),

              link:
                leadLink(
                  lead.id
                ),
            })
          ),
      });
    } catch (error) {
      console.error(
        "Ошибка поиска сделок Марины:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status: "Ошибка",
        message:
          error.message,
        details:
          error.details ||
          null,
      });
    }
  }
);

// ============================================================
// ТЕСТ ВСЕГО ПОИСКА ЗАМЕРОВ
//
// Откройте:
// /debug/tasks-test
//
// Здесь проверяется:
// задачи → сделки → инженер → контакты → поля сделки
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {
    try {
      const range =
        getDateRange();

      const measurements =
        await buildMeasurementsList();

      res.json({
        status: "OK",

        timezone:
          TIME_ZONE,

        current_moscow_time:
          new Intl.DateTimeFormat(
            "ru-RU",
            {
              timeZone:
                TIME_ZONE,
              dateStyle:
                "short",
              timeStyle:
                "medium",
            }
          ).format(
            new Date()
          ),

        engineer: {
          name:
            ENGINEER_NAME,

          field_id:
            ENGINEER_FIELD_ID,

          enum_id:
            ENGINEER_ENUM_ID,
        },

        task_type_id:
          TASK_TYPE_ID,

        date_range: {
          from:
            new Date(
              range.from *
                1000
            ).toLocaleString(
              "ru-RU",
              {
                timeZone:
                  TIME_ZONE,
              }
            ),

          to:
            new Date(
              range.to *
                1000
            ).toLocaleString(
              "ru-RU",
              {
                timeZone:
                  TIME_ZONE,
              }
            ),
        },

        found_count:
          measurements.length,

        measurements:
          measurements,

        message_preview:
          formatMessageText(
            measurements
          ),
      });
    } catch (error) {
      console.error(
        "Ошибка tasks-test:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status: "Ошибка",
        message:
          error.message,
        details:
          error.details ||
          null,
      });
    }
  }
);

// ============================================================
// УСТАНОВКА БОТА amoMessenger
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    const {
      code,
    } = req.query;

    console.log(
      "=== Установка бота amoMessenger ==="
    );

    console.log(
      "code:",
      code
    );

    if (!code) {
      return res
        .status(400)
        .send(
          "Не хватает параметра code."
        );
    }

    const CLIENT_ID =
      process.env
        .AMOMESSENGER_CLIENT_ID;

    const CLIENT_SECRET =
      process.env
        .AMOMESSENGER_CLIENT_SECRET;

    const REDIRECT_URI =
      process.env
        .AMOMESSENGER_REDIRECT_URI;

    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !REDIRECT_URI
    ) {
      return res
        .status(500)
        .send(
          "На Render не заданы AMOMESSENGER_CLIENT_ID / AMOMESSENGER_CLIENT_SECRET / AMOMESSENGER_REDIRECT_URI."
        );
    }

    try {
      const tokenResponse =
        await fetch(
          "https://id.amo.tm/oauth2/access_token",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                client_id:
                  CLIENT_ID,

                client_secret:
                  CLIENT_SECRET,

                grant_type:
                  "authorization_code",

                code:
                  code,

                redirect_uri:
                  REDIRECT_URI,
              }),
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (
        !tokenResponse.ok
      ) {
        console.log(
          "Ошибка обмена кода:",
          tokenData
        );

        return res
          .status(500)
          .send(
            "amoMessenger отклонила обмен кода на токен. Подробности в логах Render."
          );
      }

      saveJsonFile(
        AMOMESSENGER_TOKENS_FILE,
        {
          access_token:
            tokenData.access_token,

          refresh_token:
            tokenData.refresh_token,

          expires_in:
            tokenData.expires_in,

          obtained_at:
            new Date().toISOString(),
        }
      );

      console.log(
        "Бот amoMessenger успешно установлен."
      );

      res.send(
        "Готово! Бот amoMessenger успешно установлен. Эту страницу можно закрыть."
      );
    } catch (error) {
      console.error(
        "Ошибка установки amoMessenger:",
        error
      );

      res
        .status(500)
        .send(
          "Произошла ошибка при установке. Подробности в логах Render."
        );
    }
  }
);

// ============================================================
// ПРОВЕРКА ТОКЕНА amoMessenger
// ============================================================

app.get(
  "/debug/amomessenger-token",
  (req, res) => {
    const tokens =
      loadJsonFile(
        AMOMESSENGER_TOKENS_FILE
      );

    if (!tokens) {
      return res.json({
        status:
          "Токен ещё не сохранён.",
      });
    }

    res.json({
      status:
        "Токен найден",

      access_token_preview:
        tokens.access_token
          ? tokens.access_token.slice(
              0,
              15
            ) + "..."
          : null,

      obtained_at:
        tokens.obtained_at,
    });
  }
);

// ============================================================
// ПОСЛЕДНИЕ WEBHOOK
// ============================================================

app.get(
  "/debug/last",
  (req, res) => {
    res.json(
      lastRequests
    );
  }
);

// ============================================================
// НАСТРОЙКА ВИДЖЕТА
// ============================================================

app.post(
  "/",
  (req, res) => {
    console.log(
      "=== Открыта настройка виджета ==="
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>amoMessenger Widget</title>
</head>

<body style="
  font-family: Arial, sans-serif;
  padding: 20px;
">

  <h3>Виджет «Отчёт инженеров»</h3>

  <p>
    Виджет готов к работе.
  </p>

  <p>
    Инженер:
    <strong>${ENGINEER_NAME}</strong>
  </p>

  <p>
    ID значения:
    <strong>${ENGINEER_ENUM_ID}</strong>
  </p>

  <script src="https://js.amo.tm/v1/sdk.js"></script>

  <script>
    try {
      var amoSDK = window.AmoSDK();

      amoSDK.setInputValues({
        ready: "true"
      });

    } catch (e) {
      console.error(
        "SDK error",
        e
      );
    }
  </script>

</body>
</html>
`);
  }
);

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      "================================================"
    );

    console.log(
      "Сервер amoMessenger + amoCRM запущен."
    );

    console.log(
      "Порт:",
      PORT
    );

    console.log(
      "Инженер:",
      ENGINEER_NAME
    );

    console.log(
      "Engineer field ID:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "Engineer enum ID:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "Task type ID:",
      TASK_TYPE_ID
    );

    console.log(
      "Timezone:",
      TIME_ZONE
    );

    console.log(
      "================================================"
    );
  }
);
