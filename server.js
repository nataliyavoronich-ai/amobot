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
// ИНЖЕНЕР
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;


// ============================================================
// ТИП ЗАДАЧИ
// ============================================================

const TASK_TYPE_ID = 2746005;


// ============================================================
// ПОЛЯ СДЕЛКИ
// ============================================================

const FIELD_IDS = {

  contractNumber: 412776,

  measureDate: 175370,

  measureTime: 413828,

  measureAddress: 175412,

  product: 172572,

};


// ============================================================
// ФАЙЛ ТОКЕНА amoMessenger
// ============================================================

const AMOMESSENGER_TOKENS_FILE =
  path.join(
    __dirname,
    "amomessenger_tokens.json"
  );


// ============================================================
// СОСТОЯНИЕ БОТА
// ============================================================

const activeRequests =
  new Map();


// ============================================================
// ЛОГИ
// ============================================================

const lastRequests = [];

function storeRequest(req) {

  lastRequests.unshift({

    time:
      new Date().toISOString(),

    method:
      req.method,

    path:
      req.originalUrl,

    body:
      req.body,

    query:
      req.query,

  });

  if (
    lastRequests.length > 30
  ) {

    lastRequests.pop();

  }

}

app.use(
  (req, res, next) => {

    storeRequest(req);

    next();

  }
);


// ============================================================
// amoCRM API
// ============================================================

async function amocrmRequest(
  pathAndQuery
) {

  const domain =
    process.env.AMOCRM_DOMAIN;

  const token =
    process.env.AMOCRM_TOKEN;

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

  const cleanDomain =
    domain
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /\/+$/,
        ""
      );

  const url =
    `https://${cleanDomain}${pathAndQuery}`;

  console.log(
    "amoCRM GET:",
    url
  );

  const response =
    await fetch(
      url,
      {

        method:
          "GET",

        headers: {

          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json",

        },

      }
    );

  const data =
    await response
      .json()
      .catch(
        () => null
      );

  if (!response.ok) {

    const error =
      new Error(
        `amoCRM HTTP ${response.status}`
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

function loadTokens() {

  try {

    return JSON.parse(
      fs.readFileSync(
        AMOMESSENGER_TOKENS_FILE,
        "utf8"
      )
    );

  } catch {

    return null;

  }

}


async function amoMessengerRequest(
  method,
  pathAndQuery,
  body
) {

  const tokens =
    loadTokens();

  if (
    !tokens ||
    !tokens.access_token
  ) {

    throw new Error(
      "Токен amoMessenger не найден"
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

  const data =
    await response
      .json()
      .catch(
        () => null
      );

  if (!response.ok) {

    const error =
      new Error(
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
// ОТПРАВИТЬ СООБЩЕНИЕ БОТА
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
    buttons.length > 0
  ) {

    body.reply_markup = {

      inline_keyboard: {

        buttons:
          buttons.map(
            buttonText => ({

              text:
                String(buttonText),

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
// ВЕРНУТЬ УПРАВЛЕНИЕ amoMessenger
// ============================================================

async function returnControl(
  botId,
  requestId,
  code
) {

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
// МОСКОВСКОЕ ВРЕМЯ
// ============================================================

function moscowNow() {

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {

        timeZone:
          TIME_ZONE,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23",

      }
    )
      .formatToParts(
        new Date()
      );

  const result = {};

  for (
    const part of parts
  ) {

    if (
      part.type !== "literal"
    ) {

      result[part.type] =
        Number(part.value);

    }

  }

  return result;

}


// ============================================================
// МОСКОВСКИЙ UNIX TIMESTAMP
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
// ДИАПАЗОН СРОКОВ ЗАДАЧ
// ============================================================
//
// ДО 18:00:
//
// вчера 00:00
// ->
// сегодня текущее время
//
// ПОСЛЕ 18:00:
//
// сегодня 00:00
// ->
// завтра 23:59:59
// ============================================================

function getTaskDateRange() {

  const now =
    moscowNow();


  // Сегодня 00:00

  const todayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      0,
      0,
      0
    );


  // Текущее время

  const currentMoment =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute,
      now.second
    );


  // Вчера

  const yesterday =
    new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day
      )
    );

  yesterday.setUTCDate(
    yesterday.getUTCDate() - 1
  );

  const yesterdayStart =
    moscowTimestamp(
      yesterday.getUTCFullYear(),
      yesterday.getUTCMonth() + 1,
      yesterday.getUTCDate(),
      0,
      0,
      0
    );


  // Завтра

  const tomorrow =
    new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day
      )
    );

  tomorrow.setUTCDate(
    tomorrow.getUTCDate() + 1
  );

  const tomorrowEnd =
    moscowTimestamp(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      23,
      59,
      59
    );


  // До 18:00

  if (
    now.hour < 18
  ) {

    return {

      from:
        yesterdayStart,

      to:
        currentMoment,

      mode:
        "до 18:00",

    };

  }


  // После 18:00

  return {

    from:
      todayStart,

    to:
      tomorrowEnd,

    mode:
      "после 18:00",

  };

}


// ============================================================
// ФОРМАТ ДАТЫ
// ============================================================

function formatMoscowDate(
  timestamp
) {

  if (
    timestamp === null ||
    timestamp === undefined ||
    timestamp === ""
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

      timeZone:
        TIME_ZONE,

      dateStyle:
        "short",

      timeStyle:
        "medium",

    }
  )
    .format(
      new Date(
        number * 1000
      )
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
// ПОЛУЧИТЬ ТЕКСТОВОЕ ПОЛЕ
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

  const value =
    field.values[0];

  if (
    value.value !== undefined &&
    value.value !== null &&
    String(value.value).trim() !== ""
  ) {

    return String(
      value.value
    );

  }

  return null;

}


// ============================================================
// ПОЛУЧИТЬ ДАТУ ИЗ ПОЛЯ
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

        timeZone:
          TIME_ZONE,

      }
    )
      .format(
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
    const value of
    field.values
  ) {

    // Проверка ID значения списка

    if (
      value.enum_id !== undefined &&
      Number(value.enum_id) ===
        Number(ENGINEER_ENUM_ID)
    ) {

      return true;

    }

    // Дополнительная проверка текста

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
// ИНФОРМАЦИЯ О КОНТАКТЕ
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
      contact
        ? contact.name
        : null,

    phones,

  };

}


// ============================================================
// КОНТАКТ СДЕЛКИ
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

  if (
    !contacts.length
  ) {

    return {

      name:
        null,

      phones:
        [],

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

      name:
        null,

      phones:
        [],

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
      "Ошибка получения контакта:",
      error.message
    );

    return {

      name:
        null,

      phones:
        [],

    };

  }

}


// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ ПОИСКА ЗАДАЧ
// ============================================================
//
// ВАЖНО:
//
// Теперь мы НЕ загружаем все сделки.
//
// Сначала amoCRM фильтрует задачи по сроку выполнения.
//
// Потом мы оставляем:
// - entity_type = leads
// - task_type_id = 2746005
// - is_completed = false
//
// И только потом получаем связанные сделки.
//
// Это должно быть значительно быстрее предыдущего варианта.
// ============================================================

async function getMeasurementTasks() {

  const range =
    getTaskDateRange();

  const allTasks = [];

  let page = 1;


  while (true) {

    const params =
      new URLSearchParams();


    // Только задачи сделок

    params.set(
      "filter[entity_type]",
      "leads"
    );


    // Фильтр по сроку выполнения

    params.set(
      "filter[complete_till][from]",
      String(range.from)
    );

    params.set(
      "filter[complete_till][to]",
      String(range.to)
    );


    // Не загружаем огромный массив

    params.set(
      "limit",
      "250"
    );

    params.set(
      "page",
      String(page)
    );


    // Сортировка по сроку

    params.set(
      "order[complete_till]",
      "asc"
    );


    console.log(
      "Запрос задач:",
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


    // Защита от зацикливания

    if (
      page > 20
    ) {

      console.log(
        "Остановлено после 20 страниц."
      );

      break;

    }

  }


  // Оставляем только нужный тип
  // и незавершённые задачи.

  const measurementTasks =
    allTasks.filter(
      task => {

        const notCompleted =
          task.is_completed === false ||
          task.is_completed === 0 ||
          task.is_completed === "0";


        const deadline =
          Number(
            task.complete_till
          );


        return (

          String(
            task.entity_type
          ) === "leads"

          &&

          Number(
            task.task_type_id
          ) ===
          Number(
            TASK_TYPE_ID
          )

          &&

          notCompleted

          &&

          Number.isFinite(
            deadline
          )

          &&

          deadline >=
            range.from

          &&

          deadline <=
            range.to

        );

      }
    );


  console.log(
    "Найдено подходящих задач:",
    measurementTasks.length
  );


  return {

    range,

    allTasks,

    measurementTasks,

  };

}


// ============================================================
// ПОСТРОЕНИЕ СПИСКА ЗАМЕРОВ
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
    "Тип задачи:",
    TASK_TYPE_ID
  );


  const taskResult =
    await getMeasurementTasks();


  const measurements = [];


  // Чтобы одна сделка не появилась
  // несколько раз.

  const processedLeads =
    new Set();


  for (
    const task of
    taskResult.measurementTasks
  ) {

    const leadId =
      Number(
        task.entity_id
      );


    if (
      !leadId
    ) {

      continue;

    }


    // Если у одной сделки несколько
    // подходящих задач — показываем
    // сделку только один раз.

    if (
      processedLeads.has(
        leadId
      )
    ) {

      continue;

    }


    let lead;

    try {

      lead =
        await getLead(
          leadId
        );

    } catch (error) {

      console.error(
        `Ошибка получения сделки ${leadId}:`,
        error.message
      );

      continue;

    }


    // Проверяем инженера

    if (
      !isMarina(lead)
    ) {

      continue;

    }


    processedLeads.add(
      leadId
    );


    // Получаем клиента

    const client =
      await getLeadClient(
        lead
      );


    // ВАЖНО:
    // если любое поле пустое —
    // сделка всё равно добавляется.

    measurements.push({

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

    });

  }


  // Сортировка по сроку задачи

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
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );


  return {

    range:
      taskResult.range,

    allTasksCount:
      taskResult.allTasks.length,

    measurementTasksCount:
      taskResult.measurementTasks.length,

    measurements,

  };

}


// ============================================================
// ПУСТОЕ ЗНАЧЕНИЕ
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
// ТЕЛЕФОНЫ
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
// DEBUG: ПРОВЕРКА amoCRM
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

      });

    } catch (error) {

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
// DEBUG: ЗАДАЧИ
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
          result.allTasksCount,

        measurement_tasks:
          result.measurementTasksCount,

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
// DEBUG: ФИЛЬТР ЗАДАЧ
// ============================================================

app.get(
  "/debug/tasks-filter-test",
  async (
    req,
    res
  ) => {

    try {

      const range =
        getTaskDateRange();

      const params =
        new URLSearchParams();

      params.set(
        "filter[entity_type]",
        "leads"
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
        "10"
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
        Array.isArray(
          data._embedded.tasks
        )
          ? data._embedded.tasks
          : [];

      res.json({

        status:
          "OK",

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

        returned_count:
          tasks.length,

        tasks:
          tasks.map(
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
                formatMoscowDate(
                  task.complete_till
                ),

            })
          ),

      });

    } catch (error) {

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


    // Отвечаем сразу,
    // чтобы amoMessenger не ждал.

    res.status(200).json({
      ok: true,
    });


    try {

      const eventType =
        body.event_type;


      // ======================================================
      // БОТ ПОЛУЧИЛ УПРАВЛЕНИЕ
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

        const receiverUserId =
          request.author_id;


        const menuButtons = [

          "Подтвердить замер",

          "Провести замер",

          "Загрузить фотоотчет",

          "Внести правки",

        ];


        activeRequests.set(
          requestId,
          {

            stage:
              "main_menu",

            botId,

            receiverUserId,

          }
        );


        await sendBotMessage(

          botId,

          requestId,

          "Выберите задачу для выполнения",

          menuButtons,

          receiverUserId

        );


        return;

      }


      // ======================================================
      // НАЖАТИЕ КНОПКИ
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

        const requestId =
          request.id;

        const botId =
          payload.bot_id;

        const receiverUserId =
          request.author_id;

        const incoming =
          payload._embedded &&
          payload._embedded
            .income_message;


        const text =
          incoming &&
          incoming.text
            ? String(
                incoming.text
              ).trim()
            : "";


        console.log(
          "Нажата кнопка:",
          text
        );


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
            "Запускаем поиск замеров..."
          );


          try {

            const result =
              await buildMeasurements();


            // ------------------------------------------------
            // Ничего не найдено
            // ------------------------------------------------

            if (
              !result.measurements.length
            ) {

              await sendBotMessage(

                botId,

                requestId,

                `Замеры для ${ENGINEER_NAME} не найдены.`,

                [

                  "Подтвердить замер",

                  "Провести замер",

                  "Загрузить фотоотчет",

                  "Внести правки",

                ],

                receiverUserId

              );

              return;

            }


            // ------------------------------------------------
            // Сохраняем замеры
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
            // Текст списка
            // ------------------------------------------------

            const textMessage =
              formatMeasurementsList(
                result.measurements
              );


            // ------------------------------------------------
            // Кнопки
            //
            // Кнопка = № договора.
            //
            // Если № договора пуст,
            // временно используем ID сделки,
            // чтобы кнопку всё равно можно
            // было нажать.
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


            await sendBotMessage(

              botId,

              requestId,

              textMessage,

              buttons,

              receiverUserId

            );


            return;

          } catch (error) {

            console.error(
              "Ошибка поиска замеров:",
              error
            );


            await sendBotMessage(

              botId,

              requestId,

              "При обращении к amoCRM произошла ошибка. Попробуйте ещё раз.",

              [

                "Подтвердить замер",

                "Провести замер",

                "Загрузить фотоотчет",

                "Внести правки",

              ],

              receiverUserId

            );


            return;

          }

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

            `Функция «${text}» пока не подключена.`,

            [

              "Подтвердить замер",

              "Провести замер",

              "Загрузить фотоотчет",

              "Внести правки",

            ],

            receiverUserId

          );

          return;

        }


        // ====================================================
        // ВЫБРАН КОНКРЕТНЫЙ ЗАМЕР
        // ====================================================

        if (
          session.stage ===
          "measurement_selection" &&

          Array.isArray(
            session.measurements
          )
        ) {


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


          if (!selected) {

            await sendBotMessage(

              botId,

              requestId,

              "Не удалось определить выбранный замер. Пожалуйста, нажмите одну из кнопок.",

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
          // Сбрасываем состояние
          // --------------------------------------------------

          activeRequests.delete(
            requestId
          );


          return;

        }

      }

    } catch (error) {

      console.error(
        "WEBHOOK ERROR:",
        error.message,
        error.details || ""
      );

    }

  }
);


// ============================================================
// ROOT
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
// DEBUG ПОСЛЕДНИХ ЗАПРОСОВ
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
// ЗАПУСК
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
      "amoCRM + amoMessenger сервер запущен"
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
      "ENGINEER FIELD:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "ENGINEER ENUM:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "TASK TYPE:",
      TASK_TYPE_ID
    );

    console.log(
      "=========================================="
    );

  }
);
