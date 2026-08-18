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

// ============================================================
// amoCRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const TASK_TYPE_ID = 2746005;

// Поля сделки
const FIELD_IDS = {
  contractNumber: 412776,
  measureDate: 175370,
  measureTime: 413828,
  measureAddress: 175412,
  product: 172572,
};

// ============================================================
// amoMessenger
// ============================================================

const AMOMESSENGER_TOKENS_FILE = path.join(
  __dirname,
  "amomessenger_tokens.json"
);

// ============================================================
// Сессии бота
// ============================================================

const activeRequests = new Map();

// ============================================================
// Логи
// ============================================================

const lastRequests = [];

function storeRequest(req) {
  lastRequests.unshift({
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    body: req.body,
    query: req.query,
  });

  if (lastRequests.length > 30) {
    lastRequests.pop();
  }
}

app.use((req, res, next) => {
  storeRequest(req);
  next();
});

// ============================================================
// JSON ФАЙЛЫ
// ============================================================

function saveJsonFile(filePath, data) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
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
// amoCRM REQUEST
// ============================================================

async function amocrmRequest(pathAndQuery) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_TOKEN;

  if (!domain) {
    throw new Error(
      "Не задана переменная AMOCRM_DOMAIN"
    );
  }

  if (!token) {
    throw new Error(
      "Не задана переменная AMOCRM_TOKEN"
    );
  }

  const cleanDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const url =
    `https://${cleanDomain}${pathAndQuery}`;

  console.log("amoCRM GET:", url);

  const response = await fetch(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = await response
    .json()
    .catch(() => null);

  if (!response.ok) {
    const error = new Error(
      `amoCRM HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ============================================================
// amoMessenger REQUEST
// ============================================================

function loadMessengerTokens() {
  const tokens = loadJsonFile(
    AMOMESSENGER_TOKENS_FILE
  );

  if (
    !tokens ||
    !tokens.access_token
  ) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  return tokens;
}

async function amoMessengerRequest(
  method,
  pathAndQuery,
  body
) {
  const tokens =
    loadMessengerTokens();

  const response = await fetch(
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
      `amoMessenger HTTP ${response.status}`
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
// МОСКОВСКОЕ ВРЕМЯ
// ============================================================

function moscowNow() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: TIME_ZONE,

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

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] =
        Number(part.value);
    }
  }

  return result;
}

// ============================================================
// MOSCOW TIMESTAMP
// ============================================================

function moscowTimestamp(
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0
) {
  const utc =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second
    );

  return Math.floor(
    (
      utc -
      3 * 60 * 60 * 1000
    ) / 1000
  );
}

// ============================================================
// ДИАПАЗОН ДАТ ЗАДАЧ
// ============================================================
//
// До 18:00:
// вчера 00:00 -> сегодня текущее время
//
// После 18:00:
// сегодня 00:00 -> завтра 23:59:59
//
// Фильтруем именно complete_till —
// дату/время исполнения задачи.
// ============================================================

function getTaskDateRange() {
  const now =
    moscowNow();

  const todayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      0,
      0,
      0
    );

  const tomorrowStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day + 1,
      0,
      0,
      0
    );

  const yesterdayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day - 1,
      0,
      0,
      0
    );

  const currentTimestamp =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute,
      now.second
    );

  // До 18:00
  if (now.hour < 18) {
    return {
      mode: "до 18:00",

      from:
        yesterdayStart,

      to:
        currentTimestamp,
    };
  }

  // После 18:00
  return {
    mode: "после 18:00",

    from:
      todayStart,

    to:
      tomorrowStart - 1,
  };
}

// ============================================================
// ФОРМАТ ДАТЫ МОСКВА
// ============================================================

function formatMoscowDate(
  timestamp
) {
  if (
    timestamp === null ||
    timestamp === undefined
  ) {
    return null;
  }

  const number =
    Number(timestamp);

  if (
    !Number.isFinite(number)
  ) {
    return null;
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIME_ZONE,

      day: "2-digit",
      month: "2-digit",
      year: "numeric",

      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",

      hourCycle: "h23",
    }
  ).format(
    new Date(number * 1000)
  );
}

// ============================================================
// ПОЛУЧИТЬ ПОЛЕ СДЕЛКИ
// ============================================================

function getField(
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

  return (
    lead.custom_fields_values.find(
      field =>
        Number(field.field_id) ===
        Number(fieldId)
    ) || null
  );
}

// ============================================================
// ТЕКСТОВОЕ ПОЛЕ
// ============================================================

function getFieldText(
  lead,
  fieldId
) {
  const field =
    getField(
      lead,
      fieldId
    );

  if (
    !field ||
    !Array.isArray(field.values) ||
    !field.values.length
  ) {
    return null;
  }

  const values =
    field.values;

  const result = [];

  for (const item of values) {
    if (
      item.value !== undefined &&
      item.value !== null &&
      String(item.value).trim() !== ""
    ) {
      result.push(
        String(item.value)
      );
    }
  }

  if (!result.length) {
    return null;
  }

  return result.join(", ");
}

// ============================================================
// ДАТА ИЗ ПОЛЯ
// ============================================================

function getFieldDate(
  lead,
  fieldId
) {
  const field =
    getField(
      lead,
      fieldId
    );

  if (
    !field ||
    !Array.isArray(field.values) ||
    !field.values.length
  ) {
    return null;
  }

  const value =
    field.values[0].value;

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
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
        timeZone: TIME_ZONE,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
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
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function isMarina(
  lead
) {
  const field =
    getField(
      lead,
      ENGINEER_FIELD_ID
    );

  if (
    !field ||
    !Array.isArray(field.values) ||
    !field.values.length
  ) {
    return false;
  }

  for (
    const value of field.values
  ) {
    // Проверка по ID значения списка
    if (
      value.enum_id !== undefined &&
      Number(value.enum_id) ===
        Number(ENGINEER_ENUM_ID)
    ) {
      return true;
    }

    // Дополнительная проверка по названию
    if (
      value.value !== undefined &&
      String(value.value).trim() ===
        ENGINEER_NAME
    ) {
      return true;
    }
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
      process.env.AMOCRM_DOMAIN ||
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

  return (
    `https://${domain}/leads/detail/${leadId}`
  );
}

// ============================================================
// ПОЛУЧИТЬ СДЕЛКУ
// ============================================================

async function getLead(
  leadId
) {
  return amocrmRequest(
    `/api/v4/leads/${leadId}?with=contacts`
  );
}

// ============================================================
// ПОЛУЧИТЬ КОНТАКТ
// ============================================================

async function getContact(
  contactId
) {
  return amocrmRequest(
    `/api/v4/contacts/${contactId}`
  );
}

// ============================================================
// ИНФОРМАЦИЯ О КЛИЕНТЕ
// ============================================================

function extractContactInfo(
  contact
) {
  const phones = [];

  if (
    contact &&
    Array.isArray(
      contact.custom_fields_values
    )
  ) {
    for (
      const field of
      contact.custom_fields_values
    ) {
      if (
        field.field_code ===
        "PHONE"
      ) {
        for (
          const value of
          field.values || []
        ) {
          if (
            value.value !== undefined &&
            value.value !== null &&
            String(value.value).trim() !== ""
          ) {
            phones.push(
              String(value.value)
            );
          }
        }
      }
    }
  }

  return {
    name:
      contact
        ? contact.name
        : null,

    phones,
  };
}

// ============================================================
// ПОЛУЧИТЬ КЛИЕНТА СДЕЛКИ
// ============================================================

async function getLeadClient(
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
      name: null,
      phones: [],
    };
  }

  const mainContact =
    contacts.find(
      contact =>
        contact.is_main === true
    ) ||
    contacts[0];

  if (
    !mainContact ||
    !mainContact.id
  ) {
    return {
      name: null,
      phones: [],
    };
  }

  try {
    const contact =
      await getContact(
        mainContact.id
      );

    return extractContactInfo(
      contact
    );

  } catch (error) {
    console.error(
      `Ошибка получения контакта ${mainContact.id}:`,
      error.message
    );

    return {
      name: null,
      phones: [],
    };
  }
}

// ============================================================
// ПОЛУЧИТЬ ЗАДАЧИ
// ============================================================
//
// ВАЖНО:
// Здесь используем фильтры, которые уже успешно заработали
// в вашем аккаунте:
//
// entity_type = leads
// is_completed = 0
// task_type = 2746005
// complete_till = нужный диапазон
//
// Поэтому вместо 800+ задач должны приходить только
// подходящие задачи.
// ============================================================

async function getMeasurementTasks() {
  const range =
    getTaskDateRange();

  const allTasks = [];

  let page = 1;

  while (true) {
    const params =
      new URLSearchParams();

    params.set(
      "filter[entity_type]",
      "leads"
    );

    params.set(
      "filter[is_completed][]",
      "0"
    );

    params.set(
      "filter[task_type][]",
      String(TASK_TYPE_ID)
    );

    params.set(
      "filter[complete_till][from]",
      String(range.from)
    );

    params.set(
      "filter[complete_till][to]",
      String(range.to)
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

    console.log(
      "=========================================="
    );

    console.log(
      "Запрос задач:"
    );

    console.log(
      params.toString()
    );

    const data =
      await amocrmRequest(
        `/api/v4/tasks?${params.toString()}`
      );

    const current =
      data &&
      data._embedded &&
      Array.isArray(
        data._embedded.tasks
      )
        ? data._embedded.tasks
        : [];

    console.log(
      `Страница задач ${page}: ${current.length}`
    );

    allTasks.push(
      ...current
    );

    if (
      current.length < 250
    ) {
      break;
    }

    page++;

    if (page > 20) {
      break;
    }
  }

  // Дополнительная локальная проверка.
  // Это страховка на случай, если amoCRM вернёт что-то лишнее.
  const filtered =
    allTasks.filter(
      task => {

        const completed =
          task.is_completed === true ||
          task.is_completed === 1 ||
          task.is_completed === "1";

        if (completed) {
          return false;
        }

        if (
          Number(task.task_type_id) !==
          Number(TASK_TYPE_ID)
        ) {
          return false;
        }

        if (
          String(task.entity_type) !==
          "leads"
        ) {
          return false;
        }

        const deadline =
          Number(
            task.complete_till
          );

        if (
          !Number.isFinite(deadline)
        ) {
          return false;
        }

        return (
          deadline >= range.from &&
          deadline <= range.to
        );
      }
    );

  console.log(
    "=========================================="
  );

  console.log(
    "Всего получено задач:",
    allTasks.length
  );

  console.log(
    "Подходящих задач:",
    filtered.length
  );

  return {
    range,
    tasks: filtered,
  };
}

// ============================================================
// ОСНОВНАЯ ФУНКЦИЯ ПОИСКА ЗАМЕРОВ
// ============================================================
//
// НОВАЯ ЛОГИКА:
//
// 1. Получаем только подходящие задачи.
// 2. Берём entity_id задачи.
// 3. По entity_id напрямую получаем сделку.
// 4. Проверяем поле "Инженер".
// 5. Если Марина — добавляем сделку.
//
// Благодаря этому больше не нужно загружать все сделки
// аккаунта.
// ============================================================

async function buildMeasurements() {
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
    TASK_TYPE_ID
  );

  console.log(
    "=========================================="
  );

  const taskResult =
    await getMeasurementTasks();

  const measurements = [];

  // Чтобы одна сделка не появилась несколько раз
  const processedLeads =
    new Set();

  for (
    const task of
    taskResult.tasks
  ) {

    const leadId =
      Number(
        task.entity_id
      );

    if (
      !Number.isFinite(leadId) ||
      leadId <= 0
    ) {
      continue;
    }

    // Если несколько задач относятся к одной сделке,
    // показываем сделку только один раз.
    if (
      processedLeads.has(
        leadId
      )
    ) {
      continue;
    }

    processedLeads.add(
      leadId
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Проверяем задачу:",
      task.id
    );

    console.log(
      "Сделка:",
      leadId
    );

    let lead;

    try {
      lead =
        await getLead(
          leadId
        );
    } catch (error) {

      console.error(
        `Не удалось получить сделку ${leadId}:`,
        error.message
      );

      continue;
    }

    // --------------------------------------------------------
    // Проверяем инженера
    // --------------------------------------------------------

    const engineerField =
      getField(
        lead,
        ENGINEER_FIELD_ID
      );

    console.log(
      "Поле инженера:",
      JSON.stringify(
        engineerField
      )
    );

    const marina =
      isMarina(
        lead
      );

    console.log(
      "Инженер Марина:",
      marina
    );

    if (!marina) {
      console.log(
        "Сделка пропущена — инженер не Марина."
      );

      continue;
    }

    console.log(
      "Сделка подходит!"
    );

    // --------------------------------------------------------
    // Получаем клиента
    // --------------------------------------------------------

    const client =
      await getLeadClient(
        lead
      );

    // --------------------------------------------------------
    // ВАЖНО:
    //
    // Пустые поля НЕ исключают сделку.
    //
    // Например:
    // measure_time = null
    // measure_address = null
    //
    // Сделка всё равно будет показана.
    // --------------------------------------------------------

    const measurement = {

      task_id:
        task.id,

      task_complete_till:
        task.complete_till,

      task_complete_till_moscow:
        formatMoscowDate(
          task.complete_till
        ),

      lead_id:
        lead.id,

      contract_number:
        getFieldText(
          lead,
          FIELD_IDS.contractNumber
        ),

      measure_date:
        getFieldDate(
          lead,
          FIELD_IDS.measureDate
        ),

      measure_time:
        getFieldText(
          lead,
          FIELD_IDS.measureTime
        ),

      measure_address:
        getFieldText(
          lead,
          FIELD_IDS.measureAddress
        ),

      product:
        getFieldText(
          lead,
          FIELD_IDS.product
        ),

      client_name:
        client.name,

      client_phones:
        client.phones,

      lead_link:
        leadLink(
          lead.id
        ),

      engineer:
        ENGINEER_NAME,
    };

    measurements.push(
      measurement
    );

    console.log(
      "Добавлен замер:",
      JSON.stringify(
        measurement,
        null,
        2
      )
    );
  }

  // Сортировка по сроку исполнения задачи
  measurements.sort(
    (a, b) =>
      Number(
        a.task_complete_till
      ) -
      Number(
        b.task_complete_till
      )
  );

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
    range:
      taskResult.range,

    tasksLoaded:
      taskResult.tasks.length,

    measurements,
  };
}

// ============================================================
// ФОРМАТ ПУСТЫХ ЗНАЧЕНИЙ
// ============================================================

function displayValue(
  value
) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return "—";
  }

  return String(value);
}

// ============================================================
// ФОРМАТ ТЕЛЕФОНОВ
// ============================================================

function displayPhones(
  phones
) {
  if (
    !Array.isArray(phones) ||
    !phones.length
  ) {
    return "—";
  }

  return phones.join(
    ", "
  );
}

// ============================================================
// СПИСОК ЗАМЕРОВ
// ============================================================
//
// Каждая сделка = одна строка.
// Значения полей одной сделки = в одну строку.
// ============================================================

function formatMeasurementsList(
  measurements
) {
  return measurements
    .map(
      item => {

        return [

          `№ договора: ${displayValue(
            item.contract_number
          )}`,

          `Дата замера: ${displayValue(
            item.measure_date
          )}`,

          `Время замера: ${displayValue(
            item.measure_time
          )}`,

          `Адрес замера: ${displayValue(
            item.measure_address
          )}`,

          `Продукт: ${displayValue(
            item.product
          )}`,

          `Имя клиента: ${displayValue(
            item.client_name
          )}`,

          `№ телефона: ${displayPhones(
            item.client_phones
          )}`,

          `Ссылка на сделку: ${displayValue(
            item.lead_link
          )}`,

        ].join("; ");
      }
    )
    .join("\n");
}

// ============================================================
// ПОДРОБНОСТИ ОДНОГО ЗАМЕРА
// ============================================================
//
// Здесь каждое значение с новой строки.
// ============================================================

function formatMeasurementDetails(
  item
) {
  return [

    `Дата замера: ${displayValue(
      item.measure_date
    )}`,

    `Время замера: ${displayValue(
      item.measure_time
    )}`,

    `Адрес замера: ${displayValue(
      item.measure_address
    )}`,

    `Продукт: ${displayValue(
      item.product
    )}`,

    `Имя клиента: ${displayValue(
      item.client_name
    )}`,

    `№ телефона: ${displayPhones(
      item.client_phones
    )}`,

    `№ договора: ${displayValue(
      item.contract_number
    )}`,

    `Ссылка на сделку: ${displayValue(
      item.lead_link
    )}`,

  ].join("\n");
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В amoMessenger
// ============================================================

async function sendBotMessage(
  botId,
  requestId,
  text,
  buttons,
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
    Array.isArray(buttons) &&
    buttons.length
  ) {

    body.reply_markup = {

      inline_keyboard: {

        buttons:
          buttons.map(
            buttonText => ({
              text:
                String(
                  buttonText
                ),
            })
          ),
      },
    };
  }

  console.log(
    "=========================================="
  );

  console.log(
    "amoMessenger POST:",
    `/v1.3/bots/${botId}/request/${requestId}/sendMessage`
  );

  console.log(
    "BODY:",
    JSON.stringify(
      body,
      null,
      2
    )
  );

  const result =
    await amoMessengerRequest(
      "POST",
      `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
      body
    );

  console.log(
    "Сообщение отправлено:",
    result
  );

  return result;
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ amoMessenger
// ============================================================

async function returnControl(
  botId,
  requestId,
  code = "success"
) {
  console.log(
    "Возвращаем управление amoMessenger"
  );

  return amoMessengerRequest(
    "POST",
    `/v1.3/bots/${botId}/request/${requestId}/returnControl`,
    {
      return_code:
        code,
    }
  );
}

// ============================================================
// ГЛАВНОЕ МЕНЮ
// ============================================================

function getMainMenuButtons() {
  return [
    "Подтвердить замер",
    "Провести замер",
    "Загрузить фотоотчет",
    "Внести правки",
  ];
}

// ============================================================
// DEBUG: AMOCRM
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

    } catch (error) {

      res.status(500)
        .json({

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
// DEBUG: AMOMESSENGER TOKEN
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

    if (
      !tokens ||
      !tokens.access_token
    ) {

      return res.json({
        status:
          "Токен не найден",
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
        tokens.obtained_at ||
        null,

    });
  }
);

// ============================================================
// DEBUG: ПОЛЕ ИНЖЕНЕР
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

      const values =
        field.enums || [];

      const found =
        values.find(
          item =>
            Number(item.id) ===
            Number(ENGINEER_ENUM_ID)
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
          found || null,

        all_values:
          values,
      });

    } catch (error) {

      res.status(500)
        .json({

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
// DEBUG: КОНКРЕТНАЯ СДЕЛКА
// ============================================================

app.get(
  "/debug/lead-test/:id",
  async (
    req,
    res
  ) => {

    try {

      const lead =
        await getLead(
          req.params.id
        );

      res.json({

        status:
          "OK",

        lead_id:
          lead.id,

        lead_name:
          lead.name,

        is_marina:
          isMarina(
            lead
          ),

        engineer_field:
          getField(
            lead,
            ENGINEER_FIELD_ID
          ),

        contract_number:
          getFieldText(
            lead,
            FIELD_IDS.contractNumber
          ),

        measure_date:
          getFieldDate(
            lead,
            FIELD_IDS.measureDate
          ),

        measure_time:
          getFieldText(
            lead,
            FIELD_IDS.measureTime
          ),

        address:
          getFieldText(
            lead,
            FIELD_IDS.measureAddress
          ),

        product:
          getFieldText(
            lead,
            FIELD_IDS.product
          ),

        link:
          leadLink(
            lead.id
          ),

        contacts:
          lead._embedded &&
          lead._embedded.contacts
            ? lead._embedded.contacts
            : [],
      });

    } catch (error) {

      res.status(500)
        .json({

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
// DEBUG: КОНКРЕТНАЯ ЗАДАЧА
// ============================================================

app.get(
  "/debug/task-test/:id",
  async (
    req,
    res
  ) => {

    try {

      const taskId =
        Number(
          req.params.id
        );

      if (!taskId) {

        return res
          .status(400)
          .json({

            status:
              "Ошибка",

            message:
              "Неверный ID задачи",
          });
      }

      const task =
        await amocrmRequest(
          `/api/v4/tasks/${taskId}`
        );

      const range =
        getTaskDateRange();

      const deadline =
        Number(
          task.complete_till
        );

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
          formatMoscowDate(
            task.complete_till
          ),

        date_mode:
          range.mode,

        date_range: {

          from:
            formatMoscowDate(
              range.from
            ),

          to:
            formatMoscowDate(
              range.to
            ),
        },

        passes: {

          entity_type:
            String(
              task.entity_type
            ) === "leads",

          task_type:
            Number(
              task.task_type_id
            ) ===
            Number(
              TASK_TYPE_ID
            ),

          not_completed:
            task.is_completed === false ||
            task.is_completed === 0 ||
            task.is_completed === "0",

          date:
            Number.isFinite(
              deadline
            ) &&
            deadline >=
              range.from &&
            deadline <=
              range.to,
        },
      });

    } catch (error) {

      res.status(500)
        .json({

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
// DEBUG: ПОЛНЫЙ ПОИСК ЗАМЕРОВ
// ============================================================

app.get(
  "/debug/tasks-test",
  async (
    req,
    res
  ) => {

    try {

      const result =
        await buildMeasurements();

      const now =
        moscowNow();

      res.json({

        status:
          "OK",

        timezone:
          TIME_ZONE,

        current_moscow_time:
          `${String(now.day).padStart(2, "0")}.${String(now.month).padStart(2, "0")}.${now.year}, ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}:${String(now.second).padStart(2, "0")}`,

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

        date_mode:
          result.range.mode,

        date_range: {

          from:
            formatMoscowDate(
              result.range.from
            ),

          to:
            formatMoscowDate(
              result.range.to
            ),
        },

        tasks_loaded:
          result.tasksLoaded,

        found_count:
          result.measurements.length,

        measurements:
          result.measurements,
      });

    } catch (error) {

      console.error(
        "TASKS-TEST ERROR:",
        error
      );

      res.status(500)
        .json({

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
// DEBUG: ПОСЛЕДНИЕ ЗАПРОСЫ
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
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (
    req,
    res
  ) => {

    const body =
      req.body;

    console.log(
      "=========================================="
    );

    console.log(
      "AMOMESSENGER WEBHOOK"
    );

    console.log(
      JSON.stringify(
        body,
        null,
        2
      )
    );

    console.log(
      "=========================================="
    );

    // Сразу отвечаем amoMessenger
    res.status(200).json({
      ok: true,
    });

    try {

      const eventType =
        body.event_type;

      // ======================================================
      // НАМ ПЕРЕДАЛИ УПРАВЛЕНИЕ БОТОМ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {

        const payload =
          body._embedded &&
          body._embedded
            .rpa_bot_control_transferred;

        if (!payload) {
          return;
        }

        const request =
          payload._embedded &&
          payload._embedded.request;

        if (!request) {
          return;
        }

        const botId =
          payload.bot_id;

        const requestId =
          request.id;

        // В вашем webhook именно author_id
        // является пользователем, которому нужно
        // отправлять сообщения.
        const receiverUserId =
          request.author_id;

        console.log(
          "=========================================="
        );

        console.log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ БОТУ"
        );

        console.log({
          botId,
          requestId,
          receiverUserId,
        });

        // Сохраняем состояние
        activeRequests.set(
          requestId,
          {
            stage:
              "main_menu",

            botId,

            receiverUserId,
          }
        );

        // ----------------------------------------------------
        // Первый экран
        // ----------------------------------------------------

        await sendBotMessage(

          botId,

          requestId,

          "Выберите задачу для выполнения",

          getMainMenuButtons(),

          receiverUserId
        );

        console.log(
          "Главное меню отправлено"
        );

        return;
      }

      // ======================================================
      // ПОЛЬЗОВАТЕЛЬ НАЖАЛ КНОПКУ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {

        const payload =
          body._embedded &&
          body._embedded
            .rpa_bot_income_message;

        if (!payload) {
          return;
        }

        const request =
          payload._embedded &&
          payload._embedded.request;

        if (!request) {
          return;
        }

        const incoming =
          payload._embedded &&
          payload._embedded
            .income_message;

        const requestId =
          request.id;

        const botId =
          payload.bot_id;

        const receiverUserId =
          request.author_id;

        const text =
          incoming &&
          incoming.text
            ? String(
                incoming.text
              ).trim()
            : "";

        console.log(
          "=========================================="
        );

        console.log(
          "ПОЛУЧЕНО СООБЩЕНИЕ:",
          text
        );

        // ----------------------------------------------------
        // Получаем сессию
        // ----------------------------------------------------

        let session =
          activeRequests.get(
            requestId
          );

        if (!session) {

          session = {

            stage:
              "main_menu",

            botId,

            receiverUserId,
          };

          activeRequests.set(
            requestId,
            session
          );
        }

        // ====================================================
        // ПОДТВЕРДИТЬ ЗАМЕР
        // ====================================================

        if (
          text ===
          "Подтвердить замер"
        ) {

          console.log(
            "=========================================="
          );

          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );

          try {

            // ------------------------------------------------
            // Сообщение о начале
            // ------------------------------------------------

            await sendBotMessage(

              botId,

              requestId,

              "⏳ Проверяю задачи на подтверждение замера...",

              null,

              receiverUserId
            );

            // ------------------------------------------------
            // Ищем задачи и сделки
            // ------------------------------------------------

            const result =
              await buildMeasurements();

            // ------------------------------------------------
            // Если ничего не найдено
            // ------------------------------------------------

            if (
              !result.measurements.length
            ) {

              await sendBotMessage(

                botId,

                requestId,

                "📋 Замеров для подтверждения не найдено.",

                getMainMenuButtons(),

                receiverUserId
              );

              // Возвращаем управление amoMessenger,
              // чтобы пользователь снова мог запустить бота.
              await returnControl(
                botId,
                requestId,
                "success"
              );

              activeRequests.delete(
                requestId
              );

              return;
            }

            // ------------------------------------------------
            // Сохраняем найденные замеры
            // ------------------------------------------------

            session.stage =
              "measurement_selection";

            session.measurements =
              result.measurements;

            session.botId =
              botId;

            session.receiverUserId =
              receiverUserId;

            activeRequests.set(
              requestId,
              session
            );

            // ------------------------------------------------
            // Формируем список
            // ------------------------------------------------

            const listText =
              formatMeasurementsList(
                result.measurements
              );

            // ------------------------------------------------
            // Кнопки
            //
            // Основное правило:
            // текст кнопки = № договора.
            //
            // Если № договора пустой,
            // используем ID сделки.
            // Это нужно только как технический
            // запасной вариант.
            // ------------------------------------------------

            const buttons =
              result.measurements.map(
                item => {

                  if (
                    item.contract_number
                  ) {

                    return String(
                      item.contract_number
                    );
                  }

                  return `Сделка ${item.lead_id}`;
                }
              );

            const message =
              "📋 Замеры для подтверждения:\n\n" +
              listText +
              "\n\n" +
              "Выберите конкретный замер:";

            await sendBotMessage(

              botId,

              requestId,

              message,

              buttons,

              receiverUserId
            );

            console.log(
              "Список замеров отправлен."
            );

            // ВАЖНО:
            // управление НЕ возвращаем.
            // Ждём нажатия кнопки конкретного замера.

            return;

          } catch (error) {

            console.error(
              "Ошибка поиска замеров:",
              error.message
            );

            console.error(
              error.details ||
              ""
            );

            try {

              await sendBotMessage(

                botId,

                requestId,

                "❌ При обращении к amoCRM произошла ошибка. Попробуйте ещё раз.",

                getMainMenuButtons(),

                receiverUserId
              );

            } catch (sendError) {

              console.error(
                "Ошибка отправки сообщения об ошибке:",
                sendError.message
              );
            }

            return;
          }
        }

        // ====================================================
        // ВЫБОР КОНКРЕТНОГО ЗАМЕРА
        // ====================================================

        if (
          session.stage ===
          "measurement_selection" &&
          Array.isArray(
            session.measurements
          )
        ) {

          console.log(
            "Пользователь выбирает конкретный замер:",
            text
          );

          const selected =
            session.measurements.find(
              item => {

                const buttonValue =
                  item.contract_number
                    ? String(
                        item.contract_number
                      )
                    : `Сделка ${item.lead_id}`;

                return (
                  buttonValue ===
                  text
                );
              }
            );

          // --------------------------------------------------
          // Не нашли выбранный замер
          // --------------------------------------------------

          if (!selected) {

            await sendBotMessage(

              botId,

              requestId,

              "❌ Не удалось определить выбранный замер. Нажмите кнопку ещё раз.",

              session.measurements.map(
                item =>
                  item.contract_number
                    ? String(
                        item.contract_number
                      )
                    : `Сделка ${item.lead_id}`
              ),

              receiverUserId
            );

            return;
          }

          // --------------------------------------------------
          // Показываем подробности
          // --------------------------------------------------

          console.log(
            "Выбран замер:",
            JSON.stringify(
              selected,
              null,
              2
            )
          );

          await sendBotMessage(

            botId,

            requestId,

            formatMeasurementDetails(
              selected
            ),

            null,

            receiverUserId
          );

          // --------------------------------------------------
          // Пока этот этап закончен.
          // Возвращаем управление amoMessenger.
          // --------------------------------------------------

          activeRequests.delete(
            requestId
          );

          await returnControl(
            botId,
            requestId,
            "success"
          );

          return;
        }

        // ====================================================
        // ОСТАЛЬНЫЕ КНОПКИ
        // ====================================================

        if (
          text ===
          "Провести замер" ||
          text ===
          "Загрузить фотоотчет" ||
          text ===
          "Внести правки"
        ) {

          await sendBotMessage(

            botId,

            requestId,

            `Функция «${text}» будет добавлена на следующем этапе.`,

            getMainMenuButtons(),

            receiverUserId
          );

          return;
        }

      }

    } catch (error) {

      console.error(
        "=========================================="
      );

      console.error(
        "WEBHOOK ERROR:",
        error.message
      );

      console.error(
        error.details ||
        ""
      );

      console.error(
        "=========================================="
      );
    }
  }
);

// ============================================================
// WIDGET / ROOT
// ============================================================

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.send(
      "amoCRM + amoMessenger сервер работает"
    );
  }
);

// ============================================================
// WIDGET POST
// ============================================================

app.post(
  "/",
  (
    req,
    res
  ) => {

    console.log(
      "=========================================="
    );

    console.log(
      "AMOMESSENGER POST /"
    );

    console.log(
      "BODY:"
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

    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Отчёт инженеров</title>
</head>

<body style="
  font-family: Arial, sans-serif;
  padding: 30px;
">

<h2>Отчёт инженеров</h2>

<p>
Виджет подключён и готов к работе.
</p>

<script src="https://js.amo.tm/v1/sdk.js"></script>

<script>
try {

  var amoSDK =
    window.AmoSDK();

  amoSDK.setInputValues({
    ready: "true"
  });

} catch (e) {

  console.error(
    "SDK error:",
    e
  );

}
</script>

</body>
</html>`);
  }
);

// ============================================================
// OAUTH AMOMESSENGER
// ============================================================
//
// Используется при установке бота.
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (
    req,
    res
  ) => {

    const code =
      req.query.code;

    console.log(
      "=========================================="
    );

    console.log(
      "OAUTH AMOMESSENGER CALLBACK"
    );

    console.log(
      "Code:",
      code
        ? "получен"
        : "НЕТ"
    );

    console.log(
      "=========================================="
    );

    if (!code) {

      return res
        .status(400)
        .send(
          "Ошибка: параметр code не получен."
        );
    }

    const CLIENT_ID =
      process.env.AMOMESSENGER_CLIENT_ID;

    const CLIENT_SECRET =
      process.env.AMOMESSENGER_CLIENT_SECRET;

    const REDIRECT_URI =
      process.env.AMOMESSENGER_REDIRECT_URI;

    if (
      !CLIENT_ID ||
      !CLIENT_SECRET ||
      !REDIRECT_URI
    ) {

      return res
        .status(500)
        .send(
          "На Render не заданы AMOMESSENGER_CLIENT_ID, AMOMESSENGER_CLIENT_SECRET или AMOMESSENGER_REDIRECT_URI."
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
        await tokenResponse
          .json()
          .catch(
            () => null
          );

      if (
        !tokenResponse.ok
      ) {

        console.error(
          "Ошибка OAuth:",
          tokenData
        );

        return res
          .status(500)
          .send(
            "amoMessenger отклонила авторизацию. Подробности смотрите в логах Render."
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
        "=========================================="
      );

      console.log(
        "Авторизация amoMessenger успешно выполнена."
      );

      console.log(
        "Access Token: ДА"
      );

      console.log(
        "Refresh Token:",
        tokenData.refresh_token
          ? "ДА"
          : "НЕТ"
      );

      console.log(
        "=========================================="
      );

      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Авторизация amoMessenger</title>
</head>

<body style="
  font-family: Arial, sans-serif;
  padding: 40px;
">

<h2>
Авторизация amoMessenger успешно выполнена
</h2>

<p>
Токен сохранён на сервере.
</p>

<p>
Теперь можно закрыть это окно и снова запустить бота.
</p>

<p>
Access Token получен:
<b>ДА</b>
</p>

<p>
Refresh Token получен:
<b>${tokenData.refresh_token ? "ДА" : "НЕТ"}</b>
</p>

</body>
</html>
`);

    } catch (error) {

      console.error(
        "OAuth ERROR:",
        error
      );

      res
        .status(500)
        .send(
          "Ошибка авторизации amoMessenger. Подробности смотрите в логах Render."
        );
    }
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
      "TIMEZONE:",
      TIME_ZONE
    );

    console.log(
      "ENGINEER:",
      ENGINEER_NAME
    );

    console.log(
      "ENGINEER_FIELD_ID:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "ENGINEER_ENUM_ID:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "TASK_TYPE_ID:",
      TASK_TYPE_ID
    );

    console.log(
      "=========================================="
    );
  }
);
