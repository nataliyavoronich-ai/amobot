const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

// ============================================================
// НАСТРОЙКИ
// ============================================================

const PORT = process.env.PORT || 10000;

// ---------------- amoCRM ----------------

const AMOCRM_DOMAIN =
  process.env.AMOCRM_DOMAIN || "https://zlmk.amocrm.ru";

const AMOCRM_TOKEN =
  process.env.AMOCRM_TOKEN || "";

// Поле "Инженер"
const ENGINEER_FIELD_ID = 203849;

// Марина Трафимова
const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_ENUM_ID = 1059150;

// Тип задачи "Подтв. замер(и)"
const MEASUREMENT_TASK_TYPE_ID = 2746005;

// ---------------- amoMessenger ----------------

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

// Если токен уже есть в Environment Variables — используем его.
// Если нет — после OAuth он будет сохранён во временный файл.
const AMOMESSENGER_ACCESS_TOKEN =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

const AMOMESSENGER_REFRESH_TOKEN =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

const TOKEN_FILE = path.join(
  "/tmp",
  "amomessenger-token.json"
);

// ============================================================
// СЛУЖЕБНЫЕ ФУНКЦИИ
// ============================================================

function log(title, data = null) {
  console.log("");
  console.log("==========================================");
  console.log(title);

  if (data !== null) {
    if (typeof data === "string") {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  console.log("==========================================");
}

// ------------------------------------------------------------
// JSON-ответ
// ------------------------------------------------------------

function json(res, data, status = 200) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data));
}

// ------------------------------------------------------------
// Безопасное значение
// ------------------------------------------------------------

function valueOrDash(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return "—";
  }

  return String(value).trim();
}

// ------------------------------------------------------------
// Дата Москва
// ------------------------------------------------------------

function moscowDate(timestampSeconds) {
  if (!timestampSeconds) {
    return "—";
  }

  const date = new Date(Number(timestampSeconds) * 1000);

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

// ------------------------------------------------------------
// Дата без времени
// ------------------------------------------------------------

function moscowDateOnly(timestampSeconds) {
  if (!timestampSeconds) {
    return "—";
  }

  const date = new Date(Number(timestampSeconds) * 1000);

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

// ------------------------------------------------------------
// Начало сегодняшнего дня в Москве
// ------------------------------------------------------------

function getMoscowDayStartTimestamp() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find(p => p.type === "year").value);
  const month = Number(parts.find(p => p.type === "month").value);
  const day = Number(parts.find(p => p.type === "day").value);

  // Москва UTC+3
  return Math.floor(
    Date.UTC(year, month - 1, day, -3, 0, 0) / 1000
  );
}

// ------------------------------------------------------------
// Текущее московское время
// ------------------------------------------------------------

function getMoscowNowText() {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

// ============================================================
// HTTP GET amoCRM
// ============================================================

async function amoCRMGet(url) {
  if (!AMOCRM_TOKEN) {
    throw new Error(
      "Не задан AMOCRM_TOKEN"
    );
  }

  console.log("amoCRM GET:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${AMOCRM_TOKEN}`,
      Accept: "application/hal+json",
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(
      `amoCRM HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ============================================================
// HTTP POST amoMessenger
// ============================================================

async function amoMessengerPost(
  url,
  accessToken,
  body
) {
  console.log("amoMessenger POST:", url);
  console.log(
    "BODY:",
    JSON.stringify(body, null, 2)
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  console.log(
    "amoMessenger response:",
    response.status,
    data
  );

  if (!response.ok) {
    const error = new Error(
      `amoMessenger HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ============================================================
// TOKEN STORAGE
// ============================================================

function readStoredToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }

    const text = fs.readFileSync(
      TOKEN_FILE,
      "utf8"
    );

    return JSON.parse(text);
  } catch (error) {
    console.error(
      "Ошибка чтения токена:",
      error.message
    );

    return null;
  }
}

function saveStoredToken(tokenData) {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(
        tokenData,
        null,
        2
      ),
      "utf8"
    );

    console.log(
      "amoMessenger token сохранён"
    );
  } catch (error) {
    console.error(
      "Не удалось сохранить token:",
      error.message
    );
  }
}

// ============================================================
// ПОЛУЧЕНИЕ AMOMESSENGER ACCESS TOKEN
// ============================================================

async function getMessengerToken() {
  // 1. Если токен задан через Render Environment
  if (AMOMESSENGER_ACCESS_TOKEN) {
    return {
      access_token:
        AMOMESSENGER_ACCESS_TOKEN,
      refresh_token:
        AMOMESSENGER_REFRESH_TOKEN || null,
    };
  }

  // 2. Проверяем сохранённый токен
  const stored = readStoredToken();

  if (stored && stored.access_token) {
    // Если срок действия ещё не закончился
    if (
      !stored.expires_at ||
      Date.now() < stored.expires_at - 60000
    ) {
      return stored;
    }

    // Если есть refresh token — обновляем
    if (stored.refresh_token) {
      try {
        return await refreshMessengerToken(
          stored.refresh_token
        );
      } catch (error) {
        console.error(
          "Ошибка обновления amoMessenger token:",
          error.message
        );
      }
    }
  }

  throw new Error(
    "Токен amoMessenger не найден. Откройте /oauth/amomessenger/start и авторизуйте приложение."
  );
}

// ============================================================
// REFRESH TOKEN
// ============================================================

async function refreshMessengerToken(
  refreshToken
) {
  if (
    !AMOMESSENGER_CLIENT_ID ||
    !AMOMESSENGER_CLIENT_SECRET
  ) {
    throw new Error(
      "Не заданы AMOMESSENGER_CLIENT_ID или AMOMESSENGER_CLIENT_SECRET"
    );
  }

  const body = new URLSearchParams();

  body.set(
    "grant_type",
    "refresh_token"
  );

  body.set(
    "refresh_token",
    refreshToken
  );

  body.set(
    "client_id",
    AMOMESSENGER_CLIENT_ID
  );

  body.set(
    "client_secret",
    AMOMESSENGER_CLIENT_SECRET
  );

  const response = await fetch(
    "https://id.amo.tm/oauth2/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `OAuth refresh HTTP ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  const tokenData = {
    access_token:
      data.access_token,
    refresh_token:
      data.refresh_token || refreshToken,
    expires_in:
      data.expires_in || 3600,
    expires_at:
      Date.now() +
      Number(data.expires_in || 3600) *
        1000,
  };

  saveStoredToken(tokenData);

  return tokenData;
}

// ============================================================
// OAUTH START
// ============================================================

app.get(
  "/oauth/amomessenger/start",
  (req, res) => {
    if (
      !AMOMESSENGER_CLIENT_ID ||
      !AMOMESSENGER_CLIENT_SECRET
    ) {
      return res.status(500).send(
        "Не заданы AMOMESSENGER_CLIENT_ID или AMOMESSENGER_CLIENT_SECRET"
      );
    }

    const state = crypto
      .randomBytes(24)
      .toString("hex");

    const params = new URLSearchParams({
      client_id:
        AMOMESSENGER_CLIENT_ID,
      redirect_uri:
        AMOMESSENGER_REDIRECT_URI,
      response_type: "code",
      state,
    });

    const url =
      "https://id.amo.tm/access?" +
      params.toString();

    console.log(
      "OAuth URL:",
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
    try {
      log(
        "AMOMESSENGER OAUTH CALLBACK",
        req.query
      );

      const code = req.query.code;

      if (!code) {
        return res.status(400).send(
          `
          <html>
          <body style="font-family:Arial;padding:30px">
            <h2>Ошибка OAuth</h2>
            <p>Параметр <b>code</b> не получен.</p>
            <pre>${JSON.stringify(
              req.query,
              null,
              2
            )}</pre>
          </body>
          </html>
          `
        );
      }

      const body =
        new URLSearchParams();

      body.set(
        "grant_type",
        "authorization_code"
      );

      body.set(
        "code",
        code
      );

      body.set(
        "client_id",
        AMOMESSENGER_CLIENT_ID
      );

      body.set(
        "client_secret",
        AMOMESSENGER_CLIENT_SECRET
      );

      body.set(
        "redirect_uri",
        AMOMESSENGER_REDIRECT_URI
      );

      const response = await fetch(
        "https://id.amo.tm/oauth2/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        }
      );

      const text =
        await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        data = {
          raw: text,
        };
      }

      if (!response.ok) {
        throw new Error(
          `OAuth HTTP ${response.status}: ${JSON.stringify(
            data
          )}`
        );
      }

      const tokenData = {
        access_token:
          data.access_token,
        refresh_token:
          data.refresh_token || null,
        expires_in:
          data.expires_in || 3600,
        expires_at:
          Date.now() +
          Number(
            data.expires_in || 3600
          ) *
            1000,
      };

      saveStoredToken(
        tokenData
      );

      log(
        "AMOMESSENGER TOKEN ПОЛУЧЕН",
        {
          access_token_exists:
            !!tokenData.access_token,
          refresh_token_exists:
            !!tokenData.refresh_token,
          expires_in:
            tokenData.expires_in,
        }
      );

      res.send(
        `
        <html>
        <head>
          <meta charset="utf-8">
          <title>amoMessenger OAuth</title>
        </head>
        <body style="
          font-family:Arial;
          padding:30px;
          line-height:1.6
        ">
          <h2 style="color:green">
            Авторизация amoMessenger успешно выполнена
          </h2>

          <p>
            Токен сохранён на сервере.
          </p>

          <p>
            Теперь можно закрыть это окно и снова запустить бота.
          </p>

          <hr>

          <p>
            Access Token получен: <b>ДА</b>
          </p>

          <p>
            Refresh Token получен:
            <b>${
              tokenData.refresh_token
                ? "ДА"
                : "НЕТ"
            }</b>
          </p>

        </body>
        </html>
        `
      );
    } catch (error) {
      console.error(
        "OAUTH ERROR:",
        error
      );

      res.status(500).send(
        `
        <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body style="font-family:Arial;padding:30px">
          <h2 style="color:red">
            Ошибка OAuth
          </h2>

          <pre>${String(
            error.message
          )}</pre>
        </body>
        </html>
        `
      );
    }
  }
);

// ============================================================
// ГЛАВНАЯ
// ============================================================

app.get("/", (req, res) => {
  res.send(
    `
    <html>
    <head>
      <meta charset="utf-8">
      <title>Отчёты инженеров</title>
    </head>

    <body style="
      font-family:Arial;
      padding:40px;
    ">

      <h1>Отчёты инженеров</h1>

      <p>
        Сервер работает.
      </p>

      <p>
        Виджет и webhook готовы к работе.
      </p>

      <hr>

      <p>
        <a href="/health">
          Проверить сервер
        </a>
      </p>

      <p>
        <a href="/debug/config">
          Проверить настройки
        </a>
      </p>

      <p>
        <a href="/oauth/amomessenger/start">
          Авторизовать amoMessenger
        </a>
      </p>

      <p>
        <a href="/debug/search">
          Проверить поиск замеров
        </a>
      </p>

    </body>
    </html>
    `
  );
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  json(res, {
    status: "OK",
    server: "running",
    timezone: "Europe/Moscow",
    current_moscow_time:
      getMoscowNowText(),
  });
});

// ============================================================
// DEBUG CONFIG
// ============================================================

app.get(
  "/debug/config",
  async (req, res) => {
    let tokenStatus =
      "не найден";

    try {
      const token =
        await getMessengerToken();

      if (
        token &&
        token.access_token
      ) {
        tokenStatus =
          "найден";
      }
    } catch {}

    json(res, {
      status: "OK",

      amoCRM: {
        domain:
          AMOCRM_DOMAIN,
        token:
          AMOCRM_TOKEN
            ? "есть"
            : "НЕТ",
      },

      amoMessenger: {
        client_id:
          AMOMESSENGER_CLIENT_ID
            ? "есть"
            : "НЕТ",

        client_secret:
          AMOMESSENGER_CLIENT_SECRET
            ? "есть"
            : "НЕТ",

        redirect_uri:
          AMOMESSENGER_REDIRECT_URI,

        access_token:
          tokenStatus,
      },

      engineer: {
        name:
          ENGINEER_NAME,
        field_id:
          ENGINEER_FIELD_ID,
        enum_id:
          ENGINEER_ENUM_ID,
      },

      task: {
        type_id:
          MEASUREMENT_TASK_TYPE_ID,
        only_not_completed:
          true,
      },
    });
  }
);

// ============================================================
// ПОИСК ПОЛЯ В СДЕЛКЕ
// ============================================================

function getCustomField(
  lead,
  fieldId
) {
  const fields =
    lead?.custom_fields_values ||
    [];

  const field = fields.find(
    f =>
      Number(f.field_id) ===
      Number(fieldId)
  );

  if (
    !field ||
    !Array.isArray(field.values) ||
    !field.values.length
  ) {
    return null;
  }

  const first =
    field.values[0];

  if (
    first.value !== undefined &&
    first.value !== null
  ) {
    return first.value;
  }

  return null;
}

// ============================================================
// ПОИСК ПОЛЯ ИНЖЕНЕРА
// ============================================================

function isMarinaLead(lead) {
  const field =
    lead?.custom_fields_values?.find(
      f =>
        Number(f.field_id) ===
        Number(ENGINEER_FIELD_ID)
    );

  if (!field) {
    return false;
  }

  const values =
    field.values || [];

  return values.some(v => {
    const value =
      String(
        v.value ?? ""
      ).trim();

    const enumId =
      Number(
        v.enum_id ?? 0
      );

    return (
      value === ENGINEER_NAME ||
      enumId ===
        Number(ENGINEER_ENUM_ID)
    );
  });
}

// ============================================================
// ПОЛУЧИТЬ КОНТАКТЫ СДЕЛКИ
// ============================================================

function getLeadContacts(lead) {
  return (
    lead?._embedded?.contacts ||
    []
  );
}

// ============================================================
// ПОЛУЧИТЬ КОНТАКТ
// ============================================================

async function getContact(
  contactId
) {
  try {
    return await amoCRMGet(
      `${AMOCRM_DOMAIN}/api/v4/contacts/${contactId}`
    );
  } catch (error) {
    console.error(
      "Ошибка получения контакта",
      contactId,
      error.message
    );

    return null;
  }
}

// ============================================================
// ТЕЛЕФОНЫ КОНТАКТА
// ============================================================

function getContactPhones(
  contact
) {
  if (!contact) {
    return [];
  }

  const field =
    contact.custom_fields_values?.find(
      f =>
        f.field_code === "PHONE" ||
        f.field_name ===
          "Телефон"
    );

  if (!field) {
    return [];
  }

  return (
    field.values
      ?.map(v => v.value)
      .filter(Boolean) ||
    []
  );
}

// ============================================================
// ИМЯ КОНТАКТА
// ============================================================

function getContactName(
  contact
) {
  if (!contact) {
    return "—";
  }

  return (
    contact.name ||
    "—"
  );
}

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurements() {
  console.log("");
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
    "Только незавершённые задачи: ДА"
  );
  console.log(
    "=========================================="
  );

  const now =
    Math.floor(
      Date.now() / 1000
    );

  // С 00:00 предыдущего дня
  const from =
    getMoscowDayStartTimestamp() -
    24 * 60 * 60;

  const to = now;

  console.log(
    "Диапазон:",
    moscowDate(from),
    "—",
    moscowDate(to)
  );

  const allTasks = [];

  let page = 1;

  while (page <= 20) {
    const params =
      new URLSearchParams();

    params.set(
      "filter[entity_type]",
      "leads"
    );

    // ВАЖНО:
    // незавершённые задачи
    params.set(
      "filter[is_completed]",
      "0"
    );

    params.set(
      "filter[complete_till][from]",
      String(from)
    );

    params.set(
      "filter[complete_till][to]",
      String(to)
    );

    params.set(
      "limit",
      "250"
    );

    params.set(
      "page",
      String(page)
    );

    params.set(
      "order[complete_till]",
      "asc"
    );

    const url =
      `${AMOCRM_DOMAIN}/api/v4/tasks?${params.toString()}`;

    console.log(
      "Запрос задач:",
      params.toString()
    );

    const data =
      await amoCRMGet(url);

    const tasks =
      data?._embedded?.tasks ||
      [];

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    allTasks.push(
      ...tasks
    );

    if (
      !data?._links?.next ||
      tasks.length === 0
    ) {
      break;
    }

    page++;
  }

  console.log(
    "Всего загружено задач:",
    allTasks.length
  );

  // ----------------------------------------------------------
  // ФИЛЬТР ПО ТИПУ ЗАДАЧИ
  // ----------------------------------------------------------

  const measurementTasks =
    allTasks.filter(task => {
      return (
        Number(
          task.task_type_id
        ) ===
        Number(
          MEASUREMENT_TASK_TYPE_ID
        ) &&
        task.is_completed === false &&
        Number(
          task.complete_till || 0
        ) >= from &&
        Number(
          task.complete_till || 0
        ) <= to
      );
    });

  console.log(
    "Подходящих задач:",
    measurementTasks.length
  );

  // ----------------------------------------------------------
  // ПОЛУЧАЕМ СДЕЛКИ
  // ----------------------------------------------------------

  const result = [];

  for (
    const task of measurementTasks
  ) {
    try {
      const leadId =
        task.entity_id;

      if (!leadId) {
        continue;
      }

      const lead =
        await amoCRMGet(
          `${AMOCRM_DOMAIN}/api/v4/leads/${leadId}?with=contacts`
        );

      console.log(
        "Получена сделка:",
        leadId
      );

      // ВАЖНО:
      // если поле инженера отсутствует,
      // просто пропускаем эту сделку.
      // Пустые остальные поля НЕ влияют
      // на поиск.
      if (
        !isMarinaLead(lead)
      ) {
        console.log(
          "Сделка не принадлежит Марине:",
          leadId
        );

        continue;
      }

      // ------------------------------------------------------
      // ПОЛЯ СДЕЛКИ
      // ------------------------------------------------------

      const contractNumber =
        getCustomField(
          lead,
          412776
        );

      const measureDateRaw =
        getCustomField(
          lead,
          175370
        );

      const measureTime =
        getCustomField(
          lead,
          413828
        );

      const address =
        getCustomField(
          lead,
          175412
        );

      const product =
        getCustomField(
          lead,
          172572
        );

      // ------------------------------------------------------
      // ДАТА ЗАМЕРА
      // ------------------------------------------------------

      let measureDate =
        "—";

      if (
        measureDateRaw !==
          null &&
        measureDateRaw !==
          undefined &&
        String(
          measureDateRaw
        ).trim() !== ""
      ) {
        if (
          !isNaN(
            Number(
              measureDateRaw
            )
          )
        ) {
          measureDate =
            moscowDateOnly(
              Number(
                measureDateRaw
              )
            );
        } else {
          measureDate =
            String(
              measureDateRaw
            );
        }
      }

      // ------------------------------------------------------
      // КОНТАКТ
      // ------------------------------------------------------

      const linkedContacts =
        getLeadContacts(
          lead
        );

      let clientName =
        "—";

      let clientPhones =
        [];

      const mainContact =
        linkedContacts.find(
          c =>
            c.is_main === true
        ) ||
        linkedContacts[0];

      if (
        mainContact?.id
      ) {
        const contact =
          await getContact(
            mainContact.id
          );

        if (contact) {
          clientName =
            getContactName(
              contact
            );

          clientPhones =
            getContactPhones(
              contact
            );
        }
      }

      // ------------------------------------------------------
      // ДОБАВЛЯЕМ РЕЗУЛЬТАТ
      // ------------------------------------------------------

      result.push({
        task_id:
          task.id,

        task_complete_till:
          task.complete_till,

        task_complete_till_moscow:
          moscowDate(
            task.complete_till
          ),

        lead_id:
          lead.id,

        lead_name:
          lead.name || "—",

        contract_number:
          contractNumber,

        measure_date:
          measureDate,

        measure_time:
          measureTime,

        measure_address:
          address,

        product:
          product,

        client_name:
          clientName,

        client_phones:
          clientPhones,

        engineer:
          ENGINEER_NAME,

        lead_link:
          `${AMOCRM_DOMAIN}/leads/detail/${lead.id}`,
      });
    } catch (error) {
      console.error(
        "Ошибка обработки задачи:",
        task.id,
        error.message
      );
    }
  }

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    result.length
  );

  return {
    timezone:
      "Europe/Moscow",

    current_moscow_time:
      getMoscowNowText(),

    engineer: {
      name:
        ENGINEER_NAME,
      field_id:
        ENGINEER_FIELD_ID,
      enum_id:
        ENGINEER_ENUM_ID,
    },

    task_type_id:
      MEASUREMENT_TASK_TYPE_ID,

    date_mode:
      "до 18:00",

    date_range: {
      from:
        moscowDate(from),
      to:
        moscowDate(to),
    },

    tasks_loaded:
      allTasks.length,

    measurement_tasks:
      measurementTasks.length,

    found_count:
      result.length,

    measurements:
      result,
  };
}

// ============================================================
// DEBUG SEARCH
// ============================================================

app.get(
  "/debug/search",
  async (req, res) => {
    try {
      const result =
        await findMeasurements();

      json(res, {
        status: "OK",
        ...result,
      });
    } catch (error) {
      console.error(
        "DEBUG SEARCH ERROR:",
        error
      );

      json(
        res,
        {
          status:
            "Ошибка",
          message:
            error.message,
          details:
            error.details ||
            null,
        },
        error.status ||
          500
      );
    }
  }
);

// ============================================================
// DEBUG TASK
// ============================================================

app.get(
  "/debug/task-test/:taskId",
  async (req, res) => {
    try {
      const taskId =
        req.params.taskId;

      const task =
        await amoCRMGet(
          `${AMOCRM_DOMAIN}/api/v4/tasks/${taskId}`
        );

      const checks = {
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
          moscowDate(
            task.complete_till
          ),
      };

      json(res, {
        status: "OK",
        task_id:
          taskId,
        task,
        checks,
      });
    } catch (error) {
      json(
        res,
        {
          status:
            "Ошибка",
          message:
            error.message,
          details:
            error.details ||
            null,
        },
        error.status ||
          500
      );
    }
  }
);

// ============================================================
// ФОРМАТ ОТЧЁТА
// ============================================================

function buildMeasurementsText(
  searchResult
) {
  const measurements =
    searchResult.measurements ||
    [];

  if (
    measurements.length === 0
  ) {
    return (
      "📋 Замеры\n\n" +
      "На данный момент подходящих незавершённых задач на подтверждение замера не найдено."
    );
  }

  const parts = [];

  parts.push(
    `📋 Найдено замеров: ${measurements.length}`
  );

  parts.push("");

  measurements.forEach(
    (item, index) => {
      const phones =
        item.client_phones &&
        item.client_phones.length
          ? item.client_phones.join(
              ", "
            )
          : "—";

      parts.push(
        `📌 ЗАМЕР ${index + 1}`
      );

      parts.push(
        `№ договора: ${valueOrDash(
          item.contract_number
        )}`
      );

      parts.push(
        `Дата замера: ${valueOrDash(
          item.measure_date
        )}`
      );

      parts.push(
        `Время замера: ${valueOrDash(
          item.measure_time
        )}`
      );

      parts.push(
        `Адрес объекта: ${valueOrDash(
          item.measure_address
        )}`
      );

      parts.push(
        `Продукт: ${valueOrDash(
          item.product
        )}`
      );

      parts.push(
        `Клиент: ${valueOrDash(
          item.client_name
        )}`
      );

      parts.push(
        `Телефон: ${phones}`
      );

      parts.push(
        `Инженер: ${valueOrDash(
          item.engineer
        )}`
      );

      parts.push(
        `Срок задачи: ${valueOrDash(
          item.task_complete_till_moscow
        )}`
      );

      parts.push(
        `Сделка: ${item.lead_link}`
      );

      parts.push("");
      parts.push("──────────────");
      parts.push("");
    }
  );

  return parts.join("\n");
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В ЗАЯВКУ БОТА
// ============================================================

async function sendBotMessage({
  botId,
  requestId,
  receiverUserId,
  text,
}) {
  const token =
    await getMessengerToken();

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}/request/${requestId}/sendMessage`;

  return await amoMessengerPost(
    url,
    token.access_token,
    {
      text,
      receiver: {
        user_id:
          receiverUserId,
      },
    }
  );
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ БОТУ
// ============================================================

async function returnBotControl({
  botId,
  requestId,
  returnCode = "success",
}) {
  const token =
    await getMessengerToken();

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}/request/${requestId}/returnControl`;

  return await amoMessengerPost(
    url,
    token.access_token,
    {
      return_code:
        returnCode,
    }
  );
}

// ============================================================
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {
    // Очень важно:
    // отвечаем amo сразу 200.
    // Бизнес-логику выполняем после.
    res.status(200).json({
      status: "OK",
    });

    const body =
      req.body || {};

    log(
      "AMOMESSENGER WEBHOOK",
      body
    );

    try {
      const eventType =
        body.event_type;

      // ------------------------------------------------------
      // ПЕРЕДАЧА УПРАВЛЕНИЯ ВИДЖЕТУ
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {
        const wrapper =
          body?._embedded
            ?.rpa_bot_control_transferred;

        const context =
          wrapper?._embedded
            ?.context;

        const request =
          wrapper?._embedded
            ?.request;

        const botId =
          wrapper?.bot_id;

        const requestId =
          request?.id;

        const userId =
          context?.user_id ||
          request?.responsible_id;

        log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ",
          {
            botId,
            requestId,
            userId,
          }
        );

        if (
          !botId ||
          !requestId ||
          !userId
        ) {
          console.error(
            "Недостаточно данных для обработки заявки"
          );

          return;
        }

        // Просто сообщаем пользователю,
        // что поиск начался.
        try {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId:
              userId,
            text:
              "⏳ Проверяю задачи на подтверждение замера...",
          });
        } catch (error) {
          console.error(
            "Не удалось отправить сообщение о начале:",
            error.message
          );
        }

        return;
      }

      // ------------------------------------------------------
      // СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
      // ------------------------------------------------------

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {
        const wrapper =
          body?._embedded
            ?.rpa_bot_income_message;

        const context =
          wrapper?._embedded
            ?.context;

        const incomeMessage =
          wrapper?._embedded
            ?.income_message;

        const request =
          wrapper?._embedded
            ?.request;

        const botId =
          wrapper?.bot_id;

        const requestId =
          request?.id;

        const userId =
          context?.user_id ||
          incomeMessage
            ?.author
            ?.user_id;

        const messageText =
          String(
            incomeMessage?.text ||
              ""
          ).trim();

        log(
          "ПОЛУЧЕНО СООБЩЕНИЕ ОТ ПОЛЬЗОВАТЕЛЯ",
          {
            messageText,
            botId,
            requestId,
            userId,
          }
        );

        if (
          !botId ||
          !requestId ||
          !userId
        ) {
          console.error(
            "Нет botId/requestId/userId"
          );

          return;
        }

        // ----------------------------------------------------
        // ПОДТВЕРДИТЬ ЗАМЕР
        // ----------------------------------------------------

        if (
          messageText
            .toLowerCase()
            .includes(
              "подтвердить замер"
            )
        ) {
          log(
            "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
          );

          try {
            const searchResult =
              await findMeasurements();

            const report =
              buildMeasurementsText(
                searchResult
              );

            // Отправляем результат
            await sendBotMessage({
              botId,
              requestId,
              receiverUserId:
                userId,
              text: report,
            });

            log(
              "ОТЧЁТ ОТПРАВЛЕН",
              {
                found_count:
                  searchResult.found_count,
              }
            );

            // Возвращаем управление
            // конструктору бота
            await returnBotControl({
              botId,
              requestId,
              returnCode:
                "success",
            });

            log(
              "УПРАВЛЕНИЕ ВОЗВРАЩЕНО БОТУ"
            );
          } catch (error) {
            console.error(
              "ОШИБКА ПРИ ПОИСКЕ И ОТПРАВКЕ:",
              error
            );

            try {
              await sendBotMessage({
                botId,
                requestId,
                receiverUserId:
                  userId,
                text:
                  "❌ Не удалось получить данные из amoCRM.\n\n" +
                  `Ошибка: ${error.message}`,
              });
            } catch (
              sendError
            ) {
              console.error(
                "Ошибка отправки сообщения об ошибке:",
                sendError.message
              );
            }

            // Возвращаем управление с кодом error.
            // Если в настройках виджета этот код
            // называется иначе, его можно поменять
            // в одной строке ниже.
            try {
              await returnBotControl({
                botId,
                requestId,
                returnCode:
                  "error",
              });
            } catch (
              returnError
            ) {
              console.error(
                "Ошибка возврата управления:",
                returnError.message
              );
            }
          }

          return;
        }

        // ----------------------------------------------------
        // /start
        // ----------------------------------------------------

        if (
          messageText ===
          "/start"
        ) {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId:
              userId,
            text:
              "Выберите задачу для выполнения.",
          });

          return;
        }

        // ----------------------------------------------------
        // ДРУГОЕ СООБЩЕНИЕ
        // ----------------------------------------------------

        try {
          await sendBotMessage({
            botId,
            requestId,
            receiverUserId:
              userId,
            text:
              "Пожалуйста, выберите «Подтвердить замер» в меню.",
          });
        } catch (error) {
          console.error(
            "Ошибка ответа:",
            error.message
          );
        }

        return;
      }

      // Другие события просто логируем
      log(
        "Событие amoMessenger обработано",
        {
          event_type:
            eventType,
        }
      );
    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        error
      );
    }
  }
);

// ============================================================
// СТАРЫЙ / WEBHOOK
// ============================================================
// Оставляем несколько вариантов адреса,
// чтобы не пришлось менять всё сразу.

app.post(
  "/webhook",
  (req, res) => {
    // Перенаправить обработку невозможно
    // после отправки ответа, поэтому вызываем
    // внутреннюю логику напрямую.
    res.status(200).json({
      status: "OK",
    });

    console.log(
      "POST /webhook",
      JSON.stringify(
        req.body,
        null,
        2
      )
    );
  }
);

// ============================================================
// POST / — ВИДЖЕТ
// ============================================================

app.post(
  "/",
  (req, res) => {
    log(
      "AMOMESSENGER / POST",
      req.body
    );

    res.status(200).json({
      status: "OK",
      message:
        "POST / получен",
    });
  }
);

// ============================================================
// GET /oauth/amomessenger/callback
// Уже выше
// ============================================================

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).send(
      `
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family:Arial;padding:30px">

        <h2>Страница не найдена</h2>

        <p>
          Адрес:
          <b>${req.method} ${
            req.originalUrl
          }</b>
        </p>

        <p>
          Сервер работает.
        </p>

      </body>
      </html>
      `
    );
  }
);

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "ОТЧЁТЫ ИНЖЕНЕРОВ — СЕРВЕР ЗАПУЩЕН"
    );
    console.log(
      "=========================================="
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "AMOCRM:",
      AMOCRM_DOMAIN
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
      "Только незавершённые задачи: ДА"
    );

    console.log(
      "amoMessenger Client ID:",
      AMOMESSENGER_CLIENT_ID
        ? "есть"
        : "НЕТ"
    );

    console.log(
      "amoMessenger Client Secret:",
      AMOMESSENGER_CLIENT_SECRET
        ? "есть"
        : "НЕТ"
    );

    console.log(
      "amoMessenger Access Token:",
      AMOMESSENGER_ACCESS_TOKEN
        ? "есть в Environment"
        : "будет взят из OAuth"
    );

    console.log(
      "OAuth callback:",
      AMOMESSENGER_REDIRECT_URI
    );

    console.log(
      "=========================================="
    );
  }
);
