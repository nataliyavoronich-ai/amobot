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

// Тип задачи "Провести зам.(и)" — используется в функции "Провести замер"
const CONDUCT_TASK_TYPE_ID = 2746009;

// Тип задачи "Рез-т замера(и)" — появляется в сделке автоматически
// после того, как бот завершает задачу "Провести зам.(и)" через Sensei
// с результатом "Замер состоялся"
const RESULT_TASK_TYPE_ID = 2746013;

// Поля сделки, которые нужно выводить в сообщениях бота
const CONTRACT_NUMBER_FIELD_ID = 412776; // № договора (текст)
const MEASURE_DATE_FIELD_ID = 175370; // Дата замера (дата)
const MEASURE_TIME_FIELD_ID = 413828; // Время замера (список)
const ADDRESS_FIELD_ID = 175412; // Адрес объекта (текстовая область)
const PRODUCT_FIELD_ID = 172572; // Продукт (список)
const DISCOUNT_FIELD_ID = 552706; // Скидка ОП (число)

// Поля-ссылки на папки Яндекс.Диска (заполняются ботом автоматически)
const REPORTS_LINK_FIELD_ID = 555436; // "Отчеты и проекты"
const PHOTO_LINK_FIELD_ID = 543238; // "Фото проема №1" (папка "Фотоотчет")
const MEASURE_SHEET_LINK_FIELD_ID = 543236; // "Замерный лист"
const VIDEO_LINK_FIELD_ID = 554160; // "Видеоотчет"
const CONTRACT_LINK_FIELD_ID = 543254; // "Договор (Подписан)"

// Токен Яндекс.Диска (OAuth-токен приложения Яндекс.Диска).
// Как его получить — см. инструкцию, которую я прислал отдельно.
// Переменную YANDEX_DISK_TOKEN нужно задать в Environment Variables на Render.
const YANDEX_DISK_TOKEN = process.env.YANDEX_DISK_TOKEN || "";

// Корневая папка на Яндекс.Диске, внутри которой бот создаёт папки сделок
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
//
// Ключом служит идентификатор пользователя (context.user_id / author.user_id) —
// он одинаковый и для "прямого" канала (income_message), и для канала
// через виджет (rpa_bot_*), так что состояние переносится независимо
// от того, каким способом бот был запущен.

const userSelectedMeasurement = {};

// Когда пользователь нажимает "Перенос замера" или "Отказ", бот
// просит написать комментарий и ждёт следующее сообщение. Здесь
// запоминаем, какое именно действие и по какой задаче/сделке нужно
// выполнить, когда комментарий придёт.
const userPendingComment = {};

// ------------------------------------------------------------
// СОСТОЯНИЕ ДЛЯ СЦЕНАРИЯ "ПРОВЕСТИ ЗАМЕР"
// ------------------------------------------------------------

// Запоминаем, какой список замеров пользователь видел последним —
// из "Подтвердить замер" (confirm) или из "Провести замер" (conduct).
// Это нужно, чтобы при нажатии на кнопку с номером договора понять,
// в каком списке искать этот номер и какой сценарий запускать дальше.
const userLastSearchMode = {};

// Выбранный пользователем замер из списка "Провести замер"
// (task_id задачи "Провести зам.(и)" + lead_id + номер договора).
const userSelectedConductMeasurement = {};

// После нажатия "Замер состоялся" бот ждёт, пока в сделке появится
// новая задача "Рез-т замера(и)" (id типа 2746013). Здесь храним
// lead_id/task_id этой новой задачи, когда она найдена, — до тех
// пор, пока пользователь не выберет результат замера.
const userPendingResultTask = {};

// После нажатия "Заключен договор" бот просит загрузить фото и
// ждёт фотографии + нажатие кнопки "Готово". Здесь храним, в какую
// папку на Яндекс.Диске сохранять фото для этой сделки.
const userPendingPhotoUpload = {};

// Кэш имён пользователей amoCRM (для поля "Ответственный менеджер"),
// чтобы не запрашивать одного и того же пользователя много раз подряд.
const amoCrmUsersCache = {};

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
// PATCH amoCRM (используется для записи ссылок на папки Диска
// в поля сделки)
// ============================================================

async function amoCrmPatch(url, body) {
  if (!amocrmAccessToken) {
    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
    );
  }

  try {
    const response = await axios.patch(url, body, {
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
        "amoCRM вернул 401 (PATCH). Пробуем обновить токен..."
      );

      try {
        await refreshAmoCrmToken();

        const retry = await axios.patch(url, body, {
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
    console.error("amoCRM PATCH ERROR:", error.message);

    throw error;
  }
}

// Обновляет заданный набор custom-полей сделки одним запросом.
// fieldsMap: { fieldId: "значение", ... }
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
// ИМЯ ОТВЕТСТВЕННОГО МЕНЕДЖЕРА ПО СДЕЛКЕ
// ============================================================
//
// В amoCRM у сделки есть стандартное поле responsible_user_id —
// это ID пользователя-менеджера. Само имя нужно запросить отдельно
// через /api/v4/users/{id}. Кэшируем, чтобы не делать лишних запросов.

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
// ЯНДЕКС.ДИСК: СОЗДАНИЕ ПАПОК И ЗАГРУЗКА ФАЙЛОВ
// ============================================================
//
// Документация Яндекс.Диска: https://yandex.ru/dev/disk/api/
// Все запросы идут с заголовком Authorization: OAuth <токен>.

function yandexDiskHeaders() {
  return {
    Authorization: `OAuth ${YANDEX_DISK_TOKEN}`
  };
}

// Создаёт папку по указанному пути (path без ведущего "disk:/").
// Если папка уже существует — это не ошибка, просто ничего не делаем.
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

// Создаёт всю цепочку папок по пути ("a/b/c" создаст a, затем a/b,
// затем a/b/c) — Яндекс.Диск не создаёт вложенные папки одним запросом.
async function ydEnsureFolderPath(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);

  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;

    await ydEnsureFolder(current);
  }

  return fullPath;
}

// Ссылка для открытия папки в браузере в веб-интерфейсе Яндекс.Диска
// (открывается у того, кто залогинен под тем же Яндекс-аккаунтом).
function ydFolderWebUrl(path) {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://disk.yandex.ru/client/disk/${encoded}`;
}

// Загружает файл на Диск напрямую по его URL (Яндекс сам скачивает
// файл с этого адреса — не нужно скачивать его на сервер бота).
// Используется, например, для фото, присланных в amoMessenger —
// у них уже есть прямая ссылка на файл.
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

// Гарантирует, что для сделки на Яндекс.Диске создана вся структура
// папок ("amoCRM/Сделка (id)/Отчеты и проекты/..."), и что ссылки на
// эти папки записаны в соответствующие поля сделки (если ещё не
// записаны). Возвращает пути к каждой подпапке.
async function ensureLeadYandexFolders(lead) {
  const leadId = lead.id;

  const leadFolderPath =
    `${YANDEX_DISK_ROOT_FOLDER}/Сделка (${leadId})`;

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

  // Обновляем в сделке только те поля-ссылки, которые ещё пустые —
  // чтобы не перезаписывать вручную поставленные значения.
  const fieldsToUpdate = {};

  if (getFieldValues(lead, REPORTS_LINK_FIELD_ID).length === 0) {
    fieldsToUpdate[REPORTS_LINK_FIELD_ID] = ydFolderWebUrl(reportsPath);
  }

  if (getFieldValues(lead, PHOTO_LINK_FIELD_ID).length === 0) {
    fieldsToUpdate[PHOTO_LINK_FIELD_ID] = ydFolderWebUrl(photoPath);
  }

  if (getFieldValues(lead, MEASURE_SHEET_LINK_FIELD_ID).length === 0) {
    fieldsToUpdate[MEASURE_SHEET_LINK_FIELD_ID] =
      ydFolderWebUrl(measureSheetPath);
  }

  if (getFieldValues(lead, VIDEO_LINK_FIELD_ID).length === 0) {
    fieldsToUpdate[VIDEO_LINK_FIELD_ID] = ydFolderWebUrl(videoPath);
  }

  if (getFieldValues(lead, CONTRACT_LINK_FIELD_ID).length === 0) {
    fieldsToUpdate[CONTRACT_LINK_FIELD_ID] = ydFolderWebUrl(contractPath);
  }

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
// ОТПРАВКА СООБЩЕНИЯ (RPA-канал)
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
//
// Используется, когда бот запускается НЕ через передачу управления
// от виджета (rpa_bot_control_transferred), а напрямую — пользователь
// просто пишет боту сообщение, и приходит вебхук с event_type
// "income_message" и полем _embedded.conversation_identity.direct_id.
//
// В этом канале не нужен bot_id/request_id и не нужно вызывать
// returnControl — отвечаем сразу по direct_id из вебхука.

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
  console.log("amoMessenger POST (DIRECT)");
  console.log(url);
  console.log("BODY:");
  console.log(JSON.stringify(body, null, 2));

  const response = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${amomessengerAccessToken}`,
      "Content-Type": "application/json"
    },
    timeout: 30000,
    validateStatus: () => true
  });

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
      "amoMessenger token недействителен (DIRECT)."
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
// ПОИСК ЗАДАЧ "ПРОВЕСТИ ЗАМЕР" (тип 2746009), БЕЗ ФИЛЬТРА ПО ДАТЕ
// ============================================================

async function loadConductTasks() {
  const allTasks = [];

  let page = 1;

  while (true) {
    const url =
      `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

    const params = {
      limit: 250,
      page,
      "filter[task_type][0]": CONDUCT_TASK_TYPE_ID,
      "filter[is_completed]": 0
    };

    const response = await amoCrmGet(url, params);

    if (response.status === 204) {
      break;
    }

    if (response.status !== 200) {
      throw new Error(
        `amoCRM tasks (conduct) HTTP ${response.status}`
      );
    }

    const tasks =
      response.data &&
      Array.isArray(response.data._embedded?.tasks)
        ? response.data._embedded.tasks
        : [];

    allTasks.push(...tasks);

    if (tasks.length < 250) {
      break;
    }

    page++;

    if (page > 20) {
      break;
    }
  }

  return allTasks;
}

async function findConductMeasurementTasks() {
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

    if (!leadBelongsToEngineer(lead)) {
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
    `Ссылка на сделку: ${item.lead_link}\n`
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

// Общая функция поиска + показа списка для "Провести замер",
// по аналогии с searchAndPresentMeasurements для "Подтвердить замер".
async function searchAndPresentConductMeasurements(send) {
  let shouldFinish = true;

  try {
    const result = await findConductMeasurementTasks();

    if (result.measurements.length === 0) {
      await send("📋 Замеров для проведения не найдено.");
    } else {
      let message = "📋 Найдены замеры:\n\n";

      result.measurements.forEach((item, index) => {
        message += formatConductMeasurementLine(item, index);
      });

      const buttons = result.measurements.map(
        (item) =>
          item.contract_number || `Задача ${item.task_id}`
      );

      await send(message, buttons);

      shouldFinish = false;
    }
  } catch (error) {
    console.error(
      "Ошибка поиска замеров (Провести замер):",
      error.message
    );

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

// Ждём (до 30 секунд), пока в сделке появится задача типа
// "Рез-т замера(и)" (id 2746013), которую ставит Sensei после того,
// как мы завершили задачу "Провести зам.(и)" с результатом
// "Замер состоялся". Проверяем каждые 3 секунды, максимум 10 раз.
async function waitForResultTask(leadId) {
  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/tasks`;

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const response = await amoCrmGet(url, {
      limit: 50,
      "filter[entity_type]": "leads",
      "filter[entity_id][0]": leadId,
      "filter[task_type][0]": RESULT_TASK_TYPE_ID,
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
          Number(t.task_type_id) === Number(RESULT_TASK_TYPE_ID) &&
          t.is_completed === false
      );

      if (found) {
        return found;
      }
    }
  }

  return null;
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
    yandex_disk_token:
      YANDEX_DISK_TOKEN ? "ДА" : "НЕТ"
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
// ПОИСК ЗАМЕРОВ + ОТПРАВКА СПИСКА ПОЛЬЗОВАТЕЛЮ
// ============================================================
//
// Общая логика для обоих каналов (RPA и прямой). Раньше принимала
// botId/requestId/receiverUserId и сама вызывала sendMessengerMessage —
// теперь принимает универсальную функцию отправки `send(text, buttons)`,
// которая уже "знает", куда и как слать сообщение (через виджет или
// напрямую по direct_id).
//
// Возвращает true, если управление нужно вернуть amoMessenger сразу
// (замеров не найдено или произошла ошибка), и false, если бот ждёт,
// что пользователь нажмёт на кнопку с номером договора.

async function searchAndPresentMeasurements(send) {
  let shouldFinish = true;

  try {
    const result = await findMeasurementTasks();

    if (result.measurements.length === 0) {
      await send(
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

      await send(message, buttons);

      // Список с кнопками показан — НЕ отдаём управление, так как
      // ждём, что пользователь нажмёт одну из кнопок (обработка в
      // блоке "ВЫБОР КОНКРЕТНОГО ЗАМЕРА" ниже).
      shouldFinish = false;
    }
  } catch (error) {
    console.error(
      "Ошибка поиска замеров:",
      error.message
    );

    try {
      await send(
        "❌ Произошла ошибка при поиске задач. Подробности есть в логах Render."
      );
    } catch (sendError) {
      console.error(
        "Ошибка отправки ошибки:",
        sendError.message
      );
    }
  }

  return shouldFinish;
}

// ============================================================
// ОБРАБОТКА ТЕКСТА/КНОПКИ ОТ ПОЛЬЗОВАТЕЛЯ
// ============================================================
//
// Единая точка входа для бизнес-логики бота — используется и для
// RPA-канала (после передачи управления от виджета), и для прямого
// канала (когда пользователь просто пишет боту любое сообщение).
//
// options:
//   text               — текст входящего сообщения
//   userKey            — ключ пользователя для хранения состояния
//                         (userSelectedMeasurement / userPendingComment)
//   send(text, buttons)— функция отправки ответа пользователю
//   finish()           — что делать по завершении шага:
//                         для RPA-канала — returnControl,
//                         для прямого канала — ничего не делать
//   showMenuOnUnknown  — если true, на нераспознанный текст показываем
//                         главное меню (нужно для запуска бота ЛЮБЫМ
//                         сообщением по прямому каналу). Если false —
//                         на нераспознанный текст просто завершаем шаг
//                         (как было раньше в RPA-канале).

async function processUserMessage({
  text,
  userKey,
  send,
  finish,
  showMenuOnUnknown,
  imageUrls
}) {
  const trimmedText = (text || "").trim();

  console.log(
    "Обработка сообщения пользователя:",
    userKey,
    trimmedText
  );

  // ------------------------------------------------------
  // ОЖИДАЕМ КОММЕНТАРИЙ (после "Перенос замера" / "Отказ")
  // ------------------------------------------------------
  //
  // Если для этого пользователя мы ждём комментарий — значит,
  // текущее сообщение это НЕ команда/кнопка, а сам комментарий.
  // Обрабатываем его в первую очередь, до любых других проверок.

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
      await send(
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

    // Возвращаемся к шагу поиска других задач замера и
    // показываем список (или сообщение, что задач больше нет).

    const shouldFinish =
      await searchAndPresentMeasurements(send);

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
    // Кнопка "Готово" — пользователь закончил загрузку фото
    if (trimmedText === "Готово") {
      await send("✅ Фото сохранены. Спасибо!");

      delete userPendingPhotoUpload[userKey];

      await finish();

      return;
    }

    if (imageUrls && imageUrls.length > 0) {
      let uploaded = 0;

      for (const url of imageUrls) {
        try {
          const fileName =
            `photo_${Date.now()}_${uploaded + 1}.jpg`;

          await ydUploadFromUrl(
            `${pendingPhoto.contract_path}/${fileName}`,
            url
          );

          uploaded++;
        } catch (error) {
          console.error(
            "Ошибка загрузки фото на Яндекс.Диск:",
            error.message
          );
        }
      }

      if (uploaded > 0) {
        await send(
          `Фото получено (${uploaded}). Когда закончите — нажмите «Готово».`,
          ["Готово"]
        );
      } else {
        await send(
          "❌ Не удалось сохранить фото на Яндекс.Диске. " +
            "Попробуйте ещё раз или нажмите «Готово», чтобы закончить.",
          ["Готово"]
        );
      }

      return;
    }

    // Пока ждём фото, любое другое сообщение — просто напоминание
    await send(
      "Загрузите фото договора и нажмите «Готово», когда закончите.",
      ["Готово"]
    );

    return;
  }

  // ------------------------------------------------------
  // ПОДТВЕРДИТЬ ЗАМЕР
  // ------------------------------------------------------

  if (trimmedText === "Подтвердить замер") {
    userLastSearchMode[userKey] = "confirm";

    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
    );

    console.log(
      "=========================================="
    );

    await send(
      "⏳ Проверяю задачи на подтверждение замера..."
    );

    const shouldFinish =
      await searchAndPresentMeasurements(send);

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
      "=========================================="
    );

    userLastSearchMode[userKey] = "conduct";

    await send(
      "⏳ Проверяю задачи на проведение замера..."
    );

    const shouldFinish =
      await searchAndPresentConductMeasurements(send);

    if (shouldFinish) {
      await finish();
    }

    return;
  }

  if (trimmedText === "Загрузить фотоотчет") {
    await send(
      "Функция «Загрузить фотоотчет» пока находится в разработке."
    );

    await finish();

    return;
  }

  if (trimmedText === "Внести правки") {
    await send(
      "Функция «Внести правки» пока находится в разработке."
    );

    await finish();

    return;
  }

  // ------------------------------------------------------
  // ЗАМЕР ПОДТВЕРЖДЕН
  // (нажатие на кнопку после показа деталей замера)
  // ------------------------------------------------------

  if (trimmedText === "Замер подтвержден") {
    console.log(
      "=========================================="
    );

    console.log(
      "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ЗАМЕР ПОДТВЕРЖДЕН"
    );

    console.log(
      "=========================================="
    );

    const stored = userSelectedMeasurement[userKey];

    if (!stored) {
      await send(
        "Не нашёл, какой замер вы подтверждаете. " +
          "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
          "и выберите нужную задачу из списка."
      );

      await finish();

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
    }

    await finish();

    return;
  }

  // ------------------------------------------------------
  // ПЕРЕНОС ЗАМЕРА
  // ------------------------------------------------------

  if (trimmedText === "Перенос замера") {
    const stored = userSelectedMeasurement[userKey];

    if (!stored) {
      await send(
        "Не нашёл, какой замер вы переносите. " +
          "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
          "и выберите нужную задачу из списка."
      );

      await finish();

      return;
    }

    userPendingComment[userKey] = {
      task_id: stored.task_id,
      lead_id: stored.lead_id,
      resultCaption: "Перенос замера",
      displayResult: "Перенос замера"
    };

    await send("Укажите комментарий");

    // Управление НЕ возвращаем — ждём текст комментария
    // следующим сообщением.

    return;
  }

  // ------------------------------------------------------
  // ОТКАЗ
  // ------------------------------------------------------

  if (trimmedText === "Отказ") {
    const stored = userSelectedMeasurement[userKey];

    if (!stored) {
      await send(
        "Не нашёл, от какого замера вы отказываетесь. " +
          "Пожалуйста, начните заново: нажмите «Подтвердить замер» " +
          "и выберите нужную задачу из списка."
      );

      await finish();

      return;
    }

    userPendingComment[userKey] = {
      task_id: stored.task_id,
      lead_id: stored.lead_id,
      resultCaption: "Отказался от замера",
      displayResult: "Отказался от замера"
    };

    await send("Укажите комментарий");

    // Управление НЕ возвращаем — ждём текст комментария
    // следующим сообщением.

    return;
  }

  // ------------------------------------------------------
  // ЗАМЕР СОСТОЯЛСЯ (сценарий "Провести замер")
  // ------------------------------------------------------

  if (trimmedText === "Замер состоялся") {
    const stored = userSelectedConductMeasurement[userKey];

    if (!stored) {
      await send(
        "Не нашёл, какой замер вы отмечаете. " +
          "Пожалуйста, начните заново: нажмите «Провести замер» " +
          "и выберите нужную задачу из списка."
      );

      await finish();

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

  if (trimmedText === "Замер не состоялся") {
    await send(
      "Функция «Замер не состоялся» пока находится в разработке."
    );

    await finish();

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
        "Заключен договор"
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

    userPendingPhotoUpload[userKey] = {
      lead_id: stored.lead_id,
      contract_path: folders.contractPath
    };

    delete userPendingResultTask[userKey];

    await send("Загрузите фото договора", ["Готово"]);

    return;
  }

  if (
    trimmedText === "Нужно подготовить КП и/или черновой проект" ||
    trimmedText === "Думает (свяжусь сам)" ||
    trimmedText === "Думает/отказ (передать менеджеру)"
  ) {
    await send(
      `Функция «${trimmedText}» пока находится в разработке.`
    );

    await finish();

    return;
  }

  // ------------------------------------------------------
  // ВЫБОР КОНКРЕТНОГО ЗАМЕРА ПО НОМЕРУ ДОГОВОРА
  // (нажатие на одну из кнопок из списка замеров, п.5)
  //
  // Список может быть либо из "Подтвердить замер" (confirm),
  // либо из "Провести замер" (conduct) — смотрим, какой список
  // пользователь видел последним, чтобы искать номер договора
  // в нужном месте и показать нужный набор кнопок дальше.
  // ------------------------------------------------------

  if (trimmedText) {
    const mode = userLastSearchMode[userKey];

    if (mode === "conduct") {
      try {
        const result = await findConductMeasurementTasks();

        const selected = result.measurements.find(
          (item) =>
            String(item.contract_number).trim() === trimmedText
        );

        if (selected) {
          console.log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ ЗАМЕР (Провести замер):",
            trimmedText
          );

          userSelectedConductMeasurement[userKey] = {
            task_id: selected.task_id,
            lead_id: selected.lead_id,
            contract_number: selected.contract_number
          };

          await send(formatConductMeasurementDetail(selected), [
            "Замер состоялся",
            "Замер не состоялся"
          ]);

          return;
        }
      } catch (error) {
        console.error(
          "Ошибка при выборе замера (Провести замер):",
          error.message
        );
      }
    } else {
      try {
        const result = await findMeasurementTasks();

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
          userSelectedMeasurement[userKey] = {
            task_id: selected.task_id,
            lead_id: selected.lead_id,
            contract_number: selected.contract_number
          };

          await send(detailMessage, [
            "Замер подтвержден",
            "Перенос замера",
            "Отказ"
          ]);

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
  }

  // ------------------------------------------------------
  // НЕИЗВЕСТНАЯ КОМАНДА / ЗАПУСК БОТА ЛЮБЫМ СООБЩЕНИЕМ
  // ------------------------------------------------------

  console.log(
    "Неизвестная команда или запуск бота:",
    trimmedText
  );

  if (showMenuOnUnknown) {
    await send(MAIN_MENU_TEXT, MAIN_MENU_BUTTONS);

    return;
  }

  await finish();
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ССЫЛОК НА ФОТО ИЗ СООБЩЕНИЯ ВЕБХУКА
// ============================================================
//
// ВАЖНО: точная структура, в которой amoMessenger присылает
// прикреплённые фото в вебхуке, заранее неизвестна (в открытой
// документации это не описано детально). Поэтому здесь используется
// "защищённый" способ — бот сам обходит весь объект входящего
// сообщения и ищет любые строки, похожие на прямую ссылку на
// изображение (заканчивающиеся на .jpg/.jpeg/.png/.gif/.webp).
//
// Полное содержимое вебхука в любом случае пишется в лог Render
// (см. лог "AMOMESSENGER WEBHOOK" при получении сообщения) — если
// после первого реального теста с фото окажется, что бот не находит
// ссылку, нужно открыть этот лог, найти там, в каком именно поле
// пришла ссылка на фото, и сообщить мне — я поправлю функцию точно
// под этот формат.

function extractImageUrlsFromMessage(message) {
  const urls = [];

  function walk(value) {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      if (
        /^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?\S*)?$/i.test(
          value.trim()
        )
      ) {
        urls.push(value.trim());
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);

      return;
    }

    if (typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  }

  walk(message);

  return [...new Set(urls)];
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
      // ПРЯМОЙ КАНАЛ: любое входящее сообщение боту
      // (без передачи управления от виджета).
      //
      // Структура вебхука:
      // {
      //   "_embedded": {
      //     "context": { "company_id": "...", "user_id": "..." },
      //     "conversation_identity": { "direct_id": "..." },
      //     "message": { "text": "...", "author": { "user_id": "..." }, ... }
      //   },
      //   "event_type": "income_message"
      // }
      //
      // Отвечаем через POST /v1.3/direct/{direct_id}/sendMessage —
      // bot_id и request_id здесь не нужны, и возвращать управление
      // (returnControl) тоже не нужно.
      // --------------------------------------------------------

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
          log("НАЙДЕНЫ ССЫЛКИ НА ФОТО В СООБЩЕНИИ", imageUrls);
        }

        await processUserMessage({
          text,
          userKey,
          send: (msgText, buttons) =>
            sendDirectMessage(directId, msgText, buttons),
          finish: async () => {},
          showMenuOnUnknown: true,
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

        await sendMessengerMessage(
          botId,
          requestId,
          receiverUserId,
          MAIN_MENU_TEXT,
          MAIN_MENU_BUTTONS
        );

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
          send: (msgText, buttons) =>
            sendMessengerMessage(
              botId,
              requestId,
              receiverUserId,
              msgText,
              buttons
            ),
          finish: () =>
            returnControl(botId, requestId),
          showMenuOnUnknown: false,
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
