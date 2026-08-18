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

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const TASK_TYPE_ID = 2746005;

const FIELD_IDS = {
  contractNumber: 412776,
  measureDate: 175370,
  measureTime: 413828,
  measureAddress: 175412,
  product: 172572
};

const TOKENS_FILE = path.join(__dirname, "amomessenger_tokens.json");

const sessions = new Map();


// ============================================================
// ЛОГИ
// ============================================================

const lastRequests = [];

app.use((req, res, next) => {
  lastRequests.unshift({
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    body: req.body,
    query: req.query
  });

  if (lastRequests.length > 30) {
    lastRequests.pop();
  }

  next();
});


// ============================================================
// ФАЙЛЫ
// ============================================================

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}


// ============================================================
// amoCRM
// ============================================================

async function amocrmRequest(url) {

  const domain = (process.env.AMOCRM_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  const token = process.env.AMOCRM_TOKEN;

  if (!domain) {
    throw new Error("Не задан AMOCRM_DOMAIN");
  }

  if (!token) {
    throw new Error("Не задан AMOCRM_TOKEN");
  }

  console.log("amoCRM GET:", `https://${domain}${url}`);

  const response = await fetch(
    `https://${domain}${url}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {

    const error = new Error(
      `amoCRM HTTP ${response.status}`
    );

    error.details = data;

    throw error;
  }

  return data;
}


// ============================================================
// amoMessenger
// ============================================================

async function messengerRequest(method, url, body) {

  const tokens = loadJson(TOKENS_FILE);

  if (!tokens || !tokens.access_token) {
    throw new Error("Токен amoMessenger не найден");
  }

  console.log(
    "amoMessenger",
    method,
    `https://api.amo.tm${url}`
  );

  if (body) {
    console.log(
      "BODY:",
      JSON.stringify(body, null, 2)
    );
  }

  const response = await fetch(
    `https://api.amo.tm${url}`,
    {
      method,

      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json"
      },

      body: body
        ? JSON.stringify(body)
        : undefined
    }
  );

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  console.log(
    "amoMessenger response:",
    response.status,
    data
  );

  if (!response.ok) {

    const error = new Error(
      `amoMessenger HTTP ${response.status}`
    );

    error.details = data;

    throw error;
  }

  return data;
}


// ============================================================
// OAUTH amoMessenger
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {

    const code = req.query.code;

    if (!code) {
      return res
        .status(400)
        .send("Не получен параметр code.");
    }

    const clientId =
      process.env.AMOMESSENGER_CLIENT_ID;

    const clientSecret =
      process.env.AMOMESSENGER_CLIENT_SECRET;

    const redirectUri =
      process.env.AMOMESSENGER_REDIRECT_URI;

    if (
      !clientId ||
      !clientSecret ||
      !redirectUri
    ) {

      return res
        .status(500)
        .send(
          "На Render не заданы AMOMESSENGER_CLIENT_ID, AMOMESSENGER_CLIENT_SECRET или AMOMESSENGER_REDIRECT_URI."
        );
    }

    try {

      const response = await fetch(
        "https://id.amo.tm/oauth2/access_token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type:
              "authorization_code",
            code,
            redirect_uri: redirectUri
          })
        }
      );

      const data =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {

        console.error(
          "OAuth ERROR:",
          data
        );

        return res
          .status(500)
          .send(
            "amoMessenger отклонил авторизацию. Подробности в логах Render."
          );
      }

      saveJson(
        TOKENS_FILE,
        {
          access_token:
            data.access_token,

          refresh_token:
            data.refresh_token,

          expires_in:
            data.expires_in,

          obtained_at:
            new Date().toISOString()
        }
      );

      res.send(`
        <!doctype html>

        <html>
        <head>
          <meta charset="utf-8">
          <title>amoMessenger OAuth</title>
        </head>

        <body
          style="
            font-family:Arial;
            padding:40px;
          "
        >

          <h2>
            Авторизация amoMessenger успешно выполнена
          </h2>

          <p>
            Токен сохранён на сервере.
          </p>

          <p>
            Access Token получен: <b>ДА</b>
          </p>

          <p>
            Refresh Token получен:
            <b>
              ${data.refresh_token ? "ДА" : "НЕТ"}
            </b>
          </p>

          <p>
            Теперь можно закрыть это окно
            и снова запустить бота.
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
          "Ошибка OAuth. Подробности в логах Render."
        );
    }
  }
);


// ============================================================
// ПРОВЕРКА ТОКЕНА
// ============================================================

app.get(
  "/debug/amomessenger-token",
  (req, res) => {

    const tokens =
      loadJson(TOKENS_FILE);

    if (
      tokens &&
      tokens.access_token
    ) {

      return res.json({
        status: "Токен найден",

        access_token_preview:
          tokens.access_token.slice(
            0,
            15
          ) + "...",

        refresh_token_saved:
          !!tokens.refresh_token
      });
    }

    res.json({
      status: "Токен не найден"
    });
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
        timeZone: TIME_ZONE,

        year: "numeric",
        month: "2-digit",
        day: "2-digit",

        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",

        hourCycle: "h23"
      }
    ).formatToParts(new Date());

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

  return Math.floor(
    (
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
      ) - 10800000
    ) / 1000
  );
}


// ============================================================
// ДИАПАЗОН ДАТ ЗАДАЧ
//
// До 18:00:
// вчера 00:00 -> сегодня текущее время
//
// После 18:00:
// сегодня 00:00 -> завтра 23:59:59
// ============================================================

function getDateRange() {

  const now = moscowNow();

  const todayStart =
    moscowTimestamp(
      now.year,
      now.month,
      now.day
    );

  const currentTime =
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
      yesterday.getUTCDate()
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


  // ДО 18:00

  if (now.hour < 18) {

    return {

      from: yesterdayStart,

      to: currentTime,

      mode: "до 18:00"
    };
  }


  // ПОСЛЕ 18:00

  return {

    from: todayStart,

    to: tomorrowEnd,

    mode: "после 18:00"
  };
}


// ============================================================
// ФОРМАТ ДАТЫ
// ============================================================

function formatMoscowDate(timestamp) {

  if (
    timestamp === null ||
    timestamp === undefined ||
    timestamp === ""
  ) {
    return null;
  }

  const number =
    Number(timestamp);

  if (!Number.isFinite(number)) {
    return null;
  }

  return new Intl.DateTimeFormat(
    "ru-RU",
    {
      timeZone: TIME_ZONE,
      dateStyle: "short",
      timeStyle: "medium"
    }
  ).format(
    new Date(number * 1000)
  );
}


// ============================================================
// ПОЛЯ СДЕЛКИ
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

function getTextField(
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
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  return String(value);
}


// ============================================================
// ДАТА ПОЛЯ
// ============================================================

function getDateField(
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
    value === null ||
    value === undefined ||
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
        timeZone: TIME_ZONE
      }
    ).format(
      new Date(number * 1000)
    );
  }

  return String(value);
}


// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function isMarina(lead) {

  const field =
    getField(
      lead,
      ENGINEER_FIELD_ID
    );

  if (
    !field ||
    !Array.isArray(field.values)
  ) {
    return false;
  }

  return field.values.some(
    value => {

      const byId =
        value.enum_id !== undefined &&
        Number(value.enum_id) ===
        ENGINEER_ENUM_ID;

      const byName =
        value.value !== undefined &&
        String(value.value).trim() ===
        ENGINEER_NAME;

      return byId || byName;
    }
  );
}


// ============================================================
// ССЫЛКА НА СДЕЛКУ
// ============================================================

function getLeadLink(id) {

  const domain =
    (process.env.AMOCRM_DOMAIN || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

  return (
    `https://${domain}/leads/detail/${id}`
  );
}


// ============================================================
// КОНТАКТ
// ============================================================

async function getContact(id) {

  return amocrmRequest(
    `/api/v4/contacts/${id}`
  );
}


function parseContact(contact) {

  const phones = [];

  const fields =
    (
      contact &&
      contact.custom_fields_values
    ) || [];

  for (
    const field of fields
  ) {

    if (
      field.field_code !== "PHONE"
    ) {
      continue;
    }

    for (
      const value of field.values || []
    ) {

      if (
        value.value !== null &&
        value.value !== undefined &&
        String(value.value).trim() !== ""
      ) {

        phones.push(
          String(value.value)
        );
      }
    }
  }

  return {

    name:
      contact
        ? contact.name
        : null,

    phones
  };
}


// ============================================================
// ПОЛУЧЕНИЕ КЛИЕНТА СДЕЛКИ
// ============================================================

async function getLeadClient(
  lead
) {

  const contacts =
    (
      lead &&
      lead._embedded &&
      Array.isArray(
        lead._embedded.contacts
      )
    )
      ? lead._embedded.contacts
      : [];

  const contact =
    contacts.find(
      item => item.is_main === true
    ) || contacts[0];

  if (
    !contact ||
    !contact.id
  ) {

    return {
      name: null,
      phones: []
    };
  }

  try {

    const fullContact =
      await getContact(
        contact.id
      );

    return parseContact(
      fullContact
    );

  } catch (error) {

    console.error(
      "Ошибка получения контакта:",
      error.message
    );

    return {
      name: null,
      phones: []
    };
  }
}


// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ
//
// ВАЖНО:
// Фильтр НЕЗАВЕРШЁННЫХ задач:
//
// filter[is_completed][]=0
//
// Фильтр типа:
//
// filter[task_type][]=2746005
//
// И фильтр именно по ДАТЕ ИСПОЛНЕНИЯ:
//
// filter[complete_till][from]
// filter[complete_till][to]
// ============================================================

async function getTasks() {

  const range =
    getDateRange();

  const tasks = [];

  let page = 1;

  while (true) {

    const query =
      new URLSearchParams();

    query.set(
      "filter[entity_type]",
      "leads"
    );

    // НЕЗАВЕРШЕННАЯ ЗАДАЧА
    query.set(
      "filter[is_completed][]",
      "0"
    );

    // ТИП ЗАДАЧИ
    query.set(
      "filter[task_type][]",
      String(TASK_TYPE_ID)
    );

    // ДАТА ИСПОЛНЕНИЯ ОТ
    query.set(
      "filter[complete_till][from]",
      String(range.from)
    );

    // ДАТА ИСПОЛНЕНИЯ ДО
    query.set(
      "filter[complete_till][to]",
      String(range.to)
    );

    query.set(
      "limit",
      "250"
    );

    query.set(
      "page",
      String(page)
    );

    query.set(
      "order[complete_till]",
      "asc"
    );


    console.log(
      "=========================================="
    );

    console.log(
      "Запрос задач:",
      query.toString()
    );


    const data =
      await amocrmRequest(
        `/api/v4/tasks?${query.toString()}`
      );


    const currentTasks =
      (
        data &&
        data._embedded &&
        Array.isArray(
          data._embedded.tasks
        )
      )
        ? data._embedded.tasks
        : [];


    console.log(
      `Страница задач ${page}: ${currentTasks.length}`
    );


    tasks.push(
      ...currentTasks
    );


    if (
      currentTasks.length < 250
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
    "Всего загружено задач:",
    tasks.length
  );


  return {
    range,
    tasks
  };
}


// ============================================================
// ПОЛУЧЕНИЕ СДЕЛОК ПО ID
// ============================================================

async function getLeadsByIds(
  ids
) {

  const uniqueIds =
    [
      ...new Set(
        ids
          .map(Number)
          .filter(
            Number.isFinite
          )
      )
    ];


  const leads = [];


  for (
    let i = 0;
    i < uniqueIds.length;
    i += 50
  ) {

    const group =
      uniqueIds.slice(
        i,
        i + 50
      );


    const query =
      new URLSearchParams();


    for (
      const id of group
    ) {

      query.append(
        "filter[id][]",
        String(id)
      );
    }


    query.set(
      "with",
      "contacts"
    );

    query.set(
      "limit",
      "250"
    );


    const data =
      await amocrmRequest(
        `/api/v4/leads?${query.toString()}`
      );


    if (
      data &&
      data._embedded &&
      Array.isArray(
        data._embedded.leads
      )
    ) {

      leads.push(
        ...data._embedded.leads
      );
    }
  }


  return leads;
}


// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ ПОИСКА ЗАМЕРОВ
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


  // Получаем задачи
  const taskResult =
    await getTasks();

  const tasks =
    taskResult.tasks;

  const range =
    taskResult.range;


  // Дополнительная проверка.
  // Она нужна даже после серверного фильтра amoCRM.

  const validTasks =
    tasks.filter(
      task => {

        const correctEntity =
          String(
            task.entity_type
          ) === "leads";


        const correctType =
          Number(
            task.task_type_id
          ) ===
          TASK_TYPE_ID;


        const notCompleted =
          task.is_completed === false ||
          task.is_completed === 0 ||
          task.is_completed === "0";


        const completeTill =
          Number(
            task.complete_till
          );


        const correctDate =
          Number.isFinite(
            completeTill
          ) &&
          completeTill >=
            range.from &&
          completeTill <=
            range.to;


        return (
          correctEntity &&
          correctType &&
          notCompleted &&
          correctDate
        );
      }
    );


  console.log(
    "Найдено подходящих задач:",
    validTasks.length
  );


  // Получаем сделки
  const leads =
    await getLeadsByIds(
      validTasks.map(
        task => task.entity_id
      )
    );


  console.log(
    "Получено сделок:",
    leads.length
  );


  const leadMap =
    new Map(
      leads.map(
        lead => [
          Number(lead.id),
          lead
        ]
      )
    );


  // Чтобы одна сделка не выводилась несколько раз
  const selected =
    new Map();


  for (
    const task of validTasks
  ) {

    const lead =
      leadMap.get(
        Number(task.entity_id)
      );


    if (!lead) {
      continue;
    }


    // ИНЖЕНЕР = МАРИНА
    if (
      !isMarina(lead)
    ) {
      continue;
    }


    if (
      !selected.has(
        Number(lead.id)
      )
    ) {

      selected.set(
        Number(lead.id),
        task
      );
    }
  }


  const measurements = [];


  // Получаем данные сделок
  for (
    const [
      leadId,
      task
    ] of selected
  ) {

    const lead =
      leadMap.get(
        leadId
      );


    const client =
      await getLeadClient(
        lead
      );


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
        getTextField(
          lead,
          FIELD_IDS.contractNumber
        ),

      measure_date:
        getDateField(
          lead,
          FIELD_IDS.measureDate
        ),

      measure_time:
        getTextField(
          lead,
          FIELD_IDS.measureTime
        ),

      measure_address:
        getTextField(
          lead,
          FIELD_IDS.measureAddress
        ),

      product:
        getTextField(
          lead,
          FIELD_IDS.product
        ),

      client_name:
        client.name,

      client_phones:
        client.phones,

      lead_link:
        getLeadLink(
          lead.id
        ),

      engineer:
        ENGINEER_NAME
    });
  }


  measurements.sort(
    (a, b) =>
      Number(a.task_complete_till) -
      Number(b.task_complete_till)
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

    range,

    tasksLoaded:
      tasks.length,

    validTasks:
      validTasks.length,

    measurements
  };
}


// ============================================================
// ФОРМАТИРОВАНИЕ
// ============================================================

// Если поле пустое — показываем "—"
// Сделка ВСЁ РАВНО выводится.

function displayValue(value) {

  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {

    return "—";
  }

  return String(value);
}


function displayPhones(
  phones
) {

  if (
    !Array.isArray(phones) ||
    phones.length === 0
  ) {

    return "—";
  }

  return phones.join(", ");
}


// ============================================================
// СПИСОК ЗАМЕРОВ
// ============================================================

function measurementsText(
  measurements
) {

  return measurements
    .map(
      item => {

        return [

          `№ договора: ${displayValue(item.contract_number)}`,

          `Дата замера: ${displayValue(item.measure_date)}`,

          `Время замера: ${displayValue(item.measure_time)}`,

          `Адрес замера: ${displayValue(item.measure_address)}`,

          `Продукт: ${displayValue(item.product)}`,

          `Имя клиента: ${displayValue(item.client_name)}`,

          `№ телефона: ${displayPhones(item.client_phones)}`,

          `Ссылка на сделку: ${displayValue(item.lead_link)}`

        ].join("; ");
      }
    )
    .join("\n");
}


// ============================================================
// ДЕТАЛЬНЫЙ ЗАМЕР
// ============================================================

function measurementDetails(
  item
) {

  return [

    `Дата замера: ${displayValue(item.measure_date)}`,

    `Время замера: ${displayValue(item.measure_time)}`,

    `Адрес замера: ${displayValue(item.measure_address)}`,

    `Продукт: ${displayValue(item.product)}`,

    `Имя клиента: ${displayValue(item.client_name)}`,

    `№ телефона: ${displayPhones(item.client_phones)}`,

    `№ договора: ${displayValue(item.contract_number)}`,

    `Ссылка на сделку: ${displayValue(item.lead_link)}`

  ].join("\n");
}


// ============================================================
// КНОПКИ
// ============================================================

const MAIN_BUTTONS = [

  "Подтвердить замер",

  "Провести замер",

  "Загрузить фотоотчет",

  "Внести правки"

];


// ============================================================
// ОТПРАВКА СООБЩЕНИЯ
// ============================================================

async function sendMessage(
  botId,
  requestId,
  text,
  buttons,
  userId
) {

  const body = {

    text,

    receiver: {

      user_id: userId

    }

  };


  // Кнопки добавляем только если они есть

  if (
    Array.isArray(buttons) &&
    buttons.length
  ) {

    body.reply_markup = {

      inline_keyboard: {

        buttons:
          buttons.map(
            button => ({
              text: String(button)
            })
          )

      }

    };
  }


  console.log(
    "=========================================="
  );

  console.log(
    "ОТПРАВКА СООБЩЕНИЯ В amoMessenger"
  );

  console.log(
    JSON.stringify(
      body,
      null,
      2
    )
  );


  return messengerRequest(
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
  returnCode
) {

  return messengerRequest(

    "POST",

    `/v1.3/bots/${botId}/request/${requestId}/returnControl`,

    {
      return_code: returnCode
    }
  );
}


// ============================================================
// WEBHOOK amoMessenger
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {

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
      ok: true
    });


    try {

      const eventType =
        body.event_type;


      // ======================================================
      // ПЕРЕДАНО УПРАВЛЕНИЕ БОТУ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {

        const transferred =
          body
            ?._embedded
            ?.rpa_bot_control_transferred;


        const request =
          transferred
            ?._embedded
            ?.request;


        if (
          !transferred ||
          !request
        ) {

          return;
        }


        const botId =
          transferred.bot_id;


        const requestId =
          request.id;


        /*
         * ВАЖНО:
         *
         * В ваших webhook-логах:
         *
         * context.user_id
         * =
         * пользователь
         *
         * request.author_id
         * =
         * пользователь, который написал боту.
         *
         * Для отправки сообщения используем author_id.
         */

        const contextUserId =
          body
            ?._embedded
            ?.context
            ?.user_id;


        const requestAuthorId =
          request.author_id;


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


        sessions.set(
          requestId,
          {
            stage: "main",

            botId,

            userId:
              receiverUserId,

            measurements: []
          }
        );


        /*
         * После передачи управления
         * показываем главное меню.
         */

        await sendMessage(

          botId,

          requestId,

          "Выберите задачу для выполнения",

          MAIN_BUTTONS,

          receiverUserId
        );


        return;
      }


      // ======================================================
      // ПОЛУЧЕНО СООБЩЕНИЕ ОТ ПОЛЬЗОВАТЕЛЯ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {

        const incoming =
          body
            ?._embedded
            ?.rpa_bot_income_message;


        const request =
          incoming
            ?._embedded
            ?.request;


        const message =
          incoming
            ?._embedded
            ?.income_message;


        if (
          !incoming ||
          !request ||
          !message
        ) {

          return;
        }


        const requestId =
          request.id;


        const botId =
          incoming.bot_id;


        const contextUserId =
          body
            ?._embedded
            ?.context
            ?.user_id;


        const requestAuthorId =
          request.author_id;


        const receiverUserId =
          requestAuthorId ||
          contextUserId;


        const text =
          String(
            message.text || ""
          ).trim();


        console.log(
          "Получено сообщение:",
          text
        );


        let session =
          sessions.get(
            requestId
          );


        if (!session) {

          session = {

            stage: "main",

            botId,

            userId:
              receiverUserId,

            measurements: []

          };


          sessions.set(
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

            // Сначала короткое сообщение

            await sendMessage(

              botId,

              requestId,

              "⏳ Проверяю задачи на подтверждение замера...",

              null,

              receiverUserId

            );


            // Ищем задачи

            const result =
              await buildMeasurements();


            // Если ничего нет

            if (
              result.measurements.length === 0
            ) {

              await sendMessage(

                botId,

                requestId,

                `📋 Замеров для ${ENGINEER_NAME} не найдено.`,

                MAIN_BUTTONS,

                receiverUserId

              );


              await returnControl(

                botId,

                requestId,

                "success"

              );


              sessions.delete(
                requestId
              );


              return;
            }


            // Сохраняем найденные замеры

            session.stage =
              "selection";

            session.measurements =
              result.measurements;


            sessions.set(
              requestId,
              session
            );


            // =================================================
            // КНОПКИ
            //
            // Текст кнопки =
            // № договора.
            //
            // Если № договора пуст,
            // используем ID сделки,
            // чтобы кнопка всё равно была.
            // =================================================

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


            await sendMessage(

              botId,

              requestId,

              measurementsText(
                result.measurements
              ),

              buttons,

              receiverUserId

            );


            return;

          } catch (error) {

            console.error(
              "ОШИБКА ПОИСКА:",
              error.message
            );

            console.error(
              "DETAILS:",
              error.details || ""
            );


            try {

              await sendMessage(

                botId,

                requestId,

                "❗ Произошла ошибка при обращении к amoCRM. Проверьте логи Render.",

                MAIN_BUTTONS,

                receiverUserId

              );

            } catch (sendError) {

              console.error(
                "Ошибка отправки сообщения:",
                sendError.message
              );
            }


            return;
          }
        }


        // ====================================================
        // ДРУГИЕ ГЛАВНЫЕ КНОПКИ
        // Пока эти функции не реализуем.
        // ====================================================

        if (
          MAIN_BUTTONS
            .slice(1)
            .includes(text)
        ) {

          await sendMessage(

            botId,

            requestId,

            `Функция «${text}» пока не подключена.`,

            MAIN_BUTTONS,

            receiverUserId

          );

          return;
        }


        // ====================================================
        // ВЫБОР КОНКРЕТНОГО ЗАМЕРА
        // ====================================================

        if (
          session.stage ===
          "selection"
        ) {

          const selected =
            session.measurements.find(
              item => {

                const buttonText =
                  item.contract_number &&
                  String(
                    item.contract_number
                  ).trim() !== ""

                    ? String(
                        item.contract_number
                      )

                    : `Сделка ${item.lead_id}`;


                return (
                  buttonText ===
                  text
                );
              }
            );


          if (!selected) {

            const buttons =
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
              );


            await sendMessage(

              botId,

              requestId,

              "Не удалось определить выбранный замер.",

              buttons,

              receiverUserId

            );


            return;
          }


          // Показываем подробную информацию

          await sendMessage(

            botId,

            requestId,

            measurementDetails(
              selected
            ),

            null,

            receiverUserId

          );


          sessions.delete(
            requestId
          );


          await returnControl(

            botId,

            requestId,

            "success"

          );


          return;
        }
      }

    } catch (error) {

      console.error(
        "WEBHOOK ERROR:",
        error.message
      );

      console.error(
        "DETAILS:",
        error.details || ""
      );
    }
  }
);


// ============================================================
// ВИДЖЕТ
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(`
      <!doctype html>

      <html>

      <head>

        <meta charset="utf-8">

        <title>
          Отчёт инженеров
        </title>

      </head>

      <body
        style="
          font-family:Arial;
          padding:20px;
        "
      >

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


app.post(
  "/",
  (req, res) => {

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


    res.send(`
      <!doctype html>

      <html>

      <head>

        <meta charset="utf-8">

      </head>

      <body
        style="
          font-family:Arial;
          padding:20px;
        "
      >

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
// DEBUG: amoCRM
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
          account.subdomain

      });

    } catch (error) {

      res
        .status(500)
        .json({

          status:
            "Ошибка",

          message:
            error.message,

          details:
            error.details || null

        });
    }
  }
);


// ============================================================
// DEBUG: ЗАДАЧИ
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {

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
            ENGINEER_ENUM_ID

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
            )

        },

        tasks_loaded:
          result.tasksLoaded,

        valid_tasks:
          result.validTasks,

        found_count:
          result.measurements.length,

        measurements:
          result.measurements

      });

    } catch (error) {

      res
        .status(500)
        .json({

          status:
            "Ошибка",

          message:
            error.message,

          details:
            error.details || null

        });
    }
  }
);


// ============================================================
// DEBUG: ОТДЕЛЬНАЯ ЗАДАЧА
// ============================================================

app.get(
  "/debug/task-test/:id",
  async (req, res) => {

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
        getDateRange();


      const completeTill =
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
            )

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
            TASK_TYPE_ID,

          not_completed:
            task.is_completed === false ||
            task.is_completed === 0 ||
            task.is_completed === "0",

          date:
            Number.isFinite(
              completeTill
            ) &&
            completeTill >=
              range.from &&
            completeTill <=
              range.to

        }

      });

    } catch (error) {

      res
        .status(500)
        .json({

          status:
            "Ошибка",

          message:
            error.message,

          details:
            error.details || null

        });
    }
  }
);


// ============================================================
// DEBUG: СДЕЛКА
// ============================================================

app.get(
  "/debug/lead-test/:id",
  async (req, res) => {

    try {

      const leadId =
        Number(
          req.params.id
        );


      const lead =
        await amocrmRequest(
          `/api/v4/leads/${leadId}?with=contacts`
        );


      res.json({

        status:
          "OK",

        lead_id:
          lead.id,

        lead_name:
          lead.name,

        is_marina:
          isMarina(lead),

        engineer_field:
          getField(
            lead,
            ENGINEER_FIELD_ID
          ),

        contract_number:
          getTextField(
            lead,
            FIELD_IDS.contractNumber
          ),

        measure_date:
          getDateField(
            lead,
            FIELD_IDS.measureDate
          ),

        measure_time:
          getTextField(
            lead,
            FIELD_IDS.measureTime
          ),

        address:
          getTextField(
            lead,
            FIELD_IDS.measureAddress
          ),

        product:
          getTextField(
            lead,
            FIELD_IDS.product
          ),

        link:
          getLeadLink(
            lead.id
          ),

        contacts:
          lead
            ?._embedded
            ?.contacts ||
          []

      });

    } catch (error) {

      res
        .status(500)
        .json({

          status:
            "Ошибка",

          message:
            error.message,

          details:
            error.details || null

        });
    }
  }
);


// ============================================================
// ПОСЛЕДНИЕ ЗАПРОСЫ
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
// ЗАПУСК
// ============================================================

const PORT =
  process.env.PORT || 3000;


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
      "ENGINEER ENUM ID:",
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
