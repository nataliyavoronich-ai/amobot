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

// Бот из раздела "Боты", через который пользователь запускает
// рабочую заявку одним сообщением.
//
// Если ID не задан, сервер автоматически найдёт бота по названию
// "Бот инженеров" через API amo Messenger.

const AMOMESSENGER_RPA_BOT_ID =
  process.env.AMOMESSENGER_RPA_BOT_ID || "";

const AMOMESSENGER_RPA_BOT_TITLE =
  process.env.AMOMESSENGER_RPA_BOT_TITLE ||
  "Бот инженеров";

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

// Токен для API BPM-платформы Sensei (https://sensei.plus/api).
// Нужен, чтобы правильно завершать задачи, которые поставил в сделку
// процесс Sensei — если завершить такую задачу обычным способом через
// amoCRM, процесс Sensei в сделке "зависнет" и не пойдёт дальше.
// Переменная SENSEI_TOKEN уже задана в Environment Variables на Render.
const SENSEI_TOKEN = process.env.SENSEI_TOKEN || "";

// ============================================================
// ПОСТОЯННЫЕ ЗНАЧЕНИЯ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Поля сделки, которые нужно выводить в сообщениях бота
const CONTRACT_NUMBER_FIELD_ID = 412776; // № договора (текст)
const MEASURE_DATE_FIELD_ID = 175370; // Дата замера (дата)
const MEASURE_TIME_FIELD_ID = 413828; // Время замера (список)
const ADDRESS_FIELD_ID = 175412; // Адрес объекта (текстовая область)
const PRODUCT_FIELD_ID = 172572; // Продукт (список)

// Часовой пояс Москвы
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

// ============================================================
// ХРАНИЛИЩЕ ТОКЕНОВ
// ============================================================
//
// ВАЖНО:
// На бесплатном Render локальный файл может исчезнуть после перезапуска,
// а память процесса очищается при каждом рестарте/деплое.
// Поэтому для постоянной работы токены нужно сохранять в Environment
// Variables (или во внешнем хранилище — БД/Redis), иначе после каждого
// рестарта потребуется заново проходить авторизацию.

let amomessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amomessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

// ID бота-заявки, который будет запускаться из директ-бота.
// Если AMOMESSENGER_RPA_BOT_ID не задан, ID определяется автоматически
// по названию AMOMESSENGER_RPA_BOT_TITLE.
let amomessengerRpaBotId =
  AMOMESSENGER_RPA_BOT_ID || "";

// Защита от повторного создания нескольких заявок подряд одним
// и тем же пользователем во время одного запуска.
const activeDirectRequests = {};
const directRequestCreationInProgress = {};
const requestToDirectUser = {};

let amocrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amocrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

// ============================================================
// ПАМЯТЬ О ВЫБРАННОМ ЗАМЕРЕ
// ============================================================
//
// Когда пользователь нажимает на кнопку с номером договора, бот
// присылает подробности замера и предлагает кнопки "Замер подтвержден",
// "Перенос замера", "Отказ". Чтобы при нажатии на эти кнопки бот знал,
// к какой именно задаче/сделке относится нажатие, мы временно
// запоминаем выбранный замер для каждого пользователя.
//
// ВАЖНО: это хранилище живёт только в памяти процесса и очищается при
// каждом перезапуске/деплое на Render — как и токены выше.

const userSelectedMeasurement = {};

// Когда пользователь нажимает "Перенос замера" или "Отказ", бот
// просит написать комментарий и ждёт следующее сообщение. Здесь
// запоминаем, какое именно действие и по какой задаче/сделке нужно
// выполнить, когда комментарий придёт.
const userPendingComment = {};

// ID аккаунта amoCRM, нужен для заголовка X-Account при обращении
// к API Sensei. Получаем один раз и кэшируем.
let amocrmAccountId = null;

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
// POST amoCRM
// ============================================================

async function amoCrmPost(url, body) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${amocrmAccessToken}`,
        "Content-Type": "application/json",
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

        const retry = await axios.post(url, body, {
          headers: {
            Authorization: `Bearer ${amocrmAccessToken}`,
            "Content-Type": "application/json",
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
    console.error("amoCRM POST ERROR:", error.message);

    throw error;
  }
}

// ============================================================
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ (ПРИМЕЧАНИЯ) К СДЕЛКЕ
// ============================================================
//
// Добавляет текстовый комментарий пользователя в ленту событий
// сделки в amoCRM (обычное примечание). Используется после того,
// как пользователь указывает причину переноса замера/отказа.

async function addLeadNote(leadId, text) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}/notes`;

  const body = [
    {
      note_type: "common",
      params: {
        text
      }
    }
  ];

  const response = await amoCrmPost(url, body);

  if (response.status >= 400) {
    throw new Error(
      `amoCRM notes HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
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
// ID АККАУНТА AMOCRM (нужен для запросов к Sensei)
// ============================================================

async function getAmoCrmAccountId() {
  if (amocrmAccountId) {
    return amocrmAccountId;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/account`;

  const response = await amoCrmGet(url, {});

  if (
    response.status === 200 &&
    response.data &&
    response.data.id
  ) {
    amocrmAccountId = response.data.id;
  }

  return amocrmAccountId;
}

// ============================================================
// ЗАВЕРШЕНИЕ ЗАДАЧИ ЧЕРЕЗ API SENSEI
// ============================================================
//
// Задачи замера в amoCRM ставит BPM-процесс Sensei. Чтобы процесс
// корректно "узнал", что задача выполнена, и пошёл дальше по сценарию,
// завершать задачу нужно ЧЕРЕЗ API SENSEI, а не напрямую через amoCRM.
// Если завершить задачу напрямую в amoCRM — процесс Sensei в сделке
// остановится (зависнет) и не продолжит работу.
//
// Документация: https://sensei.plus/api

async function senseiCompleteTask(
  leadId,
  taskId,
  resultCaption
) {
  if (!SENSEI_TOKEN) {
    throw new Error(
      "SENSEI_TOKEN не задан в Environment Variables"
    );
  }

  const accountId = await getAmoCrmAccountId();

  const url =
    "https://api.sensei.plus/v1/element/task/complete";

  const body = {
    entity_id: Number(leadId),
    entity_type: 1,
    result_caption: resultCaption,
    task_id: Number(taskId)
  };

  const headers = {
    "Content-Type": "application/json",
    "X-Auth-Sensei-Token": SENSEI_TOKEN
  };

  if (accountId) {
    headers["X-Account"] = accountId;
  }

  log("Sensei: завершаем задачу", {
    url,
    body,
    accountId: accountId || "не удалось получить"
  });

  const response = await axios.post(
    url,
    body,
    {
      headers,
      timeout: 30000,
      validateStatus: () => true
    }
  );

  console.log(
    "Sensei ответ:",
    response.status,
    JSON.stringify(response.data)
  );

  if (
    response.status !== 200 ||
    (response.data && response.data.status &&
      response.data.status !== "success" &&
      response.data.status !== 200)
  ) {
    throw new Error(
      `Sensei вернул ошибку: HTTP ${response.status}, ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// ============================================================
// ЗАПУСК ЗАЯВКИ ИЗ ДИРЕКТ-БОТА
// ============================================================
//
// Пользователь сначала пишет нашему боту в разделе "Боты".
// При событии income_message мы программно создаём заявку
// нужного бота через POST /v1.3/bots/{BOT_ID}/run.
//
// После создания заявки amo Messenger уже работает как обычная
// заявка бота: её цепочка доходит до нашего виджета, приходит
// rpa_bot_control_transferred, и дальше используются настоящие
// inline-кнопки через sendMessage.
//
// Это позволяет сохранить:
// 1) запуск через отдельного бота в списке;
// 2) кнопки;
// 3) текущую рабочую логику поиска задач.
// ============================================================

async function getRpaBotId() {
  if (amomessengerRpaBotId) {
    return amomessengerRpaBotId;
  }

  if (!amomessengerAccessToken) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  const url =
    "https://api.amo.tm/v1.3/bots";

  console.log("");
  console.log(
    "Ищем бот-заявку по названию:",
    AMOMESSENGER_RPA_BOT_TITLE
  );

  const response = await axios.get(
    url,
    {
      params: {
        query: AMOMESSENGER_RPA_BOT_TITLE,
        limit: 100
      },
      headers: {
        Authorization:
          `Bearer ${amomessengerAccessToken}`,
        Accept: "application/hal+json"
      },
      timeout: 30000,
      validateStatus: () => true
    }
  );

  console.log(
    "Получение списка ботов:",
    response.status
  );

  if (response.status >= 400) {
    throw new Error(
      `amoMessenger GET /bots HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  const items =
    response.data?._embedded?.items || [];

  console.log(
    "Найдено ботов:",
    JSON.stringify(items, null, 2)
  );

  const exact = items.find(
    (item) =>
      String(item.title || "").trim().toLowerCase() ===
      AMOMESSENGER_RPA_BOT_TITLE.trim().toLowerCase()
  );

  if (!exact) {
    throw new Error(
      `Бот "${AMOMESSENGER_RPA_BOT_TITLE}" не найден через API amo Messenger. ` +
      `Проверьте название бота и наличие scope rpa-bots:read.`
    );
  }

  amomessengerRpaBotId = exact.id;

  console.log(
    "ID найденного бота-заявки:",
    amomessengerRpaBotId
  );

  return amomessengerRpaBotId;
}

async function createRpaRequestFromDirectMessage(
  userId
) {
  if (!userId) {
    throw new Error(
      "Не удалось определить user_id для создания заявки"
    );
  }

  if (activeDirectRequests[userId]) {
    console.log(
      "Для пользователя уже есть активная заявка:",
      activeDirectRequests[userId]
    );

    return {
      alreadyExists: true,
      requestId: activeDirectRequests[userId],
      botId: amomessengerRpaBotId
    };
  }

  if (directRequestCreationInProgress[userId]) {
    console.log(
      "Создание заявки уже выполняется для пользователя:",
      userId
    );

    return {
      alreadyInProgress: true
    };
  }

  directRequestCreationInProgress[userId] = true;

  try {
    const botId =
      await getRpaBotId();

    const url =
      `https://api.amo.tm/v1.3/bots/${botId}/run`;

    const body = {
      user_id: userId
    };

    log(
      "СОЗДАЁМ ЗАЯВКУ ИЗ ДИРЕКТ-БОТА",
      {
        botId,
        botTitle: AMOMESSENGER_RPA_BOT_TITLE,
        userId,
        url,
        body
      }
    );

    const response =
      await axios.post(
        url,
        body,
        {
          headers: {
            Authorization:
              `Bearer ${amomessengerAccessToken}`,
            "Content-Type":
              "application/json"
          },
          timeout: 30000,
          validateStatus: () => true
        }
      );

    console.log(
      "Создание заявки response:",
      response.status,
      JSON.stringify(response.data, null, 2)
    );

    if (response.status >= 400) {
      throw new Error(
        `amoMessenger create request HTTP ${response.status}: ` +
        `${JSON.stringify(response.data)}`
      );
    }

    const requestId =
      response.data?.id;

    if (!requestId) {
      throw new Error(
        "amoMessenger создал заявку, но в ответе нет request id"
      );
    }

    activeDirectRequests[userId] =
      requestId;

    requestToDirectUser[requestId] =
      userId;

    console.log(
      "Заявка успешно создана:",
      {
        botId,
        requestId,
        userId
      }
    );

    return {
      alreadyExists: false,
      alreadyInProgress: false,
      botId,
      requestId,
      request: response.data
    };
  } finally {
    delete directRequestCreationInProgress[userId];
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
// ПОЛУЧЕНИЕ КОНТАКТА
// ============================================================

async function getContact(contactId) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/contacts/${contactId}`;

  const response = await amoCrmGet(url, {});

  if (response.status !== 200) {
    console.log(
      `Не удалось получить контакт ${contactId}:`,
      response.status
    );

    return null;
  }

  return response.data;
}

function getMainContactId(lead) {
  if (
    !lead ||
    !lead._embedded ||
    !Array.isArray(lead._embedded.contacts) ||
    lead._embedded.contacts.length === 0
  ) {
    return null;
  }

  const main = lead._embedded.contacts.find(
    (c) => c.is_main
  );

  return (main || lead._embedded.contacts[0]).id;
}

function getContactPhones(contact) {
  if (
    !contact ||
    !Array.isArray(contact.custom_fields_values)
  ) {
    return [];
  }

  const phoneField = contact.custom_fields_values.find(
    (f) => f.field_code === "PHONE"
  );

  if (
    !phoneField ||
    !Array.isArray(phoneField.values)
  ) {
    return [];
  }

  return phoneField.values
    .map((v) => v.value)
    .filter(Boolean);
}

// ============================================================
// УНИВЕРСАЛЬНОЕ ЧТЕНИЕ ЗНАЧЕНИЙ ПОЛЕЙ СДЕЛКИ ПО ID
// ============================================================

function getFieldValues(entity, fieldId) {
  if (
    !entity ||
    !Array.isArray(entity.custom_fields_values)
  ) {
    return [];
  }

  const field = entity.custom_fields_values.find(
    (item) =>
      Number(item.field_id) === Number(fieldId)
  );

  if (
    !field ||
    !Array.isArray(field.values)
  ) {
    return [];
  }

  return field.values
    .map((v) => v.value)
    .filter(
      (v) => v !== null && v !== undefined && v !== ""
    );
}

function getFieldValueJoined(entity, fieldId, separator = ", ") {
  return getFieldValues(entity, fieldId).join(separator);
}

// Для полей типа "дата" amoCRM хранит значение как Unix-время (сек).
// Выводим только дату (без времени) по московскому часовому поясу.
function formatDateFieldValue(entity, fieldId) {
  const values = getFieldValues(entity, fieldId);

  if (values.length === 0) {
    return "";
  }

  return values
    .map((raw) => {
      const unix = Number(raw);

      if (!unix || Number.isNaN(unix)) {
        return String(raw);
      }

      const moscow = new Date(
        unix * 1000 + MOSCOW_OFFSET_MS
      );

      const day = String(
        moscow.getUTCDate()
      ).padStart(2, "0");

      const month = String(
        moscow.getUTCMonth() + 1
      ).padStart(2, "0");

      const year = moscow.getUTCFullYear();

      return `${day}.${month}.${year}`;
    })
    .join(", ");
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

// ИСПРАВЛЕНО:
// Раньше эта функция грузила ВСЕ задачи без фильтров и останавливалась
// после 20 страниц (5000 задач) — если нужная задача была дальше, бот
// её просто не видел. Теперь фильтрация по типу задачи, статусу
// и диапазону дат выполняется на стороне amoCRM API, поэтому грузятся
// только релевантные задачи и лимит страниц не может "отрезать" нужную.
async function loadTasksDiagnostic(fromUnix, nowUnix) {
  const allTasks = [];

  let page = 1;

  while (true) {
    const url =
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

    const params = {
      limit: 250,
      page,
      "filter[task_type][0]": MEASUREMENT_TASK_TYPE_ID,
      "filter[is_completed]": 0,
      "filter[complete_till][from]": fromUnix,
      "filter[complete_till][to]": nowUnix
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
  // 1. Получаем задачи — фильтрация по типу/статусу/дате теперь
  //    выполняется на стороне amoCRM API (см. loadTasksDiagnostic).
  // ----------------------------------------------------------

  const tasks =
    await loadTasksDiagnostic(fromUnix, nowUnix);

  console.log(
    `Всего загружено задач (уже отфильтрованных API): ${tasks.length}`
  );

  // ----------------------------------------------------------
  // 2. Тип задачи — контрольная проверка на стороне бота
  //    (на случай если фильтр API вернёт что-то лишнее)
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
  // 3. Незавершённые — контрольная проверка
  // ----------------------------------------------------------

  const notCompletedTasks =
    measurementTypeTasks.filter((task) => {
      return task.is_completed === false;
    });

  console.log(
    `Незавершённых задач этого типа: ${notCompletedTasks.length}`
  );

  // ----------------------------------------------------------
  // 4. Дата — контрольная проверка
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

    // --------------------------------------------------------
    // Подтягиваем контакт (имя + телефоны)
    // --------------------------------------------------------

    let contactName = "";
    let contactPhones = [];

    const mainContactId = getMainContactId(lead);

    if (mainContactId) {
      const contact = await getContact(mainContactId);

      if (contact) {
        contactName = contact.name || "";
        contactPhones = getContactPhones(contact);
      }
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
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,
      contract_number:
        getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID),
      measure_date:
        formatDateFieldValue(lead, MEASURE_DATE_FIELD_ID),
      measure_time:
        getFieldValueJoined(lead, MEASURE_TIME_FIELD_ID),
      address:
        getFieldValueJoined(lead, ADDRESS_FIELD_ID),
      product:
        getFieldValueJoined(lead, PRODUCT_FIELD_ID),
      contact_name: contactName,
      contact_phones: contactPhones.join(", ")
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
// DEBUG: ПОЛУЧИТЬ ВСЕ RPA-БОТЫ
// ============================================================
//
// ВРЕМЕННЫЙ ЭНДПОИНТ.
//
// Нужен только для того, чтобы посмотреть, какие RPA-боты
// доступны приложению через API amo Messenger.
//
// После получения ID этот блок можно удалить.
//

app.get(
  "/debug/rpa-bots",
  async (req, res) => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "DEBUG: ПОЛУЧЕНИЕ ВСЕХ RPA-БОТОВ"
    );
    console.log(
      "=========================================="
    );

    try {
      if (!amomessengerAccessToken) {
        return res.status(500).json({
          status: "Ошибка",
          message:
            "AMOMESSENGER_ACCESS_TOKEN не найден."
        });
      }

      const allBots = [];
      let pageToken = null;
      let pageNumber = 1;

      while (true) {
        const params = {
          limit: 500
        };

        if (pageToken) {
          params.page_token = pageToken;
        }

        console.log("");
        console.log(
          `Получаем страницу RPA-ботов: ${pageNumber}`
        );

        const response = await axios.get(
          "https://api.amo.tm/v1.3/bots",
          {
            params,
            headers: {
              Authorization:
                `Bearer ${amomessengerAccessToken}`,
              Accept:
                "application/hal+json"
            },
            timeout: 30000,
            validateStatus: () => true
          }
        );

        console.log(
          "HTTP:",
          response.status
        );

        if (response.status !== 200) {
          console.error(
            "Ошибка API RPA-ботов:"
          );

          console.error(
            JSON.stringify(
              response.data,
              null,
              2
            )
          );

          return res.status(
            response.status
          ).json({
            status: "Ошибка",
            http_status:
              response.status,
            response:
              response.data
          });
        }

        const items =
          response.data?._embedded?.items || [];

        console.log(
          `Получено ботов на странице ${pageNumber}: ${items.length}`
        );

        allBots.push(...items);

        pageToken =
          response.data?.page_token ||
          null;

        if (!pageToken) {
          break;
        }

        pageNumber++;
      }

      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        `ВСЕГО RPA-БОТОВ: ${allBots.length}`
      );
      console.log(
        "=========================================="
      );

      if (allBots.length === 0) {
        console.log(
          "RPA-БОТОВ НЕ НАЙДЕНО."
        );
      }

      allBots.forEach(
        (bot, index) => {
          console.log("");
          console.log(
            `RPA-БОТ №${index + 1}`
          );
          console.log(
            "ID:",
            bot.id
          );
          console.log(
            "Название:",
            bot.title
          );

          if (bot.links) {
            console.log(
              "Ссылки:",
              JSON.stringify(
                bot.links,
                null,
                2
              )
            );
          }
        }
      );

      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        "КОНЕЦ СПИСКА RPA-БОТОВ"
      );
      console.log(
        "=========================================="
      );

      return res.json({
        status: "OK",
        count: allBots.length,
        bots: allBots.map(
          (bot) => ({
            id: bot.id,
            title: bot.title
          })
        )
      });

    } catch (error) {
      console.error(
        "DEBUG RPA BOTS ERROR:",
        error.stack ||
          error.message
      );

      return res.status(500).json({
        status: "Ошибка",
        message:
          error.message
      });
    }
  }
);

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
    amomessenger_rpa_bot_title:
      AMOMESSENGER_RPA_BOT_TITLE,
    amomessenger_rpa_bot_id:
      amomessengerRpaBotId || null,
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
// DEBUG: AMOMESSENGER BOTS
// ============================================================
//
// Вспомогательный endpoint. Показывает, какой бот-заявка
// найден по названию "Бот инженеров".
//
// Можно открыть:
// https://amobot-cpck.onrender.com/debug/amomessenger-bot
// ============================================================

app.get(
  "/debug/amomessenger-bot",
  async (req, res) => {
    try {
      const botId =
        await getRpaBotId();

      res.json({
        status: "OK",
        bot_title:
          AMOMESSENGER_RPA_BOT_TITLE,
        bot_id:
          botId
      });
    } catch (error) {
      console.error(
        "DEBUG AMOMESSENGER BOT ERROR:",
        error.response
          ? error.response.data
          : error.stack || error.message
      );

      res.status(500).json({
        status: "Ошибка",
        message:
          error.response?.data ||
          error.message
      });
    }
  }
);

// ============================================================
// ПОИСК ЗАМЕРОВ + ОТПРАВКА СПИСКА ПОЛЬЗОВАТЕЛЮ
// ============================================================
//
// Общая логика, которая раньше была только внутри обработки кнопки
// "Подтвердить замер". Вынесена в отдельную функцию, чтобы её же можно
// было вызвать повторно после того, как пользователь закроет задачу
// через "Перенос замера" или "Отказ" — бот должен снова поискать
// оставшиеся задачи и показать список.
//
// Возвращает true, если управление нужно вернуть amoMessenger сразу
// (замеров не найдено или произошла ошибка), и false, если бот ждёт,
// что пользователь нажмёт на кнопку с номером договора.

async function searchAndPresentMeasurements(
  botId,
  requestId,
  receiverUserId
) {
  let shouldReturnControl = true;

  try {
    const result = await findMeasurementTasks();

    if (result.measurements.length === 0) {
      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        "📋 Замеров для подтверждения не найдено."
      );
    } else {
      let message = "📋 Найдены замеры:\n\n";

      result.measurements.forEach((item, index) => {
        message +=
          `${index + 1}. ` +
          `№ договора: ${item.contract_number || "—"}; ` +
          `Дата замера: ${item.measure_date || "—"}; ` +
          `Время замера: ${item.measure_time || "—"}; ` +
          `Адрес замера: ${item.address || "—"}; ` +
          `Продукт: ${item.product || "—"}; ` +
          `Имя контакта: ${item.contact_name || "—"}; ` +
          `№ телефона (-ов) контакта: ${item.contact_phones || "—"}; ` +
          `Ссылка на сделку: ${item.lead_link}\n`;
      });

      const buttons = result.measurements.map(
        (item) =>
          item.contract_number || `Задача ${item.task_id}`
      );

      await sendMessengerMessage(
        botId,
        requestId,
        receiverUserId,
        message,
        buttons
      );

      // Список с кнопками показан — НЕ отдаём управление, так как
      // ждём, что пользователь нажмёт одну из кнопок (обработка в
      // блоке "ВЫБОР КОНКРЕТНОГО ЗАМЕРА" ниже).
      shouldReturnControl = false;
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

  return shouldReturnControl;
}

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
      // ЗАЯВКА ОБНОВЛЕНА
      // --------------------------------------------------------
      //
      // Если созданная из директ-бота заявка архивирована,
      // снимаем её из временной памяти, чтобы следующий запуск
      // снова мог создать новую заявку.
      // --------------------------------------------------------

      if (
        eventType ===
        "rpa_request_updated"
      ) {
        const data =
          body._embedded
            ?.rpa_request_updated;

        const request =
          data?._embedded
            ?.request;

        const requestId =
          data?.request_id ||
          request?.id;

        const changes =
          data?.changes || [];

        const archived =
          changes.some(
            (change) =>
              change?.archive_status?.is_archived === true
          );

        log(
          "ОБНОВЛЕНИЕ ЗАЯВКИ",
          {
            requestId,
            botId: request?.bot_id,
            archived,
            changes
          }
        );

        if (archived && requestId) {
          const userId =
            requestToDirectUser[requestId];

          if (userId) {
            delete activeDirectRequests[userId];
            delete requestToDirectUser[requestId];

            console.log(
              "Активная заявка удалена из памяти:",
              {
                userId,
                requestId
              }
            );
          }
        }

        return;
      }

      // --------------------------------------------------------
      // DIRECT BOT -> СОЗДАЁМ ЗАЯВКУ
      // --------------------------------------------------------
      //
      // Пользователь пишет "старт" или ЛЮБОЕ другое сообщение
      // нашему боту в разделе "Боты".
      //
      // Это событие отличается от сообщения внутри заявки:
      // event_type = "income_message"
      //
      // Мы не пытаемся рисовать кнопки прямо в директ-чате.
      // Вместо этого создаём настоящую заявку через API amo.
      // После этого amo запускает обычную цепочку заявки,
      // а когда управление передаётся нашему виджету,
      // приходит rpa_bot_control_transferred.
      //
      // Именно там остаются наши существующие кнопки.
      // --------------------------------------------------------

      if (
        eventType ===
        "income_message"
      ) {
        const context =
          body._embedded
            ?.context;

        const conversationIdentity =
          body._embedded
            ?.conversation_identity;

        const message =
          body._embedded
            ?.message;

        const text =
          message?.text ||
          "";

        const userId =
          message?.author?.user_id ||
          context?.user_id;

        const directId =
          conversationIdentity?.direct_id;

        log(
          "ПОЛУЧЕНО СООБЩЕНИЕ ОТ ДИРЕКТ-БОТА",
          {
            text,
            userId,
            directId,
            messageId: message?.id
          }
        );

        if (!userId) {
          console.error(
            "DIRECT BOT: не удалось определить user_id."
          );

          return;
        }

        try {
          const result =
            await createRpaRequestFromDirectMessage(
              userId
            );

          if (
            result.alreadyExists ||
            result.alreadyInProgress
          ) {
            console.log(
              "Новая заявка не создавалась:",
              result
            );

            return;
          }

          console.log(
            "DIRECT BOT: заявка создана.",
            result.requestId
          );

          // Ничего больше здесь не отправляем.
          // Следующий шаг выполняет сам бот-заявка:
          // его цепочка дойдёт до виджета,
          // после чего придёт rpa_bot_control_transferred.
        } catch (error) {
          console.error(
            "Ошибка запуска заявки из директ-бота:",
            error.response
              ? JSON.stringify(error.response.data)
              : error.stack || error.message
          );

          // В случае ошибки пытаемся сообщить пользователю
          // обычным сообщением в директ.
          try {
            const errorText =
              "❌ Не удалось запустить бота-заявку. " +
              "Попробуйте ещё раз или обратитесь к администратору.";

            const directUrl =
              `https://api.amo.tm/v1.3/direct/${userId}/sendMessage`;

            await axios.post(
              directUrl,
              {
                text: errorText
              },
              {
                headers: {
                  Authorization:
                    `Bearer ${amomessengerAccessToken}`,
                  "Content-Type":
                    "application/json"
                },
                timeout: 30000,
                validateStatus: () => true
              }
            );
          } catch (sendError) {
            console.error(
              "Не удалось отправить сообщение об ошибке в директ:",
              sendError.message
            );
          }
        }

        return;
      }

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
        // ОЖИДАЕМ КОММЕНТАРИЙ (после "Перенос замера" / "Отказ")
        // ------------------------------------------------------
        //
        // Если для этого пользователя мы ждём комментарий — значит,
        // текущее сообщение это НЕ команда/кнопка, а сам комментарий.
        // Обрабатываем его в первую очередь, до любых других проверок.

        const pendingComment =
          userPendingComment[receiverUserId];

        if (pendingComment) {
          const comment = text.trim();

          console.log(
            "=========================================="
          );

          console.log(
            "ПОЛУЧЕН КОММЕНТАРИЙ:",
            pendingComment.displayResult,
            comment
          );

          console.log(
            "=========================================="
          );

          if (!comment) {
            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "Комментарий не может быть пустым. Укажите комментарий"
            );

            return;
          }

          try {
            // Важно: завершаем задачу ЧЕРЕЗ API SENSEI, а не напрямую
            // через amoCRM — иначе процесс Sensei в сделке остановится.
            await senseiCompleteTask(
              pendingComment.lead_id,
              pendingComment.task_id,
              pendingComment.resultCaption
            );

            try {
              await addLeadNote(
                pendingComment.lead_id,
                comment
              );
            } catch (noteError) {
              console.error(
                "Не удалось добавить комментарий к сделке:",
                noteError.message
              );
            }

            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              `Текущая задача amoCRM закрыта с результатом ` +
                `"${pendingComment.displayResult}".`
            );
          } catch (error) {
            console.error(
              "Ошибка завершения задачи через Sensei:",
              error.message
            );

            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "❌ Не удалось завершить задачу в Sensei. " +
                "Подробности есть в логах Render. Попробуйте ещё раз " +
                "или обратитесь к администратору."
            );
          }

          delete userPendingComment[receiverUserId];
          delete userSelectedMeasurement[receiverUserId];

          // Возвращаемся к шагу поиска других задач замера и
          // показываем список (или сообщение, что задач больше нет).

          const shouldReturnControl =
            await searchAndPresentMeasurements(
              botId,
              requestId,
              receiverUserId
            );

          if (shouldReturnControl) {
            await returnControl(
              botId,
              requestId
            );
          }

          return;
        }

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

          await sendMessengerMessage(
            botId,
            requestId,
            receiverUserId,
            "⏳ Проверяю задачи на подтверждение замера..."
          );

          const shouldReturnControl =
            await searchAndPresentMeasurements(
              botId,
              requestId,
              receiverUserId
            );

          if (shouldReturnControl) {
            await returnControl(
              botId,
              requestId
            );
          }

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

        // ------------------------------------------------------
        // ЗАМЕР ПОДТВЕРЖДЕН
        // (нажатие на кнопку после показа деталей замера)
        // ------------------------------------------------------

        if (
          text.trim() ===
          "Замер подтвержден"
        ) {
          console.log(
            "=========================================="
          );

          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ЗАМЕР ПОДТВЕРЖДЕН"
          );

          console.log(
            "=========================================="
          );

          const stored =
            userSelectedMeasurement[receiverUserId];

          if (!stored) {
            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "Не нашёл, какой замер вы подтверждаете. " +
                "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
                "и выберите нужную задачу из списка."
            );

            await returnControl(
              botId,
              requestId
            );

            return;
          }

          try {
            // Важно: завершаем задачу ЧЕРЕЗ API SENSEI, а не напрямую
            // через amoCRM — иначе процесс Sensei в сделке остановится.
            await senseiCompleteTask(
              stored.lead_id,
              stored.task_id,
              "Замер подтвержден"
            );

            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "✅ Замер подтвержден. Задача завершена."
            );

            delete userSelectedMeasurement[
              receiverUserId
            ];
          } catch (error) {
            console.error(
              "Ошибка завершения задачи через Sensei:",
              error.message
            );

            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "❌ Не удалось завершить задачу в Sensei. " +
                "Подробности есть в логах Render. Попробуйте ещё раз " +
                "или обратитесь к администратору."
            );
          }

          await returnControl(
            botId,
            requestId
          );

          return;
        }

        // ------------------------------------------------------
        // ПЕРЕНОС ЗАМЕРА
        // ------------------------------------------------------

        if (
          text.trim() ===
          "Перенос замера"
        ) {
          const stored =
            userSelectedMeasurement[receiverUserId];

          if (!stored) {
            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "Не нашёл, какой замер вы переносите. " +
                "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
                "и выберите нужную задачу из списка."
            );

            await returnControl(
              botId,
              requestId
            );

            return;
          }

          userPendingComment[receiverUserId] = {
            task_id: stored.task_id,
            lead_id: stored.lead_id,
            resultCaption: "Перенос замера",
            displayResult: "Перенос замера"
          };

          await sendMessengerMessage(
            botId,
            requestId,
            receiverUserId,
            "Укажите комментарий"
          );

          // Управление НЕ возвращаем — ждём текст комментария
          // следующим сообщением.

          return;
        }

        // ------------------------------------------------------
        // ОТКАЗ
        // ------------------------------------------------------

        if (
          text.trim() ===
          "Отказ"
        ) {
          const stored =
            userSelectedMeasurement[receiverUserId];

          if (!stored) {
            await sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              "Не нашёл, от какого замера вы отказываетесь. " +
                "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
                "и выберите нужную задачу из списка."
            );

            await returnControl(
              botId,
              requestId
            );

            return;
          }

          userPendingComment[receiverUserId] = {
            task_id: stored.task_id,
            lead_id: stored.lead_id,
            resultCaption: "Отказался от замера",
            displayResult: "Отказался от замера"
          };

          await sendMessengerMessage(
            botId,
            requestId,
            receiverUserId,
            "Укажите комментарий"
          );

          // Управление НЕ возвращаем — ждём текст комментария
          // следующим сообщением.

          return;
        }

        // ------------------------------------------------------
        // ВЫБОР КОНКРЕТНОГО ЗАМЕРА ПО НОМЕРУ ДОГОВОРА
        // (нажатие на одну из кнопок из списка замеров, п.5)
        // ------------------------------------------------------

        const selectedContract = text.trim();

        if (selectedContract) {
          try {
            const result =
              await findMeasurementTasks();

            const selected =
              result.measurements.find(
                (item) =>
                  String(item.contract_number).trim() ===
                  selectedContract
              );

            if (selected) {
              console.log(
                "=========================================="
              );

              console.log(
                "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ ЗАМЕР:",
                selectedContract
              );

              console.log(
                "=========================================="
              );

              const detailMessage =
                `Дата замера: ${selected.measure_date || "—"}\n` +
                `Время замера: ${selected.measure_time || "—"}\n` +
                `Адрес замера: ${selected.address || "—"}\n` +
                `Продукт: ${selected.product || "—"}\n` +
                `Имя контакта: ${selected.contact_name || "—"}\n` +
                `№ телефона (-ов) контакта: ${selected.contact_phones || "—"}\n` +
                `№ договора: ${selected.contract_number || "—"}\n` +
                `Ссылка на сделку: ${selected.lead_link}`;

              // Запоминаем, какой именно замер (задача + сделка)
              // выбрал этот пользователь — понадобится, когда он
              // нажмёт "Замер подтвержден" / "Перенос замера" / "Отказ".
              userSelectedMeasurement[receiverUserId] = {
                task_id: selected.task_id,
                lead_id: selected.lead_id,
                contract_number: selected.contract_number
              };

              await sendMessengerMessage(
                botId,
                requestId,
                receiverUserId,
                detailMessage,
                [
                  "Замер подтвержден",
                  "Перенос замера",
                  "Отказ"
                ]
              );

              // Управление НЕ возвращаем — ждём, что пользователь
              // нажмёт одну из кнопок выше.

              return;
            }
          } catch (error) {
            console.error(
              "Ошибка при выборе замера:",
              error.message
            );
          }
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
      "amoMessenger RPA bot title:",
      AMOMESSENGER_RPA_BOT_TITLE
    );

    console.log(
      "amoMessenger RPA bot ID:",
      amomessengerRpaBotId
        ? amomessengerRpaBotId
        : "будет найден автоматически"
    );

    console.log(
      "=========================================="
    );
  }
);
