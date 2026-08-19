const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

// --------------------
// amoCRM
// --------------------

const AMOCRM_SUBDOMAIN =
  process.env.AMOCRM_SUBDOMAIN || "zlmk";

const AMOCRM_CLIENT_ID =
  process.env.AMOCRM_CLIENT_ID || "";

const AMOCRM_CLIENT_SECRET =
  process.env.AMOCRM_CLIENT_SECRET || "";

const AMOCRM_REDIRECT_URI =
  process.env.AMOCRM_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/amocrm/callback";

// Первоначально можно передать токены через Environment Variables.
// После OAuth они также сохраняются в памяти процесса.
let amoCrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amoCrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

let amoCrmTokenExpiresAt = 0;

// --------------------
// amoCRM бизнес-логика
// --------------------

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Москва UTC+3
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

// --------------------
// amoMessenger
// --------------------

const AMOMESSENGER_TOKEN_URL =
  "https://id.amo.tm/oauth2/access_token";

const AMOMESSENGER_API =
  "https://api.amo.tm/v1.3";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

let amoMessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amoMessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function logSeparator() {
  console.log("==========================================");
}

function getMoscowDate() {
  return new Date(Date.now() + MOSCOW_OFFSET_MS);
}

function formatMoscowDate(date) {
  const d = date || getMoscowDate();

  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();

  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");

  return `${day}.${month}.${year}, ${hours}:${minutes}:${seconds}`;
}

function moscowStartOfTodayUnix() {
  const now = getMoscowDate();

  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0
  );

  return Math.floor((start - MOSCOW_OFFSET_MS) / 1000);
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function unixToMoscow(timestamp) {
  if (!timestamp) return "";

  const d = new Date(Number(timestamp) * 1000 + MOSCOW_OFFSET_MS);

  return formatMoscowDate(d);
}

function safeString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

// ============================================================
// AMOCRM OAUTH
// ============================================================

function getAmoCrmOAuthUrl() {
  if (!AMOCRM_CLIENT_ID) {
    return null;
  }

  const url = new URL(
    `https://www.amocrm.ru/oauth?client_id=${encodeURIComponent(
      AMOCRM_CLIENT_ID
    )}`
  );

  url.searchParams.set(
    "redirect_uri",
    AMOCRM_REDIRECT_URI
  );

  url.searchParams.set(
    "state",
    "amobot_cpck_state"
  );

  url.searchParams.set(
    "mode",
    "popup"
  );

  return url.toString();
}

// ------------------------------------------------------------
// Обмен authorization code на access/refresh token
// ------------------------------------------------------------

async function exchangeAmoCrmCode(code) {
  if (!AMOCRM_CLIENT_ID) {
    throw new Error(
      "AMOCRM_CLIENT_ID не задан в Environment Variables"
    );
  }

  if (!AMOCRM_CLIENT_SECRET) {
    throw new Error(
      "AMOCRM_CLIENT_SECRET не задан в Environment Variables"
    );
  }

  if (!code) {
    throw new Error(
      "Authorization code не получен"
    );
  }

  const tokenUrl =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

  console.log("==========================================");
  console.log("OAUTH AMOCRM");
  console.log("Token URL:", tokenUrl);
  console.log("Redirect URI:", AMOCRM_REDIRECT_URI);
  console.log("Authorization code получен: ДА");
  console.log("==========================================");

  try {
    const response = await axios.post(
      tokenUrl,
      {
        client_id: AMOCRM_CLIENT_ID,
        client_secret: AMOCRM_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: AMOCRM_REDIRECT_URI
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        timeout: 30000
      }
    );

    console.log(
      "amoCRM OAuth HTTP:",
      response.status
    );

    if (!response.data) {
      throw new Error(
        "amoCRM не вернул данные токена"
      );
    }

    amoCrmAccessToken =
      response.data.access_token || "";

    amoCrmRefreshToken =
      response.data.refresh_token || "";

    const expiresIn =
      Number(response.data.expires_in || 86400);

    amoCrmTokenExpiresAt =
      Date.now() + expiresIn * 1000;

    console.log(
      "amoCRM Access Token получен:",
      amoCrmAccessToken ? "ДА" : "НЕТ"
    );

    console.log(
      "amoCRM Refresh Token получен:",
      amoCrmRefreshToken ? "ДА" : "НЕТ"
    );

    console.log(
      "amoCRM токены сохранены в памяти процесса."
    );

    return response.data;
  } catch (error) {
    console.error(
      "amoCRM OAuth ERROR:",
      error.response?.status,
      error.response?.data || error.message
    );

    throw error;
  }
}

// ------------------------------------------------------------
// Обновление Access Token
// ------------------------------------------------------------

async function refreshAmoCrmToken() {
  if (!amoCrmRefreshToken) {
    throw new Error(
      "AMOCRM_REFRESH_TOKEN отсутствует"
    );
  }

  const tokenUrl =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

  console.log("==========================================");
  console.log("ОБНОВЛЕНИЕ AMOCRM ACCESS TOKEN");
  console.log("==========================================");

  const response = await axios.post(
    tokenUrl,
    {
      client_id: AMOCRM_CLIENT_ID,
      client_secret: AMOCRM_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: amoCrmRefreshToken,
      redirect_uri: AMOCRM_REDIRECT_URI
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      timeout: 30000
    }
  );

  amoCrmAccessToken =
    response.data.access_token || "";

  if (response.data.refresh_token) {
    amoCrmRefreshToken =
      response.data.refresh_token;
  }

  const expiresIn =
    Number(response.data.expires_in || 86400);

  amoCrmTokenExpiresAt =
    Date.now() + expiresIn * 1000;

  console.log(
    "amoCRM Access Token обновлен"
  );

  return response.data;
}

// ============================================================
// AMOCRM API
// ============================================================

async function ensureAmoCrmToken() {
  if (!amoCrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан. Откройте /amocrm/auth"
    );
  }

  // Обновляем токен за 5 минут до истечения.
  if (
    amoCrmTokenExpiresAt &&
    Date.now() >
      amoCrmTokenExpiresAt - 5 * 60 * 1000
  ) {
    if (amoCrmRefreshToken) {
      try {
        await refreshAmoCrmToken();
      } catch (error) {
        console.error(
          "Не удалось обновить amoCRM token:",
          error.response?.data || error.message
        );
      }
    }
  }

  return amoCrmAccessToken;
}

async function amoCrmGet(path, params) {
  await ensureAmoCrmToken();

  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru${path}`;

  console.log("amoCRM GET:", url);

  try {
    const response = await axios.get(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${amoCrmAccessToken}`,
          Accept: "application/json"
        },
        params: params || {},
        timeout: 30000,
        validateStatus: () => true
      }
    );

    console.log(
      "amoCRM response:",
      response.status
    );

    if (response.status === 401) {
      console.log(
        "amoCRM HTTP 401. Пробуем обновить токен..."
      );

      if (amoCrmRefreshToken) {
        await refreshAmoCrmToken();

        const retry = await axios.get(
          url,
          {
            headers: {
              Authorization:
                `Bearer ${amoCrmAccessToken}`,
              Accept: "application/json"
            },
            params: params || {},
            timeout: 30000,
            validateStatus: () => true
          }
        );

        if (
          retry.status < 200 ||
          retry.status > 204
        ) {
          throw new Error(
            `amoCRM HTTP ${retry.status}: ${JSON.stringify(
              retry.data
            )}`
          );
        }

        return retry.data || {};
      }
    }

    if (
      response.status !== 200 &&
      response.status !== 204
    ) {
      throw new Error(
        `amoCRM HTTP ${response.status}: ${JSON.stringify(
          response.data
        )}`
      );
    }

    return response.data || {};
  } catch (error) {
    console.error(
      "amoCRM GET ERROR:",
      error.response?.status,
      error.response?.data || error.message
    );

    throw error;
  }
}

// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ
// ============================================================

async function loadTasks() {
  const fromUnix =
    moscowStartOfTodayUnix() - 24 * 60 * 60;

  const toUnix =
    nowUnix();

  const allTasks = [];

  let page = 1;

  while (true) {
    const params = {
      "filter[entity_type]": "leads",
      "filter[is_completed][]": 0,
      "filter[task_type][]":
        MEASUREMENT_TASK_TYPE_ID,
      "filter[complete_till][from]":
        fromUnix,
      "filter[complete_till][to]":
        toUnix,
      limit: 250,
      page: page,
      "order[complete_till]":
        "asc"
    };

    console.log("==========================================");
    console.log("Запрос задач:");

    const queryString =
      new URLSearchParams(params).toString();

    console.log(queryString);

    try {
      const data =
        await amoCrmGet(
          "/api/v4/tasks",
          params
        );

      const tasks =
        data?._embedded?.tasks || [];

      console.log(
        `Страница задач ${page}: ${tasks.length}`
      );

      if (!tasks.length) {
        break;
      }

      allTasks.push(...tasks);

      if (tasks.length < 250) {
        break;
      }

      page++;

      if (page > 20) {
        console.log(
          "Остановили загрузку после 20 страниц."
        );
        break;
      }
    } catch (error) {
      // 204 / отсутствие данных
      console.error(
        "Ошибка загрузки задач:",
        error.message
      );

      break;
    }
  }

  console.log(
    "Всего задач:",
    allTasks.length
  );

  return {
    tasks: allTasks,
    fromUnix,
    toUnix
  };
}

// ============================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(leadId) {
  try {
    return await amoCrmGet(
      `/api/v4/leads/${leadId}`,
      {
        with: "contacts"
      }
    );
  } catch (error) {
    console.error(
      `Ошибка получения сделки ${leadId}:`,
      error.message
    );

    return null;
  }
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function getEngineerField(lead) {
  const fields =
    lead?.custom_fields_values || [];

  return fields.find(
    field =>
      Number(field.field_id) ===
      Number(ENGINEER_FIELD_ID)
  );
}

function leadBelongsToEngineer(lead) {
  const field =
    getEngineerField(lead);

  if (!field) {
    return false;
  }

  const values =
    field.values || [];

  return values.some(value => {
    const enumId =
      value.enum_id ??
      value.enumId ??
      value.id;

    const text =
      safeString(value.value)
        .trim()
        .toLowerCase();

    return (
      Number(enumId) ===
        Number(ENGINEER_ENUM_ID) ||
      text ===
        ENGINEER_NAME.toLowerCase()
    );
  });
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

  const {
    tasks,
    fromUnix,
    toUnix
  } = await loadTasks();

  console.log(
    "Найдено подходящих задач:",
    tasks.length
  );

  const measurements = [];

  for (const task of tasks) {
    console.log("------------------------------------------");

    console.log(
      "Проверяем задачу:",
      task.id
    );

    console.log(
      "entity_id:",
      task.entity_id
    );

    console.log(
      "entity_type:",
      task.entity_type
    );

    console.log(
      "task_type_id:",
      task.task_type_id
    );

    console.log(
      "is_completed:",
      task.is_completed
    );

    console.log(
      "complete_till:",
      unixToMoscow(
        task.complete_till
      )
    );

    if (
      String(task.entity_type) !==
      "leads"
    ) {
      console.log(
        "Пропуск: entity_type не leads"
      );

      continue;
    }

    if (
      Number(task.task_type_id) !==
      Number(MEASUREMENT_TASK_TYPE_ID)
    ) {
      console.log(
        "Пропуск: другой тип задачи"
      );

      continue;
    }

    if (
      task.is_completed === true ||
      Number(task.is_completed) === 1
    ) {
      console.log(
        "Пропуск: задача выполнена"
      );

      continue;
    }

    if (!task.entity_id) {
      console.log(
        "Пропуск: нет entity_id"
      );

      continue;
    }

    const lead =
      await getLead(
        task.entity_id
      );

    if (!lead) {
      console.log(
        "Пропуск: не удалось получить сделку"
      );

      continue;
    }

    console.log(
      "Получена сделка:",
      lead.id
    );

    const engineerField =
      getEngineerField(lead);

    if (!engineerField) {
      console.log(
        "Пропуск: поле Инженер отсутствует"
      );

      continue;
    }

    console.log(
      "Поле инженера найдено:",
      JSON.stringify(
        engineerField
      )
    );

    if (
      !leadBelongsToEngineer(lead)
    ) {
      console.log(
        "Пропуск: сделка принадлежит другому инженеру"
      );

      continue;
    }

    console.log(
      "Сделка подходит!"
    );

    const fields =
      lead.custom_fields_values || [];

    function getFieldValue(fieldId) {
      const field =
        fields.find(
          f =>
            Number(f.field_id) ===
            Number(fieldId)
        );

      if (!field) return "";

      return (
        field.values?.[0]?.value ||
        ""
      );
    }

    const contractNumber =
      getFieldValue(412776);

    const measureDate =
      getFieldValue(175370);

    const measureTime =
      getFieldValue(413828);

    const address =
      getFieldValue(175412);

    const product =
      getFieldValue(172572);

    const contact =
      lead?._embedded?.contacts?.[0];

    const clientName =
      contact?.name ||
      "Клиент не указан";

    const measurement = {
      task_id: task.id,
      lead_id: lead.id,

      lead_name:
        lead.name ||
        `Сделка #${lead.id}`,

      contract_number:
        contractNumber,

      measure_date:
        measureDate,

      measure_time:
        measureTime,

      address:
        address,

      product:
        product,

      client_name:
        clientName,

      task_complete_till:
        task.complete_till,

      task_complete_till_moscow:
        unixToMoscow(
          task.complete_till
        ),

      engineer:
        ENGINEER_NAME,

      lead_url:
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${lead.id}`
    };

    measurements.push(
      measurement
    );
  }

  console.log("==========================================");

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  console.log(
    JSON.stringify(
      measurements,
      null,
      2
    )
  );

  return {
    measurements,
    tasks_loaded: tasks.length,
    fromUnix,
    toUnix
  };
}

// ============================================================
// AMOMESSENGER TOKEN
// ============================================================

async function exchangeAmoMessengerCode(code) {
  if (!AMOMESSENGER_CLIENT_ID) {
    throw new Error(
      "AMOMESSENGER_CLIENT_ID не задан"
    );
  }

  if (!AMOMESSENGER_CLIENT_SECRET) {
    throw new Error(
      "AMOMESSENGER_CLIENT_SECRET не задан"
    );
  }

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
            "application/json"
        },
        timeout: 30000
      }
    );

  amoMessengerAccessToken =
    response.data.access_token || "";

  amoMessengerRefreshToken =
    response.data.refresh_token || "";

  console.log(
    "amoMessenger токены сохранены."
  );

  return response.data;
}

// ============================================================
// AMOMESSENGER API
// ============================================================

async function amoMessengerPost(
  url,
  body
) {
  if (!amoMessengerAccessToken) {
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
            `Bearer ${amoMessengerAccessToken}`,

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
    "amoMessenger response:",
    response.status,
    response.data
  );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    throw new Error(
      `amoMessenger HTTP ${response.status}: ${JSON.stringify(
        response.data
      )}`
    );
  }

  return response.data;
}

// ============================================================
// SEND MESSAGE
// ============================================================

async function sendBotMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  replyMarkup
) {
  const url =
    `${AMOMESSENGER_API}/bots/${botId}` +
    `/request/${requestId}` +
    `/sendMessage`;

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

  return amoMessengerPost(
    url,
    body
  );
}

// ============================================================
// RETURN CONTROL
// ============================================================

async function returnControl(
  botId,
  requestId
) {
  const url =
    `${AMOMESSENGER_API}/bots/${botId}` +
    `/request/${requestId}` +
    `/returnControl`;

  return amoMessengerPost(
    url,
    {
      return_code:
        "success"
    }
  );
}

// ============================================================
// ФОРМАТИРОВАНИЕ ЗАМЕРА
// ============================================================

function formatMeasurement(
  item,
  index
) {
  let text = "";

  text +=
    `${index + 1}. 📐 ${item.lead_name}\n`;

  text +=
    `👤 Клиент: ${item.client_name || "—"}\n`;

  text +=
    `📄 № договора: ${item.contract_number || "—"}\n`;

  text +=
    `📅 Дата замера: ${item.measure_date || "—"}\n`;

  text +=
    `⏰ Время замера: ${item.measure_time || "—"}\n`;

  text +=
    `📍 Адрес: ${item.address || "—"}\n`;

  text +=
    `🧱 Продукт: ${item.product || "—"}\n`;

  text +=
    `⏳ Срок задачи: ${item.task_complete_till_moscow || "—"}\n`;

  text +=
    `🔗 Сделка: ${item.lead_url}`;

  return text;
}

// ============================================================
// ОСНОВНОЙ ОБРАБОТЧИК "ПОДТВЕРДИТЬ ЗАМЕР"
// ============================================================

async function handleConfirmMeasurement(
  botId,
  requestId,
  receiverUserId
) {
  logSeparator();

  console.log(
    "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
  );

  logSeparator();

  try {
    await sendBotMessage(
      botId,
      requestId,
      receiverUserId,
      "⏳ Проверяю задачи на подтверждение замера..."
    );

    const result =
      await findMeasurements();

    if (
      !result.measurements ||
      result.measurements.length === 0
    ) {
      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        "📋 Замеров для подтверждения не найдено."
      );

      return;
    }

    let text =
      `📋 Найдено замеров: ${result.measurements.length}\n\n`;

    result.measurements.forEach(
      (item, index) => {
        text +=
          formatMeasurement(
            item,
            index
          );

        text +=
          "\n\n";
      }
    );

    await sendBotMessage(
      botId,
      requestId,
      receiverUserId,
      text
    );
  } catch (error) {
    console.error(
      "Ошибка поиска замеров:",
      error.response?.data ||
        error.message
    );

    try {
      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        `❌ Ошибка при поиске задач.\n\n${error.message}`
      );
    } catch (sendError) {
      console.error(
        "Не удалось отправить ошибку:",
        sendError.message
      );
    }
  }
}

// ============================================================
// HOME
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

      amocrm_authorized:
        !!amoCrmAccessToken,

      amomessenger_authorized:
        !!amoMessengerAccessToken,

      endpoints: {
        amocrm_auth:
          "/amocrm/auth",

        amocrm_callback:
          "/amocrm/callback",

        amocrm_status:
          "/amocrm/status",

        tasks_test:
          "/debug/tasks-test",

        amomessenger_status:
          "/debug/amomessenger"
      }
    });
  }
);

// ============================================================
// AMOCRM AUTH
// ============================================================

app.get(
  "/amocrm/auth",
  (req, res) => {
    try {
      if (!AMOCRM_CLIENT_ID) {
        return res.status(500).send(`
          <h2>AMOCRM_CLIENT_ID не задан</h2>
          <p>Добавьте его в Render → Environment Variables.</p>
        `);
      }

      const authUrl =
        getAmoCrmOAuthUrl();

      res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Авторизация amoCRM</title>
<style>
body {
  font-family: Arial, sans-serif;
  max-width: 700px;
  margin: 50px auto;
  padding: 20px;
}
button {
  padding: 14px 25px;
  font-size: 18px;
  cursor: pointer;
}
.info {
  background: #f3f3f3;
  padding: 15px;
  margin: 20px 0;
}
</style>
</head>

<body>

<h1>Авторизация amoCRM</h1>

<div class="info">
<p><b>Аккаунт:</b> ${AMOCRM_SUBDOMAIN}.amocrm.ru</p>
<p><b>Redirect URI:</b><br>${AMOCRM_REDIRECT_URI}</p>
</div>

<p>
Нажмите кнопку ниже и разрешите доступ интеграции.
</p>

<a href="${authUrl}">
<button>Авторизоваться в amoCRM</button>
</a>

</body>
</html>
      `);
    } catch (error) {
      res.status(500).send(
        `<pre>${error.message}</pre>`
      );
    }
  }
);

// ============================================================
// AMOCRM CALLBACK
// ============================================================

app.get(
  "/amocrm/callback",
  async (req, res) => {
    console.log("==========================================");
    console.log("AMOCRM CALLBACK");
    console.log(
      "QUERY:",
      JSON.stringify(
        req.query,
        null,
        2
      )
    );
    console.log("==========================================");

    const {
      code,
      error,
      referer
    } = req.query;

    if (error) {
      return res.status(400).send(`
        <h2>Ошибка авторизации amoCRM</h2>
        <pre>${safeString(error)}</pre>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <h2>Authorization code не получен</h2>

        <p>
        amoCRM не передал параметр <b>code</b>.
        </p>

        <pre>${JSON.stringify(
          req.query,
          null,
          2
        )}</pre>
      `);
    }

    try {
      const tokenData =
        await exchangeAmoCrmCode(
          code
        );

      res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>amoCRM авторизация</title>
</head>

<body style="font-family:Arial; max-width:700px; margin:50px auto;">

<h2>Авторизация amoCRM успешно выполнена</h2>

<p>Access Token получен: <b>${
        tokenData.access_token
          ? "ДА"
          : "НЕТ"
      }</b></p>

<p>Refresh Token получен: <b>${
        tokenData.refresh_token
          ? "ДА"
          : "НЕТ"
      }</b></p>

<p>
Теперь можно закрыть это окно.
</p>

<p>
Для проверки откройте:
<br>
<a href="/amocrm/status">
/amocrm/status
</a>
</p>

<p>
Для проверки задач:
<br>
<a href="/debug/tasks-test">
/debug/tasks-test
</a>
</p>

</body>
</html>
      `);
    } catch (error) {
      console.error(
        "AMOCRM CALLBACK ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).send(`
        <h2>Ошибка авторизации amoCRM</h2>

        <pre>${JSON.stringify(
          error.response?.data ||
            {
              message:
                error.message
            },
          null,
          2
        )}</pre>
      `);
    }
  }
);

// ============================================================
// AMOCRM STATUS
// ============================================================

app.get(
  "/amocrm/status",
  (req, res) => {
    res.json({
      status:
        amoCrmAccessToken
          ? "OK"
          : "Токен не найден",

      access_token:
        amoCrmAccessToken
          ? "ДА"
          : "НЕТ",

      refresh_token:
        amoCrmRefreshToken
          ? "ДА"
          : "НЕТ",

      client_id:
        AMOCRM_CLIENT_ID
          ? "ЗАДАН"
          : "НЕТ",

      client_secret:
        AMOCRM_CLIENT_SECRET
          ? "ЗАДАН"
          : "НЕТ",

      redirect_uri:
        AMOCRM_REDIRECT_URI,

      subdomain:
        AMOCRM_SUBDOMAIN,

      token_expires_at:
        amoCrmTokenExpiresAt
          ? new Date(
              amoCrmTokenExpiresAt
            ).toISOString()
          : null
    });
  }
);

// ============================================================
// DEBUG TASKS TEST
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {
    try {
      const result =
        await findMeasurements();

      res.json({
        status: "OK",

        timezone:
          "Europe/Moscow",

        current_moscow_time:
          formatMoscowDate(),

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
          "сегодня + вчера, до текущего момента",

        date_range: {
          from:
            unixToMoscow(
              result.fromUnix
            ),

          to:
            unixToMoscow(
              result.toUnix
            )
        },

        tasks_loaded:
          result.tasks_loaded,

        valid_tasks:
          result.tasks_loaded,

        found_count:
          result.measurements.length,

        measurements:
          result.measurements
      });
    } catch (error) {
      console.error(
        "DEBUG TASKS ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка",

        message:
          error.message,

        amocrm:
          error.response?.data ||
          null
      });
    }
  }
);

// ============================================================
// DEBUG: ПРЯМАЯ ПРОВЕРКА ЗАДАЧИ
// ============================================================

app.get(
  "/debug/task/:taskId",
  async (req, res) => {
    try {
      const taskId =
        req.params.taskId;

      const data =
        await amoCrmGet(
          `/api/v4/tasks/${taskId}`
        );

      res.json({
        status: "OK",
        task: data
      });
    } catch (error) {
      res.status(500).json({
        status:
          "Ошибка",

        message:
          error.message,

        response:
          error.response?.data ||
          null
      });
    }
  }
);

// ============================================================
// DEBUG: ПРЯМАЯ ПРОВЕРКА СДЕЛКИ
// ============================================================

app.get(
  "/debug/lead/:leadId",
  async (req, res) => {
    try {
      const leadId =
        req.params.leadId;

      const lead =
        await getLead(
          leadId
        );

      if (!lead) {
        return res.status(404).json({
          status:
            "Не найдено"
        });
      }

      const engineerField =
        getEngineerField(
          lead
        );

      res.json({
        status: "OK",

        lead_id:
          lead.id,

        lead_name:
          lead.name,

        engineer_field:
          engineerField,

        belongs_to_engineer:
          leadBelongsToEngineer(
            lead
          ),

        expected: {
          engineer:
            ENGINEER_NAME,

          field_id:
            ENGINEER_FIELD_ID,

          enum_id:
            ENGINEER_ENUM_ID
        },

        lead
      });
    } catch (error) {
      res.status(500).json({
        status:
          "Ошибка",

        message:
          error.message,

        response:
          error.response?.data ||
          null
      });
    }
  }
);

// ============================================================
// AMOMESSENGER STATUS
// ============================================================

app.get(
  "/debug/amomessenger",
  (req, res) => {
    res.json({
      status:
        amoMessengerAccessToken
          ? "OK"
          : "Токен не найден",

      access_token:
        amoMessengerAccessToken
          ? "ДА"
          : "НЕТ",

      refresh_token:
        amoMessengerRefreshToken
          ? "ДА"
          : "НЕТ",

      client_id:
        AMOMESSENGER_CLIENT_ID
          ? "ЗАДАН"
          : "НЕТ",

      client_secret:
        AMOMESSENGER_CLIENT_SECRET
          ? "ЗАДАН"
          : "НЕТ",

      redirect_uri:
        AMOMESSENGER_REDIRECT_URI
    });
  }
);

// ============================================================
// AMOMESSENGER OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    console.log("==========================================");
    console.log("OAUTH AMOMESSENGER");
    console.log("==========================================");

    const {
      code,
      error
    } = req.query;

    if (error) {
      return res.status(400).json({
        status:
          "Ошибка",

        message:
          error
      });
    }

    if (!code) {
      return res.status(400).json({
        status:
          "Ошибка",

        message:
          "Код авторизации не получен"
      });
    }

    try {
      const tokenData =
        await exchangeAmoMessengerCode(
          code
        );

      res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>amoMessenger OAuth</title>
</head>

<body style="font-family:Arial; max-width:700px; margin:50px auto;">

<h2>Авторизация amoMessenger успешно выполнена</h2>

<p>
Access Token получен:
<b>${
        tokenData.access_token
          ? "ДА"
          : "НЕТ"
      }</b>
</p>

<p>
Refresh Token получен:
<b>${
        tokenData.refresh_token
          ? "ДА"
          : "НЕТ"
      }</b>
</p>

<p>
Теперь можно закрыть это окно и снова запустить бота.
</p>

</body>
</html>
      `);
    } catch (error) {
      console.error(
        "OAuth amoMessenger ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        status:
          "Ошибка OAuth",

        message:
          error.message,

        response:
          error.response?.data ||
          null
      });
    }
  }
);

// ============================================================
// AMOMESSENGER WEBHOOK
// ============================================================

app.post(
  "/webhook",
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

    // Сначала отвечаем amoMessenger.
    res.status(200).json({
      status: "OK"
    });

    try {
      const body =
        req.body || {};

      const eventType =
        body.event_type;

      // ------------------------------------------------------
      // Передача управления виджету
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        const event =
          body?._embedded
            ?.rpa_bot_control_transferred;

        const request =
          event?._embedded
            ?.request;

        const botId =
          event?.bot_id;

        const requestId =
          request?.id;

        const contextUserId =
          body?._embedded
            ?.context
            ?.user_id;

        const requestAuthorId =
          request?.author_id;

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
          !botId ||
          !requestId ||
          !receiverUserId
        ) {
          console.error(
            "Не хватает данных для отправки сообщения."
          );

          return;
        }

        await sendBotMessage(
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

      // ------------------------------------------------------
      // Получено сообщение от пользователя
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        const event =
          body?._embedded
            ?.rpa_bot_income_message;

        const message =
          event?._embedded
            ?.income_message;

        const request =
          event?._embedded
            ?.request;

        const botId =
          event?.bot_id;

        const requestId =
          request?.id;

        const receiverUserId =
          message?.author
            ?.user_id;

        const text =
          safeString(
            message?.text
          ).trim();

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
          text ===
          "Подтвердить замер"
        ) {
          await handleConfirmMeasurement(
            botId,
            requestId,
            receiverUserId
          );

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
              "Ошибка returnControl:",
              error.message
            );
          }

          return;
        }

        if (
          text ===
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
          text ===
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
          text ===
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

        // Если пришло неизвестное сообщение
        await sendBotMessage(
          botId,
          requestId,
          receiverUserId,
          "Пожалуйста, выберите одну из доступных задач."
        );

        return;
      }

      console.log(
        "Событие не обрабатывается:",
        eventType
      );
    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        error.response?.data ||
          error.message
      );
    }
  }
);

// ============================================================
// ПРОВЕРКА WEBHOOK GET
// ============================================================

app.get(
  "/webhook",
  (req, res) => {
    res.json({
      status:
        "Webhook работает",

      method:
        "POST",

      endpoint:
        "/webhook"
    });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      status:
        "404",

      message:
        "Маршрут не найден",

      path:
        req.path
    });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {
    console.log("==========================================");
    console.log(
      "SERVER STARTED"
    );
    console.log(
      "PORT:",
      PORT
    );
    console.log(
      "Timezone: Europe/Moscow"
    );
    console.log(
      "amoCRM subdomain:",
      AMOCRM_SUBDOMAIN
    );
    console.log(
      "amoCRM token:",
      amoCrmAccessToken
        ? "ДА"
        : "НЕТ"
    );
    console.log(
      "amoMessenger token:",
      amoMessengerAccessToken
        ? "ДА"
        : "НЕТ"
    );
    console.log("==========================================");
  }
);
