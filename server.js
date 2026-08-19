const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

const AMOCRM_SUBDOMAIN = "zlmk";

const AMOCRM_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

const AMOMESSENGER_CLIENT_ID = process.env.AMOMESSENGER_CLIENT_ID;
const AMOMESSENGER_CLIENT_SECRET = process.env.AMOMESSENGER_CLIENT_SECRET;

const AMOMESSENGER_REDIRECT_URI =
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

const AMOMESSENGER_TOKEN_URL =
  "https://id.amo.tm/oauth2/access_token";

const AMOMESSENGER_VALIDATE_URL =
  "https://id.amo.tm/oauth2/validate";

const AMOMESSENGER_API =
  "https://api.amo.tm";

// ============================================================
// ДАННЫЕ БОТА / WIDGET
// ============================================================

const WIDGET_ID =
  "3340f4cd-964a-11f1-a0b2-eebcee06a940";

// ============================================================
// НАСТРОЙКИ ЗАДАЧ
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Московское время.
// Используем стандартный Intl, поэтому дополнительная
// библиотека luxon НЕ нужна.
// ============================================================


// ============================================================
// ВРЕМЕННОЕ ХРАНИЛИЩЕ ТОКЕНА AMOMESSENGER
// ============================================================

let amoMessengerTokens = {
  access_token: null,
  refresh_token: null
};


// ============================================================
// ОБЩИЕ ФУНКЦИИ
// ============================================================

function logSeparator() {
  console.log("==========================================");
}


function getMoscowDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(date);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}


function formatMoscowDate(date = new Date()) {
  const p = getMoscowDateParts(date);

  return `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}


function getMoscowTimestamp(date = new Date()) {
  const p = getMoscowDateParts(date);

  const utcEquivalent = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );

  // Москва UTC+3
  return Math.floor((utcEquivalent - 3 * 60 * 60 * 1000) / 1000);
}


function getTodayMoscowStartTimestamp() {
  const p = getMoscowDateParts();

  const utcEquivalent = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    0,
    0,
    0
  );

  return Math.floor((utcEquivalent - 3 * 60 * 60 * 1000) / 1000);
}


function getYesterdayMoscowStartTimestamp() {
  return getTodayMoscowStartTimestamp() - 24 * 60 * 60;
}


// ============================================================
// AMOMESSENGER TOKEN
// ============================================================

function getMessengerAccessToken() {
  if (
    amoMessengerTokens.access_token &&
    amoMessengerTokens.access_token.trim()
  ) {
    return amoMessengerTokens.access_token;
  }

  return null;
}


// ============================================================
// AMOMESSENGER API
// ============================================================

async function messengerRequest(method, url, body = null) {
  const token = getMessengerAccessToken();

  if (!token) {
    throw new Error("Токен amoMessenger не найден");
  }

  console.log(`amoMessenger ${method}: ${url}`);

  if (body) {
    console.log("BODY:", JSON.stringify(body, null, 2));
  }

  try {
    const response = await axios({
      method,
      url,
      data: body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

    console.log(
      "amoMessenger response:",
      response.status,
      response.data
    );

    if (response.status >= 400) {
      throw new Error(
        `amoMessenger HTTP ${response.status}`
      );
    }

    return response;
  } catch (error) {
    console.error(
      "amoMessenger ERROR:",
      error.message
    );

    throw error;
  }
}


// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В БОТ
// ============================================================

async function sendMessengerMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  replyMarkup = null
) {
  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}` +
    `/request/${requestId}/sendMessage`;

  const body = {
    text,
    receiver: {
      user_id: receiverUserId
    }
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  return messengerRequest("POST", url, body);
}


// ============================================================
// RETURN CONTROL
// ============================================================

async function returnControl(botId, requestId) {
  const url =
    `${AMOMESSENGER_API}/v1.3/bots/${botId}` +
    `/request/${requestId}/returnControl`;

  return messengerRequest("POST", url, {
    return_code: "success"
  });
}


// ============================================================
// AMOCRM API
// ============================================================

async function amoCrmGet(url) {
  if (!AMOCRM_ACCESS_TOKEN) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  console.log("amoCRM GET:", url);

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization:
          `Bearer ${AMOCRM_ACCESS_TOKEN}`,
        Accept: "application/hal+json"
      },
      timeout: 60000,
      validateStatus: () => true
    });

    console.log(
      "amoCRM response:",
      response.status
    );

    if (response.status === 204) {
      return {
        status: 204,
        data: null
      };
    }

    if (response.status >= 400) {
      console.error(
        "amoCRM ERROR BODY:",
        response.data
      );

      throw new Error(
        `amoCRM HTTP ${response.status}`
      );
    }

    return {
      status: response.status,
      data: response.data
    };
  } catch (error) {
    console.error(
      "amoCRM request error:",
      error.message
    );

    throw error;
  }
}


// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ЗАДАЧ ЗА ПЕРИОД
//
// ВАЖНО:
// Здесь специально НЕ передаем в URL:
//   filter[is_completed]
//   filter[task_type]
//
// Потому что именно комбинация этих фильтров у вас приводит
// к 204, хотя задача существует.
//
// Получаем задачи по entity_type + complete_till,
// а затем фильтруем их в JavaScript.
// ============================================================

async function loadTasks(fromTimestamp, toTimestamp) {
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
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks?` +
      params.toString();

    console.log(
      "Запрос задач:",
      params.toString()
    );

    const result = await amoCrmGet(url);

    if (
      result.status === 204 ||
      !result.data ||
      !result.data._embedded ||
      !Array.isArray(result.data._embedded.tasks)
    ) {
      console.log(
        `Страница задач ${page}: 0`
      );

      break;
    }

    const tasks =
      result.data._embedded.tasks;

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    if (page > 20) {
      console.log(
        "Остановлено после 20 страниц задач"
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
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(leadId) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}` +
    `?with=contacts`;

  const result = await amoCrmGet(url);

  if (
    !result.data ||
    !result.data.id
  ) {
    return null;
  }

  return result.data;
}


// ============================================================
// ПОЛУЧЕНИЕ ПОЛЯ ИНЖЕНЕРА
// ============================================================

function getEngineerField(lead) {
  if (
    !lead ||
    !Array.isArray(lead.custom_fields_values)
  ) {
    return null;
  }

  return lead.custom_fields_values.find(
    field =>
      Number(field.field_id) ===
      ENGINEER_FIELD_ID
  );
}


// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function leadBelongsToEngineer(lead) {
  const field = getEngineerField(lead);

  if (!field) {
    return false;
  }

  if (
    !Array.isArray(field.values)
  ) {
    return false;
  }

  return field.values.some(value => {
    const enumId =
      value.enum_id != null
        ? Number(value.enum_id)
        : null;

    const text =
      value.value != null
        ? String(value.value).trim()
        : "";

    if (
      enumId !== null &&
      enumId === Number(ENGINEER_ENUM_ID)
    ) {
      return true;
    }

    if (
      text &&
      text.toLowerCase() ===
      ENGINEER_NAME.toLowerCase()
    ) {
      return true;
    }

    return false;
  });
}


// ============================================================
// ПОЛУЧЕНИЕ НАЗВАНИЯ ЗАДАЧИ
// ============================================================

function getTaskText(task) {
  if (!task) {
    return "";
  }

  return (
    task.text ||
    task.name ||
    task.task_text ||
    ""
  );
}


// ============================================================
// ПРОВЕРКА ЗАДАЧИ
// ============================================================

function isValidMeasurementTask(task) {
  if (!task) {
    return false;
  }

  // ----------------------------------------------------------
  // 1. Сущность должна быть сделкой
  // ----------------------------------------------------------

  if (
    task.entity_type &&
    task.entity_type !== "leads"
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // 2. Тип задачи
  // ----------------------------------------------------------

  const taskTypeId =
    task.task_type_id != null
      ? Number(task.task_type_id)
      : null;

  if (
    taskTypeId !==
    Number(MEASUREMENT_TASK_TYPE_ID)
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // 3. Задача должна быть НЕ выполнена
  // ----------------------------------------------------------

  if (
    task.is_completed === true ||
    task.is_completed === 1 ||
    task.is_completed === "1"
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // 4. Дата задачи
  //
  // Дополнительная проверка на всякий случай.
  // ----------------------------------------------------------

  const completeTill =
    Number(task.complete_till);

  if (
    !Number.isFinite(completeTill)
  ) {
    return false;
  }

  const from =
    getYesterdayMoscowStartTimestamp();

  const to =
    getMoscowTimestamp();

  if (
    completeTill < from ||
    completeTill > to
  ) {
    return false;
  }

  return true;
}


// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurements() {
  logSeparator();
  console.log("ПОИСК ЗАМЕРОВ");

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

  logSeparator();

  const now = new Date();

  const nowTimestamp =
    getMoscowTimestamp(now);

  const fromTimestamp =
    getYesterdayMoscowStartTimestamp();

  console.log(
    "Диапазон:",
    formatMoscowDate(
      new Date(
        (fromTimestamp + 3 * 60 * 60) * 1000
      )
    ),
    "->",
    formatMoscowDate(now)
  );

  // ----------------------------------------------------------
  // Загружаем задачи БЕЗ фильтра типа задачи
  // и без фильтра is_completed
  // ----------------------------------------------------------

  const tasks =
    await loadTasks(
      fromTimestamp,
      nowTimestamp
    );

  // ----------------------------------------------------------
  // Сначала фильтруем задачи локально
  // ----------------------------------------------------------

  const validTasks =
    tasks.filter(
      isValidMeasurementTask
    );

  console.log(
    "Найдено задач нужного типа:",
    validTasks.length
  );

  // ----------------------------------------------------------
  // Теперь получаем сделки и проверяем инженера
  // ----------------------------------------------------------

  const measurements = [];

  for (const task of validTasks) {
    try {
      const leadId =
        Number(task.entity_id);

      if (!leadId) {
        console.log(
          "У задачи нет entity_id:",
          task.id
        );

        continue;
      }

      console.log(
        "Проверяем сделку:",
        leadId,
        "для задачи:",
        task.id
      );

      const lead =
        await getLead(leadId);

      if (!lead) {
        console.log(
          "Сделка не получена:",
          leadId
        );

        continue;
      }

      const belongs =
        leadBelongsToEngineer(lead);

      console.log(
        "Инженер в сделке:",
        belongs
      );

      if (!belongs) {
        continue;
      }

      measurements.push({
        task_id: task.id,
        lead_id: lead.id,
        lead_name:
          lead.name ||
          `Сделка #${lead.id}`,
        task_text:
          getTaskText(task),
        complete_till:
          task.complete_till,
        complete_till_moscow:
          task.complete_till
            ? formatMoscowDate(
                new Date(
                  Number(task.complete_till) * 1000
                )
              )
            : null
      });
    } catch (error) {
      console.error(
        "Ошибка обработки задачи:",
        task.id,
        error.message
      );
    }
  }

  logSeparator();

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  logSeparator();

  return {
    measurements,
    tasksLoaded: tasks.length,
    validTasks: validTasks.length,
    foundCount: measurements.length
  };
}


// ============================================================
// DEBUG
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "amoMessenger bot",
    timezone: "Europe/Moscow"
  });
});


// ============================================================
// DEBUG TOKEN AMOMESSENGER
// ============================================================

app.get(
  "/debug/messenger-token",
  async (req, res) => {
    res.json({
      status: getMessengerAccessToken()
        ? "Токен найден"
        : "Токен не найден",
      access_token:
        getMessengerAccessToken()
          ? "ДА"
          : "НЕТ",
      refresh_token:
        amoMessengerTokens.refresh_token
          ? "ДА"
          : "НЕТ"
    });
  }
);


// ============================================================
// DEBUG TASKS
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {
    try {
      const result =
        await findMeasurements();

      const now =
        new Date();

      res.json({
        status: "OK",
        timezone: "Europe/Moscow",
        current_moscow_time:
          formatMoscowDate(now),

        engineer: {
          name: ENGINEER_NAME,
          field_id: ENGINEER_FIELD_ID,
          enum_id: ENGINEER_ENUM_ID
        },

        task_type_id:
          MEASUREMENT_TASK_TYPE_ID,

        date_mode:
          "до 18:00",

        date_range: {
          from:
            formatMoscowDate(
              new Date(
                (getYesterdayMoscowStartTimestamp() +
                  3 * 60 * 60) *
                  1000
              )
            ),

          to:
            formatMoscowDate(now)
        },

        tasks_loaded:
          result.tasksLoaded,

        valid_tasks:
          result.validTasks,

        found_count:
          result.foundCount,

        measurements:
          result.measurements
      });
    } catch (error) {
      console.error(
        "DEBUG ERROR:",
        error
      );

      res.status(500).json({
        status: "Ошибка",
        message: error.message
      });
    }
  }
);


// ============================================================
// OAUTH AMOMESSENGER
// ============================================================

app.get(
  "/oauth/amomessenger/start",
  (req, res) => {
    if (
      !AMOMESSENGER_CLIENT_ID
    ) {
      return res.status(500).send(
        "AMOMESSENGER_CLIENT_ID не задан"
      );
    }

    const url =
      "https://id.amo.tm/oauth2/authorize" +
      `?client_id=${encodeURIComponent(
        AMOMESSENGER_CLIENT_ID
      )}` +
      `&redirect_uri=${encodeURIComponent(
        AMOMESSENGER_REDIRECT_URI
      )}` +
      "&response_type=code";

    console.log(
      "OAuth start:",
      url
    );

    res.redirect(url);
  }
);


// ============================================================
// OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    console.log("==========================================");
    console.log("OAUTH AMOMESSENGER");

    const code =
      req.query.code;

    if (!code) {
      console.error(
        "Код авторизации не получен"
      );

      return res.status(400).send(`
        <h2>Ошибка OAuth</h2>
        <p>Код авторизации не получен.</p>
      `);
    }

    if (
      !AMOMESSENGER_CLIENT_ID ||
      !AMOMESSENGER_CLIENT_SECRET
    ) {
      return res.status(500).send(`
        <h2>Ошибка OAuth</h2>
        <p>
          Не заданы AMOMESSENGER_CLIENT_ID
          или AMOMESSENGER_CLIENT_SECRET
          в Environment Variables.
        </p>
      `);
    }

    try {
      console.log(
        "Обмениваем authorization code на token"
      );

      console.log(
        "Token URL:",
        AMOMESSENGER_TOKEN_URL
      );

      console.log(
        "Redirect URI:",
        AMOMESSENGER_REDIRECT_URI
      );

      const response =
        await axios.post(
          AMOMESSENGER_TOKEN_URL,
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
                "application/json",
              Accept:
                "application/json"
            },
            timeout: 30000,
            validateStatus:
              () => true
          }
        );

      console.log(
        "OAuth HTTP:",
        response.status
      );

      if (
        response.status < 200 ||
        response.status >= 300
      ) {
        console.error(
          "OAuth ERROR:",
          response.data
        );

        return res.status(
          response.status
        ).send(`
          <h2>Ошибка авторизации amoMessenger</h2>
          <pre>${escapeHtml(
            JSON.stringify(
              response.data,
              null,
              2
            )
          )}</pre>
        `);
      }

      const data =
        response.data;

      if (!data.access_token) {
        return res.status(500).send(`
          <h2>Ошибка OAuth</h2>
          <p>Access Token не получен.</p>
          <pre>${escapeHtml(
            JSON.stringify(
              data,
              null,
              2
            )
          )}</pre>
        `);
      }

      amoMessengerTokens =
        {
          access_token:
            data.access_token,

          refresh_token:
            data.refresh_token ||
            null
        };

      console.log(
        "amoMessenger токены сохранены."
      );

      // --------------------------------------------------------
      // Проверяем токен
      // --------------------------------------------------------

      try {
        const validate =
          await axios.get(
            AMOMESSENGER_VALIDATE_URL,
            {
              headers: {
                Authorization:
                  `Bearer ${data.access_token}`
              },
              timeout: 30000,
              validateStatus:
                () => true
            }
          );

        console.log(
          "OAuth validate:",
          validate.status,
          validate.data
        );
      } catch (validateError) {
        console.error(
          "OAuth validate ERROR:",
          validateError.message
        );
      }

      console.log(
        "=========================================="
      );

      return res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="UTF-8">
          <title>OAuth amoMessenger</title>
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

          <hr>

          <p>
            Access Token получен:
            <b>ДА</b>
          </p>

          <p>
            Refresh Token получен:
            <b>${
              data.refresh_token
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>
        </body>
        </html>
      `);
    } catch (error) {
      console.error(
        "OAuth exception:",
        error
      );

      return res.status(500).send(`
        <h2>Ошибка OAuth</h2>
        <pre>${escapeHtml(
          error.message
        )}</pre>
      `);
    }
  }
);


// ============================================================
// ЭКРАНИРОВАНИЕ HTML
// ============================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


// ============================================================
// AMOMESSENGER WEBHOOK
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
    logSeparator();

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

    logSeparator();

    // Отвечаем amoMessenger сразу,
    // чтобы webhook не ждал выполнения
    // длинного запроса к amoCRM.
    res.status(200).json({
      status: "ok"
    });

    try {
      await processMessengerWebhook(
        req.body
      );
    } catch (error) {
      console.error(
        "WEBHOOK PROCESS ERROR:",
        error
      );
    }
  }
);


// ============================================================
// ОБРАБОТКА WEBHOOK
// ============================================================

async function processMessengerWebhook(body) {
  const eventType =
    body.event_type;

  // ----------------------------------------------------------
  // CONTROL TRANSFERRED
  // ----------------------------------------------------------

  if (
    eventType ===
    "rpa_bot_control_transferred"
  ) {
    const transferred =
      body?._embedded
        ?.rpa_bot_control_transferred;

    const botId =
      transferred?.bot_id;

    const requestId =
      transferred?._embedded
        ?.request?.id;

    const contextUserId =
      transferred?._embedded
        ?.context?.user_id;

    const requestAuthorId =
      transferred?._embedded
        ?.request?.author_id;

    const responsibleId =
      transferred?._embedded
        ?.request?.responsible_id;

    const receiverUserId =
      requestAuthorId ||
      responsibleId ||
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
          requestAuthorId,
          responsibleId
        },
        null,
        2
      )
    );

    if (
      !botId ||
      !requestId ||
      !receiverUserId
    ) {
      console.error(
        "Не хватает данных для отправки сообщения"
      );

      return;
    }

    await sendMessengerMessage(
      botId,
      requestId,
      receiverUserId,
      "Выберите задачу для выполнения:",
      {
        inline_keyboard: {
          buttons: [
            {
              text:
                "Подтвердить замер"
            },
            {
              text:
                "Провести замер"
            },
            {
              text:
                "Загрузить фотоотчет"
            },
            {
              text:
                "Внести правки"
            }
          ]
        }
      }
    );

    return;
  }


  // ----------------------------------------------------------
  // INCOME MESSAGE
  // ----------------------------------------------------------

  if (
    eventType ===
    "rpa_bot_income_message"
  ) {
    const income =
      body?._embedded
        ?.rpa_bot_income_message;

    const botId =
      income?.bot_id;

    const request =
      income?._embedded
        ?.request;

    const requestId =
      request?.id;

    const receiverUserId =
      income?._embedded
        ?.income_message
        ?.author
        ?.user_id;

    const text =
      income?._embedded
        ?.income_message
        ?.text
        ?.trim();

    console.log(
      "Получено сообщение:",
      text
    );

    console.log(
      "requestId:",
      requestId
    );

    console.log(
      "receiverUserId:",
      receiverUserId
    );

    if (
      !botId ||
      !requestId ||
      !receiverUserId
    ) {
      console.error(
        "Недостаточно данных webhook"
      );

      return;
    }

    // --------------------------------------------------------
    // ПОДТВЕРДИТЬ ЗАМЕР
    // --------------------------------------------------------

    if (
      text ===
      "Подтвердить замер"
    ) {
      console.log(
        "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
      );

      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        "⏳ Проверяю задачи на подтверждение замера..."
      );

      try {
        const result =
          await findMeasurements();

        if (
          result.measurements.length === 0
        ) {
          await sendMessengerMessage(
            botId,
            requestId,
            receiverUserId,
            "📋 Замеров для подтверждения не найдено."
          );
        } else {
          let message =
            "📋 Найдены замеры для подтверждения:\n\n";

          result.measurements.forEach(
            (item, index) => {
              message +=
                `${index + 1}. ` +
                `${item.lead_name}\n`;

              message +=
                `Задача: ${item.task_id}\n`;

              if (
                item.complete_till_moscow
              ) {
                message +=
                  `Срок: ${item.complete_till_moscow}\n`;
              }

              if (
                item.task_text
              ) {
                message +=
                  `Комментарий: ${item.task_text}\n`;
              }

              message += "\n";
            }
          );

          await sendMessengerMessage(
            botId,
            requestId,
            receiverUserId,
            message
          );
        }
      } catch (error) {
        console.error(
          "Ошибка поиска замеров:",
          error
        );

        await sendMessengerMessage(
          botId,
          requestId,
          receiverUserId,
          "❌ Произошла ошибка при проверке задач. Попробуйте ещё раз."
        );
      }

      console.log(
        "Возвращаем управление amoMessenger..."
      );

      try {
        await returnControl(
          botId,
          requestId
        );

        console.log(
          "Управление возвращено amoMessenger"
        );
      } catch (error) {
        console.error(
          "Ошибка возврата управления:",
          error.message
        );
      }

      return;
    }


    // --------------------------------------------------------
    // ДРУГИЕ КНОПКИ
    // --------------------------------------------------------

    if (
      text ===
      "Провести замер"
    ) {
      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        "Функция «Провести замер» пока находится в разработке."
      );

      await returnControl(
        botId,
        requestId
      );

      return;
    }


    if (
      text ===
      "Загрузить фотоотчет"
    ) {
      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        "Функция «Загрузить фотоотчет» пока находится в разработке."
      );

      await returnControl(
        botId,
        requestId
      );

      return;
    }


    if (
      text ===
      "Внести правки"
    ) {
      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        "Функция «Внести правки» пока находится в разработке."
      );

      await returnControl(
        botId,
        requestId
      );

      return;
    }

    console.log(
      "Неизвестное сообщение:",
      text
    );
  }
}


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      `Server started on port ${PORT}`
    );

    console.log(
      "Timezone: Europe/Moscow"
    );

    console.log(
      "amoCRM:",
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru`
    );

    console.log(
      "amoMessenger OAuth:",
      AMOMESSENGER_REDIRECT_URI
    );

    console.log(
      "AMOCRM_ACCESS_TOKEN:",
      AMOCRM_ACCESS_TOKEN
        ? "ЗАДАН"
        : "НЕ ЗАДАН"
    );

    console.log(
      "AMOMESSENGER_CLIENT_ID:",
      AMOMESSENGER_CLIENT_ID
        ? "ЗАДАН"
        : "НЕ ЗАДАН"
    );

    console.log(
      "AMOMESSENGER_CLIENT_SECRET:",
      AMOMESSENGER_CLIENT_SECRET
        ? "ЗАДАН"
        : "НЕ ЗАДАН"
    );

    console.log(
      "=========================================="
    );
  }
);
