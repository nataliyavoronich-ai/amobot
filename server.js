"use strict";

const express = require("express");
const axios = require("axios");

const app = express();

app.disable("x-powered-by");

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = Number(process.env.PORT) || 10000;
const MOSCOW_TIMEZONE = "Europe/Moscow";
const REQUEST_TIMEOUT = 15000;

const AMOCRM_SUBDOMAIN =
  process.env.AMOCRM_SUBDOMAIN || "zlmk";

const AMOCRM_BASE_URL =
  `https://${AMOCRM_SUBDOMAIN}.amocrm.ru`;

const AMOMESSENGER_BASE_URL =
  "https://api.amo.tm";

const AMOMESSENGER_ID_URL =
  "https://id.amo.tm";

const AMOCRM_CLIENT_ID =
  process.env.AMOCRM_CLIENT_ID || "";

const AMOCRM_CLIENT_SECRET =
  process.env.AMOCRM_CLIENT_SECRET || "";

const AMOCRM_REDIRECT_URI =
  process.env.AMOCRM_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amocrm/callback";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

const TASK_PAGE_LIMIT = 250;
const MAX_TASK_PAGES = 20;
const LEAD_REQUEST_CONCURRENCY = 5;

// ============================================================
// ТОКЕНЫ
// ============================================================

let amoCrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amoCrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

let amoMessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amoMessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

// Защита от одновременного обновления одного токена
let amoCrmRefreshPromise = null;

// Защита от повторной обработки webhook
const processedWebhookIds = new Map();
const WEBHOOK_CACHE_TTL = 5 * 60 * 1000;

// ============================================================
// КОНСТАНТЫ ПРОЕКТА
// ============================================================

const ENGINEER_NAME =
  process.env.ENGINEER_NAME || "Марина Трафимова";

const ENGINEER_FIELD_ID = Number(
  process.env.ENGINEER_FIELD_ID || 203849
);

const ENGINEER_ENUM_ID = Number(
  process.env.ENGINEER_ENUM_ID || 1059150
);

const MEASUREMENT_TASK_TYPE_ID = Number(
  process.env.MEASUREMENT_TASK_TYPE_ID || 2746005
);

const MEASUREMENT_TASK_NAME =
  process.env.MEASUREMENT_TASK_NAME || "Подтвердить замер";

// ============================================================
// HTTP-КЛИЕНТ
// ============================================================

const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

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

function tokenStatus(token) {
  return token ? "OK" : "НЕТ";
}

function getErrorMessage(error) {
  if (error.response) {
    const status = error.response.status;
    const apiMessage =
      error.response.data?.message ||
      error.response.data?.detail ||
      "";

    return apiMessage
      ? `HTTP ${status}: ${apiMessage}`
      : `HTTP ${status}`;
  }

  if (error.code === "ECONNABORTED") {
    return "Превышено время ожидания ответа API";
  }

  return error.message || "Неизвестная ошибка";
}

function logApiError(service, error) {
  console.error(`${service} ERROR`, {
    status: error.response?.status || null,
    data: error.response?.data || null,
    message: error.message,
  });
}

function formatMoscowDate(moscow) {
  return [
    String(moscow.day).padStart(2, "0"),
    ".",
    String(moscow.month).padStart(2, "0"),
    ".",
    moscow.year,
    ", ",
    String(moscow.hour).padStart(2, "0"),
    ":",
    String(moscow.minute).padStart(2, "0"),
    ":",
    String(moscow.second).padStart(2, "0"),
  ].join("");
}

function getMoscowNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOSCOW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function formatUnixMoscow(unixTimestamp) {
  if (!unixTimestamp) {
    return null;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIMEZONE,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(Number(unixTimestamp) * 1000));
}

function getMoscowDateStartUnix() {
  const moscow = getMoscowNow();

  // Москва использует UTC+3
  const utcMillis =
    Date.UTC(
      moscow.year,
      moscow.month - 1,
      moscow.day,
      0,
      0,
      0
    ) -
    3 * 60 * 60 * 1000;

  return Math.floor(utcMillis / 1000);
}

function getCurrentUnix() {
  return Math.floor(Date.now() / 1000);
}

function getMoscowDateRange() {
  const now = getMoscowNow();

  const from = getMoscowDateStartUnix();
  const to = getCurrentUnix();

  const startOfDay = {
    ...now,
    hour: 0,
    minute: 0,
    second: 0,
  };

  return {
    from,
    to,
    from_text: formatMoscowDate(startOfDay),
    to_text: formatMoscowDate(now),
  };
}

function getWebhookId(body) {
  return (
    body.id ||
    body.event_id ||
    body.request_id ||
    body._embedded?.request?.id ||
    null
  );
}

function isWebhookAlreadyProcessed(body) {
  const webhookId = getWebhookId(body);

  if (!webhookId) {
    return false;
  }

  const now = Date.now();

  for (const [id, timestamp] of processedWebhookIds.entries()) {
    if (now - timestamp > WEBHOOK_CACHE_TTL) {
      processedWebhookIds.delete(id);
    }
  }

  if (processedWebhookIds.has(String(webhookId))) {
    return true;
  }

  processedWebhookIds.set(String(webhookId), now);
  return false;
}

function normalizeApiError(service, error) {
  logApiError(service, error);

  const message = getErrorMessage(error);
  return new Error(`${service}: ${message}`);
}

// ============================================================
// AMOCRM OAUTH
// ============================================================

async function exchangeAmoCrmCode(code) {
  const response = await http.post(
    `${AMOCRM_BASE_URL}/oauth2/access_token`,
    {
      client_id: AMOCRM_CLIENT_ID,
      client_secret: AMOCRM_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: AMOCRM_REDIRECT_URI,
    }
  );

  amoCrmAccessToken =
    response.data.access_token || "";

  amoCrmRefreshToken =
    response.data.refresh_token || "";

  return {
    accessToken: Boolean(amoCrmAccessToken),
    refreshToken: Boolean(amoCrmRefreshToken),
  };
}

async function refreshAmoCrmToken() {
  if (
    !AMOCRM_CLIENT_ID ||
    !AMOCRM_CLIENT_SECRET ||
    !amoCrmRefreshToken
  ) {
    console.error(
      "Недостаточно данных для обновления amoCRM токена"
    );

    return false;
  }

  if (amoCrmRefreshPromise) {
    return amoCrmRefreshPromise;
  }

  amoCrmRefreshPromise = (async () => {
    try {
      const response = await http.post(
        `${AMOCRM_BASE_URL}/oauth2/access_token`,
        {
          client_id: AMOCRM_CLIENT_ID,
          client_secret: AMOCRM_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: amoCrmRefreshToken,
          redirect_uri: AMOCRM_REDIRECT_URI,
        }
      );

      amoCrmAccessToken =
        response.data.access_token || "";

      amoCrmRefreshToken =
        response.data.refresh_token || amoCrmRefreshToken;

      console.log("amoCRM токен успешно обновлён");

      return Boolean(amoCrmAccessToken);
    } catch (error) {
      logApiError("amoCRM token refresh", error);
      return false;
    } finally {
      amoCrmRefreshPromise = null;
    }
  })();

  return amoCrmRefreshPromise;
}

// ============================================================
// AMOMESSENGER OAUTH
// ============================================================

async function exchangeAmoMessengerCode(code) {
  const response = await http.post(
    `${AMOMESSENGER_ID_URL}/oauth2/access_token`,
    {
      client_id: AMOMESSENGER_CLIENT_ID,
      client_secret: AMOMESSENGER_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: AMOMESSENGER_REDIRECT_URI,
    }
  );

  amoMessengerAccessToken =
    response.data.access_token || "";

  amoMessengerRefreshToken =
    response.data.refresh_token || "";

  return {
    accessToken: Boolean(amoMessengerAccessToken),
    refreshToken: Boolean(amoMessengerRefreshToken),
  };
}

// ============================================================
// API REQUESTS
// ============================================================

async function amoCrmRequest(method, url, options = {}) {
  if (!amoCrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан. Сначала выполните OAuth amoCRM."
    );
  }

  const requestConfig = {
    method,
    url,
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${amoCrmAccessToken}`,
      "Content-Type": "application/json",
      Accept: "application/hal+json",
    },
  };

  try {
    return await http.request(requestConfig);
  } catch (error) {
    if (
      error.response?.status !== 401 ||
      !amoCrmRefreshToken
    ) {
      throw normalizeApiError("amoCRM", error);
    }

    console.log("Токен amoCRM истёк. Обновляем токен...");

    const refreshed = await refreshAmoCrmToken();

    if (!refreshed) {
      throw normalizeApiError("amoCRM", error);
    }

    return http.request({
      ...requestConfig,
      headers: {
        ...requestConfig.headers,
        Authorization: `Bearer ${amoCrmAccessToken}`,
      },
    });
  }
}

async function amoMessengerRequest(
  method,
  url,
  data = undefined
) {
  if (!amoMessengerAccessToken) {
    throw new Error("Токен amoMessenger не найден.");
  }

  try {
    return await http.request({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${amoMessengerAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw normalizeApiError("amoMessenger", error);
  }
}

// ============================================================
// OAUTH ROUTES
// ============================================================

app.get("/oauth/amocrm", (req, res) => {
  if (!AMOCRM_CLIENT_ID) {
    return res
      .status(500)
      .send("AMOCRM_CLIENT_ID не задан.");
  }

  const url =
    `${AMOCRM_BASE_URL}/oauth` +
    `?client_id=${encodeURIComponent(AMOCRM_CLIENT_ID)}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(AMOCRM_REDIRECT_URI)}`;

  res.redirect(url);
});

app.get("/oauth/amocrm/callback", async (req, res) => {
  try {
    const {
      code,
      error,
      error_description,
    } = req.query;

    if (error) {
      return res
        .status(400)
        .send(
          `Ошибка авторизации amoCRM: ${
            error_description || error
          }`
        );
    }

    if (!code) {
      return res
        .status(400)
        .send("Код авторизации amoCRM не получен.");
    }

    const result = await exchangeAmoCrmCode(code);

    res.send(`
      <h2>Авторизация amoCRM завершена</h2>
      <p>Access Token: ${
        result.accessToken ? "получен" : "не получен"
      }</p>
      <p>Refresh Token: ${
        result.refreshToken ? "получен" : "не получен"
      }</p>
      <p>Токены сохранены в памяти текущего процесса.</p>
    `);
  } catch (error) {
    logApiError("OAuth amoCRM", error);

    res
      .status(500)
      .send("Ошибка обмена кода amoCRM на токен.");
  }
});

app.get("/oauth/amomessenger", (req, res) => {
  if (!AMOMESSENGER_CLIENT_ID) {
    return res
      .status(500)
      .send("AMOMESSENGER_CLIENT_ID не задан.");
  }

  const url =
    `${AMOMESSENGER_ID_URL}/oauth2/authorize` +
    `?client_id=${encodeURIComponent(
      AMOMESSENGER_CLIENT_ID
    )}` +
    "&response_type=code" +
    `&redirect_uri=${encodeURIComponent(
      AMOMESSENGER_REDIRECT_URI
    )}`;

  res.redirect(url);
});

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    try {
      const {
        code,
        error,
        error_description,
      } = req.query;

      if (error) {
        return res
          .status(400)
          .send(
            `Ошибка авторизации amoMessenger: ${
              error_description || error
            }`
          );
      }

      if (!code) {
        return res
          .status(400)
          .send(
            "Код авторизации amoMessenger не получен."
          );
      }

      const result =
        await exchangeAmoMessengerCode(code);

      res.send(`
        <h2>Авторизация amoMessenger завершена</h2>
        <p>Access Token: ${
          result.accessToken ? "получен" : "не получен"
        }</p>
        <p>Refresh Token: ${
          result.refreshToken ? "получен" : "не получен"
        }</p>
        <p>Токены сохранены в памяти текущего процесса.</p>
      `);
    } catch (error) {
      logApiError("OAuth amoMessenger", error);

      res
        .status(500)
        .send(
          "Ошибка обмена кода amoMessenger на токен."
        );
    }
  }
);

// ============================================================
// SERVICE ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "amoMessenger bot",
    timezone: MOSCOW_TIMEZONE,
    amoMessengerToken: tokenStatus(
      amoMessengerAccessToken
    ),
    amoCrmToken: tokenStatus(amoCrmAccessToken),
  });
});

app.get("/debug/amocrm-token", async (req, res) => {
  try {
    if (!amoCrmAccessToken) {
      return res.status(401).json({
        status: "Ошибка",
        message: "AMOCRM_ACCESS_TOKEN не задан.",
      });
    }

    const response = await amoCrmRequest(
      "GET",
      `${AMOCRM_BASE_URL}/api/v4/account`
    );

    res.json({
      status: "OK",
      account: response.data,
    });
  } catch (error) {
    res.status(500).json({
      status: "Ошибка",
      message: error.message,
    });
  }
});

app.get("/debug/task/:taskId", async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({
        status: "Ошибка",
        message: "Неверный taskId.",
      });
    }

    const response = await amoCrmRequest(
      "GET",
      `${AMOCRM_BASE_URL}/api/v4/tasks/${taskId}`
    );

    const task = response.data;

    res.json({
      status: "OK",
      task_id: task.id,
      entity_id: task.entity_id,
      entity_type: task.entity_type,
      task_type_id: task.task_type_id,
      is_completed: task.is_completed,
      complete_till: task.complete_till,
      complete_till_moscow: formatUnixMoscow(
        task.complete_till
      ),
      raw: task,
    });
  } catch (error) {
    res.status(500).json({
      status: "Ошибка",
      message: error.message,
    });
  }
});

// ============================================================
// ПОМОЩНИКИ ПОИСКА
// ============================================================

function isValidMeasurementTask(task, range) {
  return (
    task.entity_type === "leads" &&
    Number(task.task_type_id) ===
      MEASUREMENT_TASK_TYPE_ID &&
    task.is_completed === false &&
    Number(task.complete_till) >= range.from &&
    Number(task.complete_till) <= range.to
  );
}

function getEngineerFieldValue(lead) {
  const field = (
    lead.custom_fields_values || []
  ).find(
    item =>
      Number(item.field_id) === ENGINEER_FIELD_ID
  );

  return field?.values?.[0] || null;
}

function hasRequiredEngineer(lead) {
  const value = getEngineerFieldValue(lead);

  if (!value) {
    return false;
  }

  return (
    Number(value.enum_id) === ENGINEER_ENUM_ID ||
    String(value.value || "").trim() === ENGINEER_NAME
  );
}

async function mapWithConcurrency(
  items,
  limit,
  handler
) {
  const results = [];
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await handler(items[index]);
      } catch (error) {
        results[index] = null;
        console.error("Ошибка параллельной операции:", {
          index,
          message: error.message,
        });
      }
    }
  }

  const workers = Array.from(
    {
      length: Math.min(limit, items.length),
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

async function loadMeasurementTasks(range) {
  const allTasks = [];

  for (
    let page = 1;
    page <= MAX_TASK_PAGES;
    page++
  ) {
    const params = {
      "filter[entity_type]": "leads",
      "filter[is_completed][]": 0,
      "filter[task_type][]":
        MEASUREMENT_TASK_TYPE_ID,
      "filter[complete_till][from]": range.from,
      "filter[complete_till][to]": range.to,
      limit: TASK_PAGE_LIMIT,
      page,
      "order[complete_till]": "asc",
    };

    const response = await amoCrmRequest(
      "GET",
      `${AMOCRM_BASE_URL}/api/v4/tasks`,
      { params }
    );

    const tasks =
      response.status === 204
        ? []
        : response.data?._embedded?.tasks || [];

    if (tasks.length === 0) {
      break;
    }

    allTasks.push(...tasks);

    if (tasks.length < TASK_PAGE_LIMIT) {
      break;
    }
  }

  return allTasks;
}

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurementTasks() {
  const moscowNow = getMoscowNow();
  const range = getMoscowDateRange();

  log("ПОИСК ЗАМЕРОВ", {
    engineer: ENGINEER_NAME,
    engineerFieldId: ENGINEER_FIELD_ID,
    engineerEnumId: ENGINEER_ENUM_ID,
    taskTypeId: MEASUREMENT_TASK_TYPE_ID,
    range,
  });

  const allTasks = await loadMeasurementTasks(range);

  const validTasks = allTasks.filter(task =>
    isValidMeasurementTask(task, range)
  );

  const measurements = (
    await mapWithConcurrency(
      validTasks,
      LEAD_REQUEST_CONCURRENCY,
      async task => {
        if (!task.entity_id) {
          return null;
        }

        try {
          const response = await amoCrmRequest(
            "GET",
            `${AMOCRM_BASE_URL}/api/v4/leads/${task.entity_id}`
          );

          const lead = response.data;
          const engineerValue =
            getEngineerFieldValue(lead);

          const engineerFound =
            hasRequiredEngineer(lead);

          console.log("Проверка сделки", {
            leadId: lead.id,
            engineer: engineerValue?.value || null,
            engineerFound,
          });

          if (!engineerFound) {
            return null;
          }

          return {
            task_id: task.id,
            entity_id: lead.id,
            lead_name:
              lead.name || `Сделка #${lead.id}`,
            complete_till: task.complete_till,
            complete_till_moscow:
              formatUnixMoscow(task.complete_till),
            engineer: ENGINEER_NAME,
            engineer_field_id: ENGINEER_FIELD_ID,
            engineer_enum_id: ENGINEER_ENUM_ID,
            lead_url:
              `${AMOCRM_BASE_URL}/leads/detail/${lead.id}`,
          };
        } catch (error) {
          console.error("Ошибка получения сделки", {
            leadId: task.entity_id,
            message: error.message,
          });

          return null;
        }
      }
    )
  ).filter(Boolean);

  return {
    timezone: MOSCOW_TIMEZONE,
    current_moscow_time:
      formatMoscowDate(moscowNow),
    engineer: {
      name: ENGINEER_NAME,
      field_id: ENGINEER_FIELD_ID,
      enum_id: ENGINEER_ENUM_ID,
    },
    task_type_id: MEASUREMENT_TASK_TYPE_ID,
    date_mode: "с начала дня до текущего времени",
    date_range: {
      from: range.from_text,
      to: range.to_text,
    },
    tasks_loaded: allTasks.length,
    valid_tasks: validTasks.length,
    found_count: measurements.length,
    measurements,
  };
}

app.get("/debug/tasks-test", async (req, res) => {
  try {
    if (!amoCrmAccessToken) {
      return res.status(401).json({
        status: "Ошибка",
        message:
          "AMOCRM_ACCESS_TOKEN не задан. Откройте /oauth/amocrm.",
      });
    }

    const result = await findMeasurementTasks();

    res.json({
      status: "OK",
      ...result,
    });
  } catch (error) {
    console.error("DEBUG TASK ERROR", error);

    res.status(500).json({
      status: "Ошибка",
      message: error.message,
    });
  }
});

// ============================================================
// AMOMESSENGER
// ============================================================

function getMessengerRequestUrl(
  botId,
  requestId,
  action
) {
  return (
    `${AMOMESSENGER_BASE_URL}/v1.3/bots/` +
    `${encodeURIComponent(botId)}/request/` +
    `${encodeURIComponent(requestId)}/${action}`
  );
}

async function sendBotMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  buttons = null
) {
  if (!botId || !requestId || !receiverUserId) {
    throw new Error(
      "Недостаточно данных для отправки сообщения."
    );
  }

  const body = {
    text: String(text || ""),
    receiver: {
      user_id: receiverUserId,
    },
  };

  if (Array.isArray(buttons) && buttons.length > 0) {
    body.reply_markup = {
      inline_keyboard: {
        buttons,
      },
    };
  }

  const url = getMessengerRequestUrl(
    botId,
    requestId,
    "sendMessage"
  );

  console.log("Отправка сообщения amoMessenger", {
    botId,
    requestId,
    receiverUserId,
    textLength: body.text.length,
  });

  return amoMessengerRequest("POST", url, body);
}

async function returnControl(botId, requestId) {
  if (!botId || !requestId) {
    console.error(
      "Невозможно вернуть управление: отсутствует botId или requestId."
    );

    return;
  }

  try {
    const url = getMessengerRequestUrl(
      botId,
      requestId,
      "returnControl"
    );

    await amoMessengerRequest(
      "POST",
      url,
      {
        return_code: "success",
      }
    );

    console.log("Управление возвращено amoMessenger");
  } catch (error) {
    console.error(
      "Ошибка возврата управления:",
      error.message
    );
  }
}

function buildMeasurementsMessage(measurements) {
  const lines = [
    "📋 Найдены замеры для подтверждения:",
    "",
  ];

  measurements.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.lead_name}`,
      `Задача: ${item.task_id}`,
      `Сделка: ${item.entity_id}`,
      `Срок: ${item.complete_till_moscow}`,
      item.lead_url,
      ""
    );
  });

  return lines.join("\n");
}

async function handleBotAction({
  botId,
  requestId,
  receiverUserId,
  processingText,
  action,
}) {
  try {
    await sendBotMessage(
      botId,
      requestId,
      receiverUserId,
      processingText
    );

    await action();
  } catch (error) {
    console.error("Ошибка обработки действия бота", {
      message: error.message,
      stack: error.stack,
    });

    try {
      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        `❗ Произошла ошибка:\n${error.message}`
      );
    } catch (sendError) {
      console.error(
        "Ошибка отправки сообщения об ошибке:",
        sendError.message
      );
    }
  } finally {
    await returnControl(botId, requestId);
  }
}

function getTransferredData(body) {
  const transferred =
    body._embedded?.rpa_bot_control_transferred;

  const request =
    transferred?._embedded?.request;

  const context =
    body._embedded?.context || {};

  const botId = transferred?.bot_id;
  const requestId = request?.id;

  const receiverUserId =
    request?.author_id ||
    context.user_id;

  return {
    botId,
    requestId,
    receiverUserId,
  };
}

function getIncomeMessageData(body) {
  const income =
    body._embedded?.rpa_bot_income_message;

  const message =
    income?._embedded?.income_message;

  const request =
    income?._embedded?.request;

  const context =
    body._embedded?.context || {};

  const botId = income?.bot_id;
  const requestId = request?.id;

  const text = String(message?.text || "");

  const receiverUserId =
    message?.author?.user_id ||
    request?.author_id ||
    context.user_id;

  return {
    botId,
    requestId,
    receiverUserId,
    text,
  };
}

// ============================================================
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
  "/webhook/amomessenger",
  (req, res) => {
    // Быстрый ответ amoMessenger
    res.status(200).json({ status: "ok" });

    void processMessengerWebhook(req.body);
  }
);

async function processMessengerWebhook(body) {
  try {
    if (!body || typeof body !== "object") {
      console.error("Некорректное тело webhook.");
      return;
    }

    if (isWebhookAlreadyProcessed(body)) {
      console.log("Дубликат webhook пропущен.");
      return;
    }

    const eventType = body.event_type;

    log("AMOMESSENGER WEBHOOK", {
      eventType,
      webhookId: getWebhookId(body),
    });

    if (
      eventType ===
      "rpa_bot_control_transferred"
    ) {
      const {
        botId,
        requestId,
        receiverUserId,
      } = getTransferredData(body);

      if (
        !botId ||
        !requestId ||
        !receiverUserId
      ) {
        console.error(
          "Недостаточно данных для control_transferred."
        );
        return;
      }

      await sendBotMessage(
        botId,
        requestId,
        receiverUserId,
        "Выберите задачу для выполнения:",
        [
          { text: "Подтвердить замер" },
          { text: "Провести замер" },
          { text: "Загрузить фотоотчет" },
          { text: "Внести правки" },
        ]
      );

      return;
    }

    if (
      eventType !==
      "rpa_bot_income_message"
    ) {
      console.log(
        "Необрабатываемый тип события:",
        eventType
      );
      return;
    }

    const {
      botId,
      requestId,
      receiverUserId,
      text,
    } = getIncomeMessageData(body);

    if (
      !botId ||
      !requestId ||
      !receiverUserId
    ) {
      console.error(
        "Недостаточно данных для income_message."
      );
      return;
    }

    const selectedAction = text.trim();

    if (
      selectedAction === MEASUREMENT_TASK_NAME
    ) {
      await handleBotAction({
        botId,
        requestId,
        receiverUserId,
        processingText:
          "⏳ Проверяю задачи на подтверждение замера...",
        action: async () => {
          if (!amoCrmAccessToken) {
            throw new Error(
              "Не настроена авторизация amoCRM. Откройте /oauth/amocrm и повторите попытку."
            );
          }

          const result =
            await findMeasurementTasks();

          if (result.found_count === 0) {
            await sendBotMessage(
              botId,
              requestId,
              receiverUserId,
              "📋 Замеров для подтверждения не найдено."
            );

            return;
          }

          await sendBotMessage(
            botId,
            requestId,
            receiverUserId,
            buildMeasurementsMessage(
              result.measurements
            )
          );
        },
      });

      return;
    }

    const developmentActions = {
      "Провести замер":
        "Функция «Провести замер» пока находится в разработке.",
      "Загрузить фотоотчет":
        "Функция «Загрузить фотоотчет» пока находится в разработке.",
      "Внести правки":
        "Функция «Внести правки» пока находится в разработке.",
    };

    if (developmentActions[selectedAction]) {
      await handleBotAction({
        botId,
        requestId,
        receiverUserId,
        processingText:
          developmentActions[selectedAction],
        action: async () => {},
      });
    }
  } catch (error) {
    console.error("WEBHOOK ERROR", {
      message: error.message,
      stack: error.stack,
    });
  }
}

// ============================================================
// ОБРАБОТКА ОШИБОК EXPRESS
// ============================================================

app.use((error, req, res, next) => {
  console.error("EXPRESS ERROR", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    status: "Ошибка",
    message: "Внутренняя ошибка сервера.",
  });
});

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(PORT, () => {
  console.log("==========================================");
  console.log("amoMessenger bot запущен");
  console.log("PORT:", PORT);
  console.log("AMOCRM:", AMOCRM_BASE_URL);
  console.log(
    "amoCRM token:",
    tokenStatus(amoCrmAccessToken)
  );
  console.log(
    "amoMessenger token:",
    tokenStatus(amoMessengerAccessToken)
  );
  console.log("==========================================");
});
