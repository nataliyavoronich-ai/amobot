// ============================================================
// ОБЩИЕ УТИЛИТЫ AMOCRM / ЯНДЕКС.ДИСК / AMOMESSENGER
// ============================================================
//
// Самостоятельная копия тех же примитивов, что использует server.js —
// нужна, чтобы бот производства (productionBotServer.js) мог работать как
// ОТДЕЛЬНЫЙ процесс/PM2-приложение, не завязанный на оперативную память
// server.js. Токен amoCRM — общий (та же "Внешняя интеграция"), но каждый
// процесс хранит свою копию в памяти и синхронизируется через Redis
// (amocrm_access_token/amocrm_refresh_token — те же ключи, что у
// server.js), а не через прямую ссылку на переменную в чужом процессе.
//
// Сознательное дублирование, а не require() из server.js: единственная
// цель всей этой переделки — чтобы падение/перезапуск одного процесса не
// касался другого. Если этот файл начнёт require'ить server.js (или
// наоборот), изоляция процессов исчезнет.

const axios = require("axios");

// ------------------------------------------------------------
// НАСТРОЙКИ
// ------------------------------------------------------------

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const AMOCRM_SUBDOMAIN = "zlmk";
const AMOCRM_CLIENT_ID = process.env.AMOCRM_CLIENT_ID || "";
const AMOCRM_CLIENT_SECRET = process.env.AMOCRM_CLIENT_SECRET || "";
const AMOCRM_REDIRECT_URI =
  process.env.AMOCRM_REDIRECT_URI || "https://amobot-cpck.onrender.com/amocrm/callback";

const YANDEX_DISK_TOKEN = process.env.YANDEX_DISK_TOKEN || "";
const YANDEX_DISK_ROOT_FOLDER = "amoCRM";

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const START_COMMANDS = new Set(["старт", "start", "/старт", "/start", "начать", "/начать"]);

let amocrmAccessToken = process.env.AMOCRM_ACCESS_TOKEN || "";
let amocrmRefreshToken = process.env.AMOCRM_REFRESH_TOKEN || "";

const amoCrmUsersCache = {};

// ------------------------------------------------------------
// REDIS (Upstash REST)
// ------------------------------------------------------------

async function redisRequest(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL или UPSTASH_REDIS_REST_TOKEN не задан");
  }

  const response = await axios.post(UPSTASH_REDIS_REST_URL, command, {
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 30000
  });

  return response.data;
}

// ------------------------------------------------------------
// AMOCRM: ТОКЕНЫ (общие с server.js через Redis, те же ключи)
// ------------------------------------------------------------

async function saveAmoCrmTokensToRedis() {
  if (!amocrmAccessToken || !amocrmRefreshToken) {
    return;
  }

  await redisRequest(["SET", "amocrm_access_token", amocrmAccessToken]);
  await redisRequest(["SET", "amocrm_refresh_token", amocrmRefreshToken]);

  console.log("[amoSharedUtils] Токены amoCRM сохранены в Upstash Redis.");
}

async function loadAmoCrmTokensFromRedis() {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.log("[amoSharedUtils] Upstash Redis не настроен. Используем токены из Environment Variables.");
    return false;
  }

  try {
    const accessResponse = await redisRequest(["GET", "amocrm_access_token"]);
    const refreshResponse = await redisRequest(["GET", "amocrm_refresh_token"]);

    if (accessResponse.result && refreshResponse.result) {
      amocrmAccessToken = accessResponse.result;
      amocrmRefreshToken = refreshResponse.result;

      console.log("[amoSharedUtils] Токены amoCRM загружены из Upstash Redis.");
      return true;
    }

    console.log("[amoSharedUtils] В Upstash Redis пока нет токенов amoCRM.");
    return false;
  } catch (error) {
    console.error(
      "[amoSharedUtils] Ошибка загрузки токенов amoCRM из Upstash Redis:",
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    return false;
  }
}

async function refreshAmoCrmToken() {
  // Токен мог уже обновиться в ДРУГОМ процессе (server.js) — перед тем как
  // тратить свой refresh_token, проверяем, не появилось ли в Redis более
  // свежее значение.
  const refreshed = await loadAmoCrmTokensFromRedis();

  if (refreshed) {
    return amocrmAccessToken;
  }

  if (!amocrmRefreshToken) {
    throw new Error("AMOCRM_REFRESH_TOKEN не задан");
  }

  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/oauth2/access_token`;

  const response = await axios.post(
    url,
    {
      client_id: AMOCRM_CLIENT_ID,
      client_secret: AMOCRM_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: amocrmRefreshToken,
      redirect_uri: AMOCRM_REDIRECT_URI
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  amocrmAccessToken = response.data.access_token;

  if (response.data.refresh_token) {
    amocrmRefreshToken = response.data.refresh_token;
  }

  await saveAmoCrmTokensToRedis();

  console.log("[amoSharedUtils] Токен amoCRM обновлён и сохранён в Redis.");

  return amocrmAccessToken;
}

// ------------------------------------------------------------
// AMOCRM: ОБЩИЙ HTTP-ЗАПРОС С АВТО-РЕФРЕШЕМ ТОКЕНА (та же логика, что в
// server.js, см. комментарий в начале файла про осознанное дублирование)
// ------------------------------------------------------------

async function amoCrmRequest(axiosMethod, errorLabel, url, { params, body, headersExtra = {} } = {}) {
  if (!amocrmAccessToken) {
    throw new Error("AMOCRM_ACCESS_TOKEN не задан в Environment Variables");
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

  const doRequest = () => (body === undefined ? axiosMethod(url, buildConfig()) : axiosMethod(url, body, buildConfig()));

  const doRequestWithRetry = async (maxAttempts = 3) => {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await doRequest();
      } catch (error) {
        lastError = error;

        if (error.response || attempt >= maxAttempts) {
          throw error;
        }

        console.log(
          `[amoSharedUtils] amoCRM ${errorLabel}: сетевая ошибка (${error.message}), ` +
            `попытка ${attempt} из ${maxAttempts}. Повторяю...`
        );

        await new Promise((resolve) => setTimeout(resolve, attempt * 700));
      }
    }

    throw lastError;
  };

  try {
    const response = await doRequestWithRetry();

    if (response.status === 401) {
      console.log(`[amoSharedUtils] amoCRM вернул 401 (${errorLabel}). Пробуем обновить токен...`);

      try {
        await refreshAmoCrmToken();
        return await doRequestWithRetry();
      } catch (refreshError) {
        return response;
      }
    }

    return response;
  } catch (error) {
    console.error(`[amoSharedUtils] amoCRM ${errorLabel} ERROR:`, error.message);
    throw error;
  }
}

async function amoCrmGet(url, params) {
  return amoCrmRequest(axios.get, "GET", url, { params });
}

async function amoCrmPost(url, body) {
  return amoCrmRequest(axios.post, "POST", url, { body, headersExtra: { "Content-Type": "application/json" } });
}

async function amoCrmPatch(url, body) {
  return amoCrmRequest(axios.patch, "PATCH", url, { body, headersExtra: { "Content-Type": "application/json" } });
}

async function getLead(leadId) {
  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/${leadId}`;
  const response = await amoCrmGet(url, { with: "contacts" });

  if (response.status !== 200) {
    console.log(`[amoSharedUtils] Не удалось получить сделку ${leadId}:`, response.status);
    return null;
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

  const url = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/users/${userId}`;
  const response = await amoCrmGet(url, {});

  if (response.status !== 200 || !response.data) {
    return "";
  }

  const name = response.data.name || "";

  amoCrmUsersCache[userId] = name;

  return name;
}

function getFieldValues(entity, fieldId) {
  if (!entity || !Array.isArray(entity.custom_fields_values)) {
    return [];
  }

  const field = entity.custom_fields_values.find((item) => Number(item.field_id) === Number(fieldId));

  if (!field || !Array.isArray(field.values)) {
    return [];
  }

  return field.values.map((v) => v.value).filter((v) => v !== null && v !== undefined && v !== "");
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

      const moscow = new Date(unix * 1000 + MOSCOW_OFFSET_MS);

      const day = String(moscow.getUTCDate()).padStart(2, "0");
      const month = String(moscow.getUTCMonth() + 1).padStart(2, "0");
      const year = moscow.getUTCFullYear();

      return `${day}.${month}.${year}`;
    })
    .join(", ");
}

// ------------------------------------------------------------
// ЯНДЕКС.ДИСК
// ------------------------------------------------------------

function yandexDiskHeaders() {
  return { Authorization: `OAuth ${YANDEX_DISK_TOKEN}` };
}

async function ydRequestWithRetry(doRequest, label, maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await doRequest();
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts) {
        throw error;
      }

      console.log(
        `[amoSharedUtils] Яндекс.Диск (${label}): сетевая ошибка (${error.message}), ` +
          `попытка ${attempt} из ${maxAttempts}. Повторяю...`
      );

      await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    }
  }

  throw lastError;
}

async function ydEnsureFolder(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error("YANDEX_DISK_TOKEN не задан в Environment Variables");
  }

  const response = await ydRequestWithRetry(
    () =>
      axios.put("https://cloud-api.yandex.net/v1/disk/resources", null, {
        params: { path },
        headers: yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }),
    `создание папки "${path}"`
  );

  if (response.status !== 201 && response.status !== 409) {
    throw new Error(`Яндекс.Диск: не удалось создать папку "${path}". HTTP ${response.status}: ${JSON.stringify(response.data)}`);
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

async function ydGetFolderPublicUrl(path) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error("YANDEX_DISK_TOKEN не задан в Environment Variables");
  }

  const response = await axios.put("https://cloud-api.yandex.net/v1/disk/resources/publish", null, {
    params: { path },
    headers: yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (response.status !== 200 && response.status !== 201 && response.status !== 409) {
    throw new Error(`Яндекс.Диск: не удалось опубликовать "${path}". HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }

  const infoResponse = await axios.get("https://cloud-api.yandex.net/v1/disk/resources", {
    params: { path, fields: "public_url" },
    headers: yandexDiskHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  if (infoResponse.status !== 200 || !infoResponse.data || !infoResponse.data.public_url) {
    throw new Error(`Яндекс.Диск: не удалось получить публичную ссылку для "${path}".`);
  }

  return infoResponse.data.public_url;
}

async function ydUploadFromUrl(path, fileUrl) {
  if (!YANDEX_DISK_TOKEN) {
    throw new Error("YANDEX_DISK_TOKEN не задан в Environment Variables");
  }

  const response = await ydRequestWithRetry(
    () =>
      axios.post("https://cloud-api.yandex.net/v1/disk/resources/upload", null, {
        params: { path, url: fileUrl },
        headers: yandexDiskHeaders(),
        timeout: 30000,
        validateStatus: () => true
      }),
    `загрузка файла "${path}"`
  );

  if (response.status !== 202 && response.status !== 201) {
    throw new Error(
      `Яндекс.Диск: не удалось начать загрузку файла в "${path}". HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

async function ydWaitForUploadOperation(operationHref, { maxAttempts = 90, delayMs = 2000 } = {}) {
  if (!operationHref) {
    return true;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await axios.get(operationHref, {
      headers: yandexDiskHeaders(),
      timeout: 30000,
      validateStatus: () => true
    });

    const status = response.status === 200 && response.data ? response.data.status : null;

    if (status === "success") {
      return true;
    }

    if (status === "failed") {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return false;
}

async function ydUploadFromUrlAndWait(path, fileUrl) {
  const result = await ydUploadFromUrl(path, fileUrl);
  const completed = await ydWaitForUploadOperation(result && result.href);

  if (!completed) {
    throw new Error(`Яндекс.Диск: загрузка файла в "${path}" не завершилась успехом за отведённое время.`);
  }

  return result;
}

// ------------------------------------------------------------
// AMOMESSENGER WEBHOOK: РАЗБОР СООБЩЕНИЙ
// ------------------------------------------------------------

function isStartCommand(text) {
  return START_COMMANDS.has(String(text || "").trim().toLowerCase());
}

function extractAmoMessengerUserName(...sources) {
  const preferredKeys = ["name", "full_name", "fullName", "user_name", "username"];

  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }

    for (const key of preferredKeys) {
      const value = source[key];

      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    const author = source.author;

    if (author && typeof author === "object") {
      for (const key of preferredKeys) {
        const value = author[key];

        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    }
  }

  return "";
}

function normalizeAmoMessengerFileUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  const markdownMatch = text.match(/\]\((https?:\/\/[^)\s]+)\)/);

  if (markdownMatch && markdownMatch[1]) {
    return markdownMatch[1];
  }

  const directMatch = text.match(/(https?:\/\/[^\s\])]+)/);

  if (directMatch && directMatch[1]) {
    return directMatch[1];
  }

  return null;
}

function extractImageUrlsFromMessage(message) {
  const urls = [];

  if (!message) {
    return urls;
  }

  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      const container = attachment && attachment.type && attachment[attachment.type];
      const link = container && container.link;

      if (typeof link === "string" && link) {
        const cleanUrl = normalizeAmoMessengerFileUrl(link);

        if (cleanUrl) {
          urls.push(cleanUrl);
        }
      }
    }
  }

  if (urls.length > 0) {
    return [...new Set(urls)];
  }

  function walk(value) {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      const cleanUrl = normalizeAmoMessengerFileUrl(value);

      if (cleanUrl) {
        urls.push(cleanUrl);
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    if (typeof value === "object") {
      for (const item of Object.values(value)) {
        walk(item);
      }
    }
  }

  walk(message);

  return [...new Set(urls)];
}

function getRealExtensionFromAmoMessengerToken(url) {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("s");

    if (!token) {
      return "";
    }

    const parts = token.split(".");

    if (parts.length < 2) {
      return "";
    }

    const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf8");
    const payload = JSON.parse(payloadJson);
    const displayName = String(payload.display_name || "");
    const lastDot = displayName.lastIndexOf(".");

    if (lastDot === -1) {
      return "";
    }

    return displayName.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch (error) {
    return "";
  }
}

function getUrlExtension(url) {
  const tokenExtension = getRealExtensionFromAmoMessengerToken(url);

  if (tokenExtension) {
    return tokenExtension;
  }

  try {
    const withoutQuery = String(url || "").split("?")[0];
    const lastDot = withoutQuery.lastIndexOf(".");
    const lastSlash = withoutQuery.lastIndexOf("/");

    if (lastDot === -1 || lastDot < lastSlash) {
      return "";
    }

    return withoutQuery.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------------
// ПРОЧИЕ ОБЩИЕ УТИЛИТЫ
// ------------------------------------------------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTaggedButton(label, identifier) {
  return `${label} (${identifier})`;
}

function parseTaggedButton(text, label) {
  const pattern = new RegExp(`^${escapeRegExp(label)} \\((.+)\\)$`);
  const match = String(text || "").match(pattern);

  return match ? match[1] : null;
}

function getMoscowDate() {
  const now = new Date();

  return new Date(now.getTime() + MOSCOW_OFFSET_MS);
}

function todayMoscowDateText() {
  const now = getMoscowDate();

  const day = String(now.getUTCDate()).padStart(2, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const year = now.getUTCFullYear();

  return `${day}.${month}.${year}`;
}

function todayMoscowStartUnix() {
  const now = getMoscowDate();

  const startUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);

  return Math.floor((startUtcMs - MOSCOW_OFFSET_MS) / 1000);
}

module.exports = {
  AMOCRM_SUBDOMAIN,
  YANDEX_DISK_ROOT_FOLDER,
  redisRequest,
  loadAmoCrmTokensFromRedis,
  amoCrmGet,
  amoCrmPost,
  amoCrmPatch,
  getLead,
  getUserName,
  getFieldValues,
  getFieldValueJoined,
  formatDateFieldValue,
  yandexDiskHeaders,
  ydEnsureFolder,
  ydEnsureFolderPath,
  ydGetFolderPublicUrl,
  ydUploadFromUrlAndWait,
  isStartCommand,
  extractAmoMessengerUserName,
  extractImageUrlsFromMessage,
  getUrlExtension,
  escapeRegExp,
  buildTaggedButton,
  parseTaggedButton,
  getMoscowDate,
  todayMoscowDateText,
  todayMoscowStartUnix
};
