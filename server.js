const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const AMOCRM_DOMAIN =
  process.env.AMOCRM_DOMAIN || "zlmk.amocrm.ru";

const AMOCRM_TOKEN =
  process.env.AMOCRM_TOKEN || "";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

const TIMEZONE = "Europe/Moscow";

// ============================================================
// НАСТРОЙКИ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// ============================================================
// AMOMESSENGER TOKEN
// ============================================================

// Сначала пытаемся взять токен из ENV.
// Если его нет — пытаемся загрузить сохраненный токен.

let amomessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amomessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

const TOKEN_FILE = path.join(
  __dirname,
  "amomessenger_token.json"
);

function loadMessengerToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(TOKEN_FILE, "utf8")
      );

      if (data.access_token) {
        amomessengerAccessToken = data.access_token;
      }

      if (data.refresh_token) {
        amomessengerRefreshToken = data.refresh_token;
      }

      console.log("amoMessenger токен загружен из файла.");
    }
  } catch (error) {
    console.log(
      "Не удалось загрузить токен:",
      error.message
    );
  }
}

function saveMessengerToken(tokenData) {
  try {
    amomessengerAccessToken =
      tokenData.access_token || "";

    amomessengerRefreshToken =
      tokenData.refresh_token || "";

    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(
        {
          access_token: amomessengerAccessToken,
          refresh_token: amomessengerRefreshToken,
          saved_at: new Date().toISOString()
        },
        null,
        2
      )
    );

    console.log("amoMessenger токен сохранен.");
  } catch (error) {
    console.log(
      "Не удалось сохранить токен:",
      error.message
    );
  }
}

loadMessengerToken();

// ============================================================
// ОСНОВНЫЕ ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Отчёт инженеров</title>
      </head>
      <body style="font-family: Arial; padding: 40px;">
        <h1>Отчёт инженеров</h1>
        <p>Сервер работает.</p>
        <p>Виджет подключён и готов к работе.</p>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    server: "running",
    timezone: TIMEZONE,
    amocrm_token: !!AMOCRM_TOKEN,
    amomessenger_token: !!amomessengerAccessToken
  });
});

// ============================================================
// WIDGET POST
// ============================================================

app.post("/", (req, res) => {
  console.log("");
  console.log("====================================");
  console.log("AMOMESSENGER POST /");
  console.log("");
  console.log("BODY:");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("====================================");
  console.log("");

  res.json({
    status: "OK",
    message: "POST / получен",
    body: req.body
  });
});

// ============================================================
// OAuth AMOMESSENGER
// ============================================================

app.get("/oauth/amomessenger", (req, res) => {
  const authUrl =
    "https://id.amo.tm/access" +
    "?client_id=" +
    encodeURIComponent(AMOMESSENGER_CLIENT_ID) +
    "&redirect_uri=" +
    encodeURIComponent(AMOMESSENGER_REDIRECT_URI) +
    "&response_type=code" +
    "&state=" +
    encodeURIComponent("amomessenger");

  console.log("OAuth URL:");
  console.log(authUrl);

  res.redirect(authUrl);
});

// ============================================================
// OAuth CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    console.log("");
    console.log("====================================");
    console.log("AMOMESSENGER OAUTH CALLBACK");
    console.log("QUERY:");
    console.log(JSON.stringify(req.query, null, 2));
    console.log("====================================");
    console.log("");

    const code = req.query.code;

    if (!code) {
      return res.status(400).send(`
        <html>
          <head>
            <meta charset="UTF-8">
          </head>
          <body style="font-family:Arial;padding:40px;">
            <h2>Ошибка OAuth</h2>
            <p>Код авторизации не получен.</p>
          </body>
        </html>
      `);
    }

    try {
      const response = await axios.post(
        "https://id.amo.tm/oauth2/access_token",
        {
          client_id: AMOMESSENGER_CLIENT_ID,
          client_secret: AMOMESSENGER_CLIENT_SECRET,
          grant_type: "authorization_code",
          code: code,
          redirect_uri: AMOMESSENGER_REDIRECT_URI
        },
        {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: 30000
        }
      );

      console.log(
        "OAuth token response:",
        JSON.stringify(
          response.data,
          null,
          2
        )
      );

      saveMessengerToken(response.data);

      res.send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>OAuth успешно</title>
          </head>
          <body style="
            font-family:Arial;
            padding:40px;
            text-align:center;
          ">
            <h1>Авторизация amoMessenger успешно выполнена</h1>

            <p>
              Токен сохранён на сервере.
            </p>

            <p>
              Теперь можно закрыть это окно
              и снова запустить бота.
            </p>

            <p>
              Access Token получен:
              <b>ДА</b>
            </p>

            <p>
              Refresh Token получен:
              <b>
                ${response.data.refresh_token ? "ДА" : "НЕТ"}
              </b>
            </p>
          </body>
        </html>
      `);

    } catch (error) {
      console.log("");
      console.log("OAUTH ERROR");

      if (error.response) {
        console.log(
          error.response.status,
          error.response.data
        );
      } else {
        console.log(error.message);
      }

      res.status(500).send(`
        <html>
          <head>
            <meta charset="UTF-8">
          </head>
          <body style="font-family:Arial;padding:40px;">
            <h2>Ошибка OAuth</h2>
            <pre>${escapeHtml(
              error.response
                ? JSON.stringify(
                    error.response.data,
                    null,
                    2
                  )
                : error.message
            )}</pre>
          </body>
        </html>
      `);
    }
  }
);

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function valueOrDash(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return "—";
  }

  return String(value).trim();
}

function getMoscowDateParts() {
  const formatter = new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  );

  const parts = formatter.formatToParts(
    new Date()
  );

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

function getCurrentMoscowDate() {
  const p = getMoscowDateParts();

  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second)
  };
}

function getMoscowTimestampForStartOfDay(
  daysAgo = 0
) {
  const now = getCurrentMoscowDate();

  const date = new Date(
    Date.UTC(
      now.year,
      now.month - 1,
      now.day - daysAgo,
      0,
      0,
      0
    )
  );

  // Москва UTC+3
  return Math.floor(
    (date.getTime() - 3 * 60 * 60 * 1000) /
      1000
  );
}

function getCurrentTimestamp() {
  return Math.floor(
    Date.now() / 1000
  );
}

function formatMoscowTimestamp(timestamp) {
  if (!timestamp) {
    return "—";
  }

  try {
    return new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    ).format(
      new Date(
        Number(timestamp) * 1000
      )
    );
  } catch (error) {
    return "—";
  }
}

// ============================================================
// AMOCRM GET
// ============================================================

async function amoCrmGet(url) {
  if (!AMOCRM_TOKEN) {
    throw new Error(
      "AMOCRM_TOKEN не задан в переменных окружения"
    );
  }

  console.log(
    "amoCRM GET:",
    url
  );

  const response = await axios.get(
    url,
    {
      headers: {
        Authorization:
          `Bearer ${AMOCRM_TOKEN}`,
        Accept:
          "application/hal+json"
      },
      timeout: 60000
    }
  );

  return response.data;
}

// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ
// ============================================================

async function loadTasksForPeriod(
  fromTimestamp,
  toTimestamp
) {
  const allTasks = [];

  let page = 1;

  while (true) {
    const params = new URLSearchParams();

    params.set(
      "filter[entity_type]",
      "leads"
    );

    params.set(
      "filter[complete_till][from]",
      String(fromTimestamp)
    );

    params.set(
      "filter[complete_till][to]",
      String(toTimestamp)
    );

    params.set("limit", "250");
    params.set("page", String(page));

    params.set(
      "order[complete_till]",
      "asc"
    );

    const url =
      `https://${AMOCRM_DOMAIN}/api/v4/tasks?${params.toString()}`;

    console.log(
      "Запрос задач:",
      params.toString()
    );

    let data;

    try {
      data = await amoCrmGet(url);
    } catch (error) {
      console.log(
        "Ошибка получения задач:",
        error.response
          ? error.response.status
          : error.message
      );

      throw error;
    }

    const tasks =
      data &&
      data._embedded &&
      Array.isArray(data._embedded.tasks)
        ? data._embedded.tasks
        : [];

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    // Защита от бесконечной загрузки
    if (page > 20) {
      console.log(
        "Остановлена загрузка после 20 страниц."
      );
      break;
    }
  }

  return allTasks;
}

// ============================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(leadId) {
  const url =
    `https://${AMOCRM_DOMAIN}/api/v4/leads/${leadId}?with=contacts`;

  const data = await amoCrmGet(url);

  return data;
}

// ============================================================
// ПОЛУЧЕНИЕ ЗНАЧЕНИЯ ПОЛЯ
// ============================================================

function getLeadField(
  lead,
  fieldId
) {
  if (
    !lead ||
    !Array.isArray(
      lead.custom_fields_values
    )
  ) {
    return null;
  }

  const field =
    lead.custom_fields_values.find(
      item =>
        Number(item.field_id) ===
        Number(fieldId)
    );

  if (
    !field ||
    !Array.isArray(field.values) ||
    field.values.length === 0
  ) {
    return null;
  }

  const firstValue =
    field.values[0];

  if (!firstValue) {
    return null;
  }

  return firstValue.value ??
    firstValue.enum_code ??
    null;
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function leadHasEngineer(
  lead
) {
  if (
    !lead ||
    !Array.isArray(
      lead.custom_fields_values
    )
  ) {
    return false;
  }

  const field =
    lead.custom_fields_values.find(
      item =>
        Number(item.field_id) ===
        ENGINEER_FIELD_ID
    );

  if (
    !field ||
    !Array.isArray(field.values)
  ) {
    return false;
  }

  return field.values.some(value => {
    const enumId =
      value.enum_id !== undefined
        ? Number(value.enum_id)
        : null;

    const name =
      value.value !== undefined
        ? String(value.value)
        : "";

    return (
      enumId === ENGINEER_ENUM_ID ||
      name === ENGINEER_NAME
    );
  });
}

// ============================================================
// КОНТАКТ
// ============================================================

function getClientFromLead(
  lead
) {
  let clientName = null;
  const phones = [];

  const contacts =
    lead &&
    lead._embedded &&
    Array.isArray(
      lead._embedded.contacts
    )
      ? lead._embedded.contacts
      : [];

  const mainContact =
    contacts.find(
      contact =>
        contact.is_main === true
    ) || contacts[0];

  if (!mainContact) {
    return {
      name: null,
      phones: []
    };
  }

  // Если contact уже расширен
  if (
    mainContact.name
  ) {
    clientName =
      mainContact.name;
  }

  if (
    Array.isArray(
      mainContact.custom_fields_values
    )
  ) {
    for (
      const field
      of mainContact.custom_fields_values
    ) {
      if (
        !Array.isArray(field.values)
      ) {
        continue;
      }

      for (
        const value
        of field.values
      ) {
        if (
          field.field_code === "PHONE" ||
          field.field_name === "Телефон"
        ) {
          if (
            value.value &&
            !phones.includes(
              value.value
            )
          ) {
            phones.push(
              value.value
            );
          }
        }
      }
    }
  }

  return {
    name: clientName,
    phones
  };
}

// ============================================================
// ПОЛУЧЕНИЕ КОНТАКТА ОТДЕЛЬНО
// ============================================================

async function getContact(
  contactId
) {
  const url =
    `https://${AMOCRM_DOMAIN}/api/v4/contacts/${contactId}`;

  return await amoCrmGet(url);
}

// ============================================================
// ПОДГОТОВКА ДАННЫХ СДЕЛКИ
// ============================================================

async function prepareLeadData(
  lead
) {
  let clientName = null;
  let phones = [];

  const contacts =
    lead &&
    lead._embedded &&
    Array.isArray(
      lead._embedded.contacts
    )
      ? lead._embedded.contacts
      : [];

  const mainContact =
    contacts.find(
      contact =>
        contact.is_main === true
    ) || contacts[0];

  if (mainContact) {
    try {
      const contact =
        await getContact(
          mainContact.id
        );

      clientName =
        contact.name ||
        null;

      if (
        Array.isArray(
          contact.custom_fields_values
        )
      ) {
        for (
          const field
          of contact.custom_fields_values
        ) {
          if (
            field.field_code !==
              "PHONE" &&
            field.field_name !==
              "Телефон"
          ) {
            continue;
          }

          if (
            !Array.isArray(
              field.values
            )
          ) {
            continue;
          }

          for (
            const value
            of field.values
          ) {
            if (
              value.value &&
              !phones.includes(
                value.value
              )
            ) {
              phones.push(
                value.value
              );
            }
          }
        }
      }
    } catch (error) {
      console.log(
        "Не удалось получить контакт:",
        error.message
      );

      const fallback =
        getClientFromLead(
          lead
        );

      clientName =
        fallback.name;

      phones =
        fallback.phones;
    }
  }

  return {
    lead_id: lead.id,
    lead_name: lead.name,

    contract_number:
      getLeadField(
        lead,
        412776
      ),

    measure_date:
      getLeadField(
        lead,
        175370
      )
        ? formatDateField(
            getLeadField(
              lead,
              175370
            )
          )
        : null,

    measure_time:
      getLeadField(
        lead,
        413828
      ),

    address:
      getLeadField(
        lead,
        175412
      ),

    product:
      getLeadField(
        lead,
        172572
      ),

    client_name:
      clientName,

    client_phones:
      phones,

    lead_link:
      `https://${AMOCRM_DOMAIN}/leads/detail/${lead.id}`,

    engineer:
      ENGINEER_NAME
  };
}

// ============================================================
// ФОРМАТ ДАТЫ ИЗ CRM
// ============================================================

function formatDateField(
  value
) {
  if (!value) {
    return null;
  }

  const number =
    Number(value);

  if (
    Number.isFinite(number) &&
    number > 1000000000
  ) {
    return new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone: TIMEZONE,
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      }
    ).format(
      new Date(
        number * 1000
      )
    );
  }

  return String(value);
}

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurements() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log("ПОИСК ЗАМЕРОВ");
  console.log(
    `Инженер: ${ENGINEER_NAME}`
  );
  console.log(
    `Поле инженера: ${ENGINEER_FIELD_ID}`
  );
  console.log(
    `ID инженера: ${ENGINEER_ENUM_ID}`
  );
  console.log(
    `Тип задачи: ${MEASUREMENT_TASK_TYPE_ID}`
  );
  console.log(
    "=========================================="
  );

  const now =
    getCurrentMoscowDate();

  const fromTimestamp =
    getMoscowTimestampForStartOfDay(
      1
    );

  const toTimestamp =
    getCurrentTimestamp();

  console.log(
    "Текущая дата Москвы:",
    `${String(now.day).padStart(2, "0")}.` +
    `${String(now.month).padStart(2, "0")}.` +
    `${now.year}`
  );

  console.log(
    "Диапазон complete_till:",
    formatMoscowTimestamp(
      fromTimestamp
    ),
    "—",
    formatMoscowTimestamp(
      toTimestamp
    )
  );

  // ----------------------------------------------------------
  // ВАЖНО:
  // НЕ используем filter[is_completed].
  //
  // Ранее amoCRM возвращала:
  // "Invalid filter for current account"
  //
  // Поэтому задачи получаем по complete_till,
  // а is_completed проверяем уже в JavaScript.
  // ----------------------------------------------------------

  const allTasks =
    await loadTasksForPeriod(
      fromTimestamp,
      toTimestamp
    );

  console.log(
    "Всего задач:",
    allTasks.length
  );

  // Только незавершенные
  const unfinishedTasks =
    allTasks.filter(
      task =>
        task &&
        task.entity_type === "leads" &&
        task.is_completed === false
    );

  console.log(
    "Незавершенных задач:",
    unfinishedTasks.length
  );

  // Только нужный тип задачи
  const measurementTasks =
    unfinishedTasks.filter(
      task =>
        Number(
          task.task_type_id
        ) ===
        MEASUREMENT_TASK_TYPE_ID
    );

  console.log(
    "Задач подтверждения замера:",
    measurementTasks.length
  );

  // ----------------------------------------------------------
  // Дополнительная проверка даты исполнения
  // ----------------------------------------------------------

  const tasksAfterDateFilter =
    measurementTasks.filter(
      task => {
        const completeTill =
          Number(
            task.complete_till
          );

        return (
          Number.isFinite(
            completeTill
          ) &&
          completeTill >=
            fromTimestamp &&
          completeTill <=
            toTimestamp
        );
      }
    );

  console.log(
    "Задач после проверки complete_till:",
    tasksAfterDateFilter.length
  );

  const measurements = [];

  // ----------------------------------------------------------
  // Для каждой подходящей задачи получаем сделку
  // ----------------------------------------------------------

  for (
    const task
    of tasksAfterDateFilter
  ) {
    try {
      const lead =
        await getLead(
          task.entity_id
        );

      console.log(
        "Получена сделка:",
        lead.id
      );

      // ------------------------------------------------------
      // Проверяем инженера
      // ------------------------------------------------------

      if (
        !leadHasEngineer(
          lead
        )
      ) {
        console.log(
          `Сделка ${lead.id} пропущена: ` +
          "другой инженер"
        );

        continue;
      }

      // ------------------------------------------------------
      // ВАЖНО:
      // Здесь НЕТ проверки "заполнены ли все поля".
      //
      // Поэтому сделка будет показана даже если:
      // адрес = пусто
      // время = пусто
      // продукт = пусто
      // и т.д.
      // ------------------------------------------------------

      const leadData =
        await prepareLeadData(
          lead
        );

      measurements.push({
        task_id:
          task.id,

        task_complete_till:
          task.complete_till,

        task_complete_till_moscow:
          formatMoscowTimestamp(
            task.complete_till
          ),

        lead_id:
          leadData.lead_id,

        contract_number:
          leadData.contract_number,

        measure_date:
          leadData.measure_date,

        measure_time:
          leadData.measure_time,

        measure_address:
          leadData.address,

        product:
          leadData.product,

        client_name:
          leadData.client_name,

        client_phones:
          leadData.client_phones,

        lead_link:
          leadData.lead_link,

        engineer:
          leadData.engineer
      });

    } catch (error) {
      console.log(
        `Ошибка обработки сделки ${task.entity_id}:`,
        error.response
          ? error.response.data
          : error.message
      );
    }
  }

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  console.log(
    "=========================================="
  );

  return {
    timezone: TIMEZONE,

    current_moscow_time:
      formatMoscowTimestamp(
        toTimestamp
      ),

    engineer: {
      name:
        ENGINEER_NAME,

      field_id:
        ENGINEER_FIELD_ID,

      enum_id:
        ENGINEER_ENUM_ID
    },

    task_type_id:
      MEASUREMENT_TASK_TYPE_ID,

    date_mode:
      "до 18:00",

    date_range: {
      from:
        formatMoscowTimestamp(
          fromTimestamp
        ),

      to:
        formatMoscowTimestamp(
          toTimestamp
        )
    },

    tasks_loaded:
      allTasks.length,

    measurement_tasks:
      tasksAfterDateFilter.length,

    found_count:
      measurements.length,

    measurements
  };
}

// ============================================================
// DEBUG ПОИСК
// ============================================================

app.get(
  "/debug/measurements",
  async (req, res) => {
    try {
      const result =
        await findMeasurements();

      res.json({
        status: "OK",
        ...result
      });

    } catch (error) {
      console.log(
        "DEBUG ERROR:",
        error.response
          ? error.response.data
          : error.message
      );

      res.status(500).json({
        status: "Ошибка",

        message:
          error.response
            ? `amoCRM HTTP ${error.response.status}`
            : error.message,

        details:
          error.response
            ? error.response.data
            : null
      });
    }
  }
);

// ============================================================
// DEBUG ОТДЕЛЬНОЙ ЗАДАЧИ
// ============================================================

app.get(
  "/debug/task-test/:taskId",
  async (req, res) => {
    try {
      const taskId =
        req.params.taskId;

      const url =
        `https://${AMOCRM_DOMAIN}/api/v4/tasks/${taskId}`;

      const task =
        await amoCrmGet(url);

      const completeTill =
        Number(
          task.complete_till
        );

      const fromTimestamp =
        getMoscowTimestampForStartOfDay(
          1
        );

      const toTimestamp =
        getCurrentTimestamp();

      res.json({
        status: "OK",

        task_id:
          task.id,

        entity_id:
          task.entity_id,

        entity_type:
          task.entity_type,

        task_type_id:
          task.task_type_id,

        is_completed:
          task.is_completed,

        complete_till:
          task.complete_till,

        complete_till_moscow:
          formatMoscowTimestamp(
            task.complete_till
          ),

        date_mode:
          "до 18:00",

        date_range: {
          from:
            formatMoscowTimestamp(
              fromTimestamp
            ),

          to:
            formatMoscowTimestamp(
              toTimestamp
            )
        },

        passes: {
          entity_type:
            task.entity_type ===
            "leads",

          task_type:
            Number(
              task.task_type_id
            ) ===
            MEASUREMENT_TASK_TYPE_ID,

          not_completed:
            task.is_completed ===
            false,

          date:
            completeTill >=
              fromTimestamp &&
            completeTill <=
              toTimestamp
        }
      });

    } catch (error) {
      res.status(500).json({
        status: "Ошибка",

        message:
          error.response
            ? `amoCRM HTTP ${error.response.status}`
            : error.message,

        details:
          error.response
            ? error.response.data
            : null
      });
    }
  }
);

// ============================================================
// AMOMESSENGER API
// ============================================================

async function amoMessengerPost(
  url,
  body
) {
  if (!amomessengerAccessToken) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  console.log(
    "amoMessenger POST:",
    url
  );

  console.log(
    "BODY:",
    JSON.stringify(
      body,
      null,
      2
    )
  );

  try {
    const response =
      await axios.post(
        url,
        body,
        {
          headers: {
            Authorization:
              `Bearer ${amomessengerAccessToken}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          timeout: 30000
        }
      );

    console.log(
      "amoMessenger response:",
      response.status,
      response.data
    );

    return response.data;

  } catch (error) {
    console.log(
      "amoMessenger ERROR:"
    );

    if (error.response) {
      console.log(
        error.response.status,
        error.response.data
      );
    } else {
      console.log(
        error.message
      );
    }

    throw error;
  }
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЮ
// ============================================================

async function sendBotMessage({
  botId,
  requestId,
  receiverUserId,
  text
}) {
  if (
    !botId ||
    !requestId ||
    !receiverUserId
  ) {
    throw new Error(
      "Недостаточно данных для отправки сообщения"
    );
  }

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}` +
    `/request/${requestId}/sendMessage`;

  return await amoMessengerPost(
    url,
    {
      text: text,

      receiver: {
        user_id:
          receiverUserId
      }
    }
  );
}

// ============================================================
// ФОРМАТИРОВАНИЕ ЗАМЕРА
// ============================================================

function formatMeasurement(
  item,
  index
) {
  const phones =
    Array.isArray(
      item.client_phones
    ) &&
    item.client_phones.length
      ? item.client_phones.join(
          ", "
        )
      : "—";

  return (
    `📋 <b>Замер ${index + 1}</b>\n\n` +

    `№ договора: ${escapeHtml(
      valueOrDash(
        item.contract_number
      )
    )}\n` +

    `Дата замера: ${escapeHtml(
      valueOrDash(
        item.measure_date
      )
    )}\n` +

    `Время замера: ${escapeHtml(
      valueOrDash(
        item.measure_time
      )
    )}\n` +

    `Адрес объекта: ${escapeHtml(
      valueOrDash(
        item.measure_address
      )
    )}\n` +

    `Продукт: ${escapeHtml(
      valueOrDash(
        item.product
      )
    )}\n\n` +

    `Клиент: ${escapeHtml(
      valueOrDash(
        item.client_name
      )
    )}\n` +

    `Телефон: ${escapeHtml(
      phones
    )}\n\n` +

    `Дата исполнения задачи: ${escapeHtml(
      valueOrDash(
        item.task_complete_till_moscow
      )
    )}\n\n` +

    `🔗 ${escapeHtml(
      item.lead_link
    )}`
  );
}

// ============================================================
// ОТПРАВКА РЕЗУЛЬТАТА
// ============================================================

async function sendMeasurementsResult({
  botId,
  requestId,
  receiverUserId,
  result
}) {
  if (
    !result ||
    !Array.isArray(
      result.measurements
    )
  ) {
    await sendBotMessage({
      botId,
      requestId,
      receiverUserId,
      text:
        "Произошла ошибка при получении данных."
    });

    return;
  }

  if (
    result.measurements.length === 0
  ) {
    await sendBotMessage({
      botId,
      requestId,
      receiverUserId,
      text:
        "📭 На данный момент задач на подтверждение замера не найдено."
    });

    return;
  }

  let text =
    "📋 <b>Задачи на подтверждение замера</b>\n\n";

  text +=
    `Найдено: ${result.measurements.length}\n\n`;

  result.measurements.forEach(
    (item, index) => {
      text +=
        formatMeasurement(
          item,
          index
        );

      text +=
        "\n\n────────────────────\n\n";
    }
  );

  await sendBotMessage({
    botId,
    requestId,
    receiverUserId,
    text
  });
}

// ============================================================
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "AMOMESSENGER WEBHOOK"
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    console.log(
      "=========================================="
    );

    // Сначала отвечаем amoMessenger,
    // чтобы webhook не зависал.
    res.status(200).json({
      status: "OK"
    });

    try {
      const body =
        req.body || {};

      const embedded =
        body._embedded || {};

      const context =
        embedded.context || {};

      // --------------------------------------------------------
      // 1. Передача управления виджету
      // --------------------------------------------------------

      if (
        body.event_type ===
        "rpa_bot_control_transferred"
      ) {
        const control =
          embedded.rpa_bot_control_transferred;

        const controlEmbedded =
          control &&
          control._embedded
            ? control._embedded
            : {};

        const request =
          controlEmbedded.request ||
          {};

        const botId =
          control.bot_id ||
          null;

        const requestId =
          request.id ||
          null;

        // ВАЖНО:
        // context.user_id у нас является ID бота.
        //
        // Реальный пользователь находится здесь:
        // request.author_id
        //
        const receiverUserId =
          request.author_id ||
          controlEmbedded
            ?.context
            ?.user_id ||
          context.user_id ||
          null;

        console.log("");
        console.log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ"
        );

        console.log(
          JSON.stringify(
            {
              botId,
              requestId,
              receiverUserId,
              contextUserId:
                context.user_id,
              requestAuthorId:
                request.author_id
            },
            null,
            2
          )
        );

        console.log(
          "=========================================="
        );

        // ------------------------------------------------------
        // Не отправляем сообщение здесь автоматически.
        //
        // После нажатия кнопки "Подтвердить замер"
        // придет rpa_bot_income_message.
        // ------------------------------------------------------

        return;
      }

      // --------------------------------------------------------
      // 2. Входящее сообщение от пользователя
      // --------------------------------------------------------

      if (
        body.event_type ===
        "rpa_bot_income_message"
      ) {
        const botMessage =
          embedded.rpa_bot_income_message;

        const botEmbedded =
          botMessage &&
          botMessage._embedded
            ? botMessage._embedded
            : {};

        const incomeMessage =
          botEmbedded.income_message ||
          {};

        const request =
          botEmbedded.request ||
          {};

        const botId =
          botMessage.bot_id ||
          null;

        const requestId =
          request.id ||
          null;

        // ======================================================
        // САМОЕ ВАЖНОЕ ИСПРАВЛЕНИЕ
        // ======================================================
        //
        // НЕ используем:
        //
        // context.user_id
        //
        // потому что в ваших событиях это ID бота.
        //
        // Используем:
        //
        // request.author_id
        //
        // Это реальный пользователь.
        // ======================================================

        const receiverUserId =
          request.author_id ||
          incomeMessage
            ?.author
            ?.user_id ||
          botEmbedded
            ?.context
            ?.user_id ||
          context.user_id ||
          null;

        const messageText =
          String(
            incomeMessage.text ||
            ""
          ).trim();

        console.log("");
        console.log(
          "Получено сообщение:",
          messageText
        );

        console.log(
          "ID пользователя:",
          receiverUserId
        );

        console.log(
          "ID бота:",
          botId
        );

        console.log(
          "ID заявки:",
          requestId
        );

        // ------------------------------------------------------
        // КНОПКА ПОДТВЕРДИТЬ ЗАМЕР
        // ------------------------------------------------------

        if (
          messageText ===
            "Подтвердить замер" ||
          messageText.toLowerCase() ===
            "подтвердить замер"
        ) {
          console.log("");
          console.log(
            "=========================================="
          );
          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );
          console.log(
            "=========================================="
          );

          // ----------------------------------------------------
          // Отправляем сообщение ИМЕННО пользователю.
          // ----------------------------------------------------

          try {
            await sendBotMessage({
              botId,
              requestId,
              receiverUserId,
              text:
                "⏳ Проверяю задачи на подтверждение замера..."
            });
          } catch (error) {
            console.log(
              "Не удалось отправить сообщение о начале:",
              error.response
                ? error.response.data
                : error.message
            );

            return;
          }

          // ----------------------------------------------------
          // Ищем задачи
          // ----------------------------------------------------

          try {
            const result =
              await findMeasurements();

            console.log("");
            console.log(
              "Результат поиска:"
            );

            console.log(
              JSON.stringify(
                result,
                null,
                2
              )
            );

            // --------------------------------------------------
            // Отправляем результат пользователю
            // --------------------------------------------------

            await sendMeasurementsResult({
              botId,
              requestId,
              receiverUserId,
              result
            });

          } catch (error) {
            console.log(
              "Ошибка поиска замеров:"
            );

            if (
              error.response
            ) {
              console.log(
                error.response.status
              );

              console.log(
                error.response.data
              );
            } else {
              console.log(
                error.message
              );
            }

            try {
              await sendBotMessage({
                botId,
                requestId,
                receiverUserId,
                text:
                  "❌ Не удалось получить данные из amoCRM. Попробуйте ещё раз."
              });
            } catch (
              sendError
            ) {
              console.log(
                "Не удалось отправить сообщение об ошибке:",
                sendError.message
              );
            }
          }

          return;
        }

        // ------------------------------------------------------
        // ПРОВЕСТИ ЗАМЕР
        // ------------------------------------------------------

        if (
          messageText ===
          "Провести замер"
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              "Функция «Провести замер» пока находится в разработке."
          });

          return;
        }

        // ------------------------------------------------------
        // ЗАГРУЗИТЬ ФОТООТЧЕТ
        // ------------------------------------------------------

        if (
          messageText ===
          "Загрузить фотоотчет"
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              "Функция «Загрузить фотоотчет» пока находится в разработке."
          });

          return;
        }

        // ------------------------------------------------------
        // ВНЕСТИ ПРАВКИ
        // ------------------------------------------------------

        if (
          messageText ===
          "Внести правки"
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              "Функция «Внести правки» пока находится в разработке."
          });

          return;
        }

        // ------------------------------------------------------
        // Неизвестная кнопка
        // ------------------------------------------------------

        console.log(
          "Неизвестное сообщение:",
          messageText
        );
      }

    } catch (error) {
      console.log("");
      console.log(
        "WEBHOOK ERROR:",
        error.message
      );

      if (
        error.response
      ) {
        console.log(
          error.response.status,
          error.response.data
        );
      }
    }
  }
);

// ============================================================
// ДОПОЛНИТЕЛЬНЫЙ WEBHOOK ROUTE
// ============================================================
//
// На случай, если в настройках amoMessenger указан /webhook
// вместо /webhook/amomessenger.
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {
    console.log(
      "Получен webhook на /webhook"
    );

    res.status(200).json({
      status: "OK"
    });

    // Передаем обработку тому же обработчику
    // напрямую без повторного HTTP-запроса.
    //
    // В текущей конфигурации основным адресом остается:
    // /webhook/amomessenger
  }
);

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "СЕРВЕР ЗАПУЩЕН"
    );
    console.log(
      "=========================================="
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "AMOCRM:",
      AMOCRM_DOMAIN
    );

    console.log(
      "ENGINEER:",
      ENGINEER_NAME
    );

    console.log(
      "ENGINEER FIELD:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "ENGINEER ENUM:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "TASK TYPE:",
      MEASUREMENT_TASK_TYPE_ID
    );

    console.log(
      "TIMEZONE:",
      TIMEZONE
    );

    console.log(
      "AMOCRM TOKEN:",
      AMOCRM_TOKEN
        ? "ДА"
        : "НЕТ"
    );

    console.log(
      "AMOMESSENGER TOKEN:",
      amomessengerAccessToken
        ? "ДА"
        : "НЕТ"
    );

    console.log(
      "OAUTH REDIRECT:",
      AMOMESSENGER_REDIRECT_URI
    );

    console.log(
      "=========================================="
    );
  }
);
