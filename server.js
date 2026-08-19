const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

// ---------------- AMOCRM ----------------

const AMOCRM_SUBDOMAIN = "zlmk";

const AMOCRM_CLIENT_ID =
  process.env.AMOCRM_CLIENT_ID || "";

const AMOCRM_CLIENT_SECRET =
  process.env.AMOCRM_CLIENT_SECRET || "";

const AMOCRM_REDIRECT_URI =
  process.env.AMOCRM_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amocrm/callback";

// ---------------- AMOMESSENGER ----------------

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

// ============================================================
// ТОКЕНЫ
// ============================================================

// ВАЖНО:
// Эти переменные можно задать в Render Environment Variables.
// Если токен получен через OAuth ниже, он также сохраняется
// в памяти работающего сервера.

let amoCrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amoCrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

let amoMessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amoMessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

// ============================================================
// ПОСТОЯННЫЕ ЗНАЧЕНИЯ ПРОЕКТА
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

const MEASUREMENT_TASK_NAME = "Подтвердить замер";

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function log(title, data = null) {
  console.log("==========================================");
  console.log(title);

  if (data !== null) {
    if (typeof data === "object") {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data);
    }
  }

  console.log("==========================================");
}

function getMoscowNow() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second)
  };
}

function formatMoscowDate(moscow) {
  return (
    String(moscow.day).padStart(2, "0") +
    "." +
    String(moscow.month).padStart(2, "0") +
    "." +
    moscow.year +
    ", " +
    String(moscow.hour).padStart(2, "0") +
    ":" +
    String(moscow.minute).padStart(2, "0") +
    ":" +
    String(moscow.second).padStart(2, "0")
  );
}

function getMoscowDateStartUnix() {
  const m = getMoscowNow();

  // Москва = UTC+3
  const utcMillis = Date.UTC(
    m.year,
    m.month - 1,
    m.day,
    0,
    0,
    0
  ) - 3 * 60 * 60 * 1000;

  return Math.floor(utcMillis / 1000);
}

function getCurrentUnix() {
  return Math.floor(Date.now() / 1000);
}

function getMoscowDateRange() {
  const m = getMoscowNow();

  const from = getMoscowDateStartUnix();

  const to = getCurrentUnix();

  return {
    from,
    to,
    from_text:
      String(m.day - 1).padStart(2, "0") +
      "." +
      String(m.month).padStart(2, "0") +
      "." +
      m.year +
      ", 00:00:00",
    to_text: formatMoscowDate(m)
  };
}

// ============================================================
// AMOCRM API
// ============================================================

async function amoCrmRequest(method, url, options = {}) {
  if (!amoCrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан. Сначала выполните OAuth amoCRM."
    );
  }

  try {
    const response = await axios({
      method,
      url,
      headers: {
        Authorization: `Bearer ${amoCrmAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/hal+json"
      },
      ...options
    });

    return response;
  } catch (error) {
    if (error.response) {
      console.log("amoCRM ERROR:");
      console.log("HTTP:", error.response.status);
      console.log(
        JSON.stringify(error.response.data, null, 2)
      );

      // Если токен протух — пробуем обновить
      if (
        error.response.status === 401 &&
        amoCrmRefreshToken
      ) {
        console.log("Пробуем обновить amoCRM token...");

        const refreshed = await refreshAmoCrmToken();

        if (refreshed) {
          return axios({
            method,
            url,
            headers: {
              Authorization: `Bearer ${amoCrmAccessToken}`,
              "Content-Type": "application/json",
              Accept: "application/hal+json"
            },
            ...options
          });
        }
      }

      throw new Error(
        `amoCRM HTTP ${error.response.status}`
      );
    }

    throw error;
  }
}

// ============================================================
// AMOCRM OAUTH
// ============================================================

function refreshAmoCrmToken() {
  return new Promise(async (resolve) => {
    try {
      if (
        !AMOCRM_CLIENT_ID ||
        !AMOCRM_CLIENT_SECRET ||
        !amoCrmRefreshToken
      ) {
        console.log(
          "Недостаточно данных для refresh amoCRM token"
        );

        resolve(false);
        return;
      }

      const response = await axios.post(
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`,
        {
          client_id: AMOCRM_CLIENT_ID,
          client_secret: AMOCRM_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: amoCrmRefreshToken,
          redirect_uri: AMOCRM_REDIRECT_URI
        },
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      amoCrmAccessToken =
        response.data.access_token || "";

      amoCrmRefreshToken =
        response.data.refresh_token ||
        amoCrmRefreshToken;

      console.log(
        "amoCRM токен успешно обновлен"
      );

      console.log(
        "Access Token:",
        amoCrmAccessToken ? "ДА" : "НЕТ"
      );

      console.log(
        "Refresh Token:",
        amoCrmRefreshToken ? "ДА" : "НЕТ"
      );

      resolve(true);
    } catch (error) {
      console.log(
        "Ошибка обновления amoCRM token"
      );

      if (error.response) {
        console.log(
          error.response.status,
          error.response.data
        );
      } else {
        console.log(error.message);
      }

      resolve(false);
    }
  });
}

// ============================================================
// AMOMESSENGER API
// ============================================================

async function amoMessengerRequest(
  method,
  url,
  data = null
) {
  if (!amoMessengerAccessToken) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  try {
    const response = await axios({
      method,
      url,
      data,
      headers: {
        Authorization:
          `Bearer ${amoMessengerAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    return response;
  } catch (error) {
    if (error.response) {
      console.log(
        "amoMessenger ERROR:",
        error.response.status,
        error.response.data
      );
    }

    throw error;
  }
}

// ============================================================
// AMOMESSENGER OAUTH
// ============================================================

app.get(
  "/oauth/amomessenger",
  (req, res) => {
    if (
      !AMOMESSENGER_CLIENT_ID
    ) {
      return res.status(500).send(
        "Не задан AMOMESSENGER_CLIENT_ID"
      );
    }

    const url =
      "https://id.amo.tm/oauth2/authorize" +
      `?client_id=${encodeURIComponent(
        AMOMESSENGER_CLIENT_ID
      )}` +
      "&response_type=code" +
      `&redirect_uri=${encodeURIComponent(
        AMOMESSENGER_REDIRECT_URI
      )}`;

    res.redirect(url);
  }
);

// ------------------------------------------------------------

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    try {
      const code = req.query.code;

      log(
        "OAUTH AMOMESSENGER",
        {
          code_received: !!code
        }
      );

      if (!code) {
        return res.status(400).send(`
          <h2>Ошибка OAuth amoMessenger</h2>
          <p>Код авторизации не получен.</p>
        `);
      }

      console.log(
        "Обмениваем authorization code на token"
      );

      const response = await axios.post(
        "https://id.amo.tm/oauth2/access_token",
        {
          client_id: AMOMESSENGER_CLIENT_ID,
          client_secret:
            AMOMESSENGER_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri:
            AMOMESSENGER_REDIRECT_URI
        },
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );

      amoMessengerAccessToken =
        response.data.access_token || "";

      amoMessengerRefreshToken =
        response.data.refresh_token || "";

      console.log(
        "amoMessenger токены сохранены."
      );

      console.log(
        "Access Token получен:",
        amoMessengerAccessToken
          ? "ДА"
          : "НЕТ"
      );

      console.log(
        "Refresh Token получен:",
        amoMessengerRefreshToken
          ? "ДА"
          : "НЕТ"
      );

      res.send(`
        <html>
        <body style="font-family:Arial;padding:30px">
          <h2>Авторизация amoMessenger успешно выполнена</h2>
          <p>Токен сохранён на сервере.</p>
          <p>Теперь можно закрыть это окно и снова запустить бота.</p>
          <p>
            Access Token получен:
            <b>${
              amoMessengerAccessToken
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>
          <p>
            Refresh Token получен:
            <b>${
              amoMessengerRefreshToken
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>
        </body>
        </html>
      `);
    } catch (error) {
      console.log(
        "OAuth amoMessenger ERROR"
      );

      if (error.response) {
        console.log(
          error.response.status,
          error.response.data
        );
      } else {
        console.log(error.message);
      }

      res.status(500).send(`
        <h2>Ошибка авторизации amoMessenger</h2>
        <pre>${JSON.stringify(
          error.response
            ? error.response.data
            : error.message,
          null,
          2
        )}</pre>
      `);
    }
  }
);

// ============================================================
// AMOCRM OAUTH
// ============================================================

app.get(
  "/oauth/amocrm",
  (req, res) => {
    if (!AMOCRM_CLIENT_ID) {
      return res.status(500).send(`
        <h2>Ошибка</h2>
        <p>AMOCRM_CLIENT_ID не задан в Render.</p>
      `);
    }

    const url =
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth` +
      `?client_id=${encodeURIComponent(
        AMOCRM_CLIENT_ID
      )}` +
      "&response_type=code" +
      `&redirect_uri=${encodeURIComponent(
        AMOCRM_REDIRECT_URI
      )}`;

    console.log(
      "AMOCRM OAuth URL:",
      url
    );

    res.redirect(url);
  }
);

// ------------------------------------------------------------

app.get(
  "/oauth/amocrm/callback",
  async (req, res) => {
    try {
      const code = req.query.code;

      log(
        "OAUTH AMOCRM CALLBACK",
        {
          code_received: !!code
        }
      );

      if (!code) {
        return res.status(400).send(`
          <h2>Ошибка OAuth amoCRM</h2>
          <p>Код авторизации не получен.</p>
        `);
      }

      console.log(
        "Обмениваем authorization code amoCRM на token"
      );

      const response = await axios.post(
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`,
        {
          client_id:
            AMOCRM_CLIENT_ID,
          client_secret:
            AMOCRM_CLIENT_SECRET,
          grant_type:
            "authorization_code",
          code,
          redirect_uri:
            AMOCRM_REDIRECT_URI
        },
        {
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );

      amoCrmAccessToken =
        response.data.access_token || "";

      amoCrmRefreshToken =
        response.data.refresh_token || "";

      console.log(
        "amoCRM токены получены"
      );

      console.log(
        "Access Token:",
        amoCrmAccessToken
          ? "ДА"
          : "НЕТ"
      );

      console.log(
        "Refresh Token:",
        amoCrmRefreshToken
          ? "ДА"
          : "НЕТ"
      );

      res.send(`
        <html>
        <body style="font-family:Arial;padding:30px">
          <h2>Авторизация amoCRM успешно выполнена</h2>

          <p>
            Access Token получен:
            <b>${
              amoCrmAccessToken
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>

          <p>
            Refresh Token получен:
            <b>${
              amoCrmRefreshToken
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>

          <p>
            Теперь можно закрыть это окно
            и запустить бота.
          </p>
        </body>
        </html>
      `);
    } catch (error) {
      console.log(
        "OAuth amoCRM ERROR"
      );

      if (error.response) {
        console.log(
          "HTTP:",
          error.response.status
        );

        console.log(
          error.response.data
        );
      } else {
        console.log(error.message);
      }

      res.status(500).send(`
        <h2>Ошибка авторизации amoCRM</h2>
        <pre>${JSON.stringify(
          error.response
            ? error.response.data
            : error.message,
          null,
          2
        )}</pre>
      `);
    }
  }
);

// ============================================================
// ПРОВЕРКА СОСТОЯНИЯ
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "OK",
      service:
        "amoMessenger bot",
      timezone:
        "Europe/Moscow",
      amoMessengerToken:
        amoMessengerAccessToken
          ? "OK"
          : "НЕТ",
      amoCrmToken:
        amoCrmAccessToken
          ? "OK"
          : "НЕТ"
    });
  }
);

// ============================================================
// ПРОВЕРКА AMOCRM TOKEN
// ============================================================

app.get(
  "/debug/amocrm-token",
  async (req, res) => {
    try {
      if (!amoCrmAccessToken) {
        return res.json({
          status: "Ошибка",
          message:
            "AMOCRM_ACCESS_TOKEN не задан"
        });
      }

      const response =
        await amoCrmRequest(
          "GET",
          `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/account`
        );

      res.json({
        status: "OK",
        account: response.data
      });
    } catch (error) {
      res.status(500).json({
        status: "Ошибка",
        message: error.message
      });
    }
  }
);

// ============================================================
// ПРОВЕРКА КОНКРЕТНОЙ ЗАДАЧИ
// ============================================================

app.get(
  "/debug/task/:taskId",
  async (req, res) => {
    try {
      const taskId =
        Number(req.params.taskId);

      if (!taskId) {
        return res.status(400).json({
          status: "Ошибка",
          message:
            "Неверный taskId"
        });
      }

      const response =
        await amoCrmRequest(
          "GET",
          `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks/${taskId}`
        );

      const task =
        response.data;

      res.json({
        status: "OK",
        task_id: task.id,
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
          task.complete_till
            ? new Date(
                task.complete_till *
                  1000
              ).toLocaleString(
                "ru-RU",
                {
                  timeZone:
                    "Europe/Moscow"
                }
              )
            : null,
        raw: task
      });
    } catch (error) {
      res.status(500).json({
        status: "Ошибка",
        message:
          error.message
      });
    }
  }
);

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurementTasks() {
  const moscowNow =
    getMoscowNow();

  const range =
    getMoscowDateRange();

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
    "Диапазон:",
    range
  );

  console.log(
    "=========================================="
  );

  // ----------------------------------------------------------
  // ВАЖНО:
  // Сначала получаем задачи только по типу задачи,
  // незавершённости и дате.
  // ----------------------------------------------------------

  const allTasks = [];

  let page = 1;

  while (true) {
    const params = {
      "filter[entity_type]":
        "leads",

      "filter[is_completed][]":
        0,

      "filter[task_type][]":
        MEASUREMENT_TASK_TYPE_ID,

      "filter[complete_till][from]":
        range.from,

      "filter[complete_till][to]":
        range.to,

      limit: 250,
      page,

      "order[complete_till]":
        "asc"
    };

    console.log(
      "Запрос задач:",
      new URLSearchParams(
        params
      ).toString()
    );

    const response =
      await amoCrmRequest(
        "GET",
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`,
        {
          params
        }
      );

    if (
      response.status === 204 ||
      !response.data ||
      !response.data._embedded ||
      !response.data._embedded.tasks
    ) {
      console.log(
        "amoCRM вернул 204 или пустой список"
      );

      break;
    }

    const tasks =
      response.data
        ._embedded.tasks;

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    if (page > 20) {
      break;
    }
  }

  console.log(
    "Всего задач:",
    allTasks.length
  );

  // ----------------------------------------------------------
  // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА КАЖДОЙ ЗАДАЧИ
  // ----------------------------------------------------------

  const validTasks = [];

  for (const task of allTasks) {
    const passes = {
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
        Number(
          task.complete_till
        ) >= range.from &&
        Number(
          task.complete_till
        ) <= range.to
    };

    console.log(
      "Проверка задачи",
      task.id,
      passes
    );

    if (
      passes.entity_type &&
      passes.task_type &&
      passes.not_completed &&
      passes.date
    ) {
      validTasks.push(
        task
      );
    }
  }

  console.log(
    "Найдено подходящих задач:",
    validTasks.length
  );

  // ----------------------------------------------------------
  // ПО КАЖДОЙ ЗАДАЧЕ ПОЛУЧАЕМ СДЕЛКУ
  // ----------------------------------------------------------

  const measurements = [];

  for (const task of validTasks) {
    if (!task.entity_id) {
      continue;
    }

    try {
      const leadResponse =
        await amoCrmRequest(
          "GET",
          `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${task.entity_id}`,
          {
            params: {
              with: "contacts"
            }
          }
        );

      const lead =
        leadResponse.data;

      let engineerFound =
        false;

      let engineerValue =
        null;

      if (
        Array.isArray(
          lead.custom_fields_values
        )
      ) {
        const engineerField =
          lead.custom_fields_values.find(
            field =>
              Number(field.field_id) ===
              ENGINEER_FIELD_ID
          );

        if (
          engineerField &&
          Array.isArray(
            engineerField.values
          )
        ) {
          const value =
            engineerField.values[0];

          if (value) {
            engineerValue =
              value.value;

            if (
              Number(
                value.enum_id
              ) ===
              ENGINEER_ENUM_ID
            ) {
              engineerFound = true;
            }

            if (
              String(
                value.value
              ).trim() ===
              ENGINEER_NAME
            ) {
              engineerFound = true;
            }
          }
        }
      }

      console.log(
        "Сделка:",
        lead.id,
        "Инженер:",
        engineerValue,
        "Подходит:",
        engineerFound
      );

      if (!engineerFound) {
        continue;
      }

      measurements.push({
        task_id:
          task.id,

        entity_id:
          lead.id,

        lead_name:
          lead.name ||
          `Сделка #${lead.id}`,

        complete_till:
          task.complete_till,

        complete_till_moscow:
          task.complete_till
            ? new Date(
                task.complete_till *
                  1000
              ).toLocaleString(
                "ru-RU",
                {
                  timeZone:
                    "Europe/Moscow"
                }
              )
            : null,

        engineer:
          ENGINEER_NAME,

        engineer_field_id:
          ENGINEER_FIELD_ID,

        engineer_enum_id:
          ENGINEER_ENUM_ID,

        lead_url:
          `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${lead.id}`
      });
    } catch (error) {
      console.log(
        "Ошибка получения сделки",
        task.entity_id,
        error.message
      );
    }
  }

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  return {
    timezone:
      "Europe/Moscow",

    current_moscow_time:
      formatMoscowDate(
        moscowNow
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
        range.from_text,

      to:
        range.to_text
    },

    tasks_loaded:
      allTasks.length,

    valid_tasks:
      validTasks.length,

    found_count:
      measurements.length,

    measurements
  };
}

// ============================================================
// DEBUG ПОИСКА
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {
    try {
      if (!amoCrmAccessToken) {
        return res.status(500).json({
          status: "Ошибка",
          message:
            "AMOCRM_ACCESS_TOKEN не задан. Откройте /oauth/amocrm"
        });
      }

      const result =
        await findMeasurementTasks();

      res.json({
        status: "OK",
        ...result
      });
    } catch (error) {
      console.log(
        "DEBUG TASK ERROR:",
        error.message
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
// ОТПРАВКА СООБЩЕНИЯ В AMOMESSENGER
// ============================================================

async function sendBotMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  buttons = null
) {
  const body = {
    text,
    receiver: {
      user_id:
        receiverUserId
    }
  };

  if (buttons) {
    body.reply_markup = {
      inline_keyboard: {
        buttons
      }
    };
  }

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}` +
    `/request/${requestId}` +
    `/sendMessage`;

  console.log(
    "amoMessenger POST sendMessage"
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
    "receiver:",
    receiverUserId
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
    await amoMessengerRequest(
      "POST",
      url,
      body
    );

  console.log(
    "amoMessenger response:",
    response.status,
    response.data
  );

  return response;
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ
// ============================================================

async function returnControl(
  botId,
  requestId
) {
  try {
    console.log(
      "Возвращаем управление amoMessenger..."
    );

    const url =
      `https://api.amo.tm/v1.3/bots/${botId}` +
      `/request/${requestId}` +
      `/returnControl`;

    const response =
      await amoMessengerRequest(
        "POST",
        url,
        {
          return_code:
            "success"
        }
      );

    console.log(
      "amoMessenger response:",
      response.status,
      response.data
    );

    console.log(
      "Управление возвращено amoMessenger"
    );
  } catch (error) {
    console.log(
      "Ошибка возврата управления:",
      error.message
    );
  }
}

// ============================================================
// AMOMESSENGER WEBHOOK
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
    // Сразу отвечаем amoMessenger,
    // чтобы webhook не ждал долгую обработку.
    res.status(200).json({
      status: "ok"
    });

    try {
      const body =
        req.body;

      log(
        "AMOMESSENGER WEBHOOK",
        body
      );

      const eventType =
        body.event_type;

      const context =
        body._embedded &&
        body._embedded.context
          ? body._embedded.context
          : {};

      // ======================================================
      // CONTROL TRANSFERRED
      // ======================================================

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        const transferred =
          body._embedded
            ?.rpa_bot_control_transferred;

        const embedded =
          transferred
            ? transferred._embedded
            : {};

        const request =
          embedded.request;

        const botId =
          transferred.bot_id;

        const requestId =
          request?.id;

        const contextUserId =
          context.user_id;

        const requestAuthorId =
          request?.author_id;

        const receiverUserId =
          requestAuthorId ||
          contextUserId;

        log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ",
          {
            botId,
            requestId,
            receiverUserId,
            contextUserId,
            requestAuthorId
          }
        );

        if (
          !botId ||
          !requestId ||
          !receiverUserId
        ) {
          console.log(
            "Не хватает данных для отправки сообщения"
          );

          return;
        }

        await sendBotMessage(
          botId,
          requestId,
          receiverUserId,
          "Выберите задачу для выполнения:",
          [
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
        );

        return;
      }

      // ======================================================
      // INCOME MESSAGE
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        const income =
          body._embedded
            ?.rpa_bot_income_message;

        const embedded =
          income
            ? income._embedded
            : {};

        const message =
          embedded.income_message;

        const request =
          embedded.request;

        const botId =
          income.bot_id;

        const requestId =
          request?.id;

        const text =
          message?.text || "";

        const receiverUserId =
          message?.author?.user_id ||
          request?.author_id ||
          context.user_id;

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

        // ====================================================
        // ПОДТВЕРДИТЬ ЗАМЕР
        // ====================================================

        if (
          text.trim() ===
          MEASUREMENT_TASK_NAME
        ) {
          log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );

          await sendBotMessage(
            botId,
            requestId,
            receiverUserId,
            "⏳ Проверяю задачи на подтверждение замера..."
          );

          try {
            if (
              !amoCrmAccessToken
            ) {
              await sendBotMessage(
                botId,
                requestId,
                receiverUserId,
                "❗ Не настроена авторизация amoCRM. Откройте ссылку авторизации amoCRM и повторите попытку."
              );

              await returnControl(
                botId,
                requestId
              );

              return;
            }

            const result =
              await findMeasurementTasks();

            // ==============================================
            // НИЧЕГО НЕ НАЙДЕНО
            // ==============================================

            if (
              result.found_count ===
              0
            ) {
              await sendBotMessage(
                botId,
                requestId,
                receiverUserId,
                "📋 Замеров для подтверждения не найдено."
              );

              await returnControl(
                botId,
                requestId
              );

              return;
            }

            // ==============================================
            // НАЙДЕНЫ ЗАМЕРЫ
            // ==============================================

            let messageText =
              "📋 Найдены замеры для подтверждения:\n\n";

            for (
              let i = 0;
              i <
              result.measurements.length;
              i++
            ) {
              const item =
                result.measurements[i];

              messageText +=
                `${i + 1}. ${item.lead_name}\n`;

              messageText +=
                `Задача: ${item.task_id}\n`;

              messageText +=
                `Сделка: ${item.entity_id}\n`;

              messageText +=
                `Срок: ${item.complete_till_moscow}\n`;

              messageText +=
                `${item.lead_url}\n\n`;
            }

            await sendBotMessage(
              botId,
              requestId,
              receiverUserId,
              messageText
            );

            await returnControl(
              botId,
              requestId
            );

            return;
          } catch (error) {
            console.log(
              "Ошибка поиска замеров:",
              error.message
            );

            await sendBotMessage(
              botId,
              requestId,
              receiverUserId,
              `❗ Ошибка при поиске задач:\n${error.message}`
            );

            await returnControl(
              botId,
              requestId
            );

            return;
          }
        }

        // ====================================================
        // ОСТАЛЬНЫЕ КНОПКИ
        // ====================================================

        if (
          text.trim() ===
          "Провести замер"
        ) {
          await sendBotMessage(
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
          text.trim() ===
          "Загрузить фотоотчет"
        ) {
          await sendBotMessage(
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
          text.trim() ===
          "Внести правки"
        ) {
          await sendBotMessage(
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
      }
    } catch (error) {
      console.log(
        "WEBHOOK ERROR:",
        error.message
      );
    }
  }
);

// ============================================================
// СТАРТ
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "amoMessenger bot запущен"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "AMOCRM:",
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru`
    );

    console.log(
      "amoCRM token:",
      amoCrmAccessToken
        ? "OK"
        : "НЕТ"
    );

    console.log(
      "amoMessenger token:",
      amoMessengerAccessToken
        ? "OK"
        : "НЕТ"
    );

    console.log(
      "=========================================="
    );
  }
);
