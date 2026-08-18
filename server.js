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
// ТОКЕН amoMessenger
// ============================================================

const AMOMESSENGER_TOKENS_FILE =
  path.join(
    __dirname,
    "amomessenger_tokens.json"
  );


// ============================================================
// АКТИВНЫЕ СЕССИИ БОТА
// ============================================================

const activeRequests =
  new Map();


// ============================================================
// ПОСЛЕДНИЕ ЗАПРОСЫ
// ============================================================

const lastRequests = [];


// ============================================================
// СЛУЖЕБНОЕ ХРАНЕНИЕ ПОСЛЕДНИХ ЗАПРОСОВ
// ============================================================

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
// amoMessenger TOKEN
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


// ============================================================
// amoMessenger API
// ============================================================

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
      part.type !==
      "literal"
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
// фильтруем именно task.complete_till.
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


  const currentMoment =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute,
      now.second
    );


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
// ФОРМАТ ДАТЫ МОСКВЫ
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
// ПОЛУЧИТЬ ТЕКСТОВОЕ ЗНАЧЕНИЕ ПОЛЯ
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
// ПОЛУЧИТЬ ВСЕ СДЕЛКИ
// ============================================================
//
// Мы НЕ используем API-фильтр по Инженеру,
// потому что в вашем аккаунте он возвращал
// "Invalid filter for current account".
//
// Загружаем сделки страницами и сами проверяем
// поле 203849.
// ============================================================

async function getMarinaLeads() {

  console.log(
    "=========================================="
  );

  console.log(
    "ПОИСК СДЕЛОК МАРИНЫ"
  );

  console.log(
    "Инженер:",
    ENGINEER_NAME
  );

  console.log(
    "Поле:",
    ENGINEER_FIELD_ID
  );

  console.log(
    "ID значения:",
    ENGINEER_ENUM_ID
  );

  console.log(
    "=========================================="
  );


  const leads = [];

  let page = 1;


  while (true) {

    const params =
      new URLSearchParams();


    params.set(
      "limit",
      "250"
    );


    params.set(
      "page",
      String(page)
    );


    params.set(
      "order[id]",
      "asc"
    );


    const data =
      await amocrmRequest(
        `/api/v4/leads?${params.toString()}`
      );


    const current =
      data &&
      data._embedded &&
      Array.isArray(
        data._embedded.leads
      )
        ? data._embedded.leads
        : [];


    console.log(
      `Страница сделок ${page}: ${current.length}`
    );


    leads.push(
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
        "Достигнут предел страниц сделок."
      );

      break;

    }

  }


  const marinaLeads =
    leads.filter(
      lead =>
        isMarina(
          lead
        )
    );


  console.log(
    "Всего сделок загружено:",
    leads.length
  );


  console.log(
    "Сделок Марины:",
    marinaLeads.length
  );


  return marinaLeads;

}


// ============================================================
// ПОЛУЧИТЬ ЗАДАЧИ ПО ID СДЕЛОК
// ============================================================
//
// Это важно.
//
// Мы не запрашиваем 900 задач всего аккаунта.
//
// Сначала находим сделки Марины,
// потом запрашиваем задачи только этих сделок.
// ============================================================

async function getTasksForLeadIds(
  leadIds
) {

  const allTasks = [];


  if (
    !Array.isArray(leadIds) ||
    !leadIds.length
  ) {

    return allTasks;

  }


  const BATCH_SIZE = 50;


  for (
    let start = 0;
    start < leadIds.length;
    start += BATCH_SIZE
  ) {

    const batch =
      leadIds.slice(
        start,
        start + BATCH_SIZE
      );


    console.log(
      `Загрузка задач для сделок: ${start + 1}-${Math.min(start + BATCH_SIZE, leadIds.length)} из ${leadIds.length}`
    );


    for (
      const leadId of
      batch
    ) {

      let page = 1;


      while (true) {

        const params =
          new URLSearchParams();


        params.set(
          "filter[entity_type]",
          "leads"
        );


        params.set(
          "filter[entity_id][0]",
          String(
            leadId
          )
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


        try {

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
            page > 20
          ) {

            break;

          }

        } catch (
          error
        ) {

          console.error(
            `Ошибка получения задач сделки ${leadId}:`,
            error.message
          );

          break;

        }

      }

    }

  }


  console.log(
    "Всего задач у сделок Марины:",
    allTasks.length
  );


  return allTasks;

}


// ============================================================
// ПОЛУЧИТЬ ПОДХОДЯЩИЕ ЗАДАЧИ
// ============================================================

async function getMeasurementTasksForMarina() {

  const leads =
    await getMarinaLeads();


  console.log(
    "Всего сделок Марины:",
    leads.length
  );


  if (
    !leads.length
  ) {

    return {

      leads: [],

      tasks: [],

    };

  }


  const leadIds =
    leads.map(
      lead =>
        Number(
          lead.id
        )
    );


  const allTasks =
    await getTasksForLeadIds(
      leadIds
    );


  const measurementTasks =
    allTasks.filter(
      task => {

        const notCompleted =
          task.is_completed === false ||
          task.is_completed === 0 ||
          task.is_completed === "0";


        return (

          String(
            task.entity_type
          ) ===
          "leads"

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

          task.complete_till !== null

          &&

          task.complete_till !== undefined

        );

      }
    );


  console.log(
    "Задач типа Подтв. замер(и):",
    measurementTasks.length
  );


  return {

    leads,

    tasks:
      measurementTasks,

  };

}


// ============================================================
// ФИЛЬТР ПО ДАТЕ ИСПОЛНЕНИЯ
// ============================================================

function filterTasksByDate(
  tasks
) {

  const range =
    getTaskDateRange();


  const filtered =
    tasks.filter(
      task => {

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


  return {

    range,

    tasks:
      filtered,

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


  const source =
    await getMeasurementTasksForMarina();


  const dateResult =
    filterTasksByDate(
      source.tasks
    );


  console.log(
    "Режим:",
    dateResult.range.mode
  );


  console.log(
    "Задач после фильтра даты:",
    dateResult.tasks.length
  );


  // ==========================================================
  // ИНДЕКС СДЕЛОК ПО ID
  // ==========================================================

  const leadsById =
    new Map();


  for (
    const lead of
    source.leads
  ) {

    leadsById.set(
      Number(
        lead.id
      ),
      lead
    );

  }


  // ==========================================================
  // ВАЖНОЕ ИСПРАВЛЕНИЕ
  // ==========================================================
  //
  // Здесь НЕ проверяем isMarina повторно.
  //
  // Почему?
  //
  // source.leads уже получены через getMarinaLeads().
  //
  // А dateResult.tasks уже получены только для этих сделок.
  //
  // Поэтому повторная проверка могла убрать найденную
  // сделку из результата.
  //
  // Теперь:
  //
  // задача -> entity_id -> сделка
  //
  // и если сделка найдена, она попадает в результат.
  // ==========================================================

  const selectedByLead =
    new Map();


  for (
    const task of
    dateResult.tasks
  ) {

    const leadId =
      Number(
        task.entity_id
      );


    const lead =
      leadsById.get(
        leadId
      );


    console.log(
      "Проверяем задачу:",
      task.id,
      "lead:",
      leadId,
      "сделка найдена:",
      !!lead
    );


    if (!lead) {

      console.log(
        "Сделка для задачи не найдена:",
        leadId
      );

      continue;

    }


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


  console.log(
    "Уникальных подходящих сделок:",
    selectedByLead.size
  );


  const measurements = [];


  // ==========================================================
  // ПОЛУЧАЕМ ДАННЫЕ СДЕЛОК
  // ==========================================================

  for (
    const [
      leadId,
      task
    ] of
    selectedByLead
  ) {

    const lead =
      leadsById.get(
        leadId
      );


    if (!lead) {

      continue;

    }


    console.log(
      "Получено сделок:",
      1,
      "ID:",
      lead.id
    );


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
    // Ни одно поле сделки НЕ используется как условие
    // для исключения сделки.
    //
    // Даже если все эти поля пустые,
    // сделка всё равно будет показана.
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


    console.log(
      "Добавляем замер:",
      JSON.stringify(
        measurement,
        null,
        2
      )
    );


    measurements.push(
      measurement
    );

  }


  // ==========================================================
  // СОРТИРОВКА ПО СРОКУ ИСПОЛНЕНИЯ ЗАДАЧИ
  // ==========================================================

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


  console.log(
    "=========================================="
  );


  return {

    range:
      dateResult.range,

    marinaLeadsCount:
      source.leads.length,

    allMeasurementTasksCount:
      source.tasks.length,

    dateTasksCount:
      dateResult.tasks.length,

    measurements,

  };

}


// ============================================================
// ЗНАЧЕНИЕ ДЛЯ ВЫВОДА
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
// ТЕЛЕФОНЫ
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
// Каждая сделка = новая строка.
// Все поля сделки = одна строка.
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


  console.log(
    "Отправляем сообщение amoMessenger:",
    text
  );


  if (
    Array.isArray(
      buttons
    )
  ) {

    console.log(
      "Кнопки:",
      buttons
    );

  }


  return amoMessengerRequest(
    "POST",
    `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
    body
  );

}


// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ
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
// ГЛАВНАЯ СТРАНИЦА
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
// ВИДЖЕТ
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

  console.error(e);

}

</script>

</body>
</html>`
    );

  }
);


// ============================================================
// OAUTH amoMessenger
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
      "OAUTH amoMessenger"
    );

    console.log(
      "code:",
      code
        ? "получен"
        : "НЕ ПОЛУЧЕН"
    );

    console.log(
      "=========================================="
    );


    if (!code) {

      return res
        .status(400)
        .send(
          "Не получен параметр code. Установка amoMessenger не выполнена."
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

      console.error(
        "Не заданы переменные amoMessenger OAuth."
      );


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
            "amoMessenger отклонил авторизацию. Подробности находятся в логах Render."
          );

      }


      fs.writeFileSync(

        AMOMESSENGER_TOKENS_FILE,

        JSON.stringify(
          {

            access_token:
              tokenData.access_token,

            refresh_token:
              tokenData.refresh_token,

            expires_in:
              tokenData.expires_in,

            obtained_at:
              new Date().toISOString(),

          },

          null,

          2

        )

      );


      console.log(
        "amoMessenger OAuth успешно завершён."
      );


      res.send(
        `
<!DOCTYPE html>

<html>

<head>

<meta charset="utf-8">

<title>amoMessenger</title>

</head>

<body style="
font-family: Arial, sans-serif;
padding: 30px;
">

<h2>
Готово!
</h2>

<p>
amoMessenger успешно авторизован.
</p>

<p>
Можно закрыть это окно.
</p>

</body>

</html>
`
      );


    } catch (
      error
    ) {

      console.error(
        "Ошибка OAuth:",
        error
      );


      res
        .status(500)
        .send(
          "Ошибка авторизации amoMessenger. Подробности в логах Render."
        );

    }

  }
);


// ============================================================
// DEBUG: ТОКЕН amoMessenger
// ============================================================

app.get(
  "/debug/amomessenger-token",
  (
    req,
    res
  ) => {

    const tokens =
      loadTokens();


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
          ? `${tokens.access_token.slice(0, 15)}...`
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
        field.enums ||
        [];


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
          found ||
          null,

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
// DEBUG: ЗАДАЧИ КОНКРЕТНОЙ СДЕЛКИ
// ============================================================

app.get(
  "/debug/lead-tasks/:id",
  async (
    req,
    res
  ) => {

    try {

      const leadId =
        Number(
          req.params.id
        );


      const params =
        new URLSearchParams();


      params.set(
        "filter[entity_type]",
        "leads"
      );


      params.set(
        "filter[entity_id][0]",
        String(
          leadId
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


      params.set(
        "order[complete_till]",
        "asc"
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

        lead_id:
          leadId,

        found_count:
          tasks.length,

        tasks:
          tasks.map(
            task => ({

              id:
                task.id,

              task_type_id:
                task.task_type_id,

              text:
                task.text,

              entity_id:
                task.entity_id,

              entity_type:
                task.entity_type,

              responsible_user_id:
                task.responsible_user_id,

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
// DEBUG: ВСЕ СДЕЛКИ МАРИНЫ
// ============================================================

app.get(
  "/debug/marina-leads",
  async (
    req,
    res
  ) => {

    try {

      const leads =
        await getMarinaLeads();


      res.json({

        status:
          "OK",

        engineer:
          ENGINEER_NAME,

        field_id:
          ENGINEER_FIELD_ID,

        enum_id:
          ENGINEER_ENUM_ID,

        found_count:
          leads.length,

        leads:
          leads.map(
            lead => ({

              id:
                lead.id,

              name:
                lead.name,

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

              engineer:
                getFieldText(
                  lead,
                  ENGINEER_FIELD_ID
                ),

            })
          ),

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

        marina_leads_count:
          result.marinaLeadsCount,

        measurement_tasks_count:
          result.allMeasurementTasksCount,

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
// DEBUG: ПРОВЕРКА ФИЛЬТРА ЗАДАЧ
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
        "10"
      );


      params.set(
        "page",
        "1"
      );


      params.set(
        "order[complete_till]",
        "asc"
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
// DEBUG: ПОСЛЕДНИЙ ЗАПРОС
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


    // Очень важно:
    // быстро отвечаем amoMessenger,
    // а обработку продолжаем.
    res
      .status(200)
      .json({
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

          console.log(
            "Нет payload rpa_bot_control_transferred"
          );

          return;

        }


        const request =
          payload._embedded &&
          payload._embedded.request;


        if (!request) {

          console.log(
            "Нет request"
          );

          return;

        }


        const botId =
          payload.bot_id;


        const requestId =
          request.id;


        const receiverUserId =
          request.author_id;


        console.log(
          "Бот получил управление."
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


        // ----------------------------------------------------
        // Сохраняем состояние
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


        // ----------------------------------------------------
        // Главное меню
        // ----------------------------------------------------

        await sendBotMessage(

          botId,

          requestId,

          "Выберите задачу для выполнения",

          [

            "Подтвердить замер",

            "Провести замер",

            "Загрузить фотоотчет",

            "Внести правки",

          ],

          receiverUserId

        );


        console.log(
          "Главное меню отправлено."
        );


        return;

      }


      // ======================================================
      // ПОЛУЧЕНО НАЖАТИЕ КНОПКИ
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
          "Получено сообщение:",
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
            "=========================================="
          );

          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );

          console.log(
            "=========================================="
          );


          try {

            const result =
              await buildMeasurements();


            console.log(
              "Количество найденных замеров:",
              result.measurements.length
            );


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
            // Формируем текст
            // ------------------------------------------------

            const textMessage =
              formatMeasurementsList(
                result.measurements
              );


            // ------------------------------------------------
            // Кнопки
            //
            // Количество кнопок =
            // количество найденных замеров.
            //
            // Текст кнопки =
            // значение № договора.
            //
            // Если № договора пуст,
            // временно используем ID сделки,
            // чтобы кнопка всё равно существовала.
            // ------------------------------------------------

            const buttons =
              result.measurements.map(
                item => {

                  if (
                    item.contract_number &&
                    String(
                      item.contract_number
                    ).trim() !== ""
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


            console.log(
              "Список замеров отправлен."
            );


            return;


          } catch (
            error
          ) {

            console.error(
              "Ошибка поиска замеров:",
              error
            );


            try {

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

            } catch (
              sendError
            ) {

              console.error(
                "Ошибка отправки сообщения об ошибке:",
                sendError
              );

            }


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

          console.log(
            "Пользователь выбирает конкретный замер:",
            text
          );


          const selected =
            session.measurements.find(
              item => {

                const buttonValue =
                  item.contract_number &&
                  String(
                    item.contract_number
                  ).trim() !== ""

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

              "Не удалось определить выбранный замер. Пожалуйста, нажмите кнопку ещё раз.",

              session.measurements.map(
                item => {

                  if (
                    item.contract_number &&
                    String(
                      item.contract_number
                    ).trim() !== ""
                  ) {

                    return String(
                      item.contract_number
                    );

                  }

                  return `Сделка ${item.lead_id}`;

                }
              ),

              receiverUserId

            );


            return;

          }


          // --------------------------------------------------
          // Показываем детали выбранной сделки
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


          console.log(
            "Подробности замера отправлены."
          );


          // --------------------------------------------------
          // Пока оставляем управление у нашего бота.
          // --------------------------------------------------

          activeRequests.delete(
            requestId
          );


          return;

        }

      }


    } catch (
      error
    ) {

      console.error(
        "WEBHOOK ERROR:",
        error.message
      );


      console.error(
        "WEBHOOK ERROR DETAILS:",
        error.details ||
        ""
      );

    }

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
      `Сервер запущен на порту ${PORT}`
    );

    console.log(
      "amoCRM:",
      process.env.AMOCRM_DOMAIN
        ? "настроен"
        : "НЕ НАСТРОЕН"
    );

    console.log(
      "amoMessenger OAuth:",
      process.env.AMOMESSENGER_CLIENT_ID
        ? "настроен"
        : "НЕ НАСТРОЕН"
    );

    console.log(
      "=========================================="
    );

  }
);
