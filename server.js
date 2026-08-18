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
// ИНЖЕНЕР ДЛЯ ТЕКУЩЕГО ТЕСТА
// ============================================================
//
// Сейчас тестируем на Марине.
// Позже сделаем автоматическое определение инженера
// по пользователю amoMessenger.
//

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;


// ============================================================
// ТИП ЗАДАЧИ
// ============================================================
//
// "Подтв. замер(и)"
//

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
// ХРАНИЛИЩЕ СОСТОЯНИЯ БОТА
// ============================================================
//
// requestId -> {
//   stage,
//   botId,
//   receiverUserId,
//   measurements
// }
//

const activeRequests = new Map();


// ============================================================
// ЛОГ ПОСЛЕДНИХ ЗАПРОСОВ
// ============================================================

const lastRequests = [];

const MAX_LAST_REQUESTS = 30;

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
    lastRequests.length >
    MAX_LAST_REQUESTS
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
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ JSON
// ============================================================

function saveJsonFile(
  filePath,
  data
) {

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      data,
      null,
      2
    )
  );

}


function loadJsonFile(
  filePath
) {

  try {

    return JSON.parse(
      fs.readFileSync(
        filePath,
        "utf8"
      )
    );

  } catch {

    return null;

  }

}


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

  if (
    response.status === 204
  ) {

    return null;

  }

  const data =
    await response
      .json()
      .catch(
        () => null
      );

  if (
    !response.ok
  ) {

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

  if (
    response.status === 204
  ) {

    return null;

  }

  const data =
    await response
      .json()
      .catch(
        () => null
      );

  if (
    !response.ok
  ) {

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
        Number(
          part.value
        );

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
// ДИАПАЗОН СРОКА ИСПОЛНЕНИЯ ЗАДАЧИ
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
//
// ВАЖНО:
// проверяем именно task.complete_till
// — срок исполнения ЗАДАЧИ.
//

function getTaskDateRange() {

  const now =
    moscowNow();


  // ----------------------------------------------------------
  // Сегодня 00:00
  // ----------------------------------------------------------

  const todayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      0,
      0,
      0
    );


  // ----------------------------------------------------------
  // Текущее время
  // ----------------------------------------------------------

  const currentMoment =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute,
      now.second
    );


  // ----------------------------------------------------------
  // Вчера
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // Завтра
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // ДО 18:00
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // ПОСЛЕ 18:00
  // ----------------------------------------------------------

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
// ФОРМАТ ДАТЫ ПО МОСКВЕ
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
    Number(
      timestamp
    );

  if (
    !Number.isFinite(
      number
    )
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
        Number(
          field.field_id
        ) ===
        Number(
          fieldId
        )
    ) || null
  );

}


// ============================================================
// ПОЛУЧИТЬ ТЕКСТОВОЕ ПОЛЕ
// ============================================================
//
// Если поле пустое -> null.
// Сделка НЕ исключается.
//

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
    !Array.isArray(
      field.values
    ) ||
    !field.values.length
  ) {

    return null;

  }

  const value =
    field.values[0];

  if (
    value.value !== undefined &&
    value.value !== null &&
    String(
      value.value
    ).trim() !== ""
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
    !Array.isArray(
      field.values
    ) ||
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
    Number(
      value
    );

  if (
    Number.isFinite(
      number
    ) &&
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

  return String(
    value
  );

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
    !Array.isArray(
      field.values
    ) ||
    !field.values.length
  ) {

    return false;

  }

  for (
    const value of
    field.values
  ) {

    // Проверка по ID значения списка

    if (
      value.enum_id !== undefined &&
      Number(
        value.enum_id
      ) ===
      Number(
        ENGINEER_ENUM_ID
      )
    ) {

      return true;

    }


    // Дополнительная проверка по названию

    if (
      value.value !== undefined &&
      String(
        value.value
      ).trim() ===
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
            String(
              value.value
            ).trim() !== ""
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

  } catch (
    error
  ) {

    console.error(
      `Ошибка получения контакта ${mainContact.id}:`,
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
// ПОЛУЧИТЬ ЗАДАЧИ ЗА НУЖНЫЙ ПЕРИОД
// ============================================================
//
// Здесь намеренно НЕ используем:
//
// filter[task_type]
// filter[is_completed]
//
// Они ранее давали некорректный результат.
//
// Используем только проверенный фильтр
// complete_till + entity_type=leads.
//
// После получения фильтруем сами.
//

async function getAllLeadTasks() {

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
      "filter[complete_till][from]",
      String(
        range.from
      )
    );


    params.set(
      "filter[complete_till][to]",
      String(
        range.to
      )
    );


    params.set(
      "limit",
      "250"
    );


    params.set(
      "page",
      String(
        page
      )
    );


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


    if (
      page > 100
    ) {

      console.log(
        "Достигнут предел страниц задач."
      );

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
// ПОЛУЧИТЬ КОНКРЕТНЫЕ СДЕЛКИ
// ============================================================
//
// После поиска задач у нас уже есть entity_id.
// Поэтому не загружаем все сделки аккаунта.
//

async function getLeadsByIds(
  leadIds
) {

  const uniqueIds =
    [
      ...new Set(
        leadIds
          .map(
            id =>
              Number(id)
          )
          .filter(
            id =>
              Number.isFinite(id) &&
              id > 0
          )
      )
    ];


  const leads = [];


  for (
    const leadId of
    uniqueIds
  ) {

    try {

      const lead =
        await getLead(
          leadId
        );

      if (
        lead &&
        lead.id
      ) {

        leads.push(
          lead
        );

      }

    } catch (
      error
    ) {

      console.error(
        `Ошибка получения сделки ${leadId}:`,
        error.message
      );

    }

  }


  return leads;

}


// ============================================================
// ПОЛУЧИТЬ ЗАДАЧИ ПОДТВЕРЖДЕНИЯ ЗАМЕРА
// ============================================================

async function getMeasurementTasks() {

  const range =
    getTaskDateRange();


  const allTasks =
    await getAllLeadTasks();


  const measurementTasks =
    allTasks.filter(
      task => {

        // Сделка

        if (
          String(
            task.entity_type
          ) !==
          "leads"
        ) {

          return false;

        }


        // Тип задачи

        if (
          Number(
            task.task_type_id
          ) !==
          Number(
            TASK_TYPE_ID
          )
        ) {

          return false;

        }


        // Только НЕЗАВЕРШЁННЫЕ задачи

        const notCompleted =
          task.is_completed === false ||
          task.is_completed === 0 ||
          task.is_completed === "0";


        if (
          !notCompleted
        ) {

          return false;

        }


        // Срок исполнения

        const deadline =
          Number(
            task.complete_till
          );


        if (
          !Number.isFinite(
            deadline
          )
        ) {

          return false;

        }


        return (
          deadline >=
          range.from
          &&
          deadline <=
          range.to
        );

      }
    );


  console.log(
    "Подходящих задач:",
    measurementTasks.length
  );


  return {

    range,

    allTasks,

    measurementTasks,

  };

}


// ============================================================
// ФОРМИРОВАНИЕ СПИСКА ЗАМЕРОВ
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


  // ----------------------------------------------------------
  // 1. Получаем задачи
  // ----------------------------------------------------------

  const taskResult =
    await getMeasurementTasks();


  const measurementTasks =
    taskResult.measurementTasks;


  // ----------------------------------------------------------
  // Если задач вообще нет
  // ----------------------------------------------------------

  if (
    !measurementTasks.length
  ) {

    return {

      range:
        taskResult.range,

      tasksLoaded:
        taskResult.allTasks.length,

      measurementTasksCount:
        0,

      dateTasksCount:
        0,

      marinaLeadsCount:
        0,

      measurements:
        [],

    };

  }


  // ----------------------------------------------------------
  // 2. ID сделок из задач
  // ----------------------------------------------------------

  const leadIds =
    measurementTasks.map(
      task =>
        task.entity_id
    );


  // ----------------------------------------------------------
  // 3. Получаем только эти сделки
  // ----------------------------------------------------------

  const leads =
    await getLeadsByIds(
      leadIds
    );


  console.log(
    "Получено сделок:",
    leads.length
  );


  // ----------------------------------------------------------
  // 4. Индекс сделок
  // ----------------------------------------------------------

  const leadsById =
    new Map();


  for (
    const lead of
    leads
  ) {

    leadsById.set(
      Number(
        lead.id
      ),
      lead
    );

  }


  // ----------------------------------------------------------
  // 5. Одна сделка = один замер
  // ----------------------------------------------------------

  const selectedByLead =
    new Map();


  for (
    const task of
    measurementTasks
  ) {

    const leadId =
      Number(
        task.entity_id
      );


    const lead =
      leadsById.get(
        leadId
      );


    if (
      !lead
    ) {

      continue;

    }


    // --------------------------------------------------------
    // Проверяем инженера
    // --------------------------------------------------------

    if (
      !isMarina(
        lead
      )
    ) {

      continue;

    }


    // --------------------------------------------------------
    // Если у сделки несколько подходящих задач,
    // берём одну.
    // --------------------------------------------------------

    if (
      !selectedByLead.has(
        leadId
      )
    ) {

      selectedByLead.set(
        leadId,
        task
      );

    }

  }


  // ----------------------------------------------------------
  // 6. Формируем итоговый список
  // ----------------------------------------------------------

  const measurements = [];


  for (
    const [
      leadId,
      task
    ]
    of
    selectedByLead
  ) {

    const lead =
      leadsById.get(
        leadId
      );


    if (
      !lead
    ) {

      continue;

    }


    // --------------------------------------------------------
    // Клиент
    // --------------------------------------------------------

    const client =
      await getLeadClient(
        lead
      );


    // --------------------------------------------------------
    // ВАЖНО:
    //
    // Ни одно поле сделки здесь НЕ является обязательным.
    //
    // Если поле пустое — значение будет null,
    // а при выводе превратится в "—".
    //
    // Поэтому сделка всё равно попадает в список.
    // --------------------------------------------------------

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


  // ----------------------------------------------------------
  // 7. Сортировка по сроку задачи
  // ----------------------------------------------------------

  measurements.sort(
    (
      a,
      b
    ) =>
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

    tasksLoaded:
      taskResult.allTasks.length,

    measurementTasksCount:
      measurementTasks.length,

    dateTasksCount:
      measurementTasks.length,

    marinaLeadsCount:
      leads.filter(
        lead =>
          isMarina(
            lead
          )
      ).length,

    measurements,

  };

}


// ============================================================
// ФОРМАТ ПУСТОГО ЗНАЧЕНИЯ
// ============================================================

function displayValue(
  value
) {

  if (
    value === null ||
    value === undefined ||
    String(
      value
    ).trim() === ""
  ) {

    return "—";

  }

  return String(
    value
  );

}


// ============================================================
// ФОРМАТ ТЕЛЕФОНОВ
// ============================================================

function displayPhones(
  phones
) {

  if (
    !Array.isArray(
      phones
    ) ||
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
// Значения полей = одна строка.
//

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

  ].join(
    "\n"
  );

}


// ============================================================
// КНОПКИ ГЛАВНОГО МЕНЮ
// ============================================================

function mainMenuButtons() {

  return [

    "Подтвердить замер",

    "Провести замер",

    "Загрузить фотоотчет",

    "Внести правки",

  ];

}


// ============================================================
// ТЕКСТ КНОПКИ ЗАМЕРА
// ============================================================
//
// По ТЗ текст кнопки = № договора.
//
// Если № договора пустой,
// временно используем ID сделки,
// чтобы кнопку всё равно можно было нажать.
//

function measurementButtonText(
  item
) {

  if (
    item.contract_number
  ) {

    return String(
      item.contract_number
    );

  }

  return `Сделка ${item.lead_id}`;

}


// ============================================================
// ОТПРАВКА СООБЩЕНИЯ amoMessenger
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
    Array.isArray(
      buttons
    ) &&
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


  return amoMessengerRequest(
    "POST",

    `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,

    body

  );

}


// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ amoMessenger
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
// ROOT POST
// ============================================================
//
// Этот POST нужен для виджета amoMessenger.
//
// Когда конструктор amoMessenger открывает настройку
// виджета, он отправляет POST /.
//
// Поэтому здесь НЕ должно быть "Cannot POST /".
//

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
      "AMOMESSENGER WIDGET POST /"
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


    res.send(
      `<!DOCTYPE html>

<html>

<head>

<meta charset="utf-8">

<title>Отчёт инженеров</title>

</head>

<body style="
font-family: Arial, sans-serif;
padding: 20px;
">

<h3>Отчёт инженеров</h3>

<p>
Виджет подключён и готов к работе.
</p>

<script src="https://js.amo.tm/v1/sdk.js"></script>

<script>

try {

  var amoSDK =
    window.AmoSDK();

  if (
    amoSDK &&
    amoSDK.setInputValues
  ) {

    amoSDK.setInputValues({
      ready: "true"
    });

  }

} catch (e) {

  console.error(e);

}

</script>

</body>

</html>`
    );

  }
);


// ============================================================
// OAUTH CALLBACK amoMessenger
// ============================================================
//
// Оставляем этот маршрут,
// чтобы адрес /oauth/amomessenger/callback
// не выдавал "Cannot GET".
//

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
      "amoMessenger OAuth CALLBACK"
    );

    console.log(
      "code:",
      code
        ? "получен"
        : "отсутствует"
    );

    console.log(
      "=========================================="
    );


    if (
      !code
    ) {

      return res
        .status(400)
        .send(
          "Не найден параметр code."
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
          "Ошибка OAuth amoMessenger:",
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
        "amoMessenger токен сохранён."
      );


      res.send(
        "Готово! Бот amoMessenger успешно установлен. Эту страницу можно закрыть."
      );

    } catch (
      error
    ) {

      console.error(
        "OAuth ERROR:",
        error
      );

      res
        .status(500)
        .send(
          "Ошибка установки amoMessenger. Подробности в логах Render."
        );

    }

  }
);


// ============================================================
// DEBUG: TOKEN amoMessenger
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
      !tokens
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
// DEBUG: amoCRM
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

    } catch (
      error
    ) {

      res
        .status(500)
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
            Number(
              item.id
            ) ===
            Number(
              ENGINEER_ENUM_ID
            )
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

    } catch (
      error
    ) {

      res
        .status(500)
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

    } catch (
      error
    ) {

      res
        .status(500)
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


      if (
        !taskId
      ) {

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

    } catch (
      error
    ) {

      res
        .status(500)
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
          `${String(
            now.day
          ).padStart(
            2,
            "0"
          )}.${String(
            now.month
          ).padStart(
            2,
            "0"
          )}.${now.year}, ${String(
            now.hour
          ).padStart(
            2,
            "0"
          )}:${String(
            now.minute
          ).padStart(
            2,
            "0"
          )}:${String(
            now.second
          ).padStart(
            2,
            "0"
          )}`,

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

        marina_leads_count:
          result.marinaLeadsCount,

        measurement_tasks_count:
          result.measurementTasksCount,

        tasks_after_date_filter:
          result.dateTasksCount,

        found_count:
          result.measurements.length,

        measurements:
          result.measurements,

      });

    } catch (
      error
    ) {

      console.error(
        "TASKS-TEST ERROR:",
        error
      );


      res
        .status(500)
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
// ОСНОВНОЙ WEBHOOK amoMessenger
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


    // --------------------------------------------------------
    // Сразу отвечаем amoMessenger.
    // --------------------------------------------------------

    res
      .status(200)
      .json({

        ok:
          true,

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


        if (
          !payload
        ) {

          return;

        }


        const request =
          payload._embedded &&
          payload._embedded.request;


        if (
          !request
        ) {

          return;

        }


        const botId =
          payload.bot_id;


        const requestId =
          request.id;


        const receiverUserId =
          request.author_id;


        // ----------------------------------------------------
        // Первый экран
        // ----------------------------------------------------

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

          mainMenuButtons(),

          receiverUserId

        );


        return;

      }


      // ======================================================
      // ПОЛЬЗОВАТЕЛЬ НАЖАЛ КНОПКУ / НАПИСАЛ СООБЩЕНИЕ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {

        const payload =
          body._embedded &&
          body._embedded
            .rpa_bot_income_message;


        if (
          !payload
        ) {

          return;

        }


        const request =
          payload._embedded &&
          payload._embedded.request;


        if (
          !request
        ) {

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
          "Получено сообщение:",
          text
        );


        // ----------------------------------------------------
        // Получаем состояние
        // ----------------------------------------------------

        let session =
          activeRequests.get(
            requestId
          );


        if (
          !session
        ) {

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
        // КНОПКА "ПОДТВЕРДИТЬ ЗАМЕР"
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

          console.log(
            "=========================================="
          );


          try {

            // ------------------------------------------------
            // Ищем задачи
            // ------------------------------------------------

            const result =
              await buildMeasurements();


            // ------------------------------------------------
            // Ничего не нашли
            // ------------------------------------------------

            if (
              !result.measurements.length
            ) {

              await sendBotMessage(

                botId,

                requestId,

                `Замеры для ${ENGINEER_NAME} не найдены.`,

                mainMenuButtons(),

                receiverUserId

              );


              session.stage =
                "main_menu";


              return;

            }


            // ------------------------------------------------
            // Сохраняем замеры в сессии
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

            const listText =
              formatMeasurementsList(
                result.measurements
              );


            // ------------------------------------------------
            // Кнопки
            //
            // Количество кнопок =
            // количество замеров.
            // ------------------------------------------------

            const buttons =
              result.measurements.map(
                item =>
                  measurementButtonText(
                    item
                  )
              );


            await sendBotMessage(

              botId,

              requestId,

              "Выберите замер:\n\n" +
              listText,

              buttons,

              receiverUserId

            );


            return;

          } catch (
            error
          ) {

            console.error(
              "Ошибка поиска замеров:",
              error
            );


            await sendBotMessage(

              botId,

              requestId,

              "При обращении к amoCRM произошла ошибка. Попробуйте ещё раз.",

              mainMenuButtons(),

              receiverUserId

            );


            session.stage =
              "main_menu";


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

            mainMenuButtons(),

            receiverUserId

          );


          session.stage =
            "main_menu";


          return;

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

          const selected =
            session.measurements.find(
              item =>
                measurementButtonText(
                  item
                ) ===
                text
            );


          // --------------------------------------------------
          // Не нашли кнопку
          // --------------------------------------------------

          if (
            !selected
          ) {

            await sendBotMessage(

              botId,

              requestId,

              "Не удалось определить выбранный замер. Пожалуйста, нажмите кнопку ещё раз.",

              session.measurements.map(
                item =>
                  measurementButtonText(
                    item
                  )
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
          // После выбора возвращаем главное меню
          // --------------------------------------------------

          session.stage =
            "main_menu";


          session.measurements =
            [];


          activeRequests.set(
            requestId,
            session
          );


          return;

        }

      }

    } catch (
      error
    ) {

      console.error(
        "WEBHOOK ERROR:",
        error.message,
        error.details ||
        ""
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
