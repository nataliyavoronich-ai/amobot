// ============================================================
// amoMessenger + amoCRM
// Версия 0.2 — диагностика сделок и задач
//
// Тестовый инженер:
// Марина Трафимова
//
// Поле Инженер:
// ID = 203849
//
// Значение Марина Трафимова:
// enum ID = 1059150
//
// Тип задачи:
// Подтв. замер(и)
// ID = 2746005
//
// Часовой пояс:
// Europe/Moscow
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const TIME_ZONE = "Europe/Moscow";

// ------------------------------------------------------------
// amoCRM
// ------------------------------------------------------------

const TASK_TYPE_ID = 2746005;

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;

const ENGINEER_NAME = "Марина Трафимова";

// ------------------------------------------------------------
// Поля сделки
// ------------------------------------------------------------

const FIELD_IDS = {
  contractNumber: 412776,
  measureDate: 175370,
  measureTime: 413828,
  measureAddress: 175412,
  product: 172572,
};

// ------------------------------------------------------------
// amoMessenger
// ------------------------------------------------------------

const AMOMESSENGER_TOKENS_FILE = path.join(
  __dirname,
  "amomessenger_tokens.json"
);

// ------------------------------------------------------------
// Хранилище текущих запросов
// ------------------------------------------------------------

const activeRequests = new Map();

// ------------------------------------------------------------
// Последние входящие запросы
// ------------------------------------------------------------

const lastRequests = [];
const MAX_STORED = 30;


// ============================================================
// СОХРАНЕНИЕ ВХОДЯЩИХ ЗАПРОСОВ
// ============================================================

function storeRequest(req) {
  lastRequests.unshift({
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
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


// ============================================================
// JSON ФАЙЛ
// ============================================================

function saveJsonFile(filePath, data) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2)
  );
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (error) {
    return null;
  }
}


// ============================================================
// amoCRM API
// ============================================================

async function amocrmRequest(pathAndQuery) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_TOKEN;

  if (!domain) {
    throw new Error(
      "Не задана переменная AMOCRM_DOMAIN."
    );
  }

  if (!token) {
    throw new Error(
      "Не задана переменная AMOCRM_TOKEN."
    );
  }

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const url =
    `https://${cleanDomain}${pathAndQuery}`;

  console.log(
    "amoCRM GET:",
    url
  );

  const response = await fetch(
    url,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${token}`,

        "Content-Type":
          "application/json",
      },
    }
  );

  if (response.status === 204) {
    return null;
  }

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    const error = new Error(
      `amoCRM ответила с ошибкой HTTP ${response.status}`
    );

    error.status =
      response.status;

    error.details =
      data;

    throw error;
  }

  return data;
}


// ============================================================
// amoMessenger API
// ============================================================

async function amoMessengerRequest(
  method,
  pathAndQuery,
  body
) {
  const tokens =
    loadJsonFile(
      AMOMESSENGER_TOKENS_FILE
    );

  if (
    !tokens ||
    !tokens.access_token
  ) {
    throw new Error(
      "Нет сохранённого токена amoMessenger."
    );
  }

  const response =
    await fetch(
      `https://api.amo.tm${pathAndQuery}`,
      {
        method,

        headers: {
          Authorization:
            `Bearer ${tokens.access_token}`,

          "Content-Type":
            "application/json",
        },

        body:
          body
            ? JSON.stringify(body)
            : undefined,
      }
    );

  if (response.status === 204) {
    return null;
  }

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    const error = new Error(
      `amoMessenger API ответила с ошибкой HTTP ${response.status}`
    );

    error.status =
      response.status;

    error.details =
      data;

    throw error;
  }

  return data;
}


// ============================================================
// Отправка сообщения в amoMessenger
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
      user_id:
        receiverUserId,
    },
  };

  if (
    buttonTexts &&
    buttonTexts.length > 0
  ) {
    body.reply_markup = {
      inline_keyboard: {
        buttons:
          buttonTexts.map(
            (buttonText) => ({
              text:
                String(
                  buttonText
                ),
            })
          ),
      },
    };
  }

  return amoMessengerRequest(
    "POST",

    `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,

    body
  );
}


// ============================================================
// Вернуть управление Salesbot
// ============================================================

async function returnControl(
  botId,
  requestId,
  returnCode
) {
  return amoMessengerRequest(
    "POST",

    `/v1.3/bots/${botId}/request/${requestId}/returnControl`,

    {
      return_code:
        returnCode,
    }
  );
}


// ============================================================
// МОСКОВСКОЕ ВРЕМЯ
// ============================================================

function moscowNow() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TIME_ZONE,

        year: "numeric",
        month: "2-digit",
        day: "2-digit",

        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",

        hourCycle: "h23",
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (
    const part of parts
  ) {
    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] =
        Number(
          part.value
        );
    }
  }

  return {
    year:
      values.year,

    month:
      values.month,

    day:
      values.day,

    hour:
      values.hour,

    minute:
      values.minute,

    second:
      values.second,
  };
}


// ============================================================
// TIMESTAMP МОСКОВСКОГО ДНЯ
// ============================================================

function moscowDayTimestamp(
  offset,
  endOfDay = false
) {
  const now =
    moscowNow();

  const date =
    new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day,

        endOfDay
          ? 23
          : 0,

        endOfDay
          ? 59
          : 0,

        endOfDay
          ? 59
          : 0
      )
    );

  date.setUTCDate(
    date.getUTCDate() +
      offset
  );

  // Москва = UTC+3
  return Math.floor(
    (
      date.getTime() -
      3 * 60 * 60 * 1000
    ) / 1000
  );
}


// ============================================================
// ДИАПАЗОН ПОИСКА ЗАДАЧ
//
// До 18:00:
// вчера 00:00 → сейчас
//
// После 18:00:
// сегодня 00:00 → завтра 23:59
// ============================================================

function getDateRange() {
  const now =
    moscowNow();

  let from;
  let to;

  if (
    now.hour < 18
  ) {
    // Вчера 00:00
    from =
      moscowDayTimestamp(
        -1,
        false
      );

    // Сейчас
    const currentMoscowAsUtc =
      Date.UTC(
        now.year,
        now.month - 1,
        now.day,
        now.hour,
        now.minute,
        now.second
      );

    to =
      Math.floor(
        (
          currentMoscowAsUtc -
          3 * 60 * 60 * 1000
        ) / 1000
      );
  } else {
    // Сегодня 00:00
    from =
      moscowDayTimestamp(
        0,
        false
      );

    // Завтра 23:59:59
    to =
      moscowDayTimestamp(
        1,
        true
      );
  }

  return {
    from,
    to,
    moscowHour:
      now.hour,
    moscowMinute:
      now.minute,
  };
}


// ============================================================
// ПОЛЯ СДЕЛКИ
// ============================================================

function getRawCustomFieldValue(
  entity,
  fieldId
) {
  if (
    !entity ||
    !entity.custom_fields_values
  ) {
    return null;
  }

  const field =
    entity.custom_fields_values.find(
      (item) =>
        Number(
          item.field_id
        ) ===
        Number(
          fieldId
        )
    );

  if (
    !field ||
    !field.values ||
    field.values.length === 0
  ) {
    return null;
  }

  return field.values[0];
}


function getCustomFieldText(
  entity,
  fieldId
) {
  const item =
    getRawCustomFieldValue(
      entity,
      fieldId
    );

  if (!item) {
    return null;
  }

  if (
    item.value !==
      undefined &&
    item.value !== null
  ) {
    return String(
      item.value
    );
  }

  if (
    item.enum_id !==
      undefined &&
    item.enum_id !== null
  ) {
    return String(
      item.enum_id
    );
  }

  return null;
}


function formatDateField(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  let timestamp =
    null;

  if (
    typeof value ===
    "number"
  ) {
    timestamp =
      value;
  }

  if (
    typeof value ===
      "string" &&
    /^\d+$/.test(
      value
    )
  ) {
    timestamp =
      Number(value);
  }

  if (
    timestamp !== null &&
    timestamp >
      1000000000
  ) {
    return new Date(
      timestamp * 1000
    ).toLocaleDateString(
      "ru-RU",
      {
        timeZone:
          TIME_ZONE,
      }
    );
  }

  return String(
    value
  );
}


function getCustomFieldDate(
  entity,
  fieldId
) {
  const item =
    getRawCustomFieldValue(
      entity,
      fieldId
    );

  if (!item) {
    return null;
  }

  return formatDateField(
    item.value
  );
}


// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function isMarinaEngineer(
  lead
) {
  const item =
    getRawCustomFieldValue(
      lead,
      ENGINEER_FIELD_ID
    );

  if (!item) {
    return false;
  }

  // Главный вариант
  if (
    item.enum_id !==
      undefined &&
    Number(
      item.enum_id
    ) ===
      Number(
        ENGINEER_ENUM_ID
      )
  ) {
    return true;
  }

  // Запасной вариант
  if (
    item.value !==
      undefined &&
    String(
      item.value
    ).trim() ===
      ENGINEER_NAME
  ) {
    return true;
  }

  return false;
}


// ============================================================
// ССЫЛКА НА СДЕЛКУ
// ============================================================

function leadLink(
  leadId
) {
  const domain =
    (
      process.env
        .AMOCRM_DOMAIN ||
      ""
    )
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /\/+$/,
        ""
      );

  return `https://${domain}/leads/detail/${leadId}`;
}


// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ СДЕЛОК
//
// ВАЖНО:
// Здесь специально НЕ используем фильтр по полю Инженер,
// потому что предыдущий вариант дал HTTP 400.
//
// Получаем сделки страницами и фильтруем Марину уже
// непосредственно в JavaScript.
// ============================================================

async function fetchAllLeads(
  maxPages = 5
) {
  const allLeads = [];

  for (
    let page = 1;
    page <= maxPages;
    page++
  ) {
    const params =
      new URLSearchParams();

    params.set(
      "with",
      "contacts"
    );

    params.set(
      "limit",
      "250"
    );

    params.set(
      "page",
      String(page)
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

    allLeads.push(
      ...leads
    );

    console.log(
      `Страница сделок ${page}: ${leads.length}`
    );

    if (
      leads.length < 250
    ) {
      break;
    }
  }

  return allLeads;
}


// ============================================================
// ПОЛУЧЕНИЕ СДЕЛОК ПО ID
// ============================================================

async function fetchLeadsByIds(
  ids
) {
  if (
    !ids ||
    ids.length === 0
  ) {
    return [];
  }

  const uniqueIds = [
    ...new Set(
      ids
        .filter(
          (id) =>
            id !== null &&
            id !== undefined
        )
        .map(
          (id) =>
            Number(id)
        )
    ),
  ];

  const allLeads = [];

  for (
    let start = 0;
    start <
      uniqueIds.length;
    start += 100
  ) {
    const chunk =
      uniqueIds.slice(
        start,
        start + 100
      );

    const params =
      new URLSearchParams();

    chunk.forEach(
      (id) => {
        params.append(
          "filter[id][]",
          String(id)
        );
      }
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

    allLeads.push(
      ...leads
    );
  }

  return allLeads;
}


// ============================================================
// КОНТАКТ
// ============================================================

async function fetchContactInfo(
  contactId
) {
  if (!contactId) {
    return {
      name: null,
      phones: [],
    };
  }

  const contact =
    await amocrmRequest(
      `/api/v4/contacts/${contactId}`
    );

  if (!contact) {
    return {
      name: null,
      phones: [],
    };
  }

  const phones = [];

  if (
    contact.custom_fields_values
  ) {
    for (
      const field of
      contact.custom_fields_values
    ) {
      if (
        field.field_code ===
          "PHONE" &&
        field.values
      ) {
        for (
          const value of
          field.values
        ) {
          if (
            value.value !==
              undefined &&
            value.value !==
              null
          ) {
            phones.push(
              String(
                value.value
              )
            );
          }
        }
      }
    }
  }

  return {
    name:
      contact.name ||
      null,

    phones,
  };
}


// ============================================================
// ДИАГНОСТИКА ЗАДАЧ
//
// Здесь специально сначала получаем задачи БЕЗ фильтра
// по датам и смотрим, что реально возвращает amoCRM.
//
// Это поможет понять правильный формат фильтра.
// ============================================================

async function fetchRawTasks(
  limit = 250
) {
  const params =
    new URLSearchParams();

  params.set(
    "limit",
    String(limit)
  );

  params.set(
    "page",
    "1"
  );

  const data =
    await amocrmRequest(
      `/api/v4/tasks?${params.toString()}`
    );

  const tasks =
    data &&
    data._embedded &&
    data._embedded.tasks
      ? data._embedded.tasks
      : [];

  return {
    data,
    tasks,
  };
}


// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ ТИПА 2746005
//
// Пока используем только фильтр task_type.
// Дату добавим после проверки реального ответа API.
// ============================================================

async function fetchMeasurementTasksRaw() {
  const params =
    new URLSearchParams();

  params.set(
    "filter[task_type]",
    String(
      TASK_TYPE_ID
    )
  );

  params.set(
    "limit",
    "250"
  );

  params.set(
    "page",
    "1"
  );

  const data =
    await amocrmRequest(
      `/api/v4/tasks?${params.toString()}`
    );

  const tasks =
    data &&
    data._embedded &&
    data._embedded.tasks
      ? data._embedded.tasks
      : [];

  return {
    data,
    tasks,
  };
}


// ============================================================
// ПОДРОБНАЯ ДИАГНОСТИКА ЗАДАЧ
// ============================================================

app.get(
  "/debug/raw-tasks",
  async (req, res) => {
    try {
      const result =
        await fetchRawTasks(
          250
        );

      res.json({
        status:
          "OK",

        total_returned:
          result.tasks.length,

        tasks:
          result.tasks,
      });
    } catch (error) {
      console.error(
        "Ошибка raw-tasks:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка",

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
// ЗАДАЧИ ТИПА 2746005
// ============================================================

app.get(
  "/debug/measurement-tasks",
  async (req, res) => {
    try {
      const result =
        await fetchMeasurementTasksRaw();

      res.json({
        status:
          "OK",

        task_type_id:
          TASK_TYPE_ID,

        total_returned:
          result.tasks.length,

        tasks:
          result.tasks,
      });
    } catch (error) {
      console.error(
        "Ошибка measurement-tasks:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка",

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
// ПОИСК СДЕЛОК МАРИНЫ
//
// Получаем сделки без фильтра API и проверяем поле
// непосредственно в каждой сделке.
// ============================================================

app.get(
  "/debug/marina-leads",
  async (req, res) => {
    try {
      console.log(
        "Начинаем поиск сделок Марины..."
      );

      const allLeads =
        await fetchAllLeads(
          5
        );

      console.log(
        "Всего получено сделок:",
        allLeads.length
      );

      const marinaLeads =
        allLeads.filter(
          isMarinaEngineer
        );

      console.log(
        "Сделок Марины:",
        marinaLeads.length
      );

      res.json({
        status:
          "OK",

        method:
          "Получение сделок без фильтра + проверка поля в ответе",

        engineer: {
          name:
            ENGINEER_NAME,

          field_id:
            ENGINEER_FIELD_ID,

          enum_id:
            ENGINEER_ENUM_ID,
        },

        total_leads_loaded:
          allLeads.length,

        marina_leads_count:
          marinaLeads.length,

        leads:
          marinaLeads.map(
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

              engineer_raw:
                getRawCustomFieldValue(
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
        "Ошибка marina-leads:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка",

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
// ПОЛУЧЕНИЕ ЗАДАЧ С ФИЛЬТРОМ ПО ТИПУ
// ============================================================

async function fetchMeasurementTasks() {
  const result =
    await fetchMeasurementTasksRaw();

  console.log(
    `Задач типа ${TASK_TYPE_ID}: ${result.tasks.length}`
  );

  return result.tasks;
}


// ============================================================
// ПОСТРОЕНИЕ ЗАМЕРОВ
//
// В ЭТОЙ ВЕРСИИ:
// 1. Получаем задачи типа 2746005.
// 2. Смотрим entity_id.
// 3. Получаем соответствующие сделки.
// 4. Проверяем Инженер = Марина.
// 5. Формируем данные сделки.
//
// Фильтр по датам пока намеренно НЕ применяем.
// Сначала проверяем реальные данные задач.
// ============================================================

async function buildMeasurementsList() {
  const tasks =
    await fetchMeasurementTasks();

  if (
    tasks.length === 0
  ) {
    return [];
  }

  const taskLeadPairs =
    tasks
      .filter(
        (task) =>
          task.entity_type ===
            "leads" &&
          task.entity_id
      )
      .map(
        (task) => ({
          task,
          lead_id:
            task.entity_id,
        })
      );

  console.log(
    "Задач, привязанных к сделкам:",
    taskLeadPairs.length
  );

  const leadIds =
    taskLeadPairs.map(
      (item) =>
        item.lead_id
    );

  const uniqueLeadIds = [
    ...new Set(
      leadIds
    ),
  ];

  const leads =
    await fetchLeadsByIds(
      uniqueLeadIds
    );

  console.log(
    "Получено связанных сделок:",
    leads.length
  );

  const marinaLeads =
    leads.filter(
      isMarinaEngineer
    );

  console.log(
    `Сделок с инженером ${ENGINEER_NAME}:`,
    marinaLeads.length
  );

  const results = [];

  for (
    const lead of
    marinaLeads
  ) {
    let contactInfo = {
      name: null,
      phones: [],
    };

    const contacts =
      lead._embedded &&
      lead._embedded.contacts
        ? lead._embedded.contacts
        : [];

    const mainContact =
      contacts.find(
        (contact) =>
          contact.is_main ===
          true
      ) ||
      contacts[0];

    if (
      mainContact
    ) {
      try {
        contactInfo =
          await fetchContactInfo(
            mainContact.id
          );
      } catch (
        contactError
      ) {
        console.error(
          "Ошибка получения контакта:",
          contactError.message
        );
      }
    }

    const relatedTask =
      taskLeadPairs.find(
        (item) =>
          Number(
            item.lead_id
          ) ===
          Number(
            lead.id
          )
      );

    results.push({
      task_id:
        relatedTask &&
        relatedTask.task
          ? relatedTask.task.id
          : null,

      task_complete_till:
        relatedTask &&
        relatedTask.task
          ? relatedTask.task
              .complete_till
          : null,

      lead_id:
        lead.id,

      lead_link:
        leadLink(
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
// ТЕСТ ВСЕЙ ЦЕПОЧКИ
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
        status:
          "OK",

        note:
          "В этой диагностической версии фильтр по датам пока НЕ применяется.",

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

        planned_date_range: {
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
      });
    } catch (error) {
      console.error(
        "Ошибка tasks-test:",
        error.details ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка",

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
// ФОРМАТ СПИСКА ЗАМЕРОВ
// ============================================================

function formatMessageText(
  measurements
) {
  return measurements
    .map(
      (m) => {
        return [
          `№ договора: ${
            m.contract_number ||
            "—"
          }`,

          `Дата замера: ${
            m.measure_date ||
            "—"
          }`,

          `Время замера: ${
            m.measure_time ||
            "—"
          }`,

          `Адрес объекта: ${
            m.measure_address ||
            "—"
          }`,

          `Продукт: ${
            m.product ||
            "—"
          }`,

          `Имя клиента: ${
            m.client_name ||
            "—"
          }`,

          `№ телефона: ${
            m.client_phones &&
            m.client_phones.length
              ? m.client_phones.join(
                  ", "
                )
              : "—"
          }`,

          `Ссылка на сделку: ${
            m.lead_link
          }`,
        ].join(
          "; "
        );
      }
    )
    .join(
      "\n"
    );
}


// ============================================================
// ПОДРОБНОСТИ ЗАМЕРА
// ============================================================

function formatMeasurementDetails(
  measurement
) {
  return [
    `Дата замера: ${
      measurement.measure_date ||
      "—"
    }`,

    `Время замера: ${
      measurement.measure_time ||
      "—"
    }`,

    `Адрес объекта: ${
      measurement.measure_address ||
      "—"
    }`,

    `Продукт: ${
      measurement.product ||
      "—"
    }`,

    `Имя клиента: ${
      measurement.client_name ||
      "—"
    }`,

    `№ телефона: ${
      measurement.client_phones &&
      measurement.client_phones.length
        ? measurement.client_phones.join(
            ", "
          )
        : "—"
    }`,

    `№ договора: ${
      measurement.contract_number ||
      "—"
    }`,

    `Ссылка на сделку: ${
      measurement.lead_link
    }`,
  ].join(
    "\n"
  );
}


// ============================================================
// WEBHOOK: ПЕРЕДАЧА УПРАВЛЕНИЯ БОТУ
// ============================================================

async function handleControlTransferred(
  body
) {
  const payload =
    body._embedded &&
    body._embedded
      .rpa_bot_control_transferred;

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

  console.log(
    "Получено управление ботом."
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

    if (
      measurements.length ===
      0
    ) {
      await sendBotMessage(
        botId,

        requestId,

        `Замеры для инженера ${ENGINEER_NAME} не найдены.`,

        null,

        receiverUserId
      );

      await returnControl(
        botId,

        requestId,

        "success"
      );

      return;
    }

    activeRequests.set(
      requestId,

      {
        botId,

        measurements,
      }
    );

    const listText =
      formatMessageText(
        measurements
      );

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

  } catch (error) {
    console.error(
      "Ошибка поиска замеров:",
      error.details ||
        error.message
    );

    await sendBotMessage(
      botId,

      requestId,

      "Произошла ошибка при получении данных из amoCRM.",

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
// WEBHOOK: НАЖАТИЕ КНОПКИ
// ============================================================

async function handleIncomeMessage(
  body
) {
  const payload =
    body._embedded &&
    body._embedded
      .rpa_bot_income_message;

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
    payload._embedded
      .income_message;

  const messageText =
    incomeMessage &&
    incomeMessage.text
      ? String(
          incomeMessage.text
        ).trim()
      : "";

  const session =
    activeRequests.get(
      requestId
    );

  if (!session) {
    console.log(
      "Нет активной сессии для requestId:",
      requestId
    );

    return;
  }

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

  if (!chosen) {
    await sendBotMessage(
      botId,

      requestId,

      "Не удалось определить выбранный замер. Пожалуйста, нажмите кнопку с номером договора.",

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
  async (
    req,
    res
  ) => {
    const body =
      req.body;

    const eventType =
      body.event_type;

    console.log(
      "================================================"
    );

    console.log(
      "Webhook amoMessenger"
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

    // Отвечаем сразу
    res.status(
      200
    ).json({
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
      }

      else if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        await handleIncomeMessage(
          body
        );
      }

      else {
        console.log(
          "Событие пока не обрабатывается:",
          eventType
        );
      }
    }

    catch (
      error
    ) {
      console.error(
        "Ошибка webhook:",
        error.details ||
          error.message
      );
    }
  }
);


// ============================================================
// ГЛАВНАЯ
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.send(
      "OK. amoMessenger + amoCRM сервер работает."
    );
  }
);


// ============================================================
// ПРОВЕРКА amoCRM
// ============================================================

app.get(
  "/debug/amocrm-test",
  async (
    req,
    res
  ) => {
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
    }

    catch (
      error
    ) {
      res.status(
        500
      ).json({
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
// ============================================================

app.get(
  "/debug/engineer-field",
  async (
    req,
    res
  ) => {
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
            Number(
              item.id
            ) ===
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
        status:
          "OK",

        field: {
          id:
            field.id,

          name:
            field.name,

          type:
            field.type,
        },

        expected_engineer: {
          name:
            ENGINEER_NAME,

          enum_id:
            ENGINEER_ENUM_ID,
        },

        found_engineer:
          marina ||
          null,

        all_values:
          enums,
      });
    }

    catch (
      error
    ) {
      res.status(
        500
      ).json({
        status:
          "Ошибка",

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
// УСТАНОВКА amoMessenger
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (
    req,
    res
  ) => {
    const {
      code,
    } =
      req.query;

    if (!code) {
      return res
        .status(
          400
        )
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
        .status(
          500
        )
        .send(
          "Не заданы переменные amoMessenger."
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
          tokenData
        );

        return res
          .status(
            500
          )
          .send(
            "amoMessenger отклонила авторизацию."
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

      res.send(
        "Готово! amoMessenger успешно подключён."
      );
    }

    catch (
      error
    ) {
      console.error(
        error
      );

      res
        .status(
          500
        )
        .send(
          "Ошибка установки amoMessenger."
        );
    }
  }
);


// ============================================================
// ПРОВЕРКА ТОКЕНА amoMessenger
// ============================================================

app.get(
  "/debug/amomessenger-token",
  (
    req,
    res
  ) => {
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
  (
    req,
    res
  ) => {
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
  (
    req,
    res
  ) => {
    console.log(
      "Открыта настройка виджета"
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

<h3>
  Виджет «Отчёт инженеров»
</h3>

<p>
  Инженер:
  <strong>
    ${ENGINEER_NAME}
  </strong>
</p>

<p>
  ID значения:
  <strong>
    ${ENGINEER_ENUM_ID}
  </strong>
</p>

<p>
  Сервер работает.
</p>

<script src="https://js.amo.tm/v1/sdk.js"></script>

<script>
try {

  var amoSDK =
    window.AmoSDK();

  amoSDK.setInputValues({
    ready: "true"
  });

}

catch (e) {

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
// ЗАПУСК
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
      "amoMessenger + amoCRM сервер запущен"
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
