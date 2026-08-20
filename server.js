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

// Токен для API BPM-платформы Sensei.
const SENSEI_TOKEN = process.env.SENSEI_TOKEN || "";

// ============================================================
// ПОСТОЯННЫЕ ЗНАЧЕНИЯ CRM
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Тип задачи "Провести зам.(и)"
const CONDUCT_TASK_TYPE_ID = 2746009;

// Тип задачи "Рез-т замера(и)"
const RESULT_TASK_TYPE_ID = 2746013;

// Поля сделки
const CONTRACT_NUMBER_FIELD_ID = 412776;
const MEASURE_DATE_FIELD_ID = 175370;
const MEASURE_TIME_FIELD_ID = 413828;
const ADDRESS_FIELD_ID = 175412;
const PRODUCT_FIELD_ID = 172572;
const DISCOUNT_FIELD_ID = 552706;

// Поля-ссылки на папки Яндекс.Диска
const REPORTS_LINK_FIELD_ID = 555436;
const PHOTO_LINK_FIELD_ID = 543238;
const MEASURE_SHEET_LINK_FIELD_ID = 543236;
const VIDEO_LINK_FIELD_ID = 554160;
const CONTRACT_LINK_FIELD_ID = 543254;

// Токен Яндекс.Диска
const YANDEX_DISK_TOKEN =
  process.env.YANDEX_DISK_TOKEN || "";

// Корневая папка на Яндекс.Диске
const YANDEX_DISK_ROOT_FOLDER = "amoCRM";

// Часовой пояс Москвы
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
// ПАМЯТЬ О СОСТОЯНИИ ПОЛЬЗОВАТЕЛЕЙ
// ============================================================

const userSelectedMeasurement = {};

const userPendingComment = {};

const userLastSearchMode = {};

const userSelectedConductMeasurement = {};

const userPendingResultTask = {};

const userPendingPhotoUpload = {};

const amoCrmUsersCache = {};

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

  return new Date(
    now.getTime() + MOSCOW_OFFSET_MS
  );
}

function formatMoscow(date) {
  const d = new Date(date);

  const year = d.getUTCFullYear();
  const month =
    String(d.getUTCMonth() + 1).padStart(2, "0");

  const day =
    String(d.getUTCDate()).padStart(2, "0");

  const hours =
    String(d.getUTCHours()).padStart(2, "0");

  const minutes =
    String(d.getUTCMinutes()).padStart(2, "0");

  const seconds =
    String(d.getUTCSeconds()).padStart(2, "0");

  return `${day}.${month}.${year}, ${hours}:${minutes}:${seconds}`;
}

function moscowToUnix(date) {
  return Math.floor(
    new Date(date).getTime() / 1000
  );
}

function unixToMoscow(unix) {
  if (!unix) return null;

  return formatMoscow(
    new Date(Number(unix) * 1000)
  );
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

  return Math.floor(
    (startUtcMs - MOSCOW_OFFSET_MS) / 1000
  );
}

function yesterdayMoscowStartUnix() {
  return (
    todayMoscowStartUnix() -
    24 * 60 * 60
  );
}

function getCurrentMoscowUnix() {
  return Math.floor(
    Date.now() / 1000
  );
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

    console.log(
      "amoCRM access token обновлён."
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
// POST AMOCRM
// ============================================================

async function amoCrmPost(url, body) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response = await axios.post(
      url,
      body,
      {
        headers: {
          Authorization:
            `Bearer ${amocrmAccessToken}`,
          "Content-Type":
            "application/json",
          Accept:
            "application/hal+json"
        },
        timeout: 60000,
        validateStatus: () => true
      }
    );

    if (response.status === 401) {
      console.log(
        "amoCRM вернул 401. Пробуем обновить токен..."
      );

      try {
        await refreshAmoCrmToken();

        const retry =
          await axios.post(
            url,
            body,
            {
              headers: {
                Authorization:
                  `Bearer ${amocrmAccessToken}`,
                "Content-Type":
                  "application/json",
                Accept:
                  "application/hal+json"
              },
              timeout: 60000,
              validateStatus: () => true
            }
          );

        return retry;
      } catch (refreshError) {
        return response;
      }
    }

    return response;
  } catch (error) {
    console.error(
      "amoCRM POST ERROR:",
      error.message
    );

    throw error;
  }
}

// ============================================================
// PATCH AMOCRM
// ============================================================

async function amoCrmPatch(url, body) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response = await axios.patch(
      url,
      body,
      {
        headers: {
          Authorization:
            `Bearer ${amocrmAccessToken}`,
          "Content-Type":
            "application/json",
          Accept:
            "application/hal+json"
        },
        timeout: 60000,
        validateStatus: () => true
      }
    );

    if (response.status === 401) {
      console.log(
        "amoCRM вернул 401 (PATCH). Пробуем обновить токен..."
      );

      try {
        await refreshAmoCrmToken();

        const retry =
          await axios.patch(
            url,
            body,
            {
              headers: {
                Authorization:
                  `Bearer ${amocrmAccessToken}`,
                "Content-Type":
                  "application/json",
                Accept:
                  "application/hal+json"
              },
              timeout: 60000,
              validateStatus: () => true
            }
          );

        return retry;
      } catch (refreshError) {
        return response;
      }
    }

    return response;
  } catch (error) {
    console.error(
      "amoCRM PATCH ERROR:",
      error.message
    );

    throw error;
  }
}

// ============================================================
// ОБНОВЛЕНИЕ ПОЛЕЙ СДЕЛКИ
// ============================================================

async function updateLeadCustomFields(
  leadId,
  fieldsMap
) {
  const customFieldsValues =
    Object.keys(fieldsMap).map(
      (fieldId) => ({
        field_id: Number(fieldId),
        values: [
          {
            value:
              fieldsMap[fieldId]
          }
        ]
      })
    );

  if (
    customFieldsValues.length === 0
  ) {
    return null;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    `.amocrm.ru/api/v4/leads/${leadId}`;

  const response =
    await amoCrmPatch(
      url,
      {
        custom_fields_values:
          customFieldsValues
      }
    );

  if (response.status >= 400) {
    throw new Error(
      `amoCRM lead PATCH HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// ============================================================
// ИМЯ ОТВЕТСТВЕННОГО МЕНЕДЖЕРА
// ============================================================

async function getUserName(userId) {
  if (!userId) {
    return "";
  }

  if (
    amoCrmUsersCache[userId]
  ) {
    return amoCrmUsersCache[userId];
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    `.amocrm.ru/api/v4/users/${userId}`;

  const response =
    await amoCrmGet(url, {});

  if (
    response.status !== 200 ||
    !response.data
  ) {
    return "";
  }

  const name =
    response.data.name || "";

  amoCrmUsersCache[userId] =
    name;

  return name;
}

// ============================================================
// ДОБАВЛЕНИЕ КОММЕНТАРИЯ К СДЕЛКЕ
// ============================================================

async function addLeadNote(
  leadId,
  text
) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    `.amocrm.ru/api/v4/leads/${leadId}/notes`;

  const body = [
    {
      note_type: "common",
      params: {
        text
      }
    }
  ];

  const response =
    await amoCrmPost(
      url,
      body
    );

  if (response.status >= 400) {
    throw new Error(
      `amoCRM notes HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// ============================================================
// GET AMOCRM
// ============================================================

async function amoCrmGet(
  url,
  params
) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response =
      await axios.get(
        url,
        {
          params,
          headers: {
            Authorization:
              `Bearer ${amocrmAccessToken}`,
            Accept:
              "application/hal+json"
          },
          timeout: 60000,
          validateStatus: () => true
        }
      );

    if (response.status === 401) {
      console.log(
        "amoCRM вернул 401. Пробуем обновить токен..."
      );

      try {
        await refreshAmoCrmToken();

        const retry =
          await axios.get(
            url,
            {
              params,
              headers: {
                Authorization:
                  `Bearer ${amocrmAccessToken}`,
                Accept:
                  "application/hal+json"
              },
              timeout: 60000,
              validateStatus: () => true
            }
          );

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
// ID АККАУНТА AMOCRM
// ============================================================

async function getAmoCrmAccountId() {
  if (amocrmAccountId) {
    return amocrmAccountId;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    ".amocrm.ru/api/v4/account";

  const response =
    await amoCrmGet(
      url,
      {}
    );

  if (
    response.status === 200 &&
    response.data &&
    response.data.id
  ) {
    amocrmAccountId =
      response.data.id;
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

  const accountId =
    await getAmoCrmAccountId();

  const url =
    "https://api.sensei.plus/v1/element/task/complete";

  const body = {
    entity_id: Number(leadId),
    entity_type: 1,
    result_caption: resultCaption,
    task_id: Number(taskId)
  };

  const headers = {
    "Content-Type":
      "application/json",
    "X-Auth-Sensei-Token":
      SENSEI_TOKEN
  };

  if (accountId) {
    headers["X-Account"] =
      accountId;
  }

  log(
    "Sensei: завершаем задачу",
    {
      url,
      body,
      accountId:
        accountId ||
        "не удалось получить"
    }
  );

  const response =
    await axios.post(
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
    JSON.stringify(
      response.data
    )
  );

  if (
    response.status !== 200 ||
    (
      response.data &&
      response.data.status &&
      response.data.status !==
        "success" &&
      response.data.status !== 200
    )
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
    Authorization:
      `OAuth ${YANDEX_DISK_TOKEN}`
  };
}

// Создаёт папку.
// Если папка уже существует — это не ошибка.
async function ydEnsureFolder(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response =
    await axios.put(
      "https://cloud-api.yandex.net/v1/disk/resources",
      null,
      {
        params: {
          path
        },
        headers:
          yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }
    );

  if (
    response.status !== 201 &&
    response.status !== 409
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось создать папку "${path}". ` +
      `HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return true;
}

// Создаёт всю цепочку вложенных папок.
async function ydEnsureFolderPath(
  fullPath
) {
  const parts =
    fullPath
      .split("/")
      .filter(Boolean);

  let current = "";

  for (const part of parts) {
    current =
      current
        ? `${current}/${part}`
        : part;

    await ydEnsureFolder(current);
  }

  return fullPath;
}

// Создаёт публичную ссылку ТОЛЬКО на конкретную папку.
// По этой ссылке пользователь не получает доступ
// к родительским папкам.
async function ydGetFolderPublicUrl(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response =
    await axios.put(
      "https://cloud-api.yandex.net/v1/disk/resources/publish",
      null,
      {
        params: {
          path
        },
        headers:
          yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }
    );

  if (
    response.status !== 200 &&
    response.status !== 201 &&
    response.status !== 409
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось опубликовать папку "${path}". ` +
      `HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  const infoResponse =
    await axios.get(
      "https://cloud-api.yandex.net/v1/disk/resources",
      {
        params: {
          path,
          fields: "public_url"
        },
        headers:
          yandexDiskHeaders(),
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
      `Яндекс.Диск: не удалось получить публичную ссылку для "${path}".`
    );
  }

  return infoResponse.data.public_url;
}

// Определяет следующий номер файла договора.
//
// Если файлов ещё нет:
// Договор 20.08.2026.jpg
//
// Если такой файл уже есть:
// Договор 20.08.2026 (1).jpg
// Договор 20.08.2026 (2).jpg
// и так далее.
//
// Нумерация продолжается с учётом файлов,
// которые были загружены ранее.
async function ydGetNextContractFileNumber(
  folderPath,
  dateText
) {
  const response =
    await axios.get(
      "https://cloud-api.yandex.net/v1/disk/resources",
      {
        params: {
          path: folderPath,
          limit: 1000,
          fields:
            "_embedded.items.name"
        },
        headers:
          yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }
    );

  if (
    response.status !== 200
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось получить список файлов "${folderPath}". ` +
      `HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
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

  const escapedDate =
    dateText.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const pattern =
    new RegExp(
      `^Договор ${escapedDate}` +
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

    if (
      !Number.isNaN(number)
    ) {
      maxNumber =
        Math.max(
          maxNumber,
          number
        );
    }
  }

  return maxNumber + 1;
}

function buildContractFileName(
  dateText,
  number
) {
  const suffix =
    Number(number) > 0
      ? ` (${Number(number)})`
      : "";

  return (
    `Договор ${dateText}` +
    `${suffix}.jpg`
  );
}

// Загружает файл на Яндекс.Диск напрямую по URL.
async function ydUploadFromUrl(
  path,
  fileUrl
) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error(
      "YANDEX_DISK_TOKEN не задан в Environment Variables"
    );
  }

  const response =
    await axios.post(
      "https://cloud-api.yandex.net/v1/disk/resources/upload",
      null,
      {
        params: {
          path,
          url: fileUrl
        },
        headers:
          yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }
    );

  if (
    response.status !== 202 &&
    response.status !== 201
  ) {
    throw new Error(
      `Яндекс.Диск: не удалось начать загрузку файла в "${path}". ` +
      `HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

// Гарантирует создание всей структуры папок
// и записывает в сделку публичные ссылки на конкретные папки.
async function ensureLeadYandexFolders(
  lead
) {
  const leadId =
    lead.id;

  const leadFolderPath =
    `${YANDEX_DISK_ROOT_FOLDER}` +
    `/Сделка (${leadId})`;

  const reportsPath =
    `${leadFolderPath}/Отчеты и проекты`;

  const photoPath =
    `${reportsPath}/Фотоотчет`;

  const measureSheetPath =
    `${reportsPath}/Замерный лист`;

  const videoPath =
    `${reportsPath}/Видео`;

  const contractPath =
    `${reportsPath}/Договор`;

  console.log(
    "Проверяю/создаю папки на Яндекс.Диске для сделки",
    leadId
  );

  await ydEnsureFolderPath(
    reportsPath
  );

  await ydEnsureFolder(
    photoPath
  );

  await ydEnsureFolder(
    measureSheetPath
  );

  await ydEnsureFolder(
    videoPath
  );

  await ydEnsureFolder(
    contractPath
  );

  // ВАЖНО:
  // Получаем публичные ссылки непосредственно на каждую папку.
  // Они заменят старые ссылки вида
  // https://disk.yandex.ru/client/disk/...
  // и не дают перейти к родительским папкам.
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

  try {
    await updateLeadCustomFields(
      leadId,
      fieldsToUpdate
    );
  } catch (error) {
    console.error(
      "Не удалось записать ссылки на папки Диска в сделку:",
      error.message
    );
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
  console.log(
    "amoMessenger POST (RPA)"
  );
  console.log(url);
  console.log("BODY:");
  console.log(
    JSON.stringify(
      body,
      null,
      2
    )
  );

  try {
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

    if (
      response.status >= 400
    ) {
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
// ОТПРАВКА СООБЩЕНИЯ (RPA-КАНАЛ)
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
// ОТПРАВКА СООБЩЕНИЯ В ПРЯМОЙ КАНАЛ
// ============================================================

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

  const body = {
    text
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

  console.log("");
  console.log(
    "amoMessenger POST (DIRECT)"
  );
  console.log(url);
  console.log("BODY:");
  console.log(
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
            `Bearer ${amomessengerAccessToken}`,
          "Content-Type":
            "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

  console.log(
    "amoMessenger DIRECT response:",
    response.status,
    JSON.stringify(
      response.data
    )
  );

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    console.log(
      "amoMessenger token недействителен (DIRECT)."
    );
  }

  if (
    response.status >= 400
  ) {
    throw new Error(
      `amoMessenger DIRECT HTTP ${response.status}`
    );
  }

  return response;
}

// ============================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ============================================================

async function getLead(
  leadId
) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    `.amocrm.ru/api/v4/leads/${leadId}`;

  const response =
    await amoCrmGet(
      url,
      {
        with: "contacts"
      }
    );

  if (
    response.status !== 200
  ) {
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

async function getContact(
  contactId
) {
  if (!contactId) {
    return null;
  }

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    `.amocrm.ru/api/v4/contacts/${contactId}`;

  const response =
    await amoCrmGet(
      url,
      {}
    );

  if (
    response.status !== 200
  ) {
    return null;
  }

  return response.data;
}

// ============================================================
// ПОЛУЧЕНИЕ ЗНАЧЕНИЙ ПОЛЯ
// ============================================================

function getFieldValues(
  lead,
  fieldId
) {
  if (
    !lead ||
    !Array.isArray(
      lead.custom_fields_values
    )
  ) {
    return [];
  }

  const field =
    lead.custom_fields_values.find(
      (item) =>
        Number(item.field_id) ===
        Number(fieldId)
    );

  if (
    !field ||
    !Array.isArray(
      field.values
    )
  ) {
    return [];
  }

  return field.values;
}

function getFieldValue(
  lead,
  fieldId
) {
  const values =
    getFieldValues(
      lead,
      fieldId
    );

  if (
    values.length === 0
  ) {
    return "";
  }

  const value =
    values[0]?.value;

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "";
  }

  return String(value);
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function getEngineerFieldValue(
  lead
) {
  return getFieldValues(
    lead,
    ENGINEER_FIELD_ID
  );
}

function leadBelongsToEngineer(
  lead
) {
  const values =
    getEngineerFieldValue(
      lead
    );

  return values.some(
    (item) => {
      const value =
        String(
          item.value || ""
        ).trim();

      const enumId =
        Number(
          item.enum_id
        );

      return (
        value === ENGINEER_NAME &&
        enumId ===
          Number(
            ENGINEER_ENUM_ID
          )
      );
    }
  );
}

// ============================================================
// ГЛАВНЫЙ КОНТАКТ СДЕЛКИ
// ============================================================

function getMainContactId(
  lead
) {
  const contacts =
    lead?._embedded?.contacts;

  if (
    !Array.isArray(
      contacts
    ) ||
    contacts.length === 0
  ) {
    return null;
  }

  const main =
    contacts.find(
      (contact) =>
        contact.is_main === true
    );

  return (
    main?.id ||
    contacts[0]?.id ||
    null
  );
}

// ============================================================
// ПОЛУЧЕНИЕ ТЕЛЕФОНОВ КОНТАКТА
// ============================================================

function getContactPhones(
  contact
) {
  if (
    !contact ||
    !Array.isArray(
      contact.custom_fields_values
    )
  ) {
    return [];
  }

  const phoneField =
    contact.custom_fields_values.find(
      (field) =>
        String(
          field.field_code || ""
        ).toUpperCase() ===
        "PHONE"
    );

  if (
    !phoneField ||
    !Array.isArray(
      phoneField.values
    )
  ) {
    return [];
  }

  return phoneField.values
    .map(
      (item) =>
        item.value
          ? String(item.value)
          : ""
    )
    .filter(Boolean);
}

// ============================================================
// ФОРМИРОВАНИЕ ДАННЫХ ПО СДЕЛКЕ
// ============================================================

async function buildMeasurementData(
  task,
  lead
) {
  let contactName = "";
  let contactPhones = [];

  const mainContactId =
    getMainContactId(
      lead
    );

  if (mainContactId) {
    const contact =
      await getContact(
        mainContactId
      );

    if (contact) {
      contactName =
        contact.name || "";

      contactPhones =
        getContactPhones(
          contact
        );
    }
  }

  const responsibleUserName =
    await getUserName(
      lead.responsible_user_id
    );

  return {
    task_id:
      Number(task.id),

    lead_id:
      Number(lead.id),

    complete_till:
      task.complete_till,

    complete_till_moscow:
      unixToMoscow(
        task.complete_till
      ),

    contract_number:
      getFieldValue(
        lead,
        CONTRACT_NUMBER_FIELD_ID
      ),

    measure_date:
      getFieldValue(
        lead,
        MEASURE_DATE_FIELD_ID
      ),

    measure_time:
      getFieldValue(
        lead,
        MEASURE_TIME_FIELD_ID
      ),

    address:
      getFieldValue(
        lead,
        ADDRESS_FIELD_ID
      ),

    product:
      getFieldValue(
        lead,
        PRODUCT_FIELD_ID
      ),

    discount:
      getFieldValue(
        lead,
        DISCOUNT_FIELD_ID
      ),

    client_name:
      contactName,

    client_phones:
      contactPhones,

    responsible_manager:
      responsibleUserName,

    lead_name:
      lead.name || ""
  };
}

// ============================================================
// ОПРЕДЕЛЕНИЕ ДИАПАЗОНА ПОИСКА ЗАМЕРОВ
// ============================================================

function getMeasurementSearchRange() {
  const now =
    getMoscowDate();

  const hours =
    now.getUTCHours();

  const nowUnix =
    getCurrentMoscowUnix();

  let fromUnix;
  let toUnix;
  let mode;

  if (
    hours < 18
  ) {
    mode =
      "до 18:00";

    fromUnix =
      yesterdayMoscowStartUnix();

    toUnix =
      nowUnix;
  } else {
    mode =
      "после 18:00";

    fromUnix =
      todayMoscowStartUnix();

    toUnix =
      todayMoscowStartUnix() +
      2 * 24 * 60 * 60 -
      1;
  }

  return {
    mode,
    fromUnix,
    toUnix,
    from:
      unixToMoscow(
        fromUnix
      ),
    to:
      unixToMoscow(
        toUnix
      ),
    current:
      formatMoscow(
        now
      )
  };
}

// ============================================================
// ПОИСК ЗАДАЧ «ПОДТВ. ЗАМЕР(И)»
// ============================================================

async function findMeasurementTasks() {
  const range =
    getMeasurementSearchRange();

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    "ПОИСК ЗАДАЧ «ПОДТВ. ЗАМЕР(И)»"
  );
  console.log(
    "=========================================="
  );

  console.log(
    "Текущее московское время:",
    range.current
  );

  console.log(
    "Режим:",
    range.mode
  );

  console.log(
    "Период поиска:",
    range.from,
    "—",
    range.to
  );

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    ".amocrm.ru/api/v4/tasks";

  const response =
    await amoCrmGet(
      url,
      {
        limit: 250,

        "filter[entity_type]":
          "leads",

        "filter[task_type][0]":
          MEASUREMENT_TASK_TYPE_ID,

        "filter[is_completed]":
          0,

        "filter[complete_till][from]":
          range.fromUnix,

        "filter[complete_till][to]":
          range.toUnix
      }
    );

  if (
    response.status !== 200
  ) {
    throw new Error(
      `amoCRM HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  const tasks =
    response.data &&
    Array.isArray(
      response.data._embedded?.tasks
    )
      ? response.data._embedded.tasks
      : [];

  console.log(
    "Загружено задач:",
    tasks.length
  );

  // Контрольная проверка типа задачи.
  const measurementTypeTasks =
    tasks.filter(
      (task) =>
        Number(
          task.task_type_id
        ) ===
        Number(
          MEASUREMENT_TASK_TYPE_ID
        )
    );

  console.log(
    `Задач типа ${MEASUREMENT_TASK_TYPE_ID}:`,
    measurementTypeTasks.length
  );

  // Контрольная проверка:
  // задача должна быть не завершена.
  const notCompletedTasks =
    measurementTypeTasks.filter(
      (task) =>
        task.is_completed === false
    );

  console.log(
    "Незавершённых задач:",
    notCompletedTasks.length
  );

  // Контрольная проверка даты.
  const dateTasks =
    notCompletedTasks.filter(
      (task) => {
        const till =
          Number(
            task.complete_till || 0
          );

        return (
          till >= range.fromUnix &&
          till <= range.toUnix
        );
      }
    );

  console.log(
    "После проверки даты:",
    dateTasks.length
  );

  const measurements = [];

  for (
    const task of dateTasks
  ) {
    if (
      !task.entity_id ||
      task.entity_type !==
        "leads"
    ) {
      continue;
    }

    const lead =
      await getLead(
        task.entity_id
      );

    if (!lead) {
      continue;
    }

    if (
      !leadBelongsToEngineer(
        lead
      )
    ) {
      continue;
    }

    const item =
      await buildMeasurementData(
        task,
        lead
      );

    measurements.push(
      item
    );
  }

  return {
    measurements,
    date_range: range
  };
}

// ============================================================
// ФОРМАТ СТРОКИ ЗАМЕРА
// ============================================================

function formatMeasurementLine(
  item,
  index
) {
  const number =
    index + 1;

  return (
    `${number}. № договора: ` +
    `${item.contract_number || "—"}\n` +

    `Дата замера: ` +
    `${item.measure_date || "—"}\n` +

    `Время замера: ` +
    `${item.measure_time || "—"}\n` +

    `Адрес замера: ` +
    `${item.address || "—"}\n` +

    `Продукт: ` +
    `${item.product || "—"}\n\n`
  );
}

// ============================================================
// ПОИСК ЗАМЕРОВ + ОТПРАВКА СПИСКА
// ============================================================

async function searchAndPresentMeasurements(
  send
) {
  let shouldFinish =
    true;

  try {
    const result =
      await findMeasurementTasks();

    if (
      result.measurements.length === 0
    ) {
      await send(
        "📋 Замеров для подтверждения не найдено."
      );
    } else {
      let message =
        "📋 Найдены замеры:\n\n";

      result.measurements.forEach(
        (item, index) => {
          message +=
            formatMeasurementLine(
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

      shouldFinish =
        false;
    }
  } catch (error) {
    console.error(
      "Ошибка поиска замеров:",
      error.message
    );

    try {
      await send(
        "❌ Произошла ошибка при поиске задач. " +
        "Подробности есть в логах Render."
      );
    } catch (
      sendError
    ) {
      console.error(
        "Ошибка отправки сообщения:",
        sendError.message
      );
    }
  }

  return shouldFinish;
}

// ============================================================
// ПОИСК ЗАДАЧ «ПРОВЕСТИ ЗАМ.(И)»
// ============================================================

async function findConductMeasurementTasks() {
  const range =
    getMeasurementSearchRange();

  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    ".amocrm.ru/api/v4/tasks";

  const response =
    await amoCrmGet(
      url,
      {
        limit: 250,

        "filter[entity_type]":
          "leads",

        "filter[task_type][0]":
          CONDUCT_TASK_TYPE_ID,

        "filter[is_completed]":
          0,

        "filter[complete_till][from]":
          range.fromUnix,

        "filter[complete_till][to]":
          range.toUnix
      }
    );

  if (
    response.status !== 200
  ) {
    throw new Error(
      `amoCRM HTTP ${response.status}: ` +
      `${JSON.stringify(response.data)}`
    );
  }

  const tasks =
    Array.isArray(
      response.data?._embedded?.tasks
    )
      ? response.data._embedded.tasks
      : [];

  const measurements = [];

  for (
    const task of tasks
  ) {
    if (
      task.entity_type !==
        "leads" ||
      task.is_completed !==
        false ||
      Number(
        task.task_type_id
      ) !==
        Number(
          CONDUCT_TASK_TYPE_ID
        )
    ) {
      continue;
    }

    const lead =
      await getLead(
        task.entity_id
      );

    if (!lead) {
      continue;
    }

    if (
      !leadBelongsToEngineer(
        lead
      )
    ) {
      continue;
    }

    const item =
      await buildMeasurementData(
        task,
        lead
      );

    measurements.push(
      item
    );
  }

  return {
    measurements,
    date_range: range
  };
}

// ============================================================
// ФОРМАТ ЗАМЕРА ДЛЯ «ПРОВЕСТИ ЗАМЕР»
// ============================================================

function formatConductMeasurementLine(
  item,
  index
) {
  const number =
    index + 1;

  return (
    `${number}. № договора: ` +
    `${item.contract_number || "—"}\n` +

    `Дата замера: ` +
    `${item.measure_date || "—"}\n` +

    `Время замера: ` +
    `${item.measure_time || "—"}\n` +

    `Адрес замера: ` +
    `${item.address || "—"}\n` +

    `Продукт: ` +
    `${item.product || "—"}\n\n`
  );
}

// ============================================================
// ПОИСК + ПОКАЗ ЗАМЕРОВ «ПРОВЕСТИ ЗАМЕР»
// ============================================================

async function searchAndPresentConductMeasurements(
  send
) {
  let shouldFinish =
    true;

  try {
    const result =
      await findConductMeasurementTasks();

    if (
      result.measurements.length === 0
    ) {
      await send(
        "📋 Замеров для проведения не найдено."
      );
    } else {
      let message =
        "📋 Найдены замеры:\n\n";

      result.measurements.forEach(
        (item, index) => {
          message +=
            formatConductMeasurementLine(
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

      shouldFinish =
        false;
    }
  } catch (error) {
    console.error(
      "Ошибка поиска замеров (Провести замер):",
      error.message
    );

    try {
      await send(
        "❌ Произошла ошибка при поиске задач. " +
        "Подробности есть в логах Render."
      );
    } catch (
      sendError
    ) {
      console.error(
        "Ошибка отправки ошибки:",
        sendError.message
      );
    }
  }

  return shouldFinish;
}

// ============================================================
// ОЖИДАНИЕ ЗАДАЧИ «РЕЗ-Т ЗАМЕРА(И)»
// ============================================================

async function waitForResultTask(
  leadId
) {
  const url =
    `https://${AMOCRM_SUBDOMAIN}` +
    ".amocrm.ru/api/v4/tasks";

  for (
    let attempt = 0;
    attempt < 10;
    attempt++
  ) {
    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          3000
        )
    );

    const response =
      await amoCrmGet(
        url,
        {
          limit: 50,

          "filter[entity_type]":
            "leads",

          "filter[entity_id][0]":
            leadId,

          "filter[task_type][0]":
            RESULT_TASK_TYPE_ID,

          "filter[is_completed]":
            0
        }
      );

    if (
      response.status === 200
    ) {
      const tasks =
        Array.isArray(
          response.data?._embedded?.tasks
        )
          ? response.data._embedded.tasks
          : [];

      const found =
        tasks.find(
          (task) =>
            Number(
              task.task_type_id
            ) ===
              Number(
                RESULT_TASK_TYPE_ID
              ) &&
            task.is_completed === false
        );

      if (found) {
        return found;
      }
    }
  }

  return null;
}
