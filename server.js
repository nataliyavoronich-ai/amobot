const express = require("express");
const axios = require("axios");

const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || "";

const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || "";
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

const DEBUG_SECRET = process.env.DEBUG_SECRET || "";

const SENSEI_TOKEN = process.env.SENSEI_TOKEN || "";

// ============================================================
// ПОСТОЯННЫЕ ЗНАЧЕНИЯ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Тип задачи "Провести зам.(и)" — используется в функции "Провести замер"
const CONDUCT_TASK_TYPE_ID = 2746009;

// Тип задачи "Рез-т замера(и)" — появляется в сделке автоматически
const RESULT_TASK_TYPE_ID = 2746013;

// Тип задачи "Указать рез-т(и)" 
const KP_TASK_TYPE_ID = 2774021;

// Тип задачи "Загруз. отчет(и)" — сценарий "Загрузить фотоотчет"
const REPORT_TASK_TYPE_ID = 2746017;
// Тип задачи "Внести правки(и)" — сценарий "Внести правки"
const CORRECTION_TASK_TYPE_ID = 2990733;
// Поля сделки, которые нужно выводить в сообщениях бота
const CONTRACT_NUMBER_FIELD_ID = 412776; // № договора (текст)
const MEASURE_DATE_FIELD_ID = 175370; // Дата замера (дата)
const MEASURE_TIME_FIELD_ID = 413828; // Время замера (список)
const ADDRESS_FIELD_ID = 175412; // Адрес объекта (текстовая область)
const PRODUCT_FIELD_ID = 172572; // Продукт (список)
const DISCOUNT_FIELD_ID = 552706; // Скидка ОП (число)
const BOT_NOT_ACCEPTED_FIELD_ID = 555162; // [Бот] Не принято
// Поле "Email рабочий" в сущности Контакт — используется в сценарии
// "Загрузить фотоотчет" при редактировании e-mail клиента.
const CONTACT_EMAIL_FIELD_ID = 141995;

// Поля-ссылки на папки Яндекс.Диска (заполняются ботом автоматически)
const REPORTS_LINK_FIELD_ID = 555436; // "Отчеты и проекты"
const PHOTO_LINK_FIELD_ID = 543238; // "Фото проема №1" (папка "Фотоотчет")
const MEASURE_SHEET_LINK_FIELD_ID = 543236; // "Замерный лист"
const VIDEO_LINK_FIELD_ID = 554160; // "Видеоотчет"
const CONTRACT_LINK_FIELD_ID = 543254; // "Договор (Подписан)"

const YANDEX_DISK_TOKEN = process.env.YANDEX_DISK_TOKEN || "";

const YANDEX_DISK_ROOT_FOLDER = "amoCRM";

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

// ============================================================
// ГЛАВНОЕ МЕНЮ
// ============================================================

const MAIN_MENU_TEXT = "Выберите задачу для выполнения:";

const MAIN_MENU_BUTTONS = [
  "Подтвердить замер",
  "Провести замер",
  "Загрузить фотоотчет",
  "Внести правки"
];

// ============================================================
// КОМАНДЫ ЗАПУСКА/ПЕРЕЗАПУСКА АЛГОРИТМА
// ============================================================
// Главное меню показывается ТОЛЬКО по этим командам. Любая из этих команд, на каком бы шаге пользователь ни находился полностью перезапускает сценарий.

const START_COMMANDS = new Set([
  "старт",
  "start",
  "/старт",
  "/start",
  "начать",
  "/начать"
]);

function isStartCommand(text) {
  return START_COMMANDS.has(
    String(text || "").trim().toLowerCase()
  );
}

// ============================================================
// ПОСЛЕДНЕЕ СООБЩЕНИЕ БОТА (для повтора при "неизвестной команде")
// ============================================================
//Если пользователь отвечает не тем, что бот ожидает — предупредить его и заново прислать то самое сообщение бота, на которое он неправильно отреагировал. Здесь запоминаем последнее отправленное ботом сообщение (текст + кнопки) для каждого пользователя.

const userLastBotMessage = {};

function wrapSendWithLastMessageTracking(userKey, rawSend) {
  return async (text, buttons) => {
    const result = await rawSend(text, buttons);

    userLastBotMessage[userKey] = {
      text,
      buttons: buttons || null
    };

    return result;
  };
}
// ============================================================
// UPSTASH REDIS — РАБОТА С ТОКЕНАМИ AMOCRM
// ============================================================

async function redisRequest(command) {
  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL или UPSTASH_REDIS_REST_TOKEN не задан"
    );
  }

  const response = await axios.post(
    UPSTASH_REDIS_REST_URL,
    command,
    {
      headers: {
        Authorization:
          `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  return response.data;
}

async function saveAmoCrmTokensToRedis() {
  if (
    !amocrmAccessToken ||
    !amocrmRefreshToken
  ) {
    throw new Error(
      "Невозможно сохранить пустые токены amoCRM"
    );
  }

  await redisRequest([
    "SET",
    "amocrm_access_token",
    amocrmAccessToken
  ]);

  await redisRequest([
    "SET",
    "amocrm_refresh_token",
    amocrmRefreshToken
  ]);

  console.log(
    "Токены amoCRM сохранены в Upstash Redis."
  );
}

async function loadAmoCrmTokensFromRedis() {
  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {
    console.log(
      "Upstash Redis не настроен. Используем токены из Environment Variables."
    );

    return false;
  }

  try {
    const accessResponse =
      await redisRequest([
        "GET",
        "amocrm_access_token"
      ]);

    const refreshResponse =
      await redisRequest([
        "GET",
        "amocrm_refresh_token"
      ]);

    const redisAccessToken =
      accessResponse.result;

    const redisRefreshToken =
      refreshResponse.result;

    if (
      redisAccessToken &&
      redisRefreshToken
    ) {
      amocrmAccessToken =
        redisAccessToken;

      amocrmRefreshToken =
        redisRefreshToken;

      console.log(
        "Токены amoCRM загружены из Upstash Redis."
      );

      return true;
    }

    console.log(
      "В Upstash Redis пока нет токенов amoCRM."
    );

    return false;

  } catch (error) {
    console.error(
      "Ошибка загрузки токенов из Upstash Redis:",
      error.response
        ? JSON.stringify(error.response.data)
        : error.message
    );

    return false;
  }
}
// ============================================================
// UPSTASH REDIS — РАБОТА С ТОКЕНАМИ AMOMESSENGER
// ============================================================

async function saveAmoMessengerTokensToRedis() {
  if (
    !amomessengerAccessToken ||
    !amomessengerRefreshToken
  ) {
    throw new Error(
      "Невозможно сохранить пустые токены amoMessenger"
    );
  }

  await redisRequest([
    "SET",
    "amomessenger_access_token",
    amomessengerAccessToken
  ]);

  await redisRequest([
    "SET",
    "amomessenger_refresh_token",
    amomessengerRefreshToken
  ]);

  console.log(
    "Токены amoMessenger сохранены в Upstash Redis."
  );
}

async function loadAmoMessengerTokensFromRedis() {
  if (
    !UPSTASH_REDIS_REST_URL ||
    !UPSTASH_REDIS_REST_TOKEN
  ) {
    console.log(
      "Upstash Redis не настроен. Используем токены amoMessenger из Environment Variables."
    );

    return false;
  }

  try {
    const accessResponse =
      await redisRequest([
        "GET",
        "amomessenger_access_token"
      ]);

    const refreshResponse =
      await redisRequest([
        "GET",
        "amomessenger_refresh_token"
      ]);

    const redisAccessToken =
      accessResponse.result;

    const redisRefreshToken =
      refreshResponse.result;

    if (
      redisAccessToken &&
      redisRefreshToken
    ) {
      amomessengerAccessToken =
        redisAccessToken;

      amomessengerRefreshToken =
        redisRefreshToken;

      console.log(
        "Токены amoMessenger загружены из Upstash Redis."
      );

      return true;
    }

    console.log(
      "В Upstash Redis пока нет токенов amoMessenger."
    );

    return false;

  } catch (error) {
    console.error(
      "Ошибка загрузки токенов amoMessenger из Upstash Redis:",
      error.response
        ? JSON.stringify(error.response.data)
        : error.message
    );

    return false;
  }
}
// ============================================================
// ХРАНИЛИЩЕ ТОКЕНОВ
// ============================================================

let amomessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amomessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

let amocrmAccessToken =
  process.env.AMOCRM_ACCESS_TOKEN || "";

let amocrmRefreshToken =
  process.env.AMOCRM_REFRESH_TOKEN || "";

// ============================================================
// ПАМЯТЬ О ВЫБРАННОМ ЗАМЕРЕ
// ============================================================

const userSelectedMeasurement = {};
const userPendingComment = {};

// ------------------------------------------------------------
// СОСТОЯНИЕ ДЛЯ СЦЕНАРИЯ "ПРОВЕСТИ ЗАМЕР"
// ------------------------------------------------------------

// Запоминаем, какой список замеров пользователь видел последним — из "Подтвердить замер" (confirm) или из "Провести замер" (conduct).
// Это нужно, чтобы при нажатии на кнопку с номером договора понять, в каком списке искать этот номер и какой сценарий запускать дальше.
const userLastSearchMode = {};
const userSelectedConductMeasurement = {};

// После нажатия "Замер состоялся" бот ждёт, пока в сделке появится новая задача "Рез-т замера(и)" (id типа 2746013). 
const userPendingResultTask = {};

// После нажатия "Нужно подготовить КП и/или черновой проект" бот ждёт, пока в сделке появится новая задача "Указать рез-т(и)" (id 2774021).
const userPendingKpTask = {};

// После нажатия "Заключен договор" бот просит загрузить фото и ждёт фотографии + нажатие кнопки "Готово". Здесь храним, в какую папку на Яндекс.Диске сохранять фото для этой сделки.
const userPendingPhotoUpload = {};
const userPhotoUploadQueue = {};
// ------------------------------------------------------------
// СОСТОЯНИЕ ДЛЯ СЦЕНАРИЯ "ВНЕСТИ ПРАВКИ"
// ------------------------------------------------------------

// Выбранная пользователем сделка.
const userSelectedCorrectionMeasurement = {};

// Список найденных задач "Внести правки".
const userCorrectionList = {};

// Ожидание загрузки файлов.
const userPendingCorrectionUpload = {};

// Очередь последовательной загрузки нескольких файлов.
const userCorrectionUploadQueue = {};

// Ожидание комментария после кнопки "Правки внесены".
const userPendingCorrectionComment = {};

// Имя текущего пользователя amoMessenger.
// Оно автоматически сопоставляется со значением поля "Инженер" в сделке.
const userEngineerName = {};
// ------------------------------------------------------------
// СОСТОЯНИЕ ДЛЯ СЦЕНАРИЯ "ЗАГРУЗИТЬ ФОТООТЧЕТ"
// ------------------------------------------------------------

// После завершения фото договора / "Думает" / "Думает-отказ" / выбора результата КП
// бот показывает кнопку "Перейти к загрузке отчета". Здесь храним сделку,
// к которой эта кнопка относится, до тех пор пока пользователь её не нажал.
const userPendingReportStart = {};

// Выбранный пользователем замер в сценарии "Загрузить фотоотчет"
// (после выбора сделки из списка задач "Загруз. отчет(и)").
const userSelectedReportMeasurement = {};

// Пользователь находится на экране "Загрузите фотоотчет" (после выбора сделки
// или после нажатия "Перейти к загрузке отчета") и видит кнопки
// "Перейти к загрузке замерн.листа" / "Вернуться к списку замеров".
// Здесь же хранятся пути к папкам сделки на Яндекс.Диске (чтобы не запрашивать
// их заново на каждом шаге) и счётчик номера следующего файла фотоотчета.
const userPendingReportHub = {};

// Ожидание загрузки файлов замерного листа + очередь обработки файлов.
const userPendingMeasureSheetUpload = {};
const userMeasureSheetUploadQueue = {};

// Очередь обработки фото прямо на экране "Загрузите фотоотчет" (папка "Фотоотчет").
const userReportPhotoUploadQueue = {};

// Ожидание загрузки видео + очередь обработки файлов.
const userPendingVideoUpload = {};
const userVideoUploadQueue = {};

// Отмечает, в какие папки сделки реально что-то загружалось за текущий
// проход сценария "Загрузить фотоотчет" (нужно для примечания в сделке —
// упоминаем в примечании только реально использованные папки).
const userReportUploadFlags = {};

// Ожидание правки поля "Бюджет" сделки (после "Завершить отчет").
const userPendingBudgetEdit = {};

// Ожидание правки e-mail клиента (после шага с бюджетом).
const userPendingEmailEdit = {};

// Сбрасывает весь временный стейт конкретного пользователя
function resetUserState(userKey) {
  delete userSelectedMeasurement[userKey];
  delete userPendingComment[userKey];
  delete userLastSearchMode[userKey];
  delete userSelectedConductMeasurement[userKey];
  delete userPendingResultTask[userKey];
  delete userPendingKpTask[userKey];
  delete userPendingPhotoUpload[userKey];
  delete userPhotoUploadQueue[userKey];
  delete userPendingReportStart[userKey];
  delete userSelectedReportMeasurement[userKey];
  delete userPendingReportHub[userKey];
  delete userPendingMeasureSheetUpload[userKey];
  delete userMeasureSheetUploadQueue[userKey];
  delete userReportPhotoUploadQueue[userKey];
  delete userPendingVideoUpload[userKey];
  delete userVideoUploadQueue[userKey];
  delete userReportUploadFlags[userKey];
  delete userPendingBudgetEdit[userKey];
  delete userPendingEmailEdit[userKey];
  delete userSelectedCorrectionMeasurement[userKey];
  delete userCorrectionList[userKey];
  delete userPendingCorrectionUpload[userKey];
  delete userCorrectionUploadQueue[userKey];
  delete userPendingCorrectionComment[userKey];
}

// Кэш имён пользователей amoCRM (для поля "Ответственный менеджер"), чтобы не запрашивать одного и того же пользователя много раз подряд.
const amoCrmUsersCache = {};

// ID аккаунта amoCRM, нужен для заголовка X-Account при обращении к API Sensei. Получаем один раз и кэшируем.
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

  return Math.floor((startUtcMs - MOSCOW_OFFSET_MS) / 1000);
}

function yesterdayMoscowStartUnix() {
  return todayMoscowStartUnix() - 24 * 60 * 60;
}

function getCurrentMoscowUnix() {
  return Math.floor(Date.now() / 1000);
}

// Сегодняшняя дата по Москве в формате ДД.ММ.ГГГГ (для имён файлов)
function todayMoscowDateText() {
  const now = getMoscowDate();

  const day = String(now.getUTCDate()).padStart(2, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const year = now.getUTCFullYear();

  return `${day}.${month}.${year}`;
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

    amocrmAccessToken =
  response.data.access_token;

if (response.data.refresh_token) {
  amocrmRefreshToken =
    response.data.refresh_token;
}

await saveAmoCrmTokensToRedis();

console.log(
  "amoCRM access token обновлён и сохранён в Redis."
);

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
// ОБЩИЙ HTTP-ЗАПРОС К AMOCRM (GET/POST/PATCH) С АВТО-РЕФРЕШЕМ ТОКЕНА
// ============================================================

async function amoCrmRequest(
  axiosMethod,
  errorLabel,
  url,
  { params, body, headersExtra = {} } = {}
) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  const buildConfig = () => ({
    params,
    headers: {
      Authorization: `Bearer ${amocrmAccessToken}`,
      Accept: "application/hal+json",
      ...headersExtra
    },
    timeout: 60000,
    validateStatus: () => true
  });

  const doRequest = () =>
    body === undefined
      ? axiosMethod(url, buildConfig())
      : axiosMethod(url, body, buildConfig());

  // Примечание: для GET axiosMethod принимает (url, config), а для POST/PATCH — (url, body, config). Вызывающие обёртки ниже передают сюда axios.get / axios.post / axios.patch напрямую,
  // поэтому сигнатура совпадает автоматически в зависимости от наличия body.

  try {
    const response = await doRequest();

    if (response.status === 401) {
      console.log(
        `amoCRM вернул 401 (${errorLabel}). Пробуем обновить токен...`
      );

      try {
        await refreshAmoCrmToken();

        return await doRequest();
      } catch (refreshError) {
        return response;
      }
    }

    return response;
  } catch (error) {
    console.error(`amoCRM ${errorLabel} ERROR:`, error.message);

    throw error;
  }
}

// ============================================================
// POST amoCRM
// ============================================================

async function amoCrmPost(url, body) {
  return amoCrmRequest(axios.post, "POST", url, {
    body,
    headersExtra: { "Content-Type": "application/json" }
  });
}

// ============================================================
// PATCH amoCRM (используется для записи ссылок на папки Диска
// в поля сделки)
// ============================================================

async function amoCrmPatch(url, body) {
  return amoCrmRequest(axios.patch, "PATCH", url, {
    body,
    headersExtra: { "Content-Type": "application/json" }
  });
}

async function updateLeadCustomFields(leadId, fieldsMap) {
  const customFieldsValues = Object.keys(fieldsMap).map(
    (fieldId) => ({
      field_id: Number(fieldId),
      values: [{ value: fieldsMap[fieldId] }]
    })
  );

  if (customFieldsValues.length === 0) {
    return null;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;

  const response = await amoCrmPatch(url, {
    custom_fields_values: customFieldsValues
  });

  if (response.status >= 400) {
    throw new Error(
      `amoCRM lead PATCH HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// ============================================================
// ОБНОВЛЕНИЕ СТАНДАРТНОГО ПОЛЯ "БЮДЖЕТ" (price) СДЕЛКИ
// ============================================================

async function updateLeadPrice(leadId, price) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;

  const response = await amoCrmPatch(url, {
    price: Number(price)
  });

  if (response.status >= 400) {
    throw new Error(
      `amoCRM lead PATCH (price) HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// ============================================================
// ОБНОВЛЕНИЕ ПОЛЕЙ КОНТАКТА (например, "Email рабочий")
// ============================================================

async function updateContactCustomFields(contactId, fieldsMap) {
  const customFieldsValues = Object.keys(fieldsMap).map(
    (fieldId) => ({
      field_id: Number(fieldId),
      values: [{ value: fieldsMap[fieldId] }]
    })
  );

  if (customFieldsValues.length === 0) {
    return null;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/contacts/${contactId}`;

  const response = await amoCrmPatch(url, {
    custom_fields_values: customFieldsValues
  });

  if (response.status >= 400) {
    throw new Error(
      `amoCRM contact PATCH HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

async function getUserName(userId) {
  if (!userId) {
    return "";
  }

  if (amoCrmUsersCache[userId]) {
    return amoCrmUsersCache[userId];
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/users/${userId}`;

  const response = await amoCrmGet(url, {});

  if (response.status !== 200 || !response.data) {
    return "";
  }

  const name = response.data.name || "";

  amoCrmUsersCache[userId] = name;

  return name;
}

// ============================================================
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ (ПРИМЕЧАНИЯ) К СДЕЛКЕ
// ============================================================

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
  return amoCrmRequest(axios.get, "GET", url, { params });
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
// ЯНДЕКС.ДИСК: СОЗДАНИЕ ПАПОК И ЗАГРУЗКА ФАЙЛОВ
// ============================================================

function yandexDiskHeaders() {
  return {
    Authorization: `OAuth ${YANDEX_DISK_TOKEN}`
  };
}

async function ydEnsureFolder(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response = await axios.put(
    "https://cloud-api.yandex.net/v1/disk/resources",
    null,
    {
      params: { path },
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    }
  );

  // 201 — папка создана, 409 — уже существует. Оба варианта — успех.
  if (
    response.status !== 201 &&
    response.status !== 409
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось создать папку "${path}". ` +
      `HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return true;
}

async function ydEnsureFolderPath(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);

  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;

    await ydEnsureFolder(current);
  }

  return fullPath;
}

// Ссылка для открытия папки в браузере в веб-интерфейсе Яндекс.Диска (открывается у того, кто залогинен под тем же Яндекс-аккаунтом).
// ============================================================
// ПУБЛИЧНАЯ ССЫЛКА НА КОНКРЕТНУЮ ПАПКУ ЯНДЕКС.ДИСКА
// ============================================================

// По такой ссылке пользователь не получает доступа к родительским папкам.
async function ydGetFolderPublicUrl(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response = await axios.put(
    "https://cloud-api.yandex.net/v1/disk/resources/publish",
    null,
    {
      params: {
        path
      },
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    }
  );

  // 409 означает, что ресурс уже опубликован.
  if (
    response.status !== 200 &&
    response.status !== 201 &&
    response.status !== 409
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось опубликовать папку "${path}". ` +
      `HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

   const infoResponse = await axios.get(
    "https://cloud-api.yandex.net/v1/disk/resources",
    {
      params: {
        path,
        fields: "public_url"
      },
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    }
  );

  if (
    infoResponse.status !== 200 ||
    !infoResponse.data ||
    !infoResponse.data.public_url
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось получить публичную ссылку ` +
      `для "${path}".`
    );
  }

  return infoResponse.data.public_url;
}

// ============================================================
// ОПРЕДЕЛЕНИЕ НОМЕРА СЛЕДУЮЩЕГО ФАЙЛА ДОГОВОРА
// ============================================================

// Универсальная версия: работает для любого префикса имени документа
// ("Договор", "Замерный лист" и т.д.), чтобы одной и той же логикой
// можно было пользоваться для разных типов загружаемых файлов.
async function ydGetNextDocumentFileNumber(
  folderPath,
  prefix,
  dateText
) {
  const response = await axios.get(
    "https://cloud-api.yandex.net/v1/disk/resources",
    {
      params: {
        path: folderPath,
        limit: 1000,
        fields: "_embedded.items.name"
      },
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    }
  );

  if (response.status !== 200) {
    throw new Error(
      `Яндекс.Диск: не удалось получить список файлов "${folderPath}". ` +
      `HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  const items =
    response.data &&
    response.data._embedded &&
    Array.isArray(
      response.data._embedded.items
    )
      ? response.data._embedded.items
      : [];

    const escapedPrefix =
    String(prefix).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    const escapedDate =
    dateText.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const pattern =
    new RegExp(
      `^${escapedPrefix} ${escapedDate}` +
      `(?: \\((\\d+)\\))?` +
      `(?:\\.[^.]*)?$`,
      "i"
    );

  let maxNumber = -1;

  for (const item of items) {
    const name =
      item && item.name
        ? String(item.name)
        : "";

    const match =
      name.match(pattern);

    if (!match) {
      continue;
    }

    const number =
      match[1] === undefined
        ? 0
        : Number(match[1]);

    if (!Number.isNaN(number)) {
      maxNumber =
        Math.max(
          maxNumber,
          number
        );
    }
  }

  return maxNumber + 1;
}

// ============================================================
// ОПРЕДЕЛЕНИЕ НОМЕРА СЛЕДУЮЩЕГО ФАЙЛА ДОГОВОРА (обёртка для совместимости)
// ============================================================

async function ydGetNextContractFileNumber(
  folderPath,
  dateText
) {
  return ydGetNextDocumentFileNumber(
    folderPath,
    "Договор",
    dateText
  );
}

// ============================================================
// ФОРМИРОВАНИЕ ИМЕНИ ФАЙЛА ДОКУМЕНТА (УНИВЕРСАЛЬНАЯ ФУНКЦИЯ)
// ============================================================

function buildDocumentFileName(
  prefix,
  dateText,
  number
) {
  const suffix =
    Number(number) > 0
      ? ` (${Number(number)})`
      : "";

  return (
    `${prefix} ${dateText}` +
    `${suffix}.jpg`
  );
}

function buildContractFileName(
  dateText,
  number
) {
  return buildDocumentFileName("Договор", dateText, number);
}

function buildMeasureSheetFileName(
  dateText,
  number
) {
  return buildDocumentFileName("Замерный лист", dateText, number);
}

function buildVideoFileName(
  dateText,
  number
) {
  return buildDocumentFileName("Видео", dateText, number);
}

async function ydUploadFromUrl(path, fileUrl) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response = await axios.post(
    "https://cloud-api.yandex.net/v1/disk/resources/upload",
    null,
    {
      params: {
        path,
        url: fileUrl
      },
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    }
  );

  if (response.status !== 202 && response.status !== 201) {
    throw new Error(
      `Яндекс.Диск: не удалось начать загрузку файла в "${path}". ` +
      `HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

async function ensureLeadYandexFolders(lead) {
  const leadId = lead.id;

  const leadFolderPath =
    `${YANDEX_DISK_ROOT_FOLDER}/Сделка (id ${leadId})`;

  const reportsPath = `${leadFolderPath}/Отчеты и проекты`;
  const photoPath = `${reportsPath}/Фотоотчет`;
  const measureSheetPath = `${reportsPath}/Замерный лист`;
  const videoPath = `${reportsPath}/Видео`;
  const contractPath = `${reportsPath}/Договор`;

  console.log("Проверяю/создаю папки на Яндекс.Диске для сделки", leadId);

  await ydEnsureFolderPath(reportsPath);
  await ydEnsureFolder(photoPath);
  await ydEnsureFolder(measureSheetPath);
  await ydEnsureFolder(videoPath);
  await ydEnsureFolder(contractPath);

  const fieldsToUpdate = {
    [REPORTS_LINK_FIELD_ID]:
      await ydGetFolderPublicUrl(
        reportsPath
      ),

    [PHOTO_LINK_FIELD_ID]:
      await ydGetFolderPublicUrl(
        photoPath
      ),

    [MEASURE_SHEET_LINK_FIELD_ID]:
      await ydGetFolderPublicUrl(
        measureSheetPath
      ),

    [VIDEO_LINK_FIELD_ID]:
      await ydGetFolderPublicUrl(
        videoPath
      ),

    [CONTRACT_LINK_FIELD_ID]:
      await ydGetFolderPublicUrl(
        contractPath
      )
  };

  if (Object.keys(fieldsToUpdate).length > 0) {
    try {
      await updateLeadCustomFields(leadId, fieldsToUpdate);
    } catch (error) {
      console.error(
        "Не удалось записать ссылки на папки Диска в сделку:",
        error.message
      );
    }
  }

  return {
    leadFolderPath,
    reportsPath,
    photoPath,
    measureSheetPath,
    videoPath,
    contractPath
  };
}
// ============================================================
// ОБНОВЛЕНИЕ ТОКЕНА AMOMESSENGER
// ============================================================

async function refreshAmoMessengerToken() {
  if (!amomessengerRefreshToken) {
    throw new Error(
      "Refresh Token amoMessenger не найден"
    );
  }

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "ОБНОВЛЯЕМ ТОКЕН AMOMESSENGER"
  );
  console.log(
    "=========================================="
  );

  try {
    const response = await axios.post(
      "https://id.amo.tm/oauth2/access_token",
      {
        grant_type: "refresh_token",

        client_id:
          AMOMESSENGER_CLIENT_ID,

        client_secret:
          AMOMESSENGER_CLIENT_SECRET,

        refresh_token:
          amomessengerRefreshToken,

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

    amomessengerAccessToken =
      response.data.access_token;

    if (response.data.refresh_token) {
      amomessengerRefreshToken =
        response.data.refresh_token;
    }

    // Сохраняем новую пару токенов в Redis.
    await saveAmoMessengerTokensToRedis();

    console.log(
      "Токен amoMessenger успешно обновлён и сохранён в Redis."
    );

    return amomessengerAccessToken;

  } catch (error) {
    console.error(
      "Ошибка обновления токена amoMessenger:",
      error.response
        ? JSON.stringify(error.response.data)
        : error.message
    );

    throw error;
  }
}
// ============================================================
// AMOMESSENGER API (RPA-канал, через виджет / control_transferred)
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
  console.log("amoMessenger POST (RPA)");
  console.log(url);
  console.log("BODY:");
  console.log(JSON.stringify(body, null, 2));

  const doRequest = async () => {
    return axios.post(
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
  };

  try {
    let response =
      await doRequest();

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
        "amoMessenger вернул " +
        `${response.status}. ` +
        "Пробуем обновить токен..."
      );

      await refreshAmoMessengerToken();

      console.log(
        "Повторяем запрос amoMessenger..."
      );

      response =
        await doRequest();

      console.log(
        "amoMessenger response после обновления токена:",
        response.status,
        response.data
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
// ОТПРАВКА СООБЩЕНИЯ (RPA-канал)
// ============================================================

// Собирает объект reply_markup из простого массива подписей кнопок —  используется и RPA-каналом (sendMessengerMessage), и прямым каналом (sendDirectMessage), поэтому вынесено в одну общую функцию.
function buildReplyMarkup(buttons) {
  if (!buttons) {
    return null;
  }

  return {
    inline_keyboard: {
      buttons: buttons.map((buttonText) => ({
        text: buttonText
      }))
    }
  };
}

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

  const replyMarkup = buildReplyMarkup(buttons);

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  return amoMessengerPost(
    botId,
    requestId,
    "sendMessage",
    body
  );
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMOMESSENGER (RPA-канал)
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
// ОТПРАВКА СООБЩЕНИЯ (ПРЯМОЙ КАНАЛ, direct_id)
// ============================================================
// ============================================================
// ДИАГНОСТИКА ПОЛУЧЕНИЯ ПОЛЬЗОВАТЕЛЯ AMOMESSENGER
// ============================================================

async function debugAmoMessengerUser(userId) {
  if (!userId) {
    return null;
  }

  const urls = [
    `https://api.amo.tm/v1.3/users/${userId}`,
    `https://api.amo.tm/v1.3/user/${userId}`,
    `https://api.amo.tm/v1.3/direct/${userId}`
  ];

  for (const url of urls) {
    try {
      console.log("");
      console.log("==========================================");
      console.log("ПРОВЕРЯЕМ ПОЛЬЗОВАТЕЛЯ AMOMESSENGER");
      console.log(url);
      console.log("==========================================");

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${amomessengerAccessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      });

      console.log(
        "AMOMESSENGER USER API RESPONSE:",
        response.status,
        JSON.stringify(response.data, null, 2)
      );

      if (
        response.status >= 200 &&
        response.status < 300
      ) {
        return response.data;
      }

    } catch (error) {
      console.error(
        "Ошибка проверки пользователя amoMessenger:",
        error.message
      );
    }
  }

  return null;
}
// ============================================================
// ПОЛУЧЕНИЕ ИМЕНИ ПОЛЬЗОВАТЕЛЯ ИЗ AMOMESSENGER
// ============================================================

async function getAmoMessengerUserName(userId) {
  if (!userId) {
    return "";
  }

  const doRequest = () =>
    axios.get(
      "https://api.amo.tm/v1.3/users",
      {
        params: {
          "user_id[]": userId
        },
        headers: {
          Authorization: `Bearer ${amomessengerAccessToken}`,
          "Content-Type": "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

  try {
    let response = await doRequest();

    if (
      response.status === 401 ||
      response.status === 403
    ) {
      console.log(
        "amoMessenger вернул " +
        `${response.status} при получении пользователя. ` +
        "Пробуем обновить токен..."
      );

      await refreshAmoMessengerToken();

      response = await doRequest();

      console.log(
        "amoMessenger response после обновления токена (users):",
        response.status
      );
    }

    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "AMOMESSENGER: ПОЛУЧЕНЫ ДАННЫЕ ПОЛЬЗОВАТЕЛЯ"
    );
    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );
    console.log(
      "=========================================="
    );

    const items =
      response.data?._embedded?.items || [];

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      console.log(
        "ПОЛЬЗОВАТЕЛЬ AMOMESSENGER НЕ НАЙДЕН:",
        userId
      );

      return "";
    }

    const user =
      items.find(
        (item) =>
          String(item.id) === String(userId)
      ) || items[0];

    const userName =
      String(
        user?.name || ""
      ).trim();

    console.log(
      "ИМЯ ПОЛЬЗОВАТЕЛЯ AMOMESSENGER:",
      userName
    );

    return userName;

  } catch (error) {
    console.error(
      "ОШИБКА ПОЛУЧЕНИЯ ПОЛЬЗОВАТЕЛЯ AMOMESSENGER:",
      error.response?.status ||
        error.message,
      JSON.stringify(
        error.response?.data || {},
        null,
        2
      )
    );

    return "";
  }
}
async function sendDirectMessage(
  directId,
  text,
  buttons = null
) {
  if (!amomessengerAccessToken) {
    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  const url =
    `https://api.amo.tm/v1.3/direct/${directId}/sendMessage`;

  const body = { text };

  const replyMarkup = buildReplyMarkup(buttons);

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  console.log("");
  console.log("amoMessenger POST (DIRECT)");
  console.log(url);
  console.log("BODY:");
  console.log(JSON.stringify(body, null, 2));

  const doRequest = () =>
    axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${amomessengerAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 30000,
      validateStatus: () => true
    });

  let response = await doRequest();

  console.log(
    "amoMessenger DIRECT response:",
    response.status,
    JSON.stringify(response.data)
  );

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    console.log(
      "amoMessenger вернул " +
      `${response.status} (DIRECT). ` +
      "Пробуем обновить токен..."
    );

    await refreshAmoMessengerToken();

    console.log(
      "Повторяем DIRECT-запрос после обновления токена..."
    );

    response = await doRequest();

    console.log(
      "amoMessenger DIRECT response после обновления токена:",
      response.status,
      JSON.stringify(response.data)
    );
  }

  if (response.status >= 400) {
    throw new Error(
      `amoMessenger DIRECT HTTP ${response.status}`
    );
  }

  return response;
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

function normalizeEngineerName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function leadBelongsToEngineer(lead, engineerName) {
  const values = getEngineerFieldValue(lead);

  const normalizedEngineerName =
    normalizeEngineerName(engineerName);

  if (!values || !normalizedEngineerName) {
    return false;
  }

  return values.some((item) =>
    normalizeEngineerName(item.value) ===
    normalizedEngineerName
  );
}
// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ЗАДАЧ
// ============================================================

async function loadAllTasksPaginated(filterParams, { verbose = false, errorLabel = "" } = {}) {
  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

  const allTasks = [];

  let page = 1;

  while (true) {
    const params = {
      limit: 250,
      page,
      ...filterParams
    };

    if (verbose) {
      console.log("");
      console.log("==========================================");
      console.log(`ЗАГРУЗКА ЗАДАЧ. СТРАНИЦА ${page}`);
      console.log("==========================================");
    }

    const response = await amoCrmGet(url, params);

    if (verbose) {
      console.log("amoCRM tasks response:", response.status);
    }

    if (response.status === 204) {
      if (verbose) {
        console.log("amoCRM вернул 204 — задач больше нет.");
      }

      break;
    }

    if (response.status !== 200) {
      if (verbose) {
        console.error(
          "Ошибка получения задач:",
          response.status,
          response.data
        );
      }

      throw new Error(
        `amoCRM tasks${errorLabel ? ` (${errorLabel})` : ""} HTTP ${response.status}`
      );
    }

    const tasks =
      response.data &&
      Array.isArray(response.data._embedded?.tasks)
        ? response.data._embedded.tasks
        : [];

    if (verbose) {
      console.log(`Получено задач на странице ${page}: ${tasks.length}`);
    }

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    // Защита от бесконечного цикла
    if (page > 20) {
      if (verbose) {
        console.log("Остановлено после 20 страниц.");
      }

      break;
    }
  }

  if (verbose) {
    console.log("");
    console.log(`ВСЕГО ЗАГРУЖЕНО ЗАДАЧ: ${allTasks.length}`);
  }

  return allTasks;
}

async function loadTasksDiagnostic(fromUnix, nowUnix) {
  return loadAllTasksPaginated(
    {
      "filter[task_type][0]": MEASUREMENT_TASK_TYPE_ID,
      "filter[is_completed]": 0,
      "filter[complete_till][from]": fromUnix,
      "filter[complete_till][to]": nowUnix
    },
    { verbose: true }
  );
}

// ============================================================
// ФИЛЬТРАЦИЯ ЗАДАЧ
// ============================================================

async function findMeasurementTasks(engineerName) {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log("ПОИСК ЗАМЕРОВ");
  console.log(
    `Инженер: ${engineerName}`
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

  // 1. Получаем задачи — фильтрация по типу/статусу/дате теперь выполняется на стороне amoCRM API (см. loadTasksDiagnostic).
  

  const tasks =
    await loadTasksDiagnostic(fromUnix, nowUnix);

  console.log(
    `Всего загружено задач (уже отфильтрованных API): ${tasks.length}`
  );

   // 2. Тип задачи — контрольная проверка на стороне бота (на случай если фильтр API вернёт что-то лишнее)

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

  // 3. Незавершённые — контрольная проверка
 
  const notCompletedTasks =
    measurementTypeTasks.filter((task) => {
      return task.is_completed === false;
    });

  console.log(
    `Незавершённых задач этого типа: ${notCompletedTasks.length}`
  );

   // 4. Дата — контрольная проверка

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

   // ВАЖНАЯ ДИАГНОСТИКА

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

   // 5. Проверяем сделки
 
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
      leadBelongsToEngineer(lead, engineerName);

    console.log(
      "Подходит инженер:",
      belongs
    );

    if (!belongs) {
      continue;
    }

       // Подтягиваем контакт (имя + телефоны)
   
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
        engineerName,
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

// ПОИСК ЗАДАЧ "ПРОВЕСТИ ЗАМЕР" (тип 2746009), БЕЗ ФИЛЬТРА ПО ДАТЕ

async function loadConductTasks() {
  return loadAllTasksPaginated(
    {
      "filter[task_type][0]": CONDUCT_TASK_TYPE_ID,
      "filter[is_completed]": 0
    },
    { verbose: false, errorLabel: "conduct" }
  );
}

async function findConductMeasurementTasks(engineerName) {
  console.log("");
  console.log("ПОИСК ЗАДАЧ ПРОВЕСТИ ЗАМЕР (тип " + CONDUCT_TASK_TYPE_ID + ")");

  const tasks = await loadConductTasks();

  const measurements = [];

  for (const task of tasks) {
    if (
      !task.entity_id ||
      task.entity_type !== "leads" ||
      Number(task.task_type_id) !== Number(CONDUCT_TASK_TYPE_ID) ||
      task.is_completed !== false
    ) {
      continue;
    }

    const lead = await getLead(task.entity_id);

    if (!lead) {
      continue;
    }

        if (!leadBelongsToEngineer(lead, engineerName)) {
      continue;
    }

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

    const managerName = await getUserName(lead.responsible_user_id);

    measurements.push({
      task_id: Number(task.id),
      lead_id: Number(task.entity_id),
      lead_link:
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,
      measure_date: formatDateFieldValue(lead, MEASURE_DATE_FIELD_ID),
      address: getFieldValueJoined(lead, ADDRESS_FIELD_ID),
      manager_name: managerName,
      budget:
        lead.price !== undefined && lead.price !== null
          ? String(lead.price)
          : "",
      discount: getFieldValueJoined(lead, DISCOUNT_FIELD_ID),
      product: getFieldValueJoined(lead, PRODUCT_FIELD_ID),
      contract_number: getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID),
      contact_name: contactName,
      contact_phones: contactPhones.join(", ")
    });
  }

  console.log(`ИТОГО ЗАМЕРОВ (Провести замер): ${measurements.length}`);

  return { measurements };
}

function formatConductMeasurementLine(item, index) {
  return (
    `${index + 1}. ` +
    `Дата замера: ${item.measure_date || "—"}; ` +
    `Адрес замера: ${item.address || "—"}; ` +
    `Ответственный менеджер: ${item.manager_name || "—"}; ` +
    `Бюджет: ${item.budget || "—"}; ` +
    `Скидка ОП: ${item.discount || "—"}; ` +
    `Продукт: ${item.product || "—"}; ` +
    `Имя клиента: ${item.contact_name || "—"}; ` +
    `№ телефона (-ов) клиента: ${item.contact_phones || "—"}; ` +
    `№ договора: ${item.contract_number || "—"}; ` +
    `Ссылка на сделку: ${item.lead_link}\n\n`
  );
}

function formatConductMeasurementDetail(item) {
  return (
    `Дата замера: ${item.measure_date || "—"}\n` +
    `Адрес замера: ${item.address || "—"}\n` +
    `Ответственный менеджер: ${item.manager_name || "—"}\n` +
    `Бюджет: ${item.budget || "—"}\n` +
    `Скидка ОП: ${item.discount || "—"}\n` +
    `Продукт: ${item.product || "—"}\n` +
    `Имя клиента: ${item.contact_name || "—"}\n` +
    `№ телефона (-ов) клиента: ${item.contact_phones || "—"}\n` +
    `№ договора: ${item.contract_number || "—"}\n` +
    `Ссылка на сделку: ${item.lead_link}`
  );
}

// ------------------------------------------------------------
// ПОИСК ЗАДАЧ "ЗАГРУЗ. ОТЧЕТ(И)" (тип 2746017), СЦЕНАРИЙ
// "ЗАГРУЗИТЬ ФОТООТЧЕТ". Поля карточки полностью совпадают
// с задачами "Провести замер", поэтому переиспользуем те же
// функции форматирования строки списка (formatConductMeasurementLine).
// ------------------------------------------------------------

async function loadReportTasks() {
  return loadAllTasksPaginated(
    {
      "filter[task_type][0]": REPORT_TASK_TYPE_ID,
      "filter[is_completed]": 0
    },
    { verbose: false, errorLabel: "report" }
  );
}

async function findReportMeasurementTasks(engineerName) {
  console.log("");
  console.log("ПОИСК ЗАДАЧ ЗАГРУЗ. ОТЧЕТ (тип " + REPORT_TASK_TYPE_ID + ")");

  const tasks = await loadReportTasks();

  const measurements = [];

  for (const task of tasks) {
    if (
      !task.entity_id ||
      task.entity_type !== "leads" ||
      Number(task.task_type_id) !== Number(REPORT_TASK_TYPE_ID) ||
      task.is_completed !== false
    ) {
      continue;
    }

    const lead = await getLead(task.entity_id);

    if (!lead) {
      continue;
    }

    if (!leadBelongsToEngineer(lead, engineerName)) {
      continue;
    }

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

    const managerName = await getUserName(lead.responsible_user_id);

    measurements.push({
      task_id: Number(task.id),
      lead_id: Number(task.entity_id),
      lead_link:
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,
      measure_date: formatDateFieldValue(lead, MEASURE_DATE_FIELD_ID),
      address: getFieldValueJoined(lead, ADDRESS_FIELD_ID),
      manager_name: managerName,
      budget:
        lead.price !== undefined && lead.price !== null
          ? String(lead.price)
          : "",
      discount: getFieldValueJoined(lead, DISCOUNT_FIELD_ID),
      product: getFieldValueJoined(lead, PRODUCT_FIELD_ID),
      contract_number: getFieldValueJoined(lead, CONTRACT_NUMBER_FIELD_ID),
      contact_name: contactName,
      contact_phones: contactPhones.join(", ")
    });
  }

  console.log(`ИТОГО ЗАМЕРОВ (Загрузить фотоотчет): ${measurements.length}`);

  return { measurements };
}

async function searchAndPresentReportMeasurements(send, engineerName) {
  return runMeasurementSearchAndPresent(send, {
    searchFn: () => findReportMeasurementTasks(engineerName),
    emptyMessage: "📋 Задач на загрузку отчета не найдено.",
    formatLine: formatConductMeasurementLine,
    errorLogLabel: " (Загрузить фотоотчет)"
  });
}

// Ищет уже существующую (не ожидая появления) незавершённую задачу заданного
// типа в сделке. В отличие от waitForTaskOfType не ждёт и не повторяет попытки —
// используется там, где задача уже должна существовать на момент вызова.
async function findExistingTaskOfType(leadId, taskTypeId) {
  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

  const response = await amoCrmGet(url, {
    limit: 50,
    "filter[entity_type]": "leads",
    "filter[entity_id][0]": leadId,
    "filter[task_type][0]": taskTypeId,
    "filter[is_completed]": 0
  });

  if (response.status !== 200) {
    return null;
  }

  const tasks =
    response.data &&
    Array.isArray(response.data._embedded?.tasks)
      ? response.data._embedded.tasks
      : [];

  return (
    tasks.find(
      (t) =>
        Number(t.task_type_id) === Number(taskTypeId) &&
        t.is_completed === false
    ) || null
  );
}

// ============================================================
// "ПРИВЯЗКА" КНОПОК К КОНКРЕТНОМУ ЗАМЕРУ
// ============================================================

function buildMeasurementIdentifier(item) {
  return item && item.contract_number
    ? `№${item.contract_number}`
    : `задача ${item && item.task_id}`;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTaggedButton(label, identifier) {
  return `${label} (${identifier})`;
}

// Возвращает идентификатор, зашитый в кнопку, если trimmedText — это именно кнопка с данным label; иначе null (значит, это не нажатие данной кнопки вообще).
function parseTaggedButton(text, label) {
  const pattern = new RegExp(
    `^${escapeRegExp(label)} \\((.+)\\)$`
  );

  const match = String(text || "").match(pattern);

  return match ? match[1] : null;
}

function formatMeasurementDetail(item) {
  return (
    `Дата замера: ${item.measure_date || "—"}\n` +
    `Время замера: ${item.measure_time || "—"}\n` +
    `Адрес замера: ${item.address || "—"}\n` +
    `Продукт: ${item.product || "—"}\n` +
    `Имя контакта: ${item.contact_name || "—"}\n` +
    `№ телефона (-ов) контакта: ${item.contact_phones || "—"}\n` +
    `№ договора: ${item.contract_number || "—"}\n` +
    `Ссылка на сделку: ${item.lead_link}`
  );
}

function buildMeasurementActionButtons(item) {
  const id = buildMeasurementIdentifier(item);

  return [
    buildTaggedButton("Замер подтвержден", id),
    buildTaggedButton("Перенос замера", id),
    buildTaggedButton("Отказ", id)
  ];
}

function buildConductActionButtons(item) {
  const id = buildMeasurementIdentifier(item);

  return [
    buildTaggedButton("Замер состоялся", id),
    buildTaggedButton("Замер не состоялся", id)
  ];
}

// Сообщает пользователю, что нажатая кнопка относится к уже неактуальному сообщению
async function sendStaleButtonNotice(send, currentStoredItem, kind) {
  if (currentStoredItem) {
    await send(
      "⚠️ Это кнопка из уже неактуального сообщения — сейчас в работе " +
        "другой замер. Вот его карточка ещё раз:"
    );

    if (kind === "conduct") {
      await send(
        formatConductMeasurementDetail(currentStoredItem),
        buildConductActionButtons(currentStoredItem)
      );
    } else {
      await send(
        formatMeasurementDetail(currentStoredItem),
        buildMeasurementActionButtons(currentStoredItem)
      );
    }

    return;
  }

  await send(
    "⚠️ Это кнопка из уже неактуального сообщения — замер уже " +
      "обработан или сессия обновилась. Пожалуйста, начните заново: " +
      (kind === "conduct"
        ? "нажмите «Провести замер»."
        : "нажмите «Подтвердить замер».")
  );
}

async function resolveActiveMeasurementOrNotify(
  send,
  finish,
  measurementMap,
  userKey,
  buttonId,
  kind
) {
  const stored = measurementMap[userKey];

  if (!stored || buildMeasurementIdentifier(stored) !== buttonId) {
    await sendStaleButtonNotice(send, stored, kind);

    if (!stored) {
      await finish();
    }

    return null;
  }

  return stored;
}

async function runMeasurementSearchAndPresent(send, {
  searchFn,
  emptyMessage,
  formatLine,
  errorLogLabel
}) {
  let shouldFinish = true;

  try {
    const result = await searchFn();

    if (result.measurements.length === 0) {
      await send(emptyMessage);
    } else {
      let message = "📋 Найдены замеры:\n\n";

      result.measurements.forEach((item, index) => {
        message += formatLine(item, index);
      });

      const buttons = result.measurements.map(
        (item) => item.contract_number || `Задача ${item.task_id}`
      );

      await send(message, buttons);

          shouldFinish = false;
    }
  } catch (error) {
    console.error(`Ошибка поиска замеров${errorLogLabel}:`, error.message);

    try {
      await send(
        "❌ Произошла ошибка при поиске задач. Подробности есть в логах Render."
      );
    } catch (sendError) {
      console.error("Ошибка отправки ошибки:", sendError.message);
    }
  }

  return shouldFinish;
}

async function searchAndPresentConductMeasurements(send, engineerName) {
  return runMeasurementSearchAndPresent(send, {
    searchFn: () => findConductMeasurementTasks(engineerName),
    emptyMessage: "📋 Замеров для проведения не найдено.",
    formatLine: formatConductMeasurementLine,
    errorLogLabel: " (Провести замер)"
  });
}

// Ждём (до 30 секунд), пока в сделке появится задача типа "Рез-т замера(и)" (id 2746013), которую ставит Sensei. Проверяем каждые 3 секунды, максимум 10 раз.
async function waitForTaskOfType(leadId, taskTypeId) {
  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const response = await amoCrmGet(url, {
      limit: 50,
      "filter[entity_type]": "leads",
      "filter[entity_id][0]": leadId,
      "filter[task_type][0]": taskTypeId,
      "filter[is_completed]": 0
    });

    if (response.status === 200) {
      const tasks =
        response.data &&
        Array.isArray(response.data._embedded?.tasks)
          ? response.data._embedded.tasks
          : [];

      const found = tasks.find(
        (t) =>
          Number(t.task_type_id) === Number(taskTypeId) &&
          t.is_completed === false
      );

      if (found) {
        return found;
      }
    }
  }

  return null;
}

async function waitForResultTask(leadId) {
  return waitForTaskOfType(leadId, RESULT_TASK_TYPE_ID);
}

// Показывается после загрузки фото договора и после веток
// "Думает (свяжусь сам)" / "Думает/отказ (передать менеджеру)" /
// выбора результата по КП — предлагает перейти к загрузке отчета
// и замерного листа по этой же сделке.
async function offerReportStart(send, userKey, leadId) {
  userPendingReportStart[userKey] = { lead_id: leadId };

  await send(
    "Загрузите отчет и замерный лист",
    ["Перейти к загрузке отчета"]
  );
}

// ------------------------------------------------------------
// ВХОД НА ЭКРАН "ЗАГРУЗИТЕ ФОТООТЧЕТ" (хаб сценария "Загрузить фотоотчет")
// ------------------------------------------------------------
// Готовит папки на Яндекс.Диске для сделки, запоминает их пути (чтобы не
// запрашивать заново на каждом шаге), обнуляет флаги "что уже загружено"
// и показывает экран с кнопками.

async function enterReportHub(send, finish, userKey, leadId, reportTaskId) {
  try {
    const lead = await getLead(leadId);

    if (!lead) {
      throw new Error("Сделка не найдена");
    }

    const folders = await ensureLeadYandexFolders(lead);

    const dateText = todayMoscowDateText();

    const nextPhotoNumber = await ydGetNextDocumentFileNumber(
      folders.photoPath,
      "Фотоотчет",
      dateText
    );

    userReportUploadFlags[userKey] = {
      photo: false,
      measureSheet: false,
      video: false
    };

    userPendingReportHub[userKey] = {
      lead_id: leadId,
      report_task_id: reportTaskId,
      folders,
      photo_date_text: dateText,
      photo_next_number: nextPhotoNumber
    };

    await send(
  "Загрузите фото замера",
  ["Вернуться к списку замеров"]
);
  } catch (error) {
    console.error(
      "Ошибка подготовки папок на Яндекс.Диске (Загрузить фотоотчет):",
      error.message
    );

    await send(
      "❌ Не удалось подготовить папки на Яндекс.Диске. " +
        "Подробности есть в логах Render."
    );

    await finish();
  }
}

// ------------------------------------------------------------
// ПРИМЕЧАНИЕ СО ССЫЛКАМИ НА ПАПКИ (только те, куда реально что-то загрузили)
// ------------------------------------------------------------

async function buildReportNoteText(folders, flags) {
  const lines = ["Ссылки на папки в yandex:"];

  if (flags && flags.photo) {
    const url = await ydGetFolderPublicUrl(folders.photoPath);

    lines.push(`Фотоотчет: ${url}`);
  }

  if (flags && flags.measureSheet) {
    const url = await ydGetFolderPublicUrl(folders.measureSheetPath);

    lines.push(`Замерный лист: ${url}`);
  }

  if (flags && flags.video) {
    const url = await ydGetFolderPublicUrl(folders.videoPath);

    lines.push(`Видео: ${url}`);
  }

  return lines.join("\n");
}

// ------------------------------------------------------------
// ЗАВЕРШЕНИЕ ОТЧЕТА (кнопка "Завершить отчет" на шаге замерного листа
// или на шаге видео)
// ------------------------------------------------------------

async function finishReportFlow(
  send,
  finish,
  userKey,
  leadId,
  reportTaskId
) {
  try {
    await senseiCompleteTask(
      leadId,
      reportTaskId,
      "Отчет загружен"
    );
  } catch (error) {
    console.error(
      "Ошибка завершения задачи (Загруз. отчет(и)):",
      error.message
    );

    await send(
      "❌ Не удалось завершить задачу в Sensei. " +
        "Подробности есть в логах Render. Попробуйте ещё раз " +
        "или обратитесь к администратору."
    );

    await finish();

    return;
  }

  const flags = userReportUploadFlags[userKey];

  try {
    const lead = await getLead(leadId);

    if (lead) {
      const folders = await ensureLeadYandexFolders(lead);

      const noteText = await buildReportNoteText(folders, flags);

      await addLeadNote(leadId, noteText);
    }
  } catch (error) {
    console.error(
      "Не удалось добавить примечание со ссылками на папки:",
      error.message
    );
  }

  delete userPendingReportHub[userKey];
  delete userPendingMeasureSheetUpload[userKey];
  delete userPendingVideoUpload[userKey];
  delete userReportUploadFlags[userKey];

  await startBudgetEditStep(send, userKey, leadId);
}

// ------------------------------------------------------------
// ШАГ 7: ПРАВКА БЮДЖЕТА СДЕЛКИ
// ------------------------------------------------------------

async function startBudgetEditStep(send, userKey, leadId) {
  let budgetText = "—";

  try {
    const lead = await getLead(leadId);

    if (lead && lead.price !== undefined && lead.price !== null) {
      budgetText = String(lead.price);
    }
  } catch (error) {
    console.error(
      "Не удалось получить бюджет сделки:",
      error.message
    );
  }

  userPendingBudgetEdit[userKey] = { lead_id: leadId };

  await send(
    `Бюджет сделки: ${budgetText}\nВнесите изменения`,
    ["Без изменений"]
  );
}

// ------------------------------------------------------------
// ШАГ 8: ПРАВКА E-MAIL КЛИЕНТА
// ------------------------------------------------------------

async function startEmailEditStep(send, userKey, leadId) {
  let emailText = "пусто";
  let contactId = null;

  try {
    const lead = await getLead(leadId);

    contactId = getMainContactId(lead);

    if (contactId) {
      const contact = await getContact(contactId);

      const currentEmail = getFieldValueJoined(
        contact,
        CONTACT_EMAIL_FIELD_ID
      );

      if (currentEmail) {
        emailText = currentEmail;
      }
    }
  } catch (error) {
    console.error(
      "Не удалось получить e-mail клиента:",
      error.message
    );
  }

  userPendingEmailEdit[userKey] = {
    lead_id: leadId,
    contact_id: contactId
  };

  await send(
    `E-mail клиента: ${emailText}\nВнесите изменения`,
    ["Без изменений"]
  );
}

// Возврат к списку задач "Загруз. отчет(и)" — финальный шаг п.9/п.10 сценария.
async function returnToReportList(send, finish, userKey, engineerName) {
  userLastSearchMode[userKey] = "report";

  const shouldFinish = await searchAndPresentReportMeasurements(send, engineerName);

  if (shouldFinish) {
    await finish();
  }
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
      MEASUREMENT_TASK_TYPE_ID,
    conduct_task_type_id:
      CONDUCT_TASK_TYPE_ID,
    result_task_type_id:
      RESULT_TASK_TYPE_ID,
        kp_task_type_id:
      KP_TASK_TYPE_ID,
    report_task_type_id:
      REPORT_TASK_TYPE_ID,
    yandex_disk_token:
      YANDEX_DISK_TOKEN ? "ДА" : "НЕТ"
  });
});

// ============================================================
// DEBUG: TOKENS (ВРЕМЕННЫЙ ЭНДПОИНТ)
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

await saveAmoCrmTokensToRedis();

console.log(
  "amoCRM токены успешно получены и сохранены в Redis."
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
        await findMeasurementTasks(ENGINEER_NAME);

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

// Сохраняем новые токены постоянно,
// чтобы они не потерялись после перезапуска Render.
await saveAmoMessengerTokensToRedis();

console.log(
  "amoMessenger токены успешно получены и сохранены в Redis."
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
// СЦЕНАРИЙ "ВНЕСТИ ПРАВКИ"
// ============================================================

async function loadCorrectionTasks() {
  return loadAllTasksPaginated(
    {
      "filter[task_type][0]": CORRECTION_TASK_TYPE_ID,
      "filter[is_completed]": 0
    },
    {
      verbose: false,
      errorLabel: "correction"
    }
  );
}

async function findCorrectionTasks(engineerName) {
  const tasks =
    await loadCorrectionTasks();

  const measurements = [];

  for (const task of tasks) {
    if (
      !task.entity_id ||
      task.entity_type !== "leads" ||
      Number(task.task_type_id) !==
        Number(CORRECTION_TASK_TYPE_ID) ||
      task.is_completed !== false
    ) {
      continue;
    }

    const lead =
      await getLead(task.entity_id);

    if (
      !lead ||
      !leadBelongsToEngineer(
        lead,
        engineerName
      )
    ) {
      continue;
    }

    let contactName = "";
    let contactPhones = [];

    const mainContactId =
      getMainContactId(lead);

    if (mainContactId) {
      const contact =
        await getContact(mainContactId);

      if (contact) {
        contactName =
          contact.name || "";

        contactPhones =
          getContactPhones(contact);
      }
    }

    measurements.push({
      task_id: Number(task.id),

      lead_id:
        Number(task.entity_id),

      lead_link:
        `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${task.entity_id}`,

      measure_date:
        formatDateFieldValue(
          lead,
          MEASURE_DATE_FIELD_ID
        ),

      address:
        getFieldValueJoined(
          lead,
          ADDRESS_FIELD_ID
        ),

      manager_name:
        await getUserName(
          lead.responsible_user_id
        ),

      budget:
        lead.price !== undefined &&
        lead.price !== null
          ? String(lead.price)
          : "",

      product:
        getFieldValueJoined(
          lead,
          PRODUCT_FIELD_ID
        ),

      contact_name:
        contactName,

      contact_phones:
        contactPhones.join(", "),

      contract_number:
        getFieldValueJoined(
          lead,
          CONTRACT_NUMBER_FIELD_ID
        ),

      bot_not_accepted:
        getFieldValueJoined(
          lead,
          BOT_NOT_ACCEPTED_FIELD_ID
        )
    });
  }

  return {
    measurements
  };
}

function formatCorrectionLine(
  item,
  index
) {
  return (
    `${index + 1}. ` +
    `Дата замера: ${item.measure_date || "—"}; ` +
    `Адрес замера: ${item.address || "—"}; ` +
    `Ответственный менеджер: ${item.manager_name || "—"}; ` +
    `Бюджет: ${item.budget || "—"}; ` +
    `Продукт: ${item.product || "—"}; ` +
    `Имя клиента: ${item.contact_name || "—"}; ` +
    `№ телефона клиента: ${item.contact_phones || "—"}; ` +
    `№ договора: ${item.contract_number || "—"}; ` +
    `[Бот] Не принято: ${item.bot_not_accepted || "—"}; ` +
    `Ссылка на сделку: ${item.lead_link}\n\n`
  );
}

function formatCorrectionDetail(item) {
  return (
    `Дата замера: ${item.measure_date || "—"}\n` +
    `Адрес замера: ${item.address || "—"}\n` +
    `Ответственный менеджер: ${item.manager_name || "—"}\n` +
    `Бюджет: ${item.budget || "—"}\n` +
    `Продукт: ${item.product || "—"}\n` +
    `Имя клиента: ${item.contact_name || "—"}\n` +
    `№ телефона клиента: ${item.contact_phones || "—"}\n` +
    `№ договора: ${item.contract_number || "—"}\n` +
    `[Бот] Не принято: ${item.bot_not_accepted || "—"}`
  );
}

function buildCorrectionActionButtons() {
  return [
    "Замерный лист",
    "Фотоотчет",
    "Видеоотчет",
    "Договор",
    "Правки внесены"
  ];
}
// ------------------------------------------------------------
// СЦЕНАРИЙ "ВНЕСТИ ПРАВКИ": ЗАГРУЗКА ФАЙЛОВ ПО ТИПАМ
// ------------------------------------------------------------

const CORRECTION_UPLOAD_TYPES = {
  "Замерный лист": {
    folderKey: "measureSheetPath",
    prefix: "Замерный лист",
    promptText: "Загрузите замерный лист"
  },
  "Фотоотчет": {
    folderKey: "photoPath",
    prefix: "Фотоотчет",
    promptText: "Загрузите фотоотчет"
  },
  "Видеоотчет": {
    folderKey: "videoPath",
    prefix: "Видео",
    promptText: "Загрузите видео"
  },
  "Договор": {
    folderKey: "contractPath",
    prefix: "Договор",
    promptText: "Загрузите фото договора"
  }
};

async function startCorrectionUpload(
  send,
  finish,
  userKey,
  correction,
  buttonText
) {
  const config = CORRECTION_UPLOAD_TYPES[buttonText];

  if (!config) {
    await send("⚠️ Неизвестный тип правки. Попробуйте ещё раз.");
    return;
  }

  try {
    const lead = await getLead(correction.lead_id);

    if (!lead) {
      throw new Error("Сделка не найдена");
    }

    const folders = await ensureLeadYandexFolders(lead);

    const folderPath = folders[config.folderKey];

    const dateText = todayMoscowDateText();

    const nextFileNumber = await ydGetNextDocumentFileNumber(
      folderPath,
      config.prefix,
      dateText
    );

    userPendingCorrectionUpload[userKey] = {
      lead_id: correction.lead_id,
      task_id: correction.task_id,
      button_text: buttonText,
      folder_path: folderPath,
      prefix: config.prefix,
      date_text: dateText,
      next_file_number: nextFileNumber,
      has_uploaded_file: false,
      prompt_text: config.promptText
    };

    await send(config.promptText);
  } catch (error) {
    console.error(
      "Ошибка подготовки папки на Яндекс.Диске (Внести правки):",
      error.message
    );

    await send(
      "❌ Не удалось подготовить папку на Яндекс.Диске. " +
        "Подробности есть в логах Render."
    );

    await finish();
  }
}
async function searchAndPresentCorrections(
  send,
  userKey,
  engineerName
) {
  const result =
    await findCorrectionTasks(
      engineerName
    );

  userCorrectionList[userKey] =
    result.measurements;

  if (
    result.measurements.length === 0
  ) {
    await send(
      "Задач на внесение правок не найдено"
    );

    return true;
  }

  let message =
    "📋 Найдены замеры:\n\n";

  result.measurements.forEach(
    (item, index) => {
      message +=
        formatCorrectionLine(
          item,
          index
        );
    }
  );

  const buttons =
    result.measurements.map(
      (item) =>
        item.contract_number ||
        `Задача ${item.task_id}`
    );

  await send(
    message,
    buttons
  );

  return false;
}
// ============================================================
// ПОИСК ЗАМЕРОВ + ОТПРАВКА СПИСКА ПОЛЬЗОВАТЕЛЮ
// ============================================================

function formatMeasurementLine(item, index) {
  return (
    `${index + 1}. ` +
    `№ договора: ${item.contract_number || "—"}; ` +
    `Дата замера: ${item.measure_date || "—"}; ` +
    `Время замера: ${item.measure_time || "—"}; ` +
    `Адрес замера: ${item.address || "—"}; ` +
    `Продукт: ${item.product || "—"}; ` +
    `Имя контакта: ${item.contact_name || "—"}; ` +
    `№ телефона (-ов) контакта: ${item.contact_phones || "—"}; ` +
    `Ссылка на сделку: ${item.lead_link}\n\n`
  );
}

async function searchAndPresentMeasurements(send, engineerName) {
  return runMeasurementSearchAndPresent(send, {
    searchFn: () => findMeasurementTasks(engineerName),
    emptyMessage: "📋 Замеров для подтверждения не найдено.",
    formatLine: formatMeasurementLine,
    errorLogLabel: ""
  });
}

// ============================================================
// ОБРАБОТКА ТЕКСТА/КНОПКИ ОТ ПОЛЬЗОВАТЕЛЯ
// ============================================================

async function processUserMessage({
  text,
  userKey,
  userName,
  send,
  finish,
  imageUrls
}) {
  const trimmedText = (text || "").trim();

  const currentEngineerName =
    String(
      userName ||
      userEngineerName[userKey] ||
      ""
    ).trim();

  if (currentEngineerName) {
    userEngineerName[userKey] =
      currentEngineerName;
  }

  console.log(
    "Обработка сообщения пользователя:",
    userKey,
    trimmedText
  );

  // ------------------------------------------------------
  // СТАРТ / ПЕРЕЗАПУСК АЛГОРИТМА
  // ------------------------------------------------------
 
  if (isStartCommand(trimmedText)) {
    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ЗАПУСТИЛ/ПЕРЕЗАПУСТИЛ АЛГОРИТМ:",
      trimmedText
    );

    console.log(
      "=========================================="
    );

    resetUserState(userKey);

    await send(MAIN_MENU_TEXT, MAIN_MENU_BUTTONS);

      return;
  }

  // ------------------------------------------------------
  // ОЖИДАЕМ КОММЕНТАРИЙ (после "Перенос замера" / "Отказ")
  // ------------------------------------------------------
 
  const pendingComment = userPendingComment[userKey];

  if (pendingComment) {
    const comment = trimmedText;

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
      const promptLabel =
        pendingComment.promptText || "Укажите комментарий";

      await send(
        `Комментарий не может быть пустым. ${promptLabel}`
      );

      return;
    }

    try {
      
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

      await send(
        `Текущая задача amoCRM закрыта с результатом ` +
          `"${pendingComment.displayResult}".`
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи через Sensei:",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );
    }

    delete userPendingComment[userKey];
    delete userSelectedMeasurement[userKey];

    // Возвращаемся к шагу поиска: для сценария "Подтвердить замер"

    const shouldFinish =
      pendingComment.afterSearchMode === "conduct"
        ? await searchAndPresentConductMeasurements(send, currentEngineerName)
        : await searchAndPresentMeasurements(send, currentEngineerName);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  // ------------------------------------------------------
  // ОЖИДАЕМ ФОТО ДОГОВОРА (после кнопки "Заключен договор")
  // ------------------------------------------------------

  const pendingPhoto = userPendingPhotoUpload[userKey];

  if (pendingPhoto) {
    // Кнопка "Готово" — пользователь закончил загрузку фото.
  
    if (trimmedText === "Готово") {
      if (!pendingPhoto.has_uploaded_photo) {
        await send(
          "Пока не получено ни одного фото договора. " +
            "Загрузите хотя бы одно фото, прежде чем нажать «Готово»."
        );

        return;
      }

      await send("✅ Фото сохранены. Спасибо!");

      const finishedLeadId = pendingPhoto.lead_id;

      delete userPendingPhotoUpload[userKey];

      await offerReportStart(send, userKey, finishedLeadId);

      return;
    }

   if (
  imageUrls &&
  imageUrls.length > 0
) {
  // --------------------------------------------------------
  // СТАВИМ ЗАГРУЗКУ В ОЧЕРЕДЬ
  // --------------------------------------------------------

  const previousQueue =
    userPhotoUploadQueue[userKey] ||
    Promise.resolve();

  const currentQueue =
    previousQueue
      .catch(() => {
        // Не даём ошибке предыдущей загрузки
        // остановить очередь.
      })
      .then(async () => {
        // ВАЖНО:
        // Получаем актуальное состояние внутри очереди,
        // а не используем pendingPhoto, полученный до ожидания.
        const currentPendingPhoto =
          userPendingPhotoUpload[
            userKey
          ];

        if (
          !currentPendingPhoto
        ) {
          return;
        }

        let uploaded = 0;

        for (
          const url of imageUrls
        ) {
          try {
            // Берём номер непосредственно перед загрузкой.
            const currentNumber =
              currentPendingPhoto
                .next_file_number;

            const fileName =
              buildContractFileName(
                currentPendingPhoto
                  .contract_date_text,
                currentNumber
              );

            console.log(
              "Загружаю фото договора:",
              {
                userKey,
                url,
                fileName,
                number:
                  currentNumber
              }
            );

            await ydUploadFromUrl(
              `${currentPendingPhoto.contract_path}/${fileName}`,
              url
            );

            // Номер увеличиваем только после успешного запуска загрузки на Яндекс.Диск.
            currentPendingPhoto
              .next_file_number =
                currentNumber + 1;

            uploaded++;

            console.log(
              "Фото успешно отправлено на Яндекс.Диск:",
              fileName
            );
          } catch (error) {
            console.error(
              "Ошибка загрузки фото на Яндекс.Диск:",
              error.message
            );
          }
        }

        if (
          uploaded > 0
        ) {
          currentPendingPhoto.has_uploaded_photo = true;

          await send(
            `Фото получено (${uploaded}). ` +
            "Когда закончите — нажмите «Готово».",
            ["Готово"]
          );
        } else if (currentPendingPhoto.has_uploaded_photo) {
           await send(
            "❌ Не удалось сохранить фото на Яндекс.Диске. " +
            "Попробуйте ещё раз или нажмите «Готово», " +
            "чтобы закончить.",
            ["Готово"]
          );
        } else {
          await send(
            "❌ Не удалось сохранить фото на Яндекс.Диске. " +
            "Попробуйте загрузить его ещё раз."
          );
        }
      });

  userPhotoUploadQueue[
    userKey
  ] =
    currentQueue;

  try {
    await currentQueue;
  } finally {
   if (
      userPhotoUploadQueue[
        userKey
      ] === currentQueue
    ) {
      delete userPhotoUploadQueue[
        userKey
      ];
    }
  }

  return;
}

   if (pendingPhoto.has_uploaded_photo) {
      await send(
        "Загрузите фото договора и нажмите «Готово», когда закончите.",
        ["Готово"]
      );
    } else {
      await send(
        "Загрузите фото договора."
      );
    }

    return;
  }

  // ------------------------------------------------------
  // ЭКРАН "ЗАГРУЗИТЕ ФОТО замера" (хаб сценария "Загрузить фотоотчет")
  // Пользователь может прислать фото (папка "Фотоотчет") или нажать
  // одну из двух кнопок.
  // ------------------------------------------------------

  const pendingReportHub = userPendingReportHub[userKey];

  if (pendingReportHub) {
    if (trimmedText === "Вернуться к списку замеров") {
      delete userPendingReportHub[userKey];
      delete userReportUploadFlags[userKey];

      await returnToReportList(send, finish, userKey, currentEngineerName);

      return;
    }

    if (trimmedText === "Перейти к загрузке замерн.листа") {
      try {
        const dateText = todayMoscowDateText();

        const nextFileNumber = await ydGetNextDocumentFileNumber(
          pendingReportHub.folders.measureSheetPath,
          "Замерный лист",
          dateText
        );

        userPendingMeasureSheetUpload[userKey] = {
          lead_id: pendingReportHub.lead_id,
          report_task_id: pendingReportHub.report_task_id,
          folders: pendingReportHub.folders,
          measure_sheet_path: pendingReportHub.folders.measureSheetPath,
          date_text: dateText,
          next_file_number: nextFileNumber,
          has_uploaded_file: false
        };

        delete userPendingReportHub[userKey];

        await send("Загрузите замерный лист");
      } catch (error) {
        console.error(
          "Ошибка подготовки папки замерного листа:",
          error.message
        );

        await send(
          "❌ Не удалось подготовить папку на Яндекс.Диске. " +
            "Подробности есть в логах Render."
        );

        await finish();
      }

      return;
    }

    if (imageUrls && imageUrls.length > 0) {
      // --------------------------------------------------------
      // СТАВИМ ЗАГРУЗКУ ФОТО ОТЧЕТА В ОЧЕРЕДЬ
      // --------------------------------------------------------

      const previousQueue =
        userReportPhotoUploadQueue[userKey] || Promise.resolve();

      const currentQueue = previousQueue
        .catch(() => {
          // Не даём ошибке предыдущей загрузки остановить очередь.
        })
        .then(async () => {
          const currentHub = userPendingReportHub[userKey];

          if (!currentHub) {
            return;
          }

          let uploaded = 0;

          for (const url of imageUrls) {
            try {
              const currentNumber = currentHub.photo_next_number;

              const fileName = buildDocumentFileName(
                "Фотоотчет",
                currentHub.photo_date_text,
                currentNumber
              );

              console.log("Загружаю фото отчета:", {
                userKey,
                url,
                fileName,
                number: currentNumber
              });

              await ydUploadFromUrl(
                `${currentHub.folders.photoPath}/${fileName}`,
                url
              );

              currentHub.photo_next_number = currentNumber + 1;

              uploaded++;

              console.log(
                "Фото отчета успешно отправлено на Яндекс.Диск:",
                fileName
              );
            } catch (error) {
              console.error(
                "Ошибка загрузки фото отчета на Яндекс.Диск:",
                error.message
              );
            }
          }

         if (uploaded > 0) {
  if (userReportUploadFlags[userKey]) {
    userReportUploadFlags[userKey].photo = true;
  }

  await send(
    `Фото получено (${uploaded}). Когда закончите — нажмите «Перейти к загрузке замерн.листа».`,
    [
      "Перейти к загрузке замерн.листа",
      "Вернуться к списку замеров"
    ]
  );
} else {
            await send(
              "❌ Не удалось сохранить фото на Яндекс.Диске. " +
                "Попробуйте ещё раз.",
              [
                "Перейти к загрузке замерн.листа",
                "Вернуться к списку замеров"
              ]
            );
          }
        });

      userReportPhotoUploadQueue[userKey] = currentQueue;

      try {
        await currentQueue;
      } finally {
        if (userReportPhotoUploadQueue[userKey] === currentQueue) {
          delete userReportPhotoUploadQueue[userKey];
        }
      }

      return;
    }

    // Другой текст на этом экране — напоминаем про доступные кнопки.
    await send(
  "Загрузите фото замера.",
  ["Вернуться к списку замеров"]
);

return;
  }

  // ------------------------------------------------------
  // ОЖИДАЕМ ФАЙЛЫ ЗАМЕРНОГО ЛИСТА
  // (после кнопки "Перейти к загрузке замерн.листа")
  // ------------------------------------------------------

  const pendingMeasureSheet = userPendingMeasureSheetUpload[userKey];

  if (pendingMeasureSheet) {
    // Пользователь нажал одну из двух кнопок завершения загрузки.

    if (
      trimmedText === "Перейти к загрузке видео" ||
      trimmedText === "Завершить отчет"
    ) {
      if (!pendingMeasureSheet.has_uploaded_file) {
        await send(
          "Пока не получено ни одного файла замерного листа. " +
            "Загрузите хотя бы один файл, прежде чем продолжить."
        );

        return;
      }

      if (trimmedText === "Перейти к загрузке видео") {
        try {
          const dateText = todayMoscowDateText();

          const nextFileNumber = await ydGetNextDocumentFileNumber(
            pendingMeasureSheet.folders.videoPath,
            "Видео",
            dateText
          );

          userPendingVideoUpload[userKey] = {
            lead_id: pendingMeasureSheet.lead_id,
            report_task_id: pendingMeasureSheet.report_task_id,
            folders: pendingMeasureSheet.folders,
            video_path: pendingMeasureSheet.folders.videoPath,
            date_text: dateText,
            next_file_number: nextFileNumber,
            has_uploaded_file: false
          };

          delete userPendingMeasureSheetUpload[userKey];

          await send("Загрузите видео");
        } catch (error) {
          console.error(
            "Ошибка подготовки папки видео:",
            error.message
          );

          await send(
            "❌ Не удалось подготовить папку на Яндекс.Диске. " +
              "Подробности есть в логах Render."
          );

          await finish();
        }

        return;
      }

      // trimmedText === "Завершить отчет"

      await finishReportFlow(
        send,
        finish,
        userKey,
        pendingMeasureSheet.lead_id,
        pendingMeasureSheet.report_task_id
      );

      return;
    }

    if (imageUrls && imageUrls.length > 0) {
      // --------------------------------------------------------
      // СТАВИМ ЗАГРУЗКУ В ОЧЕРЕДЬ (по аналогии с фото договора)
      // --------------------------------------------------------

      const previousQueue =
        userMeasureSheetUploadQueue[userKey] || Promise.resolve();

      const currentQueue = previousQueue
        .catch(() => {
          // Не даём ошибке предыдущей загрузки остановить очередь.
        })
        .then(async () => {
          const currentPending =
            userPendingMeasureSheetUpload[userKey];

          if (!currentPending) {
            return;
          }

          let uploaded = 0;

          for (const url of imageUrls) {
            try {
              const currentNumber =
                currentPending.next_file_number;

              const fileName = buildMeasureSheetFileName(
                currentPending.date_text,
                currentNumber
              );

              console.log("Загружаю файл замерного листа:", {
                userKey,
                url,
                fileName,
                number: currentNumber
              });

              await ydUploadFromUrl(
                `${currentPending.measure_sheet_path}/${fileName}`,
                url
              );

              currentPending.next_file_number = currentNumber + 1;

              uploaded++;

              console.log(
                "Файл замерного листа успешно отправлен на Яндекс.Диск:",
                fileName
              );
            } catch (error) {
              console.error(
                "Ошибка загрузки файла замерного листа на Яндекс.Диск:",
                error.message
              );
            }
          }

          if (uploaded > 0) {
            currentPending.has_uploaded_file = true;

            if (userReportUploadFlags[userKey]) {
              userReportUploadFlags[userKey].measureSheet = true;
            }

            await send(
              `Файл(ы) получено (${uploaded}). Когда закончите — выберите действие:`,
              ["Перейти к загрузке видео", "Завершить отчет"]
            );
          } else if (currentPending.has_uploaded_file) {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте ещё раз или выберите действие:",
              ["Перейти к загрузке видео", "Завершить отчет"]
            );
          } else {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте загрузить его ещё раз."
            );
          }
        });

      userMeasureSheetUploadQueue[userKey] = currentQueue;

      try {
        await currentQueue;
      } finally {
        if (userMeasureSheetUploadQueue[userKey] === currentQueue) {
          delete userMeasureSheetUploadQueue[userKey];
        }
      }

      return;
    }

    if (pendingMeasureSheet.has_uploaded_file) {
      await send(
        "Загрузите замерный лист или выберите действие:",
        ["Перейти к загрузке видео", "Завершить отчет"]
      );
    } else {
      await send("Загрузите замерный лист.");
    }

    return;
  }

  // ------------------------------------------------------
  // ОЖИДАЕМ ВИДЕО (после кнопки "Перейти к загрузке видео")
  // ------------------------------------------------------

  const pendingVideo = userPendingVideoUpload[userKey];

  if (pendingVideo) {
    if (trimmedText === "Завершить отчет") {
      if (!pendingVideo.has_uploaded_file) {
        await send(
          "Пока не получено ни одного видео. " +
            "Загрузите хотя бы один файл, прежде чем продолжить."
        );

        return;
      }

      await finishReportFlow(
        send,
        finish,
        userKey,
        pendingVideo.lead_id,
        pendingVideo.report_task_id
      );

      return;
    }

    if (imageUrls && imageUrls.length > 0) {
      // --------------------------------------------------------
      // СТАВИМ ЗАГРУЗКУ ВИДЕО В ОЧЕРЕДЬ
      // --------------------------------------------------------

      const previousQueue =
        userVideoUploadQueue[userKey] || Promise.resolve();

      const currentQueue = previousQueue
        .catch(() => {
          // Не даём ошибке предыдущей загрузки остановить очередь.
        })
        .then(async () => {
          const currentPending = userPendingVideoUpload[userKey];

          if (!currentPending) {
            return;
          }

          let uploaded = 0;

          for (const url of imageUrls) {
            try {
              const currentNumber = currentPending.next_file_number;

              const fileName = buildVideoFileName(
                currentPending.date_text,
                currentNumber
              );

              console.log("Загружаю видео:", {
                userKey,
                url,
                fileName,
                number: currentNumber
              });

              await ydUploadFromUrl(
                `${currentPending.video_path}/${fileName}`,
                url
              );

              currentPending.next_file_number = currentNumber + 1;

              uploaded++;

              console.log(
                "Видео успешно отправлено на Яндекс.Диск:",
                fileName
              );
            } catch (error) {
              console.error(
                "Ошибка загрузки видео на Яндекс.Диск:",
                error.message
              );
            }
          }

          if (uploaded > 0) {
            currentPending.has_uploaded_file = true;

            if (userReportUploadFlags[userKey]) {
              userReportUploadFlags[userKey].video = true;
            }

            await send(
              `Файл(ы) получено (${uploaded}). ` +
                "Когда закончите — нажмите «Завершить отчет».",
              ["Завершить отчет"]
            );
          } else if (currentPending.has_uploaded_file) {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте ещё раз или нажмите «Завершить отчет».",
              ["Завершить отчет"]
            );
          } else {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте загрузить его ещё раз."
            );
          }
        });

      userVideoUploadQueue[userKey] = currentQueue;

      try {
        await currentQueue;
      } finally {
        if (userVideoUploadQueue[userKey] === currentQueue) {
          delete userVideoUploadQueue[userKey];
        }
      }

      return;
    }

    if (pendingVideo.has_uploaded_file) {
      await send(
        "Загрузите видео или нажмите «Завершить отчет».",
        ["Завершить отчет"]
      );
    } else {
      await send("Загрузите видео.");
    }

    return;
  }

  // ------------------------------------------------------
  // ПРАВКА БЮДЖЕТА СДЕЛКИ (после "Завершить отчет")
  // ------------------------------------------------------

  const pendingBudget = userPendingBudgetEdit[userKey];

  if (pendingBudget) {
    if (trimmedText === "Без изменений") {
      delete userPendingBudgetEdit[userKey];

      await startEmailEditStep(send, userKey, pendingBudget.lead_id);

      return;
    }

    if (!/^\d+$/.test(trimmedText)) {
      await send("Введите сообщение, состоящие только из цифр");

      return;
    }

    try {
      await updateLeadPrice(pendingBudget.lead_id, trimmedText);
    } catch (error) {
      console.error(
        "Не удалось обновить бюджет сделки:",
        error.message
      );

      await send(
        "❌ Не удалось сохранить бюджет в amoCRM. " +
          "Подробности есть в логах Render."
      );

      await finish();

      return;
    }

    delete userPendingBudgetEdit[userKey];

    await startEmailEditStep(send, userKey, pendingBudget.lead_id);

    return;
  }

  // ------------------------------------------------------
  // ПРАВКА E-MAIL КЛИЕНТА
  // ------------------------------------------------------

  const pendingEmail = userPendingEmailEdit[userKey];

  if (pendingEmail) {
    if (trimmedText === "Без изменений") {
      delete userPendingEmailEdit[userKey];

      await returnToReportList(send, finish, userKey, currentEngineerName);

      return;
    }

    if (
      !trimmedText.includes("@") ||
      !trimmedText.includes(".")
    ) {
      await send("Введите корректный e-mail");

      return;
    }

    if (pendingEmail.contact_id) {
      try {
        await updateContactCustomFields(pendingEmail.contact_id, {
          [CONTACT_EMAIL_FIELD_ID]: trimmedText
        });
      } catch (error) {
        console.error(
          "Не удалось обновить e-mail контакта:",
          error.message
        );

        await send(
          "❌ Не удалось сохранить e-mail в amoCRM. " +
            "Подробности есть в логах Render."
        );

        await finish();

        return;
      }
    } else {
      console.log(
        "У сделки нет привязанного контакта — e-mail не сохранён."
      );
    }

    await send("Правки внесены");

    delete userPendingEmailEdit[userKey];

    await returnToReportList(send, finish, userKey, currentEngineerName);

    return;
  }
    // ------------------------------------------------------
  // ОЖИДАЕМ ФАЙЛЫ ДЛЯ ПРАВОК
  // (Замерный лист / Фотоотчет / Видеоотчет / Договор)
  // ------------------------------------------------------

  const pendingCorrectionUpload =
    userPendingCorrectionUpload[userKey];

  if (pendingCorrectionUpload) {
    if (trimmedText === "Завершить загрузку") {
      if (!pendingCorrectionUpload.has_uploaded_file) {
        await send(
          "Пока не получено ни одного файла. " +
            "Загрузите хотя бы один файл, прежде чем нажать «Завершить загрузку»."
        );

        return;
      }

      delete userPendingCorrectionUpload[userKey];

      await send(
        "✅ Файлы сохранены. Выберите, что ещё нужно поправить:",
        buildCorrectionActionButtons()
      );

      return;
    }

    if (imageUrls && imageUrls.length > 0) {
      const previousQueue =
        userCorrectionUploadQueue[userKey] || Promise.resolve();

      const currentQueue = previousQueue
        .catch(() => {})
        .then(async () => {
          const currentPending =
            userPendingCorrectionUpload[userKey];

          if (!currentPending) {
            return;
          }

          let uploaded = 0;

          for (const url of imageUrls) {
            try {
              const currentNumber =
                currentPending.next_file_number;

              const fileName = buildDocumentFileName(
                currentPending.prefix,
                currentPending.date_text,
                currentNumber
              );

              console.log("Загружаю файл (Внести правки):", {
                userKey,
                url,
                fileName,
                number: currentNumber
              });

              await ydUploadFromUrl(
                `${currentPending.folder_path}/${fileName}`,
                url
              );

              currentPending.next_file_number = currentNumber + 1;

              uploaded++;
            } catch (error) {
              console.error(
                "Ошибка загрузки файла (Внести правки):",
                error.message
              );
            }
          }

          if (uploaded > 0) {
            currentPending.has_uploaded_file = true;

            await send(
              `Файл(ы) получено (${uploaded}). Когда закончите — нажмите «Завершить загрузку».`,
              ["Завершить загрузку"]
            );
          } else if (currentPending.has_uploaded_file) {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте ещё раз или нажмите «Завершить загрузку».",
              ["Завершить загрузку"]
            );
          } else {
            await send(
              "❌ Не удалось сохранить файл на Яндекс.Диске. " +
                "Попробуйте загрузить его ещё раз."
            );
          }
        });

      userCorrectionUploadQueue[userKey] = currentQueue;

      try {
        await currentQueue;
      } finally {
        if (userCorrectionUploadQueue[userKey] === currentQueue) {
          delete userCorrectionUploadQueue[userKey];
        }
      }

      return;
    }

    if (pendingCorrectionUpload.has_uploaded_file) {
      await send(
        "Загрузите файл или нажмите «Завершить загрузку».",
        ["Завершить загрузку"]
      );
    } else {
      await send(pendingCorrectionUpload.prompt_text + ".");
    }

    return;
  }

  // ------------------------------------------------------
  // ОЖИДАЕМ КОММЕНТАРИЙ ПОСЛЕ "ПРАВКИ ВНЕСЕНЫ"
  // ------------------------------------------------------

  const pendingCorrectionComment =
    userPendingCorrectionComment[userKey];

  if (pendingCorrectionComment) {
    const comment = trimmedText;

    if (!comment) {
      await send(
        "Комментарий не может быть пустым. Введите комментарий"
      );

      return;
    }

    try {
      await senseiCompleteTask(
        pendingCorrectionComment.lead_id,
        pendingCorrectionComment.task_id,
        "Правки внесены"
      );

      try {
        await addLeadNote(
          pendingCorrectionComment.lead_id,
          comment
        );
      } catch (noteError) {
        console.error(
          "Не удалось добавить комментарий к сделке (Внести правки):",
          noteError.message
        );
      }

      await send(
        'Текущая задача amoCRM закрыта с результатом "Правки внесены".'
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (Внести правки):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    delete userPendingCorrectionComment[userKey];
    delete userSelectedCorrectionMeasurement[userKey];
    delete userPendingCorrectionUpload[userKey];

    const shouldFinish = await searchAndPresentCorrections(
      send,
      userKey,
      currentEngineerName
    );

    if (shouldFinish) {
      await finish();
    }

    return;
  }
// ------------------------------------------------------
// СЦЕНАРИЙ "ВНЕСТИ ПРАВКИ": КАРТОЧКА И ДЕЙСТВИЯ
// ------------------------------------------------------

const selectedCorrection =
  userSelectedCorrectionMeasurement[userKey];

if (selectedCorrection) {
  if (
    trimmedText === "Замерный лист" ||
    trimmedText === "Фотоотчет" ||
    trimmedText === "Видеоотчет" ||
    trimmedText === "Договор"
  ) {
    await startCorrectionUpload(
      send,
      finish,
      userKey,
      selectedCorrection,
      trimmedText
    );

    return;
  }

  if (trimmedText === "Правки внесены") {
    userPendingCorrectionComment[userKey] = {
      lead_id: selectedCorrection.lead_id,
      task_id: selectedCorrection.task_id
    };

    await send("Введите комментарий");

    return;
  }
}
  // ------------------------------------------------------
  // ПОДТВЕРДИТЬ ЗАМЕР
  // ------------------------------------------------------
// ------------------------------------------------------
// ВНЕСТИ ПРАВКИ
// ------------------------------------------------------

if (trimmedText === "Внести правки") {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "ЗАПУСК СЦЕНАРИЯ: ВНЕСТИ ПРАВКИ"
  );
  console.log(
    "Инженер:",
    currentEngineerName
  );
  console.log(
    "Тип задачи:",
    CORRECTION_TASK_TYPE_ID
  );
  console.log(
    "=========================================="
  );

  if (!currentEngineerName) {
    await send(
      "⚠️ Не удалось определить пользователя. " +
      "Перезапустите бота командой /старт."
    );

    return;
  }

  delete userSelectedCorrectionMeasurement[userKey];
  delete userPendingCorrectionUpload[userKey];
  delete userPendingCorrectionComment[userKey];

  await searchAndPresentCorrections(
    send,
    userKey,
    currentEngineerName
  );

  return;
}
  // ------------------------------------------------------
// ВЫБОР СДЕЛКИ В СЦЕНАРИИ "ВНЕСТИ ПРАВКИ"
// ------------------------------------------------------

const correctionList =
  userCorrectionList[userKey];

if (
  Array.isArray(correctionList) &&
  correctionList.length > 0
) {
  const selectedCorrection =
    correctionList.find(
      (item) =>
        String(
          item.contract_number || ""
        ).trim() === trimmedText
    );

  if (selectedCorrection) {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "ВЫБРАН ЗАМЕР ДЛЯ ВНЕСЕНИЯ ПРАВОК"
    );
    console.log(
      JSON.stringify(
        selectedCorrection,
        null,
        2
      )
    );
    console.log(
      "=========================================="
    );

    userSelectedCorrectionMeasurement[userKey] =
      selectedCorrection;

    delete userCorrectionList[userKey];

    await send(
      formatCorrectionDetail(
        selectedCorrection
      ),
      buildCorrectionActionButtons()
    );

    return;
  }
}
  if (trimmedText === "Подтвердить замер") {
    userLastSearchMode[userKey] = "confirm";

    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
    );

    console.log(
      "Инженер:",
      currentEngineerName
    );

    console.log(
      "=========================================="
    );

    if (!currentEngineerName) {
      await send(
        "⚠️ Не удалось определить пользователя. " +
          "Перезапустите бота командой /старт."
      );

      return;
    }

    await send(
      "⏳ Проверяю задачи на подтверждение замера..."
    );

    const shouldFinish =
      await searchAndPresentMeasurements(send, currentEngineerName);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  // ------------------------------------------------------
  // ДРУГИЕ КНОПКИ ГЛАВНОГО МЕНЮ
  // ------------------------------------------------------

  if (trimmedText === "Провести замер") {
    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПРОВЕСТИ ЗАМЕР"
    );

    console.log(
      "Инженер:",
      currentEngineerName
    );

    console.log(
      "=========================================="
    );

    if (!currentEngineerName) {
      await send(
        "⚠️ Не удалось определить пользователя. " +
          "Перезапустите бота командой /старт."
      );

      return;
    }

    userLastSearchMode[userKey] = "conduct";

    await send(
      "⏳ Проверяю задачи на проведение замера..."
    );

    const shouldFinish =
      await searchAndPresentConductMeasurements(send, currentEngineerName);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  if (trimmedText === "Загрузить фотоотчет") {
    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ЗАГРУЗИТЬ ФОТООТЧЕТ"
    );

    console.log(
      "Инженер:",
      currentEngineerName
    );

    console.log(
      "=========================================="
    );

    if (!currentEngineerName) {
      await send(
        "⚠️ Не удалось определить пользователя. " +
          "Перезапустите бота командой /старт."
      );

      return;
    }

    userLastSearchMode[userKey] = "report";

    await send(
      "⏳ Проверяю задачи на загрузку отчета..."
    );

    const shouldFinish =
      await searchAndPresentReportMeasurements(send, currentEngineerName);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  // ------------------------------------------------------
  // ЗАМЕР ПОДТВЕРЖДЕН
  // ------------------------------------------------------

  const confirmedMeasurementId = parseTaggedButton(
    trimmedText,
    "Замер подтвержден"
  );

  if (confirmedMeasurementId !== null) {
    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ЗАМЕР ПОДТВЕРЖДЕН"
    );

    console.log(
      "=========================================="
    );

    const stored = await resolveActiveMeasurementOrNotify(
      send,
      finish,
      userSelectedMeasurement,
      userKey,
      confirmedMeasurementId,
      "confirm"
    );

    if (!stored) {
      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.task_id,
        "Замер подтвержден"
      );

      await send(
        "✅ Замер подтвержден. Задача завершена."
      );

      delete userSelectedMeasurement[userKey];
    } catch (error) {
      console.error(
        "Ошибка завершения задачи через Sensei:",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    // Возвращаемся к шагу поиска остальных задач замера и показываем список (или сообщение, что задач больше нет)

    const shouldFinish =
      await searchAndPresentMeasurements(send, currentEngineerName);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  // ------------------------------------------------------
  // ПЕРЕНОС ЗАМЕРА
  // ------------------------------------------------------

  const rescheduleMeasurementId = parseTaggedButton(
    trimmedText,
    "Перенос замера"
  );

  if (rescheduleMeasurementId !== null) {
    const stored = await resolveActiveMeasurementOrNotify(
      send,
      finish,
      userSelectedMeasurement,
      userKey,
      rescheduleMeasurementId,
      "confirm"
    );

    if (!stored) {
      return;
    }

    userPendingComment[userKey] = {
      task_id: stored.task_id,
      lead_id: stored.lead_id,
      resultCaption: "Перенос замера",
      displayResult: "Перенос замера"
    };

    await send("Укажите комментарий");

   return;
  }

  // ------------------------------------------------------
  // ОТКАЗ
  // ------------------------------------------------------

  const declineMeasurementId = parseTaggedButton(
    trimmedText,
    "Отказ"
  );

  if (declineMeasurementId !== null) {
    const stored = await resolveActiveMeasurementOrNotify(
      send,
      finish,
      userSelectedMeasurement,
      userKey,
      declineMeasurementId,
      "confirm"
    );

    if (!stored) {
      return;
    }

    userPendingComment[userKey] = {
      task_id: stored.task_id,
      lead_id: stored.lead_id,
      resultCaption: "Отказался от замера",
      displayResult: "Отказался от замера"
    };

    await send("Укажите комментарий");

   return;
  }

  // ------------------------------------------------------
  // ЗАМЕР СОСТОЯЛСЯ (сценарий "Провести замер")
  // ------------------------------------------------------

  const conductedMeasurementId = parseTaggedButton(
    trimmedText,
    "Замер состоялся"
  );

  if (conductedMeasurementId !== null) {
    const stored = await resolveActiveMeasurementOrNotify(
      send,
      finish,
      userSelectedConductMeasurement,
      userKey,
      conductedMeasurementId,
      "conduct"
    );

    if (!stored) {
      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.task_id,
        "Замер состоялся"
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (Замер состоялся):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    delete userSelectedConductMeasurement[userKey];

    await send(
      "⏳ Ожидаю, пока в сделке появится следующая задача..."
    );

    const resultTask = await waitForResultTask(stored.lead_id);

    if (!resultTask) {
      await send(
        "❌ Не дождался появления задачи «Рез-т замера(и)» в сделке " +
          "(прошло 30 секунд). Проверьте сделку в amoCRM вручную " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    userPendingResultTask[userKey] = {
      lead_id: stored.lead_id,
      result_task_id: Number(resultTask.id)
    };

    await send("Укажите результат замера", [
      "Заключен договор",
      "Нужно подготовить КП и/или черновой проект",
      "Думает (свяжусь сам)",
      "Думает/отказ (передать менеджеру)"
    ]);

    return;
  }
  const notConductedMeasurementId = parseTaggedButton(
    trimmedText,
    "Замер не состоялся"
  );

  if (notConductedMeasurementId !== null) {
    const stored = await resolveActiveMeasurementOrNotify(
      send,
      finish,
      userSelectedConductMeasurement,
      userKey,
      notConductedMeasurementId,
      "conduct"
    );

    if (!stored) {
      return;
    }

    userPendingComment[userKey] = {
      task_id: stored.task_id,
      lead_id: stored.lead_id,
      resultCaption: "Замер не состоялся (указать причину)",
      displayResult: "Замер не состоялся",
      promptText: "Укажите причину",
      afterSearchMode: "conduct"
    };

    delete userSelectedConductMeasurement[userKey];

    await send("Укажите причину");

   return;
  }

  // ------------------------------------------------------
  // ЗАКЛЮЧЕН ДОГОВОР
  // ------------------------------------------------------

  if (trimmedText === "Заключен договор") {
    const stored = userPendingResultTask[userKey];

    if (!stored) {
      await send(
        "Не нашёл задачу «Рез-т замера(и)» для этой сделки. " +
          "Пожалуйста, начните заново: нажмите «Провести замер»."
      );

      await finish();

      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.result_task_id,
        "Да, заключен договор"
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (Заключен договор):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    let folders;

    try {
      const lead = await getLead(stored.lead_id);

      folders = await ensureLeadYandexFolders(lead);
    } catch (error) {
      console.error(
        "Ошибка подготовки папок на Яндекс.Диске:",
        error.message
      );

      await send(
        "❌ Не удалось подготовить папку на Яндекс.Диске. " +
          "Подробности есть в логах Render."
      );

      await finish();

      return;
    }

const contractUploadDate =
  getMoscowDate();

const contractDateText =
  `${String(
    contractUploadDate.getUTCDate()
  ).padStart(2, "0")}.` +
  `${String(
    contractUploadDate.getUTCMonth() + 1
  ).padStart(2, "0")}.` +
  `${contractUploadDate.getUTCFullYear()}`;

let nextContractFileNumber;

try {
  nextContractFileNumber =
    await ydGetNextContractFileNumber(
      folders.contractPath,
      contractDateText
    );
} catch (error) {
  console.error(
    "Ошибка определения номера следующего файла договора:",
    error.message
  );

  await send(
    "❌ Не удалось определить имя следующего файла договора. " +
    "Подробности есть в логах Render."
  );

  await finish();

  return;
}

userPendingPhotoUpload[userKey] = {
  lead_id:
    stored.lead_id,

  contract_path:
    folders.contractPath,

  contract_date_text:
    contractDateText,

  next_file_number:
    nextContractFileNumber,

  has_uploaded_photo:
    false
};

delete userPendingResultTask[
  userKey
];

await send(
  "Загрузите фото договора"
);

return;
  }

    // ------------------------------------------------------
  // ДУМАЕТ (СВЯЖУСЬ САМ) / ДУМАЕТ-ОТКАЗ (ПЕРЕДАТЬ МЕНЕДЖЕРУ)
  // ------------------------------------------------------

  if (
    trimmedText === "Думает (свяжусь сам)" ||
    trimmedText === "Думает/отказ (передать менеджеру)"
  ) {
    const stored = userPendingResultTask[userKey];

    if (!stored) {
      await send(
        "Не нашёл задачу «Рез-т замера(и)» для этой сделки. " +
          "Пожалуйста, начните заново: нажмите «Провести замер»."
      );

      await finish();

      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.result_task_id,
        trimmedText
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (" + trimmedText + "):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    delete userPendingResultTask[userKey];

    await send(
      `Текущая задача amoCRM закрыта с результатом "${trimmedText}".`
    );

    await offerReportStart(send, userKey, stored.lead_id);

    return;
  }

  // ------------------------------------------------------
  // НУЖНО ПОДГОТОВИТЬ КП И/ИЛИ ЧЕРНОВОЙ ПРОЕКТ
  // ------------------------------------------------------

  if (trimmedText === "Нужно подготовить КП и/или черновой проект") {
    const stored = userPendingResultTask[userKey];

    if (!stored) {
      await send(
        "Не нашёл задачу «Рез-т замера(и)» для этой сделки. " +
          "Пожалуйста, начните заново: нажмите «Провести замер»."
      );

      await finish();

      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.result_task_id,
        "Нужно подготовить КП и/или черновой проект"
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (Нужно подготовить КП):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    delete userPendingResultTask[userKey];

    await send("⏳ Ожидаю, пока в сделке появится следующая задача...");

    const kpTask = await waitForTaskOfType(
      stored.lead_id,
      KP_TASK_TYPE_ID
    );

    if (!kpTask) {
      await send(
        "❌ Не дождался появления задачи «Указать рез-т(и)» в сделке " +
          "(прошло 30 секунд). Проверьте сделку в amoCRM вручную " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    userPendingKpTask[userKey] = {
      lead_id: stored.lead_id,
      kp_task_id: Number(kpTask.id)
    };

    await send("Укажите что нужно подготовить клиенту", [
      "КП",
      "Черновой проект",
      "КП + черновой проект"
    ]);

    return;
  }

  // ------------------------------------------------------
  // ВЫБОР: КП / ЧЕРНОВОЙ ПРОЕКТ / КП + ЧЕРНОВОЙ ПРОЕКТ
  // ------------------------------------------------------

  if (
    trimmedText === "КП" ||
    trimmedText === "Черновой проект" ||
    trimmedText === "КП + черновой проект"
  ) {
    const stored = userPendingKpTask[userKey];

    if (!stored) {
      await send(
        "Не нашёл задачу «Указать рез-т(и)» для этой сделки. " +
          "Пожалуйста, начните заново: нажмите «Провести замер»."
      );

      await finish();

      return;
    }

    try {
      await senseiCompleteTask(
        stored.lead_id,
        stored.kp_task_id,
        trimmedText
      );
    } catch (error) {
      console.error(
        "Ошибка завершения задачи (Указать рез-т):",
        error.message
      );

      await send(
        "❌ Не удалось завершить задачу в Sensei. " +
          "Подробности есть в логах Render. Попробуйте ещё раз " +
          "или обратитесь к администратору."
      );

      await finish();

      return;
    }

    delete userPendingKpTask[userKey];

    await send(
      `Текущая задача amoCRM закрыта с результатом "${trimmedText}".`
    );

    await offerReportStart(send, userKey, stored.lead_id);

    return;
  }

  // ------------------------------------------------------
  // ПЕРЕЙТИ К ЗАГРУЗКЕ ОТЧЕТА
  // (кнопка после фото договора / "Думает" / выбора по КП)
  // ------------------------------------------------------

  if (trimmedText === "Перейти к загрузке отчета") {
    const stored = userPendingReportStart[userKey];

    if (!stored) {
      await send(
        "⚠️ Это кнопка из уже неактуального сообщения — сессия обновилась. " +
          "Пожалуйста, начните заново: нажмите «Загрузить фотоотчет»."
      );

      await finish();

      return;
    }

    const reportTask = await findExistingTaskOfType(
      stored.lead_id,
      REPORT_TASK_TYPE_ID
    );

    if (!reportTask) {
      await send(
        "❌ Не нашёл задачу «Загруз. отчет(и)» в этой сделке. " +
          "Проверьте сделку в amoCRM вручную или обратитесь к администратору."
      );

      delete userPendingReportStart[userKey];

      await finish();

      return;
    }

    delete userPendingReportStart[userKey];

    await enterReportHub(
      send,
      finish,
      userKey,
      stored.lead_id,
      Number(reportTask.id)
    );

    return;
  }

  // ------------------------------------------------------
  // ВЫБОР КОНКРЕТНОГО ЗАМЕРА ПО НОМЕРУ ДОГОВОРА
   // ------------------------------------------------------

  if (trimmedText) {
    const mode = userLastSearchMode[userKey];

    if (mode === "conduct") {
      try {
        const result = await findConductMeasurementTasks(currentEngineerName);

        const selected = result.measurements.find(
          (item) =>
            String(item.contract_number).trim() === trimmedText
        );

        if (selected) {
          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ ЗАМЕР (Провести замер):",
            trimmedText
          );

          // Запоминаем весь замер целиком (а не только id) 
          userSelectedConductMeasurement[userKey] = selected;

          await send(
            formatConductMeasurementDetail(selected),
            buildConductActionButtons(selected)
          );

          return;
        }
      } catch (error) {
        console.error(
          "Ошибка при выборе замера (Провести замер):",
          error.message
        );
      }
    } else if (mode === "report") {
      try {
        const result = await findReportMeasurementTasks(currentEngineerName);

        const selected = result.measurements.find(
          (item) =>
            String(item.contract_number).trim() === trimmedText
        );

        if (selected) {
          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ ЗАМЕР (Загрузить фотоотчет):",
            trimmedText
          );

          userSelectedReportMeasurement[userKey] = selected;

          await enterReportHub(
            send,
            finish,
            userKey,
            selected.lead_id,
            selected.task_id
          );

          return;
        }
      } catch (error) {
        console.error(
          "Ошибка при выборе замера (Загрузить фотоотчет):",
          error.message
        );
      }
    } else {
      try {
        const result = await findMeasurementTasks(currentEngineerName);

        const selected = result.measurements.find(
          (item) =>
            String(item.contract_number).trim() ===
            trimmedText
        );

        if (selected) {
          console.log(
            "=========================================="
          );

          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ ЗАМЕР:",
            trimmedText
          );

          console.log(
            "=========================================="
          );

          const detailMessage = formatMeasurementDetail(selected);

          // Запоминаем весь замер целиком.
          userSelectedMeasurement[userKey] = selected;

          await send(
            detailMessage,
            buildMeasurementActionButtons(selected)
          );

          return;
        }
      } catch (error) {
        console.error(
          "Ошибка при выборе замера:",
          error.message
        );
      }
    }
  }

  // ------------------------------------------------------
  // НЕИЗВЕСТНАЯ КОМАНДА
  // ------------------------------------------------------
  
  console.log(
    "Неизвестная команда:",
    trimmedText
  );

  await send(
    "⚠️ Неизвестная команда. Следуйте, пожалуйста, алгоритму бота " +
      "или начните сначала командой `/старт`"
  );

  const lastMessage = userLastBotMessage[userKey];

  if (lastMessage) {
    await send(
      lastMessage.text,
      lastMessage.buttons || undefined
    );
  }
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ССЫЛОК НА ФОТО ИЗ СООБЩЕНИЯ AMOMESSENGER
// ============================================================

function extractImageUrlsFromMessage(message) {
  const urls = [];

  if (!message) {
    return urls;
  }

  // --------------------------------------------------------
  // ПРЯМОЕ ИЗВЛЕЧЕНИЕ ИЗ attachments
  // --------------------------------------------------------

  if (
    Array.isArray(message.attachments)
  ) {
    for (
      const attachment of message.attachments
    ) {
      if (
        attachment &&
        attachment.type === "photo" &&
        attachment.photo &&
        attachment.photo.link
      ) {
        const cleanUrl =
          normalizeAmoMessengerFileUrl(
            attachment.photo.link
          );

        if (cleanUrl) {
          urls.push(
            cleanUrl
          );
        }
      }
    }
  }

  // --------------------------------------------------------
  // ДОПОЛНИТЕЛЬНЫЙ ПОИСК НА СЛУЧАЙ ДРУГОЙ СТРУКТУРЫ WEBHOOK
  // --------------------------------------------------------

  function walk(value) {
    if (!value) {
      return;
    }

    if (
      typeof value === "string"
    ) {
      const cleanUrl =
        normalizeAmoMessengerFileUrl(
          value
        );

      if (cleanUrl) {
        urls.push(
          cleanUrl
        );
      }

      return;
    }

    if (
      Array.isArray(value)
    ) {
      for (
        const item of value
      ) {
        walk(item);
      }

      return;
    }

    if (
      typeof value === "object"
    ) {
      for (
        const item of Object.values(value)
      ) {
        walk(item);
      }
    }
  }

  walk(message);

  return [
    ...new Set(urls)
  ];
}


// ============================================================
// ОЧИСТКА ССЫЛКИ AMOMESSENGER
// ============================================================

// ============================================================
// ОЧИСТКА ССЫЛКИ AMOMESSENGER
// ============================================================

function normalizeAmoMessengerFileUrl(
  value
) {
  if (
    !value ||
    typeof value !== "string"
  ) {
    return null;
  }

  const text =
    value.trim();

  const markdownMatch =
    text.match(
      /\]\((https?:\/\/[^)\s]+)\)/
    );

  if (
    markdownMatch &&
    markdownMatch[1]
  ) {
    return markdownMatch[1];
  }

  // --------------------------------------------------------
  // Обычная прямая ссылка.
  // --------------------------------------------------------

  const directMatch =
    text.match(
      /(https?:\/\/[^\s\])]+)/
    );

  if (
    directMatch &&
    directMatch[1]
  ) {
    return directMatch[1];
  }

  return null;
}


// ============================================================
// ИЗВЛЕЧЕНИЕ ИМЕНИ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ AMOMESSENGER
// ============================================================

function extractAmoMessengerUserName(...sources) {
  const preferredKeys = [
    "name",
    "full_name",
    "fullName",
    "user_name",
    "username"
  ];

  for (const source of sources) {
    if (
      !source ||
      typeof source !== "object"
    ) {
      continue;
    }

    for (const key of preferredKeys) {
      const value =
        source[key];

      if (
        typeof value === "string" &&
        value.trim()
      ) {
        return value.trim();
      }
    }

    const author =
      source.author;

    if (
      author &&
      typeof author === "object"
    ) {
      for (const key of preferredKeys) {
        const value =
          author[key];

        if (
          typeof value === "string" &&
          value.trim()
        ) {
          return value.trim();
        }
      }
    }
  }

  return "";
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

        if (eventType === "income_message") {
        const data = body._embedded || {};

        const context = data.context || {};

        const conversationIdentity =
          data.conversation_identity || {};

        const message = data.message || {};

        const directId =
          conversationIdentity.direct_id;

        const text = message.text || "";

        const userKey =
          context.user_id ||
          (message.author && message.author.user_id);
let userName = extractAmoMessengerUserName(
  message.author,
  context,
  message
);

// Если имя не пришло непосредственно в webhook,
// получаем его через API amoMessenger.
if (!userName && userKey) {
  userName =
    await getAmoMessengerUserName(
      userKey
    );
}

console.log(
  "ПОЛЬЗОВАТЕЛЬ AMOMESSENGER:",
  JSON.stringify(
    {
      userKey,
      userName
    },
    null,
    2
  )
);
 
        log(
          "ПРЯМОЙ КАНАЛ: ВХОДЯЩЕЕ СООБЩЕНИЕ",
          {
            directId,
            userKey,
            text
          }
        );

        if (!directId || !userKey) {
          console.error(
            "Не удалось определить direct_id или user_id из вебхука."
          );

          return;
        }

        const imageUrls = extractImageUrlsFromMessage(message);

if (imageUrls.length > 0) {
  log(
    "НАЙДЕНЫ ССЫЛКИ НА ФОТО В СООБЩЕНИИ",
    imageUrls
  );
}

await processUserMessage({
  text,
  userKey,
  userName,

  send: wrapSendWithLastMessageTracking(
    userKey,
    (msgText, buttons) =>
      sendDirectMessage(
        directId,
        msgText,
        buttons
      )
  ),

  finish: async () => {},

  imageUrls
});

return;
      }

      // --------------------------------------------------------
      // CONTROL TRANSFERRED (RPA-канал через виджет)
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

       resetUserState(receiverUserId);

        await wrapSendWithLastMessageTracking(
          receiverUserId,
          (msgText, buttons) =>
            sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              msgText,
              buttons
            )
        )(MAIN_MENU_TEXT, MAIN_MENU_BUTTONS);

        return;
      }

      // --------------------------------------------------------
      // INCOME MESSAGE (RPA-канал через виджет)
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

        if (
          !botId ||
          !requestId ||
          !receiverUserId
        ) {
          console.error(
            "Не удалось определить параметры запроса (RPA)."
          );

          return;
        }

        const imageUrls =
          extractImageUrlsFromMessage(incomeMessage);

        if (imageUrls.length > 0) {
          log("НАЙДЕНЫ ССЫЛКИ НА ФОТО В СООБЩЕНИИ (RPA)", imageUrls);
        }

        await processUserMessage({
          text,
          userKey: receiverUserId,
          send: wrapSendWithLastMessageTracking(
            receiverUserId,
            (msgText, buttons) =>
              sendMessengerMessage(
                botId,
                requestId,
                receiverUserId,
                msgText,
                buttons
              )
          ),
          finish: () =>
            returnControl(botId, requestId),
          imageUrls
        });

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

async function startServer() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "ЗАПУСК БОТА"
  );
  console.log(
    "=========================================="
  );

  await loadAmoCrmTokensFromRedis();
await loadAmoMessengerTokensFromRedis();
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
        "amoCRM refresh token:",
        amocrmRefreshToken
          ? "ДА"
          : "НЕТ"
      );

      console.log(
        "Upstash Redis:",
        UPSTASH_REDIS_REST_URL &&
        UPSTASH_REDIS_REST_TOKEN
          ? "НАСТРОЕН"
          : "НЕ НАСТРОЕН"
      );

      console.log(
        "amoMessenger token:",
        amomessengerAccessToken
          ? "ДА"
          : "НЕТ"
      );
console.log(
  "amoMessenger refresh token:",
  amomessengerRefreshToken
    ? "ДА"
    : "НЕТ"
);
      console.log(
        "=========================================="
      );
    }
  );
}

startServer().catch((error) => {
  console.error(
    "КРИТИЧЕСКАЯ ОШИБКА ПРИ ЗАПУСКЕ:",
    error
  );

  process.exit(1);
});
