const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

const AMOCRM_SUBDOMAIN = "zlmk";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

// amoCRM OAuth
const AMOCRM_CLIENT_ID =
  process.env.AMOCRM_CLIENT_ID || "";

const AMOCRM_CLIENT_SECRET =
  process.env.AMOCRM_CLIENT_SECRET || "";

const AMOCRM_REDIRECT_URI =
  process.env.AMOCRM_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/amocrm/callback";

// Секрет для временного debug-эндпоинта, который отдаёт токены.
// ОБЯЗАТЕЛЬНО задайте DEBUG_SECRET в Environment Variables на Render
// перед использованием /debug/tokens, и удалите/отключите этот
// эндпоинт после того, как заберёте токены.
const DEBUG_SECRET = process.env.DEBUG_SECRET || "";

// ============================================================
// ПОСТОЯННЫЕ ЗНАЧЕНИЯ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Часовой пояс Москвы
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

// ============================================================
// ХРАНИЛИЩЕ ТОКЕНОВ
// ============================================================

// ВАЖНО:
// На бесплатном Render локальный файл может исчезнуть после перезапуска,
// а память процесса очищается при каждом рестарте/деплое.
// Поэтому для постоянной работы токены нужно сохранять в Environment
// Variables (или во внешнее хранилище — БД/Redis), иначе после каждого
// рестарта потребуется заново проходить авторизацию.

let amomessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amomessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

let amocrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amocrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function log(title, data) {
  console.log("");
  console.log("==========================================");
  console.log(title);

  if (data !== undefined) {
    if (typeof data === "string") {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  console.log("==========================================");
}

function getMoscowDate() {
  const now = new Date();

  // Получаем UTC-время и добавляем +3 часа.
  // ВАЖНО: у получившегося объекта Date поля getUTCFullYear/getUTCMonth/
  // getUTCDate/getUTCHours и т.д. фактически представляют московское
  // время (хотя формально это UTC-геттеры). Это используется ниже.
  return new Date(now.getTime() + MOSCOW_OFFSET_MS);
}

function formatMoscow(date) {
  const d = new Date(date);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");

  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");

  return `${day}.${month}.${year}, ${hours}:${minutes}:${seconds}`;
}

function moscowToUnix(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function unixToMoscow(unix) {
  if (!unix) return null;

  return formatMoscow(new Date(Number(unix) * 1000));
}

// ИСПРАВЛЕНО:
// Раньше функция брала "московские" год/месяц/день из getMoscowDate()
// и снова оборачивала их в Date.UTC(...), из-за чего получалась
// полночь UTC, а не полночь по Москве — диапазон дат сдвигался на
// 3 часа вперёд и мог "срезать" пограничные задачи.
function todayMoscowStartUnix() {
  const now = getMoscowDate();

  const startUtcMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0
  );

  // startUtcMs — это полночь календарного дня в "смещённых" полях,
  // поэтому нужно вычесть обратно московское смещение, чтобы получить
  // настоящий Unix-момент полуночи по Москве.
  return Math.floor((startUtcMs - MOSCOW_OFFSET_MS) / 1000);
}

function yesterdayMoscowStartUnix() {
  return todayMoscowStartUnix() - 24 * 60 * 60;
}

function getCurrentMoscowUnix() {
  return Math.floor(Date.now() / 1000);
}

// ============================================================
// ПОЛУЧЕНИЕ AMOCRM ACCESS TOKEN
// ============================================================

async function refreshAmoCrmToken() {
  if (!amocrmRefreshToken) {
    throw new Error(
      "AMOCRM_REFRESH_TOKEN не задан"
    );
  }

  log("Обновляем токен amoCRM");

  const url =
    "https://" +
    AMOCRM_SUBDOMAIN +
    ".amocrm.ru/oauth2/access_token";

  try {
    const response = await axios.post(
      url,
      {
        client_id: AMOCRM_CLIENT_ID,
        client_secret: AMOCRM_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: amocrmRefreshToken,
        redirect_uri: AMOCRM_REDIRECT_URI
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    amocrmAccessToken = response.data.access_token;

    if (response.data.refresh_token) {
      amocrmRefreshToken = response.data.refresh_token;
    }

    console.log("amoCRM access token обновлён.");

    return amocrmAccessToken;
  } catch (error) {
    console.error(
      "Ошибка обновления amoCRM token:",
      error.response
        ? JSON.stringify(error.response.data)
        : error.message
    );

    throw error;
  }
}

// ============================================================
// GET amoCRM
// ============================================================

async function amoCrmGet(url, params) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        Authorization: `Bearer ${amocrmAccessToken}`,
        Accept: "application/hal+json"
      },
      timeout: 60000,
      validateStatus: () => true
    });

    if (response.status === 401) {
      console.log(
        "amoCRM вернул 401. Пробуем обновить токен..."
      );

      try {
        await refreshAmoCrmToken();

        const retry = await axios.get(url, {
          params,
          headers: {
            Authorization: `Bearer ${amocrmAccessToken}`,
            Accept: "application/hal+json"
          },
          timeout: 60000,
          validateStatus: () => true
        });

        return retry;
      } catch (refreshError) {
        return response;
      }
    }

    return response;
  } catch (error) {
    console.error(
      "amoCRM GET ERROR:",
      error.message
    );

    throw error;
  }
}

// ============================================================
// AMOMESSENGER API
// ============================================================

async function amoMessengerPost(
  botId,
  requestId,
  method,
  body
) {
  if (!amomessengerAccessToken) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}` +
    `/request/${requestId}/${method}`;

  console.log("");
  console.log("amoMessenger POST");
  console.log(url);
  console.log("BODY:");
  console.log(JSON.stringify(body, null, 2));

  try {
    const response = await axios.post(
      url,
      body,
      {
        headers: {
          Authorization:
            `Bearer ${amomessengerAccessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

    console.log(
      "amoMessenger response:",
      response.status,
      response.data
    );

    if (
      response.status === 401 ||
      response.status === 403
    ) {
      console.log(
        "amoMessenger token недействителен."
      );
    }

    if (response.status >= 400) {
      throw new Error(
        `amoMessenger HTTP ${response.status}`
      );
    }

    return response;
  } catch (error) {
    console.error(
      "amoMessenger POST ERROR:",
      error.message
    );

    throw error;
  }
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ
// ============================================================

async function sendMessengerMessage(
  botId,
  requestId,
  receiverUserId,
  text,
  buttons = null
) {
  const body = {
    text,
    receiver: {
      user_id: receiverUserId
    }
  };

  if (buttons) {
    body.reply_markup = {
      inline_keyboard: {
        buttons: buttons.map((text) => ({
          text
        }))
      }
    };
  }

  return amoMessengerPost(
    botId,
    requestId,
    "sendMessage",
    body
  );
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMOMESSENGER
// ============================================================

async function returnControl(
  botId,
  requestId
) {
  try {
    console.log(
      "Возвращаем управление amoMessenger..."
    );

    await amoMessengerPost(
      botId,
      requestId,
      "returnControl",
      {
        return_code: "success"
      }
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
}

// ============================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(leadId) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;

  const response = await amoCrmGet(
    url,
    {
      with: "contacts"
    }
  );

  if (response.status !== 200) {
    console.log(
      `Не удалось получить сделку ${leadId}:`,
      response.status
    );

    return null;
  }

  return response.data;
}

// ============================================================
// ПОИСК ЗНАЧЕНИЯ ПОЛЯ ИНЖЕНЕР
// ============================================================

function getEngineerFieldValue(lead) {
  if (
    !lead ||
    !Array.isArray(lead.custom_fields_values)
  ) {
    return null;
  }

  const field = lead.custom_fields_values.find(
    (item) =>
      Number(item.field_id) ===
      Number(ENGINEER_FIELD_ID)
  );

  if (!field) {
    return null;
  }

  if (
    !Array.isArray(field.values) ||
    field.values.length === 0
  ) {
    return null;
  }

  return field.values
    .map((v) => {
      if (
        v.enum_id !== undefined &&
        v.enum_id !== null
      ) {
        return {
          value: v.value,
          enum_id: Number(v.enum_id)
        };
      }

      return {
        value: v.value,
        enum_id: null
      };
    });
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

// ИСПРАВЛЕНО: сравнение по имени теперь без учёта регистра и лишних
// пробелов (раньше расхождение в регистре или пробелах в конце строки
// приводило к тому, что подходящая сделка не находилась).
function leadBelongsToEngineer(lead) {
  const values = getEngineerFieldValue(lead);

  if (!values) {
    return false;
  }

  const normalizedEngineerName = ENGINEER_NAME
    .trim()
    .toLowerCase();

  return values.some((item) => {
    if (
      item.enum_id !== null &&
      Number(item.enum_id) ===
        Number(ENGINEER_ENUM_ID)
    ) {
      return true;
    }

    if (item.value) {
      const normalizedValue = String(item.value)
        .trim()
        .toLowerCase();

      if (normalizedValue === normalizedEngineerName) {
        return true;
      }
    }

    return false;
  });
}

// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ЗАДАЧ
//
// ВАЖНО:
// Здесь специально НЕТ фильтров:
// is_completed
// task_type
// complete_till
//
// Это сделано для диагностики.
// Сначала получаем задачи, потом фильтруем их сами.
// ============================================================

async function loadTasksDiagnostic() {
  const allTasks = [];

  let page = 1;

  while (true) {
    const url =
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

    const params = {
      limit: 250,
      page
    };

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      `ЗАГРУЗКА ЗАДАЧ. СТРАНИЦА ${page}`
    );
    console.log(
      "=========================================="
    );

    const response = await amoCrmGet(
      url,
      params
    );

    console.log(
      "amoCRM tasks response:",
      response.status
    );

    if (response.status === 204) {
      console.log(
        "amoCRM вернул 204 — задач больше нет."
      );

      break;
    }

    if (response.status !== 200) {
      console.error(
        "Ошибка получения задач:",
        response.status,
        response.data
      );

      throw new Error(
        `amoCRM tasks HTTP ${response.status}`
      );
    }

    const tasks =
      response.data &&
      Array.isArray(response.data._embedded?.tasks)
        ? response.data._embedded.tasks
        : [];

    console.log(
      `Получено задач на странице ${page}: ${tasks.length}`
    );

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    // Защита от бесконечного цикла
    if (page > 20) {
      console.log(
        "Остановлено после 20 страниц."
      );

      break;
    }
  }

  console.log("");
  console.log(
    `ВСЕГО ЗАГРУЖЕНО ЗАДАЧ: ${allTasks.length}`
  );

  return allTasks;
}

// ============================================================
// ФИЛЬТРАЦИЯ ЗАДАЧ
// ============================================================

async function findMeasurementTasks() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log("ПОИСК ЗАМЕРОВ");
  console.log(
    `Инженер: ${ENGINEER_NAME}`
  );
  console.log(
    `Поле инженера: ${ENGINEER_FIELD_ID}`
  );
  console.log(
    `ID инженера: ${ENGINEER_ENUM_ID}`
  );
  console.log(
    `Тип задачи: ${MEASUREMENT_TASK_TYPE_ID}`
  );
  console.log(
    "=========================================="
  );

  const nowUnix = getCurrentMoscowUnix();

  // Вчера 00:00 по Москве
  const fromUnix =
    yesterdayMoscowStartUnix();

  console.log(
    "Диапазон Unix:",
    fromUnix,
    "—",
    nowUnix
  );

  console.log(
    "От:",
    unixToMoscow(fromUnix)
  );

  console.log(
    "До:",
    unixToMoscow(nowUnix)
  );

  // ----------------------------------------------------------
  // 1. Получаем задачи без жёстких API-фильтров
  // ----------------------------------------------------------

  const tasks =
    await loadTasksDiagnostic();

  console.log(
    `Всего загружено задач: ${tasks.length}`
  );

  // ----------------------------------------------------------
  // 2. Сначала смотрим задачи типа 2746005
  // ----------------------------------------------------------

  const measurementTypeTasks =
    tasks.filter((task) => {
      return (
        Number(task.task_type_id) ===
        Number(MEASUREMENT_TASK_TYPE_ID)
      );
    });

  console.log(
    `Задач типа ${MEASUREMENT_TASK_TYPE_ID}: ${measurementTypeTasks.length}`
  );

  // ----------------------------------------------------------
  // 3. Незавершённые
  // ----------------------------------------------------------

  const notCompletedTasks =
    measurementTypeTasks.filter((task) => {
      return task.is_completed === false;
    });

  console.log(
    `Незавершённых задач этого типа: ${notCompletedTasks.length}`
  );

  // ----------------------------------------------------------
  // 4. Дата
  // ----------------------------------------------------------

  const dateTasks =
    notCompletedTasks.filter((task) => {
      const till =
        Number(task.complete_till || 0);

      return (
        till >= fromUnix &&
        till <= nowUnix
      );
    });

  console.log(
    `Задач после проверки даты: ${dateTasks.length}`
  );

  // ----------------------------------------------------------
  // ВАЖНАЯ ДИАГНОСТИКА
  // ----------------------------------------------------------

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "ДИАГНОСТИКА ПОДХОДЯЩИХ ЗАДАЧ"
  );
  console.log(
    "=========================================="
  );

  dateTasks.forEach((task) => {
    console.log(
      JSON.stringify(
        {
          id: task.id,
          entity_id: task.entity_id,
          entity_type: task.entity_type,
          task_type_id: task.task_type_id,
          is_completed: task.is_completed,
          complete_till: task.complete_till,
          complete_till_moscow:
            unixToMoscow(task.complete_till),
          text: task.text
        },
        null,
        2
      )
    );
  });

  // ----------------------------------------------------------
  // 5. Проверяем сделки
  // ----------------------------------------------------------

  const measurements = [];

  for (const task of dateTasks) {
    if (
      !task.entity_id ||
      task.entity_type !== "leads"
    ) {
      console.log(
        `Задача ${task.id}: пропуск — нет сделки`
      );

      continue;
    }

    console.log("");
    console.log(
      "Проверяем задачу:",
      task.id
    );

    console.log(
      "Связанная сделка:",
      task.entity_id
    );

    const lead =
      await getLead(task.entity_id);

    if (!lead) {
      console.log(
        "Сделку получить не удалось."
      );

      continue;
    }

    const engineerValues =
      getEngineerFieldValue(lead);

    console.log(
      "Поле инженера сделки:",
      JSON.stringify(
        engineerValues,
        null,
        2
      )
    );

    const belongs =
      leadBelongsToEngineer(lead);

    console.log(
      "Подходит инженер:",
      belongs
    );

    if (!belongs) {
      continue;
    }

    measurements.push({
      task_id: Number(task.id),
      lead_id: Number(task.entity_id),
      lead_name:
        lead.name ||
        `Сделка #${task.entity_id}`,
      task_type_id:
        Number(task.task_type_id),
      complete_till:
        task.complete_till,
      complete_till_moscow:
        unixToMoscow(
          task.complete_till
        ),
      is_completed:
        task.is_completed,
      engineer:
        ENGINEER_NAME,
      lead_link:
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`
    });
  }

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    `ИТОГО ЗАМЕРОВ: ${measurements.length}`
  );
  console.log(
    "=========================================="
  );

  return {
    measurements,
    tasksLoaded: tasks.length,
    validTasks: dateTasks.length
  };
}

// ============================================================
// DEBUG: STATUS
// ============================================================

app.get("/status", (req, res) => {
  res.json({
    status: "OK",
    service: "amoMessenger bot",
    timezone: "Europe/Moscow",
    amomessenger_token:
      amomessengerAccessToken
        ? "ДА"
        : "НЕТ",
    amocrm_token:
      amocrmAccessToken
        ? "ДА"
        : "НЕТ",
    engineer: ENGINEER_NAME,
    engineer_field_id:
      ENGINEER_FIELD_ID,
    engineer_enum_id:
      ENGINEER_ENUM_ID,
    task_type_id:
      MEASUREMENT_TASK_TYPE_ID
  });
});

// ============================================================
// DEBUG: TOKENS (ВРЕМЕННЫЙ ЭНДПОИНТ)
//
// Отдаёт текущие значения токенов, чтобы можно было скопировать их
// в Environment Variables на Render. Защищён секретом DEBUG_SECRET.
//
// ВАЖНО: после того как заберёте токены — удалите этот роут из кода
// или хотя бы очистите переменную DEBUG_SECRET на Render, чтобы никто
// посторонний не смог получить доступ к вашим токенам.
// ============================================================

app.get("/debug/tokens", (req, res) => {
  if (!DEBUG_SECRET) {
    return res.status(500).send(
      "DEBUG_SECRET не задан в Environment Variables. Задайте его, чтобы использовать этот эндпоинт."
    );
  }

  if (req.query.secret !== DEBUG_SECRET) {
    return res.status(403).send("Forbidden");
  }

  res.json({
    amocrm_access_token: amocrmAccessToken || null,
    amocrm_refresh_token: amocrmRefreshToken || null,
    amomessenger_access_token: amomessengerAccessToken || null,
    amomessenger_refresh_token: amomessengerRefreshToken || null
  });
});

// ============================================================
// AMOCRM AUTH
// ============================================================

app.get("/amocrm/auth", (req, res) => {
  if (!AMOCRM_CLIENT_ID) {
    return res.status(500).send(
      "AMOCRM_CLIENT_ID не задан в Environment Variables"
    );
  }

  const url =
    `https://www.amocrm.ru/oauth?` +
    `client_id=${encodeURIComponent(AMOCRM_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(AMOCRM_REDIRECT_URI)}` +
    `&response_type=code` +
    `&mode=post_message`;

  console.log(
    "amoCRM authorization URL:",
    url
  );

  res.redirect(url);
});

// ============================================================
// AMOCRM CALLBACK
// ============================================================

app.get("/amocrm/callback", async (req, res) => {
  const code = req.query.code;

  console.log("");
  console.log(
    "=========================================="
  );
  console.log("AMOCRM OAUTH CALLBACK");
  console.log(
    "=========================================="
  );

  if (!code) {
    return res.status(400).send(
      "Код авторизации amoCRM не получен."
    );
  }

  try {
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
        },
        timeout: 30000
      }
    );

    amocrmAccessToken =
      response.data.access_token;

    amocrmRefreshToken =
      response.data.refresh_token;

    console.log(
      "amoCRM токены успешно получены."
    );

    res.send(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="UTF-8">
        <title>amoCRM OAuth</title>
      </head>
      <body style="font-family:Arial;padding:40px;">
        <h2>Авторизация amoCRM успешно выполнена</h2>

        <p>
          Access Token получен:
          <b>ДА</b>
        </p>

        <p>
          Refresh Token получен:
          <b>ДА</b>
        </p>

        <p>
          Теперь можно закрыть это окно.
        </p>

        <p>
          <a href="/amocrm/status">
            Проверить статус
          </a>
        </p>

        <p>
          <a href="/debug/tasks-test">
            Проверить задачи
          </a>
        </p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(
      "AMOCRM OAuth ERROR:",
      error.response
        ? error.response.data
        : error.message
    );

    res.status(500).json({
      status: "Ошибка",
      message:
        error.response?.data ||
        error.message
    });
  }
});

// ============================================================
// AMOCRM STATUS
// ============================================================

app.get("/amocrm/status", (req, res) => {
  res.json({
    status: "OK",

    amocrm_access_token:
      amocrmAccessToken
        ? "ДА"
        : "НЕТ",

    amocrm_refresh_token:
      amocrmRefreshToken
        ? "ДА"
        : "НЕТ",

    subdomain:
      AMOCRM_SUBDOMAIN,

    engineer:
      ENGINEER_NAME,

    engineer_field_id:
      ENGINEER_FIELD_ID,

    engineer_enum_id:
      ENGINEER_ENUM_ID,

    task_type_id:
      MEASUREMENT_TASK_TYPE_ID
  });
});

// ============================================================
// DEBUG TASKS
// ============================================================

app.get(
  "/debug/tasks-test",
  async (req, res) => {
    try {
      if (!amocrmAccessToken) {
        return res.status(500).json({
          status: "Ошибка",
          message:
            "AMOCRM_ACCESS_TOKEN не задан в Environment Variables и авторизация amoCRM ещё не выполнена."
        });
      }

      const now =
        getMoscowDate();

      const nowUnix =
        getCurrentMoscowUnix();

      const fromUnix =
        yesterdayMoscowStartUnix();

      const result =
        await findMeasurementTasks();

      res.json({
        status: "OK",

        timezone:
          "Europe/Moscow",

        current_moscow_time:
          formatMoscow(now),

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
            formatMoscow(
              new Date(
                fromUnix * 1000
              )
            ),

          to:
            formatMoscow(
              new Date(
                nowUnix * 1000
              )
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
      console.error(
        "DEBUG TASKS ERROR:",
        error.response
          ? error.response.data
          : error.stack
      );

      res.status(500).json({
        status: "Ошибка",

        message:
          error.response?.data ||
          error.message,

        stack:
          error.stack
      });
    }
  }
);

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
        "AMOMESSENGER_CLIENT_ID не задан"
      );
    }

    const url =
      "https://id.amo.tm/oauth2/authorize?" +
      `client_id=${encodeURIComponent(
        AMOMESSENGER_CLIENT_ID
      )}` +
      `&redirect_uri=${encodeURIComponent(
        AMOMESSENGER_REDIRECT_URI
      )}` +
      `&response_type=code`;

    console.log(
      "amoMessenger OAuth URL:",
      url
    );

    res.redirect(url);
  }
);

// ============================================================
// AMOMESSENGER OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {
    const code =
      req.query.code;

    if (!code) {
      return res.status(400).send(`
        <h2>Ошибка OAuth</h2>
        <p>Код авторизации не получен.</p>
      `);
    }

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "OAUTH AMOMESSENGER"
    );
    console.log(
      "Обмениваем authorization code на token"
    );
    console.log(
      "=========================================="
    );

    try {
      const response =
        await axios.post(
          "https://id.amo.tm/oauth2/access_token",
          {
            grant_type:
              "authorization_code",

            client_id:
              AMOMESSENGER_CLIENT_ID,

            client_secret:
              AMOMESSENGER_CLIENT_SECRET,

            redirect_uri:
              AMOMESSENGER_REDIRECT_URI,

            code
          },
          {
            headers: {
              "Content-Type":
                "application/json"
            },
            timeout: 30000
          }
        );

      console.log(
        "OAuth HTTP:",
        response.status
      );

      amomessengerAccessToken =
        response.data.access_token;

      amomessengerRefreshToken =
        response.data.refresh_token;

      console.log(
        "amoMessenger токены сохранены."
      );

      res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="UTF-8">
          <title>amoMessenger OAuth</title>
        </head>

        <body style="font-family:Arial;padding:40px;">

          <h2>
            Авторизация amoMessenger успешно выполнена
          </h2>

          <p>
            Access Token получен:
            <b>ДА</b>
          </p>

          <p>
            Refresh Token получен:
            <b>ДА</b>
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
        "OAuth amoMessenger ERROR:",
        error.response
          ? error.response.data
          : error.message
      );

      res.status(500).json({
        status: "Ошибка OAuth",
        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// AMOMESSENGER STATUS
// ============================================================

app.get(
  "/oauth/amomessenger/status",
  (req, res) => {
    res.json({
      status:
        amomessengerAccessToken
          ? "OK"
          : "Токен не найден",

      access_token:
        amomessengerAccessToken
          ? "ДА"
          : "НЕТ",

      refresh_token:
        amomessengerRefreshToken
          ? "ДА"
          : "НЕТ"
    });
  }
);

// ============================================================
// AMOMESSENGER WEBHOOK
// ============================================================

app.post(
  "/",
  async (req, res) => {
    const body =
      req.body || {};

    console.log("");
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

    // Сразу отвечаем amoMessenger.
    res.status(200).json({
      status: "OK"
    });

    try {
      const eventType =
        body.event_type;

      // --------------------------------------------------------
      // CONTROL TRANSFERRED
      // --------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        const data =
          body._embedded
            ?.rpa_bot_control_transferred;

        const nested =
          data?._embedded;

        const context =
          body._embedded
            ?.context;

        const request =
          nested?.request;

        const botId =
          data?.bot_id;

        const requestId =
          request?.id;

        const requestAuthorId =
          request?.author_id;

        const contextUserId =
          context?.user_id;

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
          console.error(
            "Не удалось определить параметры запроса."
          );

          return;
        }

        await sendMessengerMessage(
          botId,
          requestId,
          receiverUserId,
          "Выберите задачу для выполнения:",
          [
            "Подтвердить замер",
            "Провести замер",
            "Загрузить фотоотчет",
            "Внести правки"
          ]
        );

        return;
      }

      // --------------------------------------------------------
      // INCOME MESSAGE
      // --------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        const data =
          body._embedded
            ?.rpa_bot_income_message;

        const nested =
          data?._embedded;

        const context =
          body._embedded
            ?.context;

        const incomeMessage =
          nested?.income_message;

        const request =
          nested?.request;

        const text =
          incomeMessage?.text ||
          "";

        const botId =
          data?.bot_id;

        const requestId =
          request?.id;

        const receiverUserId =
          incomeMessage?.author?.user_id ||
          request?.author_id ||
          context?.user_id;

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

        // ------------------------------------------------------
        // ПОДТВЕРДИТЬ ЗАМЕР
        // ------------------------------------------------------

        if (
          text.trim() ===
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
            // Сообщение пользователю
            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "⏳ Проверяю задачи на подтверждение замера..."
            );

            // Поиск
            const result =
              await findMeasurementTasks();

            // ------------------------------------------------
            // Если ничего не нашли
            // ------------------------------------------------

            if (
              result.measurements.length ===
              0
            ) {
              await sendMessengerMessage(
                botId,
                requestId,
                receiverUserId,
                "📋 Замеров для подтверждения не найдено."
              );
            }

            // ------------------------------------------------
            // Если нашли
            // ------------------------------------------------

            else {
              let message =
                "📋 Найдены замеры:\n\n";

              result.measurements.forEach(
                (item, index) => {
                  message +=
                    `${index + 1}. ` +
                    `${item.lead_name}\n`;

                  message +=
                    `📝 Задача: ${item.task_id}\n`;

                  message +=
                    `📅 Срок: ${item.complete_till_moscow}\n`;

                  message +=
                    `${item.lead_link}\n\n`;
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
              error.message
            );

            try {
              await sendMessengerMessage(
                botId,
                requestId,
                receiverUserId,
                "❌ Произошла ошибка при поиске задач. Подробности есть в логах Render."
              );
            } catch (sendError) {
              console.error(
                "Ошибка отправки ошибки:",
                sendError.message
              );
            }
          }

          // ------------------------------------------------
          // Возвращаем управление amoMessenger
          // ------------------------------------------------

          await returnControl(
            botId,
            requestId
          );

          return;
        }

        // ------------------------------------------------------
        // ДРУГИЕ КНОПКИ
        // ------------------------------------------------------

        if (
          text.trim() ===
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
          text.trim() ===
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
          text.trim() ===
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
          "Неизвестная команда:",
          text
        );

        await returnControl(
          botId,
          requestId
        );

        return;
      }
    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        error.stack ||
          error.message
      );
    }
  }
);

// ============================================================
// GET /
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "OK",
      service:
        "amoMessenger + amoCRM bot",
      timezone:
        "Europe/Moscow"
    });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).send(
      `Cannot ${req.method} ${req.path}`
    );
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "amoMessenger BOT STARTED"
    );
    console.log(
      "=========================================="
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "amoCRM:",
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru`
    );

    console.log(
      "Timezone:",
      "Europe/Moscow"
    );

    console.log(
      "Engineer:",
      ENGINEER_NAME
    );

    console.log(
      "Engineer field:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "Engineer enum:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "Measurement task type:",
      MEASUREMENT_TASK_TYPE_ID
    );

    console.log(
      "amoCRM token:",
      amocrmAccessToken
        ? "ДА"
        : "НЕТ"
    );

    console.log(
      "amoMessenger token:",
      amomessengerAccessToken
        ? "ДА"
        : "НЕТ"
    );

    console.log(
      "=========================================="
    );
  }
);
