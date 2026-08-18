const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

// -------------------- amoCRM --------------------

const AMOCRM_SUBDOMAIN =
  process.env.AMOCRM_SUBDOMAIN || "zlmk";

const AMOCRM_BASE_URL =
  `https://${AMOCRM_SUBDOMAIN}.amocrm.ru`;

const AMOCRM_ACCESS_TOKEN =
  process.env.AMOCRM_ACCESS_TOKEN || "";

// -------------------- amoMessenger --------------------

const AMOMESSENGER_API =
  "https://api.amo.tm";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  `${process.env.RENDER_EXTERNAL_URL || "https://amobot-cpck.onrender.com"}/oauth/amomessenger/callback`;

const AMOMESSENGER_BOT_ID =
  process.env.AMOMESSENGER_BOT_ID ||
  "3a807710-9afb-11f1-884e-eec7b5bfceb5";

// ============================================================
// ПОСТОЯННЫЕ НАСТРОЙКИ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

const TIMEZONE = "Europe/Moscow";

// ============================================================
// ФАЙЛ ДЛЯ ТОКЕНА AMOMESSENGER
// ============================================================

const TOKEN_FILE = path.join(
  process.cwd(),
  "amomessenger_token.json"
);

function readMessengerToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }

    const data = JSON.parse(
      fs.readFileSync(TOKEN_FILE, "utf8")
    );

    return data;
  } catch (error) {
    console.error(
      "Ошибка чтения токена amoMessenger:",
      error.message
    );

    return null;
  }
}

function saveMessengerToken(data) {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    console.log(
      "Токен amoMessenger сохранён."
    );
  } catch (error) {
    console.error(
      "Ошибка сохранения токена:",
      error.message
    );
  }
}

// ============================================================
// ТОКЕН AMOMESSENGER
// ============================================================

function getMessengerAccessToken() {
  const saved = readMessengerToken();

  if (saved && saved.access_token) {
    return saved.access_token;
  }

  if (process.env.AMOMESSENGER_ACCESS_TOKEN) {
    return process.env.AMOMESSENGER_ACCESS_TOKEN;
  }

  return null;
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function moscowDateTime(timestampSeconds) {
  if (!timestampSeconds) {
    return null;
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  ).format(
    new Date(timestampSeconds * 1000)
  );
}

function getMoscowNow() {
  return new Date();
}

function startOfMoscowDay(date) {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(date);

  const year = parts.find(
    x => x.type === "year"
  ).value;

  const month = parts.find(
    x => x.type === "month"
  ).value;

  const day = parts.find(
    x => x.type === "day"
  ).value;

  // Москва UTC+3
  return Math.floor(
    new Date(
      `${year}-${month}-${day}T00:00:00+03:00`
    ).getTime() / 1000
  );
}

function yesterdayStartMoscow() {
  return startOfMoscowDay(
    new Date(
      Date.now() - 24 * 60 * 60 * 1000
    )
  );
}

function nowTimestamp() {
  return Math.floor(
    Date.now() / 1000
  );
}

function safeString(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  return String(value);
}

// ============================================================
// AMOCRM GET
// ============================================================

async function amoCRMGet(url) {

  if (!AMOCRM_ACCESS_TOKEN) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
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
          `Bearer ${AMOCRM_ACCESS_TOKEN}`,

        Accept:
          "application/hal+json"
      },

      timeout: 30000
    }
  );

  return response.data;
}

// ============================================================
// AMOMESSENGER POST
// ============================================================

async function messengerPost(
  url,
  body
) {

  const token =
    getMessengerAccessToken();

  if (!token) {
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

  const response =
    await axios.post(
      url,
      body,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
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
}

// ============================================================
// ПОЛУЧЕНИЕ ЗНАЧЕНИЯ ПОЛЯ СДЕЛКИ
// ============================================================

function getCustomField(
  lead,
  fieldId
) {

  const fields =
    lead &&
    Array.isArray(
      lead.custom_fields_values
    )
      ? lead.custom_fields_values
      : [];

  const field =
    fields.find(
      f =>
        Number(f.field_id) ===
        Number(fieldId)
    );

  if (!field) {
    return null;
  }

  if (
    !Array.isArray(field.values) ||
    field.values.length === 0
  ) {
    return null;
  }

  return field;
}

// ============================================================
// ПОЛУЧЕНИЕ ТЕКСТОВОГО ЗНАЧЕНИЯ
// ============================================================

function getFieldValue(
  lead,
  fieldId
) {

  const field =
    getCustomField(
      lead,
      fieldId
    );

  if (!field) {
    return null;
  }

  const first =
    field.values[0];

  if (!first) {
    return null;
  }

  return (
    first.value ??
    null
  );
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function isMarinaLead(lead) {

  const field =
    getCustomField(
      lead,
      ENGINEER_FIELD_ID
    );

  if (!field) {
    return false;
  }

  const values =
    Array.isArray(field.values)
      ? field.values
      : [];

  return values.some(
    value => {

      const enumId =
        Number(
          value.enum_id
        );

      const textValue =
        safeString(
          value.value
        ).trim();

      return (
        enumId ===
          Number(ENGINEER_ENUM_ID)
        ||
        textValue ===
          ENGINEER_NAME
      );
    }
  );
}

// ============================================================
// ПОЛУЧЕНИЕ КОНТАКТА
// ============================================================

async function getMainContact(
  lead
) {

  const contacts =
    lead &&
    lead._embedded &&
    Array.isArray(
      lead._embedded.contacts
    )
      ? lead._embedded.contacts
      : [];

  if (!contacts.length) {
    return {
      name: "",
      phones: []
    };
  }

  let contact =
    contacts.find(
      c => c.is_main
    ) ||
    contacts[0];

  try {

    const data =
      await amoCRMGet(
        `${AMOCRM_BASE_URL}/api/v4/contacts/${contact.id}`
      );

    let name =
      safeString(
        data.name
      );

    const phones = [];

    const fields =
      Array.isArray(
        data.custom_fields_values
      )
        ? data.custom_fields_values
        : [];

    for (const field of fields) {

      const fieldName =
        safeString(
          field.field_name
        ).toLowerCase();

      if (
        fieldName.includes("телефон")
      ) {

        const values =
          Array.isArray(field.values)
            ? field.values
            : [];

        for (const value of values) {

          const phone =
            safeString(
              value.value
            ).trim();

          if (phone) {
            phones.push(phone);
          }
        }
      }
    }

    return {
      name,
      phones
    };

  } catch (error) {

    console.error(
      "Ошибка получения контакта:",
      error.message
    );

    return {
      name: "",
      phones: []
    };
  }
}

// ============================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(
  leadId
) {

  const url =
    `${AMOCRM_BASE_URL}/api/v4/leads/${leadId}?with=contacts`;

  return await amoCRMGet(url);
}

// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ
// ============================================================

async function getMeasurementTasks() {

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

  const from =
    yesterdayStartMoscow();

  const to =
    nowTimestamp();

  const allTasks = [];

  let page = 1;

  while (true) {

    const params =
      new URLSearchParams();

    params.set(
      "filter[entity_type]",
      "leads"
    );

    // Только незавершённые
    params.append(
      "filter[is_completed][]",
      "0"
    );

    // Только Подтв. замер(и)
    params.append(
      "filter[task_type][]",
      String(
        MEASUREMENT_TASK_TYPE_ID
      )
    );

    // Дата исполнения задачи
    params.set(
      "filter[complete_till][from]",
      String(from)
    );

    params.set(
      "filter[complete_till][to]",
      String(to)
    );

    params.set(
      "limit",
      "250"
    );

    params.set(
      "page",
      String(page)
    );

    params.set(
      "order[complete_till]",
      "asc"
    );

    const url =
      `${AMOCRM_BASE_URL}/api/v4/tasks?${params.toString()}`;

    console.log(
      "=========================================="
    );

    console.log(
      "Запрос задач:",
      params.toString()
    );

    let data;

    try {

      data =
        await amoCRMGet(url);

    } catch (error) {

      console.error(
        "Ошибка получения задач:",
        error.response?.status,
        error.response?.data ||
          error.message
      );

      break;
    }

    const tasks =
      data &&
      data._embedded &&
      Array.isArray(
        data._embedded.tasks
      )
        ? data._embedded.tasks
        : [];

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(
      ...tasks
    );

    if (
      !data._links ||
      !data._links.next
    ) {
      break;
    }

    if (tasks.length < 250) {
      break;
    }

    page++;

    // Защита от бесконечной пагинации
    if (page > 20) {
      console.log(
        "Остановлена пагинация после 20 страниц."
      );
      break;
    }
  }

  console.log(
    "Всего задач:",
    allTasks.length
  );

  // ----------------------------------------------------------
  // Дополнительная локальная проверка.
  // Она нужна даже если API уже отфильтровал задачи.
  // ----------------------------------------------------------

  const validTasks =
    allTasks.filter(
      task => {

        const entityOk =
          task.entity_type ===
          "leads";

        const typeOk =
          Number(
            task.task_type_id
          ) ===
          Number(
            MEASUREMENT_TASK_TYPE_ID
          );

        const completedOk =
          task.is_completed === false;

        const dateOk =
          Number(
            task.complete_till
          ) >= from &&
          Number(
            task.complete_till
          ) <= to;

        return (
          entityOk &&
          typeOk &&
          completedOk &&
          dateOk
        );
      }
    );

  console.log(
    "Найдено подходящих задач:",
    validTasks.length
  );

  return {
    tasks: validTasks,
    from,
    to
  };
}

// ============================================================
// ФОРМИРОВАНИЕ ОДНОГО ЗАМЕРА
// ============================================================

async function buildMeasurement(
  task
) {

  const leadId =
    task.entity_id;

  if (!leadId) {
    return null;
  }

  let lead;

  try {

    lead =
      await getLead(
        leadId
      );

  } catch (error) {

    console.error(
      `Не удалось получить сделку ${leadId}:`,
      error.response?.status,
      error.response?.data ||
        error.message
    );

    return null;
  }

  // ==========================================================
  // ГЛАВНАЯ ПРОВЕРКА:
  // инженер находится именно в сделке
  // ==========================================================

  const engineerOk =
    isMarinaLead(
      lead
    );

  console.log(
    `Сделка ${leadId}: инженер Марина =`,
    engineerOk
  );

  if (!engineerOk) {
    return null;
  }

  // ==========================================================
  // ВАЖНО:
  // НИ ОДНО ИЗ ЭТИХ ПОЛЕЙ НЕ ЯВЛЯЕТСЯ ОБЯЗАТЕЛЬНЫМ.
  // Если поле пустое — сделку всё равно показываем.
  // ==========================================================

  const contractNumber =
    getFieldValue(
      lead,
      412776
    );

  const measureDate =
    getFieldValue(
      lead,
      175370
    );

  const measureTime =
    getFieldValue(
      lead,
      413828
    );

  const measureAddress =
    getFieldValue(
      lead,
      175412
    );

  const product =
    getFieldValue(
      lead,
      172572
    );

  const client =
    await getMainContact(
      lead
    );

  return {

    task_id:
      task.id,

    task_complete_till:
      task.complete_till,

    task_complete_till_moscow:
      moscowDateTime(
        task.complete_till
      ),

    lead_id:
      lead.id,

    contract_number:
      contractNumber || "",

    measure_date:
      measureDate || "",

    measure_time:
      measureTime || "",

    measure_address:
      measureAddress || "",

    product:
      product || "",

    client_name:
      client.name || "",

    client_phones:
      client.phones || [],

    lead_link:
      `${AMOCRM_BASE_URL}/leads/detail/${lead.id}`,

    engineer:
      ENGINEER_NAME
  };
}

// ============================================================
// ПОИСК ВСЕХ ЗАМЕРОВ
// ============================================================

async function findMeasurements() {

  const result =
    await getMeasurementTasks();

  const tasks =
    result.tasks;

  const measurements = [];

  for (
    const task of tasks
  ) {

    console.log(
      "=========================================="
    );

    console.log(
      "Проверяем задачу:",
      task.id
    );

    console.log(
      "Сделка:",
      task.entity_id
    );

    console.log(
      "Срок:",
      moscowDateTime(
        task.complete_till
      )
    );

    const measurement =
      await buildMeasurement(
        task
      );

    if (measurement) {

      measurements.push(
        measurement
      );

      console.log(
        ">>> СДЕЛКА ПОДХОДИТ <<<"
      );

    } else {

      console.log(
        "Сделка не подходит."
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

  return {
    ...result,
    measurements
  };
}

// ============================================================
// ФОРМАТ СООБЩЕНИЯ БОТУ
// ============================================================

function formatMeasurement(
  measurement
) {

  const contract =
    measurement.contract_number ||
    "не заполнено";

  const date =
    measurement.measure_date ||
    "не заполнено";

  const time =
    measurement.measure_time ||
    "не заполнено";

  const address =
    measurement.measure_address ||
    "не заполнено";

  const product =
    measurement.product ||
    "не заполнено";

  const client =
    measurement.client_name ||
    "не заполнено";

  const phones =
    Array.isArray(
      measurement.client_phones
    ) &&
    measurement.client_phones.length
      ? measurement.client_phones.join(
          ", "
        )
      : "не заполнено";

  return (
    `📋 Подтвердить замер\n\n` +

    `Клиент: ${client}\n` +

    `Телефон: ${phones}\n\n` +

    `№ договора: ${contract}\n` +

    `Дата замера: ${date}\n` +

    `Время замера: ${time}\n` +

    `Адрес объекта: ${address}\n` +

    `Продукт: ${product}\n\n` +

    `Срок выполнения задачи: ` +
    `${measurement.task_complete_till_moscow}\n\n` +

    `${measurement.lead_link}`
  );
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В ЗАЯВКУ AMOMESSENGER
// ============================================================

async function sendBotMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  replyMarkup = null
) {

  const body = {
    text,
    receiver: {
      user_id:
        receiverUserId
    }
  };

  if (replyMarkup) {
    body.reply_markup =
      replyMarkup;
  }

  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}/request/${requestId}/sendMessage`;

  return await messengerPost(
    url,
    body
  );
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMOMESSENGER
// ============================================================

async function returnControl(
  botId,
  requestId
) {

  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}/request/${requestId}/returnControl`;

  try {

    await messengerPost(
      url,
      {
        return_code:
          "success"
      }
    );

    console.log(
      "Управление возвращено amoMessenger."
    );

  } catch (error) {

    console.error(
      "Ошибка возврата управления:",
      error.response?.status,
      error.response?.data ||
        error.message
    );
  }
}

// ============================================================
// ГЛАВНАЯ ЛОГИКА КНОПКИ
// ============================================================

async function handleConfirmMeasurement(
  botId,
  requestId,
  receiverUserId
) {

  console.log(
    "=========================================="
  );

  console.log(
    "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ:",
    "ПОДТВЕРДИТЬ ЗАМЕР"
  );

  console.log(
    "=========================================="
  );

  try {

    // --------------------------------------------------------
    // Сначала сообщаем пользователю,
    // что поиск начался.
    // --------------------------------------------------------

    try {

      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        "⏳ Проверяю задачи на подтверждение замера..."
      );

      console.log(
        "Сообщение о начале отправлено."
      );

    } catch (error) {

      console.error(
        "Не удалось отправить сообщение о начале:",
        error.response?.status,
        error.response?.data ||
          error.message
      );
    }

    // --------------------------------------------------------
    // Ищем задачи
    // --------------------------------------------------------

    const result =
      await findMeasurements();

    const measurements =
      result.measurements;

    // --------------------------------------------------------
    // Если ничего не найдено
    // --------------------------------------------------------

    if (
      !measurements.length
    ) {

      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        "📋 Замеров для подтверждения не найдено."
      );

      return;
    }

    // --------------------------------------------------------
    // Если найдено несколько сделок
    // --------------------------------------------------------

    let text =
      `📋 Найдено замеров: ${measurements.length}\n\n`;

    measurements.forEach(
      (
        measurement,
        index
      ) => {

        text +=
          `━━━━━━━━━━━━━━\n` +

          `№ ${index + 1}\n\n` +

          formatMeasurement(
            measurement
          ) +

          `\n\n`;
      }
    );

    // --------------------------------------------------------
    // Кнопки
    // --------------------------------------------------------

    const replyMarkup = {
      inline_keyboard: {
        buttons: [
          {
            text: "Готово"
          }
        ]
      }
    };

    await sendBotMessage(
      botId,
      requestId,
      receiverUserId,
      text,
      replyMarkup
    );

    console.log(
      "Результат отправлен пользователю."
    );

  } catch (error) {

    console.error(
      "ОШИБКА ОСНОВНОЙ ЛОГИКИ:",
      error.response?.status,
      error.response?.data ||
        error.message
    );

    try {

      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        "❗ Произошла ошибка при получении данных. Попробуйте ещё раз."
      );

    } catch (sendError) {

      console.error(
        "Не удалось отправить ошибку пользователю:",
        sendError.response?.status,
        sendError.response?.data ||
          sendError.message
      );
    }

  } finally {

    // ВАЖНО:
    // обязательно возвращаем управление amoMessenger

    await returnControl(
      botId,
      requestId
    );
  }
}

// ============================================================
// WEBHOOK AMOMESSENGER
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

    // Сразу отвечаем amoMessenger,
    // чтобы webhook не ждал всю работу.
    res.status(200).json({
      status: "OK"
    });

    try {

      const body =
        req.body || {};

      const eventType =
        body.event_type;

      const embedded =
        body._embedded || {};

      // ------------------------------------------------------
      // Получаем контекст
      // ------------------------------------------------------

      const context =
        embedded.context || {};

      const contextUserId =
        context.user_id || null;

      // ------------------------------------------------------
      // Передача управления виджету
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {

        const transferred =
          embedded
            .rpa_bot_control_transferred;

        const transferredEmbedded =
          transferred &&
          transferred._embedded
            ? transferred._embedded
            : {};

        const request =
          transferredEmbedded.request ||
          {};

        const botId =
          transferred.bot_id ||
          request.bot_id ||
          AMOMESSENGER_BOT_ID;

        const requestId =
          request.id;

        const requestAuthorId =
          request.author_id || null;

        const receiverUserId =
          requestAuthorId ||
          contextUserId;

        console.log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ"
        );

        console.log(
          JSON.stringify(
            {
              botId,
              requestId,
              receiverUserId,
              contextUserId,
              requestAuthorId
            },
            null,
            2
          )
        );

        if (
          requestId &&
          receiverUserId
        ) {

          // Не блокируем webhook
          handleConfirmMeasurement(
            botId,
            requestId,
            receiverUserId
          ).catch(
            error => {
              console.error(
                "Ошибка фоновой обработки:",
                error.message
              );
            }
          );
        }

        return;
      }

      // ------------------------------------------------------
      // Сообщение пользователя,
      // если оно приходит непосредственно боту
      // ------------------------------------------------------

      if (
        eventType ===
        "income_message"
      ) {

        const message =
          embedded.message;

        if (!message) {
          return;
        }

        console.log(
          "Получено сообщение:",
          message.text
        );

        return;
      }

      // ------------------------------------------------------
      // Сообщение внутри RPA заявки
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {

        const data =
          embedded.rpa_bot_income_message;

        if (!data) {
          return;
        }

        const dataEmbedded =
          data._embedded || {};

        const incomeMessage =
          dataEmbedded.income_message ||
          {};

        const request =
          dataEmbedded.request ||
          {};

        const text =
          safeString(
            incomeMessage.text
          ).trim();

        const botId =
          data.bot_id ||
          request.bot_id ||
          AMOMESSENGER_BOT_ID;

        const requestId =
          request.id;

        const receiverUserId =
          request.author_id ||
          contextUserId;

        console.log(
          "Получено сообщение:",
          text
        );

        if (
          text ===
          "Подтвердить замер"
        ) {

          await handleConfirmMeasurement(
            botId,
            requestId,
            receiverUserId
          );

          return;
        }

        return;
      }

    } catch (error) {

      console.error(
        "WEBHOOK ERROR:",
        error.message
      );
    }
  }
);

// ============================================================
// СТРАНИЦА ПРОВЕРКИ
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(
      `
      <h1>Отчёт инженеров</h1>
      <p>Сервер работает.</p>
      <p>amoCRM: ${AMOCRM_SUBDOMAIN}.amocrm.ru</p>
      <p>Инженер: ${ENGINEER_NAME}</p>
      <p>ID поля: ${ENGINEER_FIELD_ID}</p>
      <p>ID значения: ${ENGINEER_ENUM_ID}</p>
      <p>ID типа задачи: ${MEASUREMENT_TASK_TYPE_ID}</p>
      <p>Часовой пояс: ${TIMEZONE}</p>
      `
    );
  }
);

// ============================================================
// DEBUG: AMOCRM
// ============================================================

app.get(
  "/debug/amocrm-test",
  async (req, res) => {

    try {

      const data =
        await amoCRMGet(
          `${AMOCRM_BASE_URL}/api/v4/account`
        );

      res.json({
        status:
          "Связь с amoCRM работает!",

        account_name:
          data.name,

        account_id:
          data.id,

        subdomain:
          AMOCRM_SUBDOMAIN
      });

    } catch (error) {

      res.status(500).json({
        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: ПОЛЕ ИНЖЕНЕРА
// ============================================================

app.get(
  "/debug/engineer-field",
  async (req, res) => {

    try {

      const data =
        await amoCRMGet(
          `${AMOCRM_BASE_URL}/api/v4/leads/custom_fields`
        );

      const fields =
        data &&
        data._embedded &&
        Array.isArray(
          data._embedded.custom_fields
        )
          ? data._embedded.custom_fields
          : [];

      const field =
        fields.find(
          f =>
            Number(f.id) ===
            Number(ENGINEER_FIELD_ID)
        );

      if (!field) {

        return res.json({
          status: "NOT_FOUND",
          expected_field_id:
            ENGINEER_FIELD_ID
        });
      }

      const values =
        field.enums ||
        field.values ||
        [];

      const found =
        values.find(
          v =>
            Number(v.id) ===
            Number(ENGINEER_ENUM_ID)
          ||
            v.value ===
            ENGINEER_NAME
        );

      res.json({

        status: "OK",

        field: {
          id:
            field.id,

          name:
            field.name,

          type:
            field.type
        },

        expected_engineer: {
          name:
            ENGINEER_NAME,

          enum_id:
            ENGINEER_ENUM_ID
        },

        found_engineer:
          found || null,

        all_values:
          values.map(
            v => ({
              id:
                v.id,

              value:
                v.value,

              sort:
                v.sort
            })
          )
      });

    } catch (error) {

      res.status(500).json({
        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: ВСЕ ЗАДАЧИ ПО ТЕКУЩЕМУ ФИЛЬТРУ
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {

    try {

      const result =
        await getMeasurementTasks();

      res.json({

        status:
          "OK",

        timezone:
          TIMEZONE,

        current_moscow_time:
          moscowDateTime(
            nowTimestamp()
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
            moscowDateTime(
              result.from
            ),

          to:
            moscowDateTime(
              result.to
            )
        },

        tasks_loaded:
          result.tasks.length,

        tasks:
          result.tasks.map(
            task => ({
              id:
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
                moscowDateTime(
                  task.complete_till
                )
            })
          ),

        measurements:
          result.measurements
      });

    } catch (error) {

      console.error(
        "DEBUG tasks-test ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({

        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: КОНКРЕТНАЯ ЗАДАЧА
// ============================================================

app.get(
  "/debug/task-test/:taskId",
  async (req, res) => {

    try {

      const taskId =
        Number(
          req.params.taskId
        );

      if (!taskId) {

        return res.status(400).json({
          status:
            "Ошибка",

          message:
            "Неверный ID задачи"
        });
      }

      const task =
        await amoCRMGet(
          `${AMOCRM_BASE_URL}/api/v4/tasks/${taskId}`
        );

      const from =
        yesterdayStartMoscow();

      const to =
        nowTimestamp();

      const passes = {

        entity_type:
          task.entity_type ===
          "leads",

        task_type:
          Number(
            task.task_type_id
          ) ===
          Number(
            MEASUREMENT_TASK_TYPE_ID
          ),

        not_completed:
          task.is_completed === false,

        date:
          Number(
            task.complete_till
          ) >= from &&
          Number(
            task.complete_till
          ) <= to
      };

      res.json({

        status:
          "OK",

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
          moscowDateTime(
            task.complete_till
          ),

        date_mode:
          "до 18:00",

        date_range: {
          from:
            moscowDateTime(
              from
            ),

          to:
            moscowDateTime(
              to
            )
        },

        passes
      });

    } catch (error) {

      res.status(500).json({

        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: КОНКРЕТНАЯ СДЕЛКА
// ============================================================

app.get(
  "/debug/lead-test/:leadId",
  async (req, res) => {

    try {

      const leadId =
        Number(
          req.params.leadId
        );

      const lead =
        await getLead(
          leadId
        );

      const engineerField =
        getCustomField(
          lead,
          ENGINEER_FIELD_ID
        );

      const engineerOk =
        isMarinaLead(
          lead
        );

      res.json({

        status:
          "OK",

        lead_id:
          lead.id,

        lead_name:
          lead.name,

        is_marina:
          engineerOk,

        engineer_field:
          engineerField,

        contract_number:
          getFieldValue(
            lead,
            412776
          ),

        measure_date:
          getFieldValue(
            lead,
            175370
          ),

        measure_time:
          getFieldValue(
            lead,
            413828
          ),

        address:
          getFieldValue(
            lead,
            175412
          ),

        product:
          getFieldValue(
            lead,
            172572
          ),

        link:
          `${AMOCRM_BASE_URL}/leads/detail/${lead.id}`,

        raw_lead:
          lead
      });

    } catch (error) {

      res.status(500).json({

        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: ПРОВЕРКА КОНКРЕТНОЙ ЗАДАЧИ + СДЕЛКИ
// ============================================================

app.get(
  "/debug/measurement-test/:taskId",
  async (req, res) => {

    try {

      const taskId =
        Number(
          req.params.taskId
        );

      const task =
        await amoCRMGet(
          `${AMOCRM_BASE_URL}/api/v4/tasks/${taskId}`
        );

      const lead =
        await getLead(
          task.entity_id
        );

      const engineerField =
        getCustomField(
          lead,
          ENGINEER_FIELD_ID
        );

      const engineerOk =
        isMarinaLead(
          lead
        );

      const contact =
        await getMainContact(
          lead
        );

      res.json({

        status:
          "OK",

        task: {

          id:
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
            moscowDateTime(
              task.complete_till
            )
        },

        lead: {

          id:
            lead.id,

          name:
            lead.name,

          engineer_ok:
            engineerOk,

          engineer_field:
            engineerField,

          contract_number:
            getFieldValue(
              lead,
              412776
            ),

          measure_date:
            getFieldValue(
              lead,
              175370
            ),

          measure_time:
            getFieldValue(
              lead,
              413828
            ),

          address:
            getFieldValue(
              lead,
              175412
            ),

          product:
            getFieldValue(
              lead,
              172572
            )
        },

        client:
          contact
      });

    } catch (error) {

      res.status(500).json({

        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: MARINA LEADS
// ============================================================

app.get(
  "/debug/marina-leads",
  async (req, res) => {

    try {

      const result =
        await getMeasurementTasks();

      const details = [];

      for (
        const task of result.tasks
      ) {

        const lead =
          await getLead(
            task.entity_id
          );

        const engineerOk =
          isMarinaLead(
            lead
          );

        details.push({

          task_id:
            task.id,

          lead_id:
            lead.id,

          lead_name:
            lead.name,

          is_marina:
            engineerOk,

          engineer_field:
            getCustomField(
              lead,
              ENGINEER_FIELD_ID
            )
        });
      }

      res.json({

        status:
          "OK",

        tasks_loaded:
          result.tasks.length,

        details
      });

    } catch (error) {

      res.status(500).json({

        status:
          "Ошибка",

        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// DEBUG: ТОКЕН AMOMESSENGER
// ============================================================

app.get(
  "/debug/messenger-token",
  (req, res) => {

    const token =
      readMessengerToken();

    res.json({

      status:
        token &&
        token.access_token
          ? "OK"
          : "Токен не найден",

      access_token:
        token &&
        token.access_token
          ? "ДА"
          : "НЕТ",

      refresh_token:
        token &&
        token.refresh_token
          ? "ДА"
          : "НЕТ"
    });
  }
);

// ============================================================
// OAUTH AMOMESSENGER
// ============================================================

app.get(
  "/oauth/amomessenger",
  (req, res) => {

    if (
      !AMOMESSENGER_CLIENT_ID
    ) {

      return res.status(500).send(
        "AMOMESSENGER_CLIENT_ID не задан."
      );
    }

    const params =
      new URLSearchParams({

        client_id:
          AMOMESSENGER_CLIENT_ID,

        redirect_uri:
          AMOMESSENGER_REDIRECT_URI,

        response_type:
          "code"
      });

    const url =
      `https://www.amocrm.ru/oauth?${params.toString()}`;

    res.redirect(url);
  }
);

// ============================================================
// OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {

    const code =
      req.query.code;

    if (!code) {

      return res.status(400).send(
        "Код авторизации не получен."
      );
    }

    if (
      !AMOMESSENGER_CLIENT_ID ||
      !AMOMESSENGER_CLIENT_SECRET
    ) {

      return res.status(500).send(
        "Не заданы AMOMESSENGER_CLIENT_ID или AMOMESSENGER_CLIENT_SECRET."
      );
    }

    try {

      const response =
        await axios.post(

          "https://api.amo.tm/v1.3/oauth2/access_token",

          {
            client_id:
              AMOMESSENGER_CLIENT_ID,

            client_secret:
              AMOMESSENGER_CLIENT_SECRET,

            grant_type:
              "authorization_code",

            code,

            redirect_uri:
              AMOMESSENGER_REDIRECT_URI
          },

          {
            headers: {
              "Content-Type":
                "application/json"
            },

            timeout: 30000
          }
        );

      saveMessengerToken(
        response.data
      );

      res.send(`
        <html>
        <head>
          <meta charset="UTF-8">
          <title>amoMessenger</title>
        </head>
        <body style="font-family:Arial;padding:40px;">
          <h2>Авторизация amoMessenger успешно выполнена</h2>

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
              ${
                response.data.refresh_token
                  ? "ДА"
                  : "НЕТ"
              }
            </b>
          </p>
        </body>
        </html>
      `);

    } catch (error) {

      console.error(
        "OAuth amoMessenger ERROR:",
        error.response?.status,
        error.response?.data ||
          error.message
      );

      res.status(500).send(
        `
        <h2>Ошибка авторизации amoMessenger</h2>
        <pre>${JSON.stringify(
          error.response?.data ||
            error.message,
          null,
          2
        )}</pre>
        `
      );
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      status:
        "OK",

      server:
        "amobot-cpck",

      timezone:
        TIMEZONE,

      amocrm:
        AMOCRM_SUBDOMAIN,

      engineer:
        ENGINEER_NAME,

      engineer_field_id:
        ENGINEER_FIELD_ID,

      engineer_enum_id:
        ENGINEER_ENUM_ID,

      task_type_id:
        MEASUREMENT_TASK_TYPE_ID,

      messenger_token:
        getMessengerAccessToken()
          ? "OK"
          : "NOT_FOUND"
    });
  }
);

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      "=========================================="
    );

    console.log(
      "SERVER STARTED"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "AMOCRM:",
      AMOCRM_BASE_URL
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
      "MESSENGER TOKEN:",
      getMessengerAccessToken()
        ? "OK"
        : "NOT FOUND"
    );

    console.log(
      "=========================================="
    );
  }
);
