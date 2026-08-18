const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 3000;

const AMOCRM_DOMAIN =
  process.env.AMOCRM_DOMAIN || "zlmk.amocrm.ru";

const AMOCRM_TOKEN =
  process.env.AMOCRM_TOKEN;

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID;

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET;

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

const AMOMESSENGER_API =
  "https://api.amo.tm";

const AMOMESSENGER_AUTH =
  "https://id.amo.tm";


// ============================================================
// НАСТРОЙКИ БОТА
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Москва
const TIMEZONE = "Europe/Moscow";


// ============================================================
// ХРАНЕНИЕ ТОКЕНА AMOMESSENGER
// ============================================================

// На Render файловая система временная,
// поэтому одновременно поддерживаем:
// 1. переменную окружения
// 2. файл /tmp
//
// После OAuth токен будет сохранён в файл.

const TOKEN_FILE = path.join(
  "/tmp",
  "amomessenger-token.json"
);

let messengerToken = null;


// ============================================================
// ЗАГРУЗКА СОХРАНЁННОГО ТОКЕНА
// ============================================================

function loadMessengerToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = fs.readFileSync(
        TOKEN_FILE,
        "utf8"
      );

      messengerToken = JSON.parse(data);

      console.log(
        "AMOMESSENGER TOKEN: загружен из файла"
      );

      return messengerToken;
    }
  } catch (error) {
    console.error(
      "Ошибка загрузки токена:",
      error.message
    );
  }

  if (process.env.AMOMESSENGER_ACCESS_TOKEN) {
    messengerToken = {
      access_token:
        process.env.AMOMESSENGER_ACCESS_TOKEN,

      refresh_token:
        process.env.AMOMESSENGER_REFRESH_TOKEN || null,

      expires_at: 0
    };

    console.log(
      "AMOMESSENGER TOKEN: загружен из ENV"
    );

    return messengerToken;
  }

  return null;
}


// ============================================================
// СОХРАНЕНИЕ ТОКЕНА
// ============================================================

function saveMessengerToken(token) {
  messengerToken = {
    ...token
  };

  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(
        messengerToken,
        null,
        2
      )
    );

    console.log(
      "AMOMESSENGER TOKEN: сохранён"
    );
  } catch (error) {
    console.error(
      "Ошибка сохранения токена:",
      error.message
    );
  }
}


// Загружаем при запуске
loadMessengerToken();


// ============================================================
// ОПРЕДЕЛЕНИЕ МОСКОВСКОЙ ДАТЫ
// ============================================================

function getMoscowDateParts() {
  const formatter = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  );

  const parts = formatter.formatToParts(
    new Date()
  );

  const result = {};

  for (const part of parts) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day"
    ) {
      result[part.type] =
        Number(part.value);
    }
  }

  return result;
}


// ============================================================
// НАЧАЛО ВЧЕРА 00:00 ПО МОСКВЕ
// ============================================================

function getYesterdayStartMoscowTimestamp() {
  const date = getMoscowDateParts();

  const todayStartUtc =
    Date.UTC(
      date.year,
      date.month - 1,
      date.day
    );

  // Москва = UTC+3
  const todayStartMoscow =
    todayStartUtc -
    3 * 60 * 60 * 1000;

  const yesterdayStart =
    todayStartMoscow -
    24 * 60 * 60 * 1000;

  return Math.floor(
    yesterdayStart / 1000
  );
}


// ============================================================
// ФОРМАТ ДАТЫ ПО МОСКВЕ
// ============================================================

function formatMoscowDate(timestamp) {
  if (!timestamp) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }
  ).format(
    new Date(timestamp * 1000)
  );
}


// ============================================================
// ФОРМАТ ВРЕМЕНИ ПО МОСКВЕ
// ============================================================

function formatMoscowTime(timestamp) {
  if (!timestamp) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      hour: "2-digit",
      minute: "2-digit"
    }
  ).format(
    new Date(timestamp * 1000)
  );
}


// ============================================================
// ПОЛУЧИТЬ AMOMESSENGER TOKEN
// ============================================================

async function getMessengerAccessToken() {
  if (!messengerToken) {
    loadMessengerToken();
  }

  if (!messengerToken) {
    throw new Error(
      "Токен amoMessenger не найден. Откройте /oauth/amomessenger/start"
    );
  }

  // Если есть срок действия и токен ещё жив,
  // используем его.
  if (
    messengerToken.expires_at &&
    Date.now() <
      messengerToken.expires_at - 60000
  ) {
    return messengerToken.access_token;
  }

  // Если срока нет, но access_token есть —
  // пробуем его.
  if (
    messengerToken.access_token &&
    !messengerToken.refresh_token
  ) {
    return messengerToken.access_token;
  }

  // Если есть refresh token — обновляем.
  if (messengerToken.refresh_token) {
    try {
      console.log(
        "AMOMESSENGER: обновляем access token..."
      );

      const params =
        new URLSearchParams();

      params.append(
        "client_id",
        AMOMESSENGER_CLIENT_ID
      );

      params.append(
        "client_secret",
        AMOMESSENGER_CLIENT_SECRET
      );

      params.append(
        "grant_type",
        "refresh_token"
      );

      params.append(
        "refresh_token",
        messengerToken.refresh_token
      );

      const response =
        await axios.post(
          `${AMOMESSENGER_AUTH}/oauth2/access_token`,
          params.toString(),
          {
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },
            timeout: 20000
          }
        );

      const token =
        response.data;

      saveMessengerToken({
        ...token,

        expires_at:
          Date.now() +
          Number(token.expires_in || 86400) *
            1000
      });

      console.log(
        "AMOMESSENGER: access token обновлён"
      );

      return messengerToken.access_token;

    } catch (error) {
      console.error(
        "Ошибка обновления AMOMESSENGER token:",
        error.response?.data ||
          error.message
      );

      throw new Error(
        "Не удалось обновить токен amoMessenger. Откройте /oauth/amomessenger/start"
      );
    }
  }

  return messengerToken.access_token;
}


// ============================================================
// AMOMESSENGER API
// ============================================================

async function messengerRequest(
  method,
  url,
  data = null,
  retry = true
) {
  const token =
    await getMessengerAccessToken();

  try {
    console.log(
      `amoMessenger ${method}: ${url}`
    );

    if (data) {
      console.log(
        "BODY:",
        JSON.stringify(
          data,
          null,
          2
        )
      );
    }

    const response =
      await axios({
        method,
        url,
        data,
        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        timeout: 25000,

        validateStatus:
          () => true
      });

    console.log(
      "amoMessenger response:",
      response.status,
      response.data
    );

    // Если токен устарел — обновляем
    // и повторяем запрос один раз.
    if (
      response.status === 401 &&
      retry &&
      messengerToken?.refresh_token
    ) {
      console.log(
        "AMOMESSENGER: 401, пробуем обновить токен"
      );

      messengerToken.expires_at = 0;

      await getMessengerAccessToken();

      return messengerRequest(
        method,
        url,
        data,
        false
      );
    }

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error(
        `amoMessenger HTTP ${response.status}: ${
          JSON.stringify(
            response.data
          )
        }`
      );
    }

    return response.data;

  } catch (error) {
    console.error(
      "AMOMESSENGER REQUEST ERROR:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}


// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В ЗАЯВКУ БОТА
// ============================================================

async function sendBotMessage({
  botId,
  requestId,
  receiverUserId,
  text,
  buttons = null
}) {
  if (!botId) {
    throw new Error(
      "Не указан botId"
    );
  }

  if (!requestId) {
    throw new Error(
      "Не указан requestId"
    );
  }

  if (!receiverUserId) {
    throw new Error(
      "Не указан receiverUserId"
    );
  }

  // ВАЖНО:
  // receiverUserId — ID реального пользователя,
  // а НЕ bot_id и НЕ context.user_id.

  const body = {
    text: text,

    receiver: {
      user_id:
        receiverUserId
    }
  };

  if (
    Array.isArray(buttons) &&
    buttons.length
  ) {
    body.reply_markup = {
      inline_keyboard: {
        buttons:
          buttons.map(
            button => ({
              text: button
            })
          )
      }
    };
  }

  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}/request/${requestId}/sendMessage`;

  return messengerRequest(
    "POST",
    url,
    body
  );
}


// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMO
// ============================================================

async function returnControl(
  botId,
  requestId,
  returnCode = "success"
) {
  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}/request/${requestId}/returnControl`;

  try {
    return await messengerRequest(
      "POST",
      url,
      {
        return_code:
          returnCode
      }
    );
  } catch (error) {
    console.error(
      "Ошибка возврата управления:",
      error.message
    );

    return null;
  }
}


// ============================================================
// AMOCRM REQUEST
// ============================================================

async function amoCrmGet(url) {
  if (!AMOCRM_TOKEN) {
    throw new Error(
      "AMOCRM_TOKEN не задан в переменных Render"
    );
  }

  console.log(
    "amoCRM GET:",
    url
  );

  const response =
    await axios.get(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${AMOCRM_TOKEN}`,

          Accept:
            "application/hal+json"
        },

        timeout: 30000,

        validateStatus:
          () => true
      }
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    console.error(
      "amoCRM ERROR:",
      response.status,
      response.data
    );

    throw new Error(
      `amoCRM HTTP ${response.status}`
    );
  }

  return response.data;
}


// ============================================================
// ПОЛУЧИТЬ ЗАДАЧИ
// ============================================================

async function getMeasurementTasks(
  nowTimestamp
) {
  const fromTimestamp =
    getYesterdayStartMoscowTimestamp();

  const allTasks = [];

  let page = 1;

  while (true) {
    const params =
      new URLSearchParams();

    params.append(
      "filter[entity_type]",
      "leads"
    );

    // ТОЛЬКО НЕЗАВЕРШЁННЫЕ
    params.append(
      "filter[is_completed][]",
      "0"
    );

    // ТОЛЬКО нужный тип задачи
    params.append(
      "filter[task_type][]",
      String(
        MEASUREMENT_TASK_TYPE_ID
      )
    );

    // Дата исполнения задачи:
    // от вчера 00:00 по Москве
    params.append(
      "filter[complete_till][from]",
      String(fromTimestamp)
    );

    // До текущего момента
    params.append(
      "filter[complete_till][to]",
      String(nowTimestamp)
    );

    params.append(
      "limit",
      "250"
    );

    params.append(
      "page",
      String(page)
    );

    params.append(
      "order[complete_till]",
      "asc"
    );

    const url =
      `https://${AMOCRM_DOMAIN}/api/v4/tasks?${params.toString()}`;

    console.log(
      "=========================================="
    );

    console.log(
      "Запрос задач:",
      params.toString()
    );

    const data =
      await amoCrmGet(url);

    const tasks =
      data?._embedded?.tasks ||
      [];

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(
      ...tasks
    );

    if (
      tasks.length < 250
    ) {
      break;
    }

    page++;

    // Защита от бесконечного цикла
    if (page > 20) {
      break;
    }
  }

  console.log(
    "Всего задач:",
    allTasks.length
  );

  return allTasks;
}


// ============================================================
// ПОЛУЧИТЬ КОНТАКТ
// ============================================================

async function getContact(
  contactId
) {
  try {
    const url =
      `https://${AMOCRM_DOMAIN}/api/v4/contacts/${contactId}`;

    return await amoCrmGet(
      url
    );
  } catch (error) {
    console.error(
      `Не удалось получить контакт ${contactId}:`,
      error.message
    );

    return null;
  }
}


// ============================================================
// ПОЛУЧИТЬ СДЕЛКУ
// ============================================================

async function getLead(
  leadId
) {
  const url =
    `https://${AMOCRM_DOMAIN}/api/v4/leads/${leadId}?with=contacts`;

  return amoCrmGet(
    url
  );
}


// ============================================================
// ПОЛУЧИТЬ ЗНАЧЕНИЕ ПОЛЯ СДЕЛКИ
// ============================================================

function getLeadField(
  lead,
  fieldId
) {
  const field =
    (
      lead.custom_fields_values ||
      []
    ).find(
      item =>
        Number(item.field_id) ===
        Number(fieldId)
    );

  if (
    !field ||
    !Array.isArray(
      field.values
    ) ||
    !field.values.length
  ) {
    return null;
  }

  return (
    field.values[0].value ??
    null
  );
}


// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function leadBelongsToEngineer(
  lead
) {
  const field =
    (
      lead.custom_fields_values ||
      []
    ).find(
      item =>
        Number(item.field_id) ===
        Number(
          ENGINEER_FIELD_ID
        )
    );

  if (!field) {
    return false;
  }

  const values =
    field.values || [];

  return values.some(
    value => {
      const enumId =
        Number(
          value.enum_id
        );

      const text =
        String(
          value.value || ""
        ).trim();

      return (
        enumId ===
          Number(
            ENGINEER_ENUM_ID
          ) ||
        text ===
          ENGINEER_NAME
      );
    }
  );
}


// ============================================================
// ПОЛУЧИТЬ КЛИЕНТА И ТЕЛЕФОНЫ
// ============================================================

async function getLeadClient(
  lead
) {
  const contacts =
    lead?._embedded?.contacts ||
    [];

  if (!contacts.length) {
    return {
      name: null,
      phones: []
    };
  }

  const mainContact =
    contacts.find(
      contact =>
        contact.is_main === true
    ) ||
    contacts[0];

  const contact =
    await getContact(
      mainContact.id
    );

  if (!contact) {
    return {
      name: null,
      phones: []
    };
  }

  const phones = [];

  const customFields =
    contact.custom_fields_values ||
    [];

  for (
    const field
    of customFields
  ) {
    const fieldName =
      String(
        field.field_name ||
        ""
      ).toLowerCase();

    if (
      fieldName.includes(
        "телефон"
      )
    ) {
      for (
        const value
        of field.values || []
      ) {
        if (
          value.value
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

  return {
    name:
      contact.name ||
      null,

    phones:
      [
        ...new Set(
          phones
        )
      ]
  };
}


// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurements() {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  console.log(
    "=========================================="
  );

  console.log(
    "ПОИСК ЗАМЕРОВ"
  );

  console.log(
    "Инженер:",
    ENGINEER_NAME
  );

  console.log(
    "Поле инженера:",
    ENGINEER_FIELD_ID
  );

  console.log(
    "ID инженера:",
    ENGINEER_ENUM_ID
  );

  console.log(
    "Тип задачи:",
    MEASUREMENT_TASK_TYPE_ID
  );

  console.log(
    "=========================================="
  );

  const tasks =
    await getMeasurementTasks(
      now
    );

  console.log(
    "Найдено подходящих задач:",
    tasks.length
  );

  const measurements = [];

  for (
    const task
    of tasks
  ) {
    // Дополнительная защита
    // на случай, если amoCRM вернул
    // что-то лишнее.
    if (
      task.entity_type !==
      "leads"
    ) {
      continue;
    }

    if (
      Number(
        task.task_type_id
      ) !==
      Number(
        MEASUREMENT_TASK_TYPE_ID
      )
    ) {
      continue;
    }

    if (
      task.is_completed === true
    ) {
      continue;
    }

    if (
      !task.entity_id
    ) {
      continue;
    }

    console.log(
      "Проверяем задачу:",
      task.id,
      "сделка:",
      task.entity_id
    );

    try {
      const lead =
        await getLead(
          task.entity_id
        );

      if (
        !lead
      ) {
        continue;
      }

      if (
        !leadBelongsToEngineer(
          lead
        )
      ) {
        console.log(
          "Сделка не принадлежит инженеру:",
          lead.id
        );

        continue;
      }

      const client =
        await getLeadClient(
          lead
        );

      // ВАЖНО:
      // поля могут быть пустыми.
      // НИ ОДНО поле не является обязательным.
      // Поэтому мы всё равно добавляем сделку.

      const contractNumber =
        getLeadField(
          lead,
          412776
        );

      const measureDate =
        getLeadField(
          lead,
          175370
        );

      const measureTime =
        getLeadField(
          lead,
          413828
        );

      const measureAddress =
        getLeadField(
          lead,
          175412
        );

      const product =
        getLeadField(
          lead,
          172572
        );

      measurements.push({
        task_id:
          task.id,

        task_complete_till:
          task.complete_till,

        task_complete_till_moscow:
          `${formatMoscowDate(
            task.complete_till
          )} ${formatMoscowTime(
            task.complete_till
          )}`,

        lead_id:
          lead.id,

        lead_name:
          lead.name ||
          `Сделка #${lead.id}`,

        contract_number:
          contractNumber,

        measure_date:
          measureDate
            ? formatMoscowDate(
                Number(
                  measureDate
                )
              )
            : null,

        measure_time:
          measureTime,

        measure_address:
          measureAddress,

        product:
          product,

        client_name:
          client.name,

        client_phones:
          client.phones,

        lead_link:
          `https://${AMOCRM_DOMAIN}/leads/detail/${lead.id}`,

        engineer:
          ENGINEER_NAME
      });

    } catch (error) {
      console.error(
        `Ошибка обработки сделки ${task.entity_id}:`,
        error.message
      );
    }
  }

  console.log(
    "=========================================="
  );

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  console.log(
    "=========================================="
  );

  return measurements;
}


// ============================================================
// ФОРМИРОВАНИЕ СООБЩЕНИЯ О ЗАМЕРАХ
// ============================================================

function buildMeasurementsMessage(
  measurements
) {
  if (
    !measurements.length
  ) {
    return (
      "📋 Замеров для подтверждения не найдено."
    );
  }

  let text =
    "📋 Замеры для подтверждения\n\n";

  measurements.forEach(
    (item, index) => {
      text +=
        `━━━━━━━━━━━━━━━━━━\n`;

      text +=
        `📌 ЗАМЕР №${index + 1}\n\n`;

      text +=
        `👤 Клиент: ${
          item.client_name ||
          "—"
        }\n`;

      if (
        item.client_phones &&
        item.client_phones.length
      ) {
        text +=
          `📞 Телефон: ${
            item.client_phones.join(
              ", "
            )
          }\n`;
      } else {
        text +=
          `📞 Телефон: —\n`;
      }

      text +=
        `📄 № договора: ${
          item.contract_number ||
          "—"
        }\n`;

      text +=
        `📅 Дата замера: ${
          item.measure_date ||
          "—"
        }\n`;

      text +=
        `⏰ Время замера: ${
          item.measure_time ||
          "—"
        }\n`;

      text +=
        `📍 Адрес: ${
          item.measure_address ||
          "—"
        }\n`;

      text +=
        `🏗 Продукт: ${
          item.product ||
          "—"
        }\n`;

      text +=
        `📝 Срок задачи: ${
          item.task_complete_till_moscow ||
          "—"
        }\n`;

      text +=
        `🔗 ${item.lead_link}\n\n`;
    }
  );

  text +=
    "━━━━━━━━━━━━━━━━━━\n";

  text +=
    `Всего замеров: ${measurements.length}`;

  return text;
}


// ============================================================
// ГЛАВНАЯ СТРАНИЦА
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <title>Отчёт инженеров</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 40px;
            background: #f7f7f7;
          }

          .box {
            max-width: 700px;
            margin: auto;
            background: white;
            padding: 30px;
            border-radius: 12px;
          }

          h1 {
            margin-top: 0;
          }

          a {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 18px;
            background: #1976d2;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        </style>
      </head>

      <body>
        <div class="box">
          <h1>Отчёт инженеров</h1>

          <p>
            Сервер работает.
          </p>

          <p>
            AMO Messenger webhook:
            <b>подключён</b>
          </p>

          <p>
            OAuth:
            <b>
              ${
                messengerToken
                  ? "токен найден"
                  : "токен НЕ найден"
              }
            </b>
          </p>

          <a href="/oauth/amomessenger/start">
            Авторизовать amoMessenger
          </a>
        </div>
      </body>
      </html>
    `);
  }
);


// ============================================================
// OAUTH START
// ============================================================

app.get(
  "/oauth/amomessenger/start",
  (req, res) => {
    if (
      !AMOMESSENGER_CLIENT_ID ||
      !AMOMESSENGER_CLIENT_SECRET
    ) {
      return res.status(500).send(
        "Не заданы AMOMESSENGER_CLIENT_ID или AMOMESSENGER_CLIENT_SECRET"
      );
    }

    const state =
      Math.random()
        .toString(36)
        .substring(2) +
      Date.now();

    const url =
      `${AMOMESSENGER_AUTH}/access` +
      `?client_id=${encodeURIComponent(
        AMOMESSENGER_CLIENT_ID
      )}` +
      `&redirect_uri=${encodeURIComponent(
        AMOMESSENGER_REDIRECT_URI
      )}` +
      `&response_type=code` +
      `&state=${encodeURIComponent(
        state
      )}`;

    console.log(
      "OAuth URL:",
      url
    );

    res.redirect(
      url
    );
  }
);


// ============================================================
// OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    console.log(
      "=========================================="
    );

    console.log(
      "AMOMESSENGER OAUTH CALLBACK"
    );

    console.log(
      "QUERY:",
      req.query
    );

    const code =
      req.query.code;

    if (!code) {
      return res.status(400).send(`
        <h2>Ошибка OAuth</h2>
        <p>Код авторизации не получен.</p>
        <pre>${JSON.stringify(
          req.query,
          null,
          2
        )}</pre>
      `);
    }

    try {
      const params =
        new URLSearchParams();

      params.append(
        "client_id",
        AMOMESSENGER_CLIENT_ID
      );

      params.append(
        "client_secret",
        AMOMESSENGER_CLIENT_SECRET
      );

      params.append(
        "grant_type",
        "authorization_code"
      );

      params.append(
        "code",
        code
      );

      params.append(
        "redirect_uri",
        AMOMESSENGER_REDIRECT_URI
      );

      const response =
        await axios.post(
          `${AMOMESSENGER_AUTH}/oauth2/access_token`,
          params.toString(),
          {
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            timeout: 20000
          }
        );

      const token =
        response.data;

      saveMessengerToken({
        ...token,

        expires_at:
          Date.now() +
          Number(
            token.expires_in ||
            86400
          ) *
          1000
      });

      console.log(
        "=========================================="
      );

      console.log(
        "AMOMESSENGER OAUTH: УСПЕШНО"
      );

      console.log(
        "Access Token получен:",
        Boolean(
          token.access_token
        )
      );

      console.log(
        "Refresh Token получен:",
        Boolean(
          token.refresh_token
        )
      );

      console.log(
        "=========================================="
      );

      res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="UTF-8">
          <title>OAuth</title>
        </head>

        <body style="
          font-family: Arial;
          padding: 40px;
        ">

          <h2>
            Авторизация amoMessenger успешно выполнена
          </h2>

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
            <b>${
              token.refresh_token
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>

        </body>
        </html>
      `);

    } catch (error) {
      console.error(
        "OAUTH ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).send(`
        <h2>Ошибка OAuth</h2>

        <pre>${JSON.stringify(
          error.response?.data ||
            error.message,
          null,
          2
        )}</pre>
      `);
    }
  }
);


// ============================================================
// ПРОВЕРКА ТОКЕНА
// ============================================================

app.get(
  "/debug/messenger-token",
  (req, res) => {
    res.json({
      status:
        messengerToken
          ? "OK"
          : "Токен не найден",

      has_access_token:
        Boolean(
          messengerToken?.access_token
        ),

      has_refresh_token:
        Boolean(
          messengerToken?.refresh_token
        )
    });
  }
);


// ============================================================
// DEBUG ПОИСКА ЗАМЕРОВ
// ============================================================

app.get(
  "/debug/measurements",
  async (req, res) => {
    try {
      const measurements =
        await findMeasurements();

      res.json({
        status: "OK",

        timezone:
          TIMEZONE,

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

        found_count:
          measurements.length,

        measurements
      });

    } catch (error) {
      console.error(
        "DEBUG ERROR:",
        error
      );

      res.status(500).json({
        status: "Ошибка",

        message:
          error.message
      });
    }
  }
);


// ============================================================
// AMOMESSENGER WEBHOOK
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
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

    // СРАЗУ отвечаем amo 200,
    // чтобы webhook не считался зависшим.
    res.status(200).json({
      status: "OK"
    });

    // Дальше обрабатываем событие
    // независимо от ответа webhook.

    try {
      const body =
        req.body || {};

      const eventType =
        body.event_type;

      const embedded =
        body._embedded || {};

      // ======================================================
      // ПЕРЕДАЧА УПРАВЛЕНИЯ ВИДЖЕТУ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        const event =
          embedded
            .rpa_bot_control_transferred;

        if (!event) {
          console.log(
            "Нет rpa_bot_control_transferred"
          );

          return;
        }

        const request =
          event._embedded?.request;

        const botId =
          event.bot_id;

        const requestId =
          request?.id;

        // ВАЖНО:
        // Это реальный пользователь.
        //
        // НЕ используем:
        // event._embedded.context.user_id
        // потому что там у вас ID бота.

        const receiverUserId =
          request?.author_id ||
          event._embedded?.context?.user_id;

        console.log(
          "=========================================="
        );

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
                event._embedded
                  ?.context
                  ?.user_id,

              requestAuthorId:
                request
                  ?.author_id
            },
            null,
            2
          )
        );

        console.log(
          "=========================================="
        );

        if (
          !botId ||
          !requestId ||
          !receiverUserId
        ) {
          console.error(
            "Не хватает botId/requestId/receiverUserId"
          );

          return;
        }

        // ------------------------------------------------------
        // Сначала сразу отвечаем пользователю
        // ------------------------------------------------------

        try {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,

            text:
              "⏳ Проверяю задачи на подтверждение замера..."
          });

          console.log(
            "Сообщение о начале отправлено"
          );

        } catch (error) {
          console.error(
            "Не удалось отправить сообщение о начале:",
            error.message
          );
        }

        // ------------------------------------------------------
        // Ищем замеры
        // ------------------------------------------------------

        try {
          const measurements =
            await findMeasurements();

          const text =
            buildMeasurementsMessage(
              measurements
            );

          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text
          });

          console.log(
            "Результат отправлен пользователю"
          );

        } catch (error) {
          console.error(
            "Ошибка поиска замеров:",
            error.message
          );

          try {
            await sendBotMessage({
              botId,
              requestId,
              receiverUserId,

              text:
                "❌ Не удалось получить список замеров.\n\n" +
                "Ошибка: " +
                error.message
            });
          } catch (
            sendError
          ) {
            console.error(
              "Не удалось отправить сообщение об ошибке:",
              sendError.message
            );
          }
        }

        // ------------------------------------------------------
        // Возвращаем управление amo
        // ------------------------------------------------------

        await returnControl(
          botId,
          requestId,
          "success"
        );

        console.log(
          "Управление возвращено amo"
        );

        return;
      }


      // ======================================================
      // ВХОДЯЩЕЕ СООБЩЕНИЕ ВИДЖЕТУ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        const event =
          embedded
            .rpa_bot_income_message;

        const message =
          event
            ?._embedded
            ?.income_message;

        const request =
          event
            ?._embedded
            ?.request;

        const botId =
          event?.bot_id;

        const requestId =
          request?.id;

        const receiverUserId =
          request?.author_id ||
          event
            ?._embedded
            ?.context
            ?.user_id;

        const messageText =
          (
            message?.text ||
            ""
          ).trim();

        console.log(
          "Получено сообщение:",
          messageText
        );

        // ------------------------------------------------------
        // Кнопка "Подтвердить замер"
        // ------------------------------------------------------

        if (
          messageText
            .toLowerCase()
            .includes(
              "подтвердить замер"
            )
        ) {
          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );

          try {
            await sendBotMessage({
              botId,
              requestId,
              receiverUserId,

              text:
                "⏳ Проверяю задачи на подтверждение замера..."
            });

            const measurements =
              await findMeasurements();

            const text =
              buildMeasurementsMessage(
                measurements
              );

            await sendBotMessage({
              botId,
              requestId,
              receiverUserId,
              text
            });

          } catch (error) {
            console.error(
              "Ошибка обработки Подтвердить замер:",
              error.message
            );

            try {
              await sendBotMessage({
                botId,
                requestId,
                receiverUserId,

                text:
                  "❌ Произошла ошибка при поиске замеров:\n" +
                  error.message
              });
            } catch (
              sendError
            ) {
              console.error(
                sendError.message
              );
            }
          }

          await returnControl(
            botId,
            requestId,
            "success"
          );

          return;
        }

        // ------------------------------------------------------
        // Остальные кнопки
        // ------------------------------------------------------

        if (
          messageText
            .toLowerCase()
            .includes(
              "провести замер"
            )
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,

            text:
              "🔧 Раздел «Провести замер» пока находится в разработке."
          });

          await returnControl(
            botId,
            requestId,
            "success"
          );

          return;
        }

        if (
          messageText
            .toLowerCase()
            .includes(
              "загрузить фотоотчет"
            )
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,

            text:
              "📷 Раздел «Загрузить фотоотчет» пока находится в разработке."
          });

          await returnControl(
            botId,
            requestId,
            "success"
          );

          return;
        }

        if (
          messageText
            .toLowerCase()
            .includes(
              "внести правки"
            )
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,

            text:
              "✏️ Раздел «Внести правки» пока находится в разработке."
          });

          await returnControl(
            botId,
            requestId,
            "success"
          );

          return;
        }

        // Неизвестное сообщение
        await sendBotMessage({
          botId,
          requestId,
          receiverUserId,

          text:
            "Пожалуйста, выберите действие в меню бота."
        });

        await returnControl(
          botId,
          requestId,
          "success"
        );

        return;
      }

    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        error
      );
    }
  }
);


// ============================================================
// ВАЖНО:
// Иногда webhook в настройках указывают прямо на /.
// Поэтому оставляем дополнительный POST /
// ============================================================

app.post(
  "/",
  async (req, res) => {
    console.log(
      "=========================================="
    );

    console.log(
      "POST /"
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

    // Это запрос настройки виджета
    // из sheets.amo.tm.

    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <title>Отчёт инженеров</title>
      </head>

      <body style="
        font-family: Arial;
        padding: 30px;
      ">

        <h2>
          Отчёт инженеров
        </h2>

        <p>
          Виджет подключён и готов к работе.
        </p>

      </body>
      </html>
    `);
  }
);


// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "СЕРВЕР ЗАПУЩЕН"
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
      "AMOMESSENGER TOKEN:",
      messengerToken
        ? "ЕСТЬ"
        : "НЕТ"
    );

    console.log(
      "=========================================="
    );
  }
);
