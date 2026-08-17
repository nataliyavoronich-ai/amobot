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

const AMOMESSENGER_TOKENS_FILE = path.join(
  __dirname,
  "amomessenger_tokens.json"
);

// ============================================================
// АКТИВНЫЕ СЕССИИ БОТА
// ============================================================

const activeRequests = new Map();

// ============================================================
// ПОСЛЕДНИЕ WEBHOOK
// ============================================================

const lastRequests = [];


// ============================================================
// amoCRM REQUEST
// ============================================================

async function amocrmRequest(pathAndQuery) {

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
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

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
        method: "GET",

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
      .catch(() => null);

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
// amoMessenger REQUEST
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
      .catch(() => null);

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
// ПОСЛЕДНИЕ WEBHOOK
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

      result[
        part.type
      ] =
        Number(
          part.value
        );
    }
  }

  return result;
}


// ============================================================
// ПРЕОБРАЗОВАНИЕ МОСКОВСКОЙ ДАТЫ В UNIX
// ============================================================
//
// Москва = UTC+3
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
// ДИАПАЗОН ДЛЯ ПОИСКА ЗАДАЧ
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

  const todayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day,
      0,
      0,
      0
    );

  const tomorrowStartDate =
    new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day
      )
    );

  tomorrowStartDate.setUTCDate(
    tomorrowStartDate.getUTCDate() + 1
  );

  const tomorrowYear =
    tomorrowStartDate.getUTCFullYear();

  const tomorrowMonth =
    tomorrowStartDate.getUTCMonth() + 1;

  const tomorrowDay =
    tomorrowStartDate.getUTCDate();

  const tomorrowEnd =
    moscowTimestamp(
      tomorrowYear,
      tomorrowMonth,
      tomorrowDay,
      23,
      59,
      59
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

  const yesterdayDate =
    new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day
      )
    );

  yesterdayDate.setUTCDate(
    yesterdayDate.getUTCDate() - 1
  );

  const yesterdayStart =
    moscowTimestamp(
      yesterdayDate.getUTCFullYear(),
      yesterdayDate.getUTCMonth() + 1,
      yesterdayDate.getUTCDate(),
      0,
      0,
      0
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
// ФОРМАТИРОВАНИЕ UNIX В МОСКОВСКОЕ ВРЕМЯ
// ============================================================

function formatMoscowDate(
  timestamp
) {

  if (
    !timestamp
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
        Number(timestamp) *
        1000
      )
    );
}


// ============================================================
// ПОЛУЧЕНИЕ ЗНАЧЕНИЯ CUSTOM FIELD
// ============================================================

function getField(
  lead,
  fieldId
) {

  if (
    !lead ||
    !lead.custom_fields_values
  ) {

    return null;
  }

  return lead.custom_fields_values.find(
    field =>
      Number(
        field.field_id
      ) ===
      Number(
        fieldId
      )
  ) || null;
}


// ============================================================
// ТЕКСТОВОЕ ЗНАЧЕНИЕ CUSTOM FIELD
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
    !field.values ||
    !field.values.length
  ) {

    return null;
  }

  const value =
    field.values[0];

  if (
    value.value !==
    undefined
  ) {

    return String(
      value.value
    );
  }

  if (
    value.enum_id !==
    undefined
  ) {

    return String(
      value.enum_id
    );
  }

  return null;
}


// ============================================================
// ДАТА ИЗ ПОЛЯ СДЕЛКИ
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
    !field.values ||
    !field.values.length
  ) {

    return null;
  }

  const value =
    field.values[0].value;

  if (
    value ===
    undefined ||
    value ===
    null
  ) {

    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isNaN(number) &&
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
    !field.values ||
    !field.values.length
  ) {

    return false;
  }

  const value =
    field.values[0];

  // Основной вариант для select
  if (
    value.enum_id !==
      undefined &&
    Number(
      value.enum_id
    ) ===
      Number(
        ENGINEER_ENUM_ID
      )
  ) {

    return true;
  }

  // Дополнительная проверка
  if (
    value.value !==
      undefined &&
    String(
      value.value
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
// ПОЛУЧЕНИЕ СДЕЛКИ ПО ID
// ============================================================

async function getLead(
  leadId
) {

  return amocrmRequest(
    `/api/v4/leads/${leadId}?with=contacts`
  );
}


// ============================================================
// ПОЛУЧЕНИЕ КОНТАКТА
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
    contact.custom_fields_values
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
// ПОЛУЧЕНИЕ ЗАДАЧ
// ============================================================
//
// ВАЖНО:
// Фильтр task_type поддерживается API amoCRM.
// complete_till не фильтруем через URL,
// потому что API списка задач документирует
// task_type, is_completed, responsible_user_id,
// entity_type и т.д., но не complete_till.
// Поэтому дату проверяем здесь.
// ============================================================

async function getMeasurementTasks() {

  const tasks = [];

  let page = 1;

  while (true) {

    const params =
      new URLSearchParams();

    params.set(
      "filter[task_type][]",
      String(
        TASK_TYPE_ID
      )
    );

    params.set(
      "filter[is_completed][]",
      "0"
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

    const data =
      await amocrmRequest(
        `/api/v4/tasks?${params.toString()}`
      );

    const current =
      data &&
      data._embedded &&
      data._embedded.tasks
        ? data._embedded.tasks
        : [];

    tasks.push(
      ...current
    );

    console.log(
      `Задачи: страница ${page}, получено ${current.length}`
    );

    if (
      current.length < 250
    ) {

      break;
    }

    page++;

    // Защита от бесконечного цикла
    if (
      page > 100
    ) {

      break;
    }
  }

  return tasks;
}


// ============================================================
// ОТБОР ЗАДАЧ ПО ДАТЕ
// ============================================================

function filterTasksByDate(
  tasks
) {

  const range =
    getTaskDateRange();

  const filtered =
    tasks.filter(
      task => {

        if (
          task.entity_type !==
          "leads"
        ) {

          return false;
        }

        if (
          !task.entity_id
        ) {

          return false;
        }

        if (
          !task.complete_till
        ) {

          return false;
        }

        const deadline =
          Number(
            task.complete_till
          );

        return (
          deadline >=
            range.from &&
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
// ПОЛУЧЕНИЕ ВСЕХ НУЖНЫХ СДЕЛОК
// ============================================================

async function getLeadsForTasks(
  tasks
) {

  const leadIds = [
    ...new Set(
      tasks.map(
        task =>
          Number(
            task.entity_id
          )
      )
    ),
  ];

  const leads = [];

  for (
    const leadId of
    leadIds
  ) {

    try {

      const lead =
        await getLead(
          leadId
        );

      if (
        lead
      ) {

        leads.push(
          lead
        );
      }

    } catch (
      error
    ) {

      console.error(
        `Не удалось получить сделку ${leadId}:`,
        error.message
      );
    }
  }

  return leads;
}


// ============================================================
// ФОРМИРОВАНИЕ ЗАМЕРОВ
// ============================================================

async function buildMeasurements() {

  console.log(
    "======================================"
  );

  console.log(
    "Начинаем поиск замеров"
  );

  console.log(
    "Инженер:",
    ENGINEER_NAME
  );

  console.log(
    "Тип задачи:",
    TASK_TYPE_ID
  );

  const allTasks =
    await getMeasurementTasks();

  console.log(
    "Всего задач нужного типа:",
    allTasks.length
  );

  const dateResult =
    filterTasksByDate(
      allTasks
    );

  const tasks =
    dateResult.tasks;

  console.log(
    "Задач после фильтра по дате:",
    tasks.length
  );

  const leads =
    await getLeadsForTasks(
      tasks
    );

  console.log(
    "Получено сделок:",
    leads.length
  );

  const result = [];

  for (
    const task of
    tasks
  ) {

    const lead =
      leads.find(
        item =>
          Number(
            item.id
          ) ===
          Number(
            task.entity_id
          )
      );

    if (
      !lead
    ) {

      continue;
    }

    // Проверяем инженера именно в сделке
    if (
      !isMarina(
        lead
      )
    ) {

      console.log(
        `Сделка ${lead.id} пропущена: другой инженер`
      );

      continue;
    }

    let clientName =
      null;

    let clientPhones = [];

    const contacts =
      lead._embedded &&
      lead._embedded.contacts
        ? lead._embedded.contacts
        : [];

    const mainContact =
      contacts.find(
        contact =>
          contact.is_main ===
          true
      ) ||
      contacts[0];

    if (
      mainContact
    ) {

      try {

        const contact =
          await getContact(
            mainContact.id
          );

        const info =
          extractContactInfo(
            contact
          );

        clientName =
          info.name;

        clientPhones =
          info.phones;

      } catch (
        error
      ) {

        console.error(
          "Ошибка получения контакта:",
          error.message
        );
      }
    }

    result.push({

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
        clientName,

      client_phones:
        clientPhones,

      lead_link:
        leadLink(
          lead.id
        ),

      engineer:
        ENGINEER_NAME,

    });
  }

  console.log(
    "ИТОГО НАЙДЕНО:",
    result.length
  );

  console.log(
    "======================================"
  );

  return {

    range:
      dateResult.range,

    allTasksCount:
      allTasks.length,

    dateTasksCount:
      tasks.length,

    measurements:
      result,

  };
}


// ============================================================
// DEBUG: СВЯЗЬ С amoCRM
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
        Number(req.params.id);

      if (!leadId) {

        return res.status(400).json({
          status: "Ошибка",
          message: "Неверный ID сделки",
        });

      }

      const params =
        new URLSearchParams();

      params.set(
        "filter[entity_type]",
        "leads"
      );

      params.set(
        "filter[entity_id][]",
        String(leadId)
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
        data._embedded.tasks
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

              created_at:
                task.created_at,

              created_at_moscow:
                formatMoscowDate(
                  task.created_at
                ),

              updated_at:
                task.updated_at,

              updated_at_moscow:
                formatMoscowDate(
                  task.updated_at
                ),

            })
          ),

        raw:
          data,

      });

    } catch (
      error
    ) {

      console.error(
        "Ошибка получения задач сделки:",
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
// DEBUG: КОНКРЕТНАЯ СДЕЛКА
//
// Можно проверить:
// /debug/lead-test/35485692
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

      const engineerField =
        getField(
          lead,
          ENGINEER_FIELD_ID
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
          engineerField,

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

        raw_lead:
          lead,

      });

    } catch (
      error
    ) {

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
// DEBUG: ЗАДАЧИ НУЖНОГО ТИПА
// ============================================================

app.get(
  "/debug/measurement-tasks",
  async (
    req,
    res
  ) => {

    try {

      const tasks =
        await getMeasurementTasks();

      res.json({

        status:
          "OK",

        task_type_id:
          TASK_TYPE_ID,

        total:
          tasks.length,

        tasks:
          tasks.map(
            task => ({

              id:
                task.id,

              task_type_id:
                task.task_type_id,

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

              text:
                task.text,

            })
          ),

      });

    } catch (
      error
    ) {

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
// DEBUG: ПОЛНАЯ ЦЕПОЧКА
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
          `${String(now.day).padStart(2, "0")}.${String(now.month).padStart(2, "0")}.${now.year} ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}:${String(now.second).padStart(2, "0")}`,

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

        all_tasks_count:
          result.allTasksCount,

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
// amoMessenger: отправка сообщения
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
    buttons &&
    buttons.length
  ) {

    body.reply_markup = {

      inline_keyboard: {

        buttons:
          buttons.map(
            text => ({
              text:
                String(text),
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
// amoMessenger: вернуть управление
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
// ФОРМАТ СПИСКА ЗАМЕРОВ
// ============================================================

function formatMeasurementsList(
  measurements
) {

  return measurements
    .map(
      item => {

        const phones =
          item.client_phones &&
          item.client_phones.length
            ? item.client_phones.join(
                ", "
              )
            : "—";

        return [
          `№ договора: ${item.contract_number || "—"}`,

          `Дата замера: ${item.measure_date || "—"}`,

          `Время замера: ${item.measure_time || "—"}`,

          `Адрес замера: ${item.measure_address || "—"}`,

          `Продукт: ${item.product || "—"}`,

          `Имя клиента: ${item.client_name || "—"}`,

          `№ телефона: ${phones}`,

          `Ссылка на сделку: ${item.lead_link}`,

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
// ФОРМАТ ОДНОГО ЗАМЕРА
// ============================================================

function formatMeasurementDetails(
  item
) {

  const phones =
    item.client_phones &&
    item.client_phones.length
      ? item.client_phones.join(
          ", "
        )
      : "—";

  return [

    `Дата замера: ${item.measure_date || "—"}`,

    `Время замера: ${item.measure_time || "—"}`,

    `Адрес замера: ${item.measure_address || "—"}`,

    `Продукт: ${item.product || "—"}`,

    `Имя клиента: ${item.client_name || "—"}`,

    `№ телефона: ${phones}`,

    `№ договора: ${item.contract_number || "—"}`,

    `Ссылка на сделку: ${item.lead_link}`,

  ].join(
    "\n"
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

    console.log(
      "AMOMESSENGER WEBHOOK:"
    );

    console.log(
      JSON.stringify(
        body,
        null,
        2
      )
    );

    res.status(200)
      .json({
        ok: true,
      });

    try {

      const eventType =
        body.event_type;

      // ------------------------------------------------------
      // Передача управления боту
      // ------------------------------------------------------

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

        const result =
          await buildMeasurements();

        if (
          !result.measurements.length
        ) {

          await sendBotMessage(

            botId,

            requestId,

            `Замеры для ${ENGINEER_NAME} не найдены.`,

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
            measurements:
              result.measurements,

            botId,

            receiverUserId,
          }
        );

        const text =
          "Выберите замер:\n\n" +
          formatMeasurementsList(
            result.measurements
          );

        const buttons =
          result.measurements.map(
            item =>
              item.contract_number ||
              String(
                item.lead_id
              )
          );

        await sendBotMessage(

          botId,

          requestId,

          text,

          buttons,

          receiverUserId

        );

        return;
      }

      // ------------------------------------------------------
      // Нажата кнопка
      // ------------------------------------------------------

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

        const session =
          activeRequests.get(
            requestId
          );

        if (!session) {

          console.log(
            "Сессия не найдена:",
            requestId
          );

          return;
        }

        const selected =
          session.measurements.find(
            item =>
              (
                item.contract_number ||
                String(
                  item.lead_id
                )
              ) ===
              text
          );

        if (!selected) {

          await sendBotMessage(

            botId,

            requestId,

            "Не удалось определить выбранный замер.",

            session.measurements.map(
              item =>
                item.contract_number ||
                String(
                  item.lead_id
                )
            ),

            receiverUserId

          );

          return;
        }

        await sendBotMessage(

          botId,

          requestId,

          formatMeasurementDetails(
            selected
          ),

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

    } catch (
      error
    ) {

      console.error(
        "WEBHOOK ERROR:",
        error.message,
        error.details
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
// DEBUG LAST REQUESTS
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
      "======================================"
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
      "======================================"
    );

  }
);
