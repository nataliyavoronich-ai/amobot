const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { DateTime } = require("luxon");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const AMOCRM_DOMAIN =
  process.env.AMOCRM_DOMAIN || "zlmk.amocrm.ru";

const AMOCRM_ACCESS_TOKEN =
  process.env.AMOCRM_ACCESS_TOKEN ||
  process.env.AMOCRM_TOKEN ||
  "";

const AMOMESSENGER_CLIENT_ID =
  process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
  process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
  process.env.AMOMESSENGER_REDIRECT_URI ||
  "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

// ============================================================
// amoMessenger OAuth
// ============================================================

let amoMessengerAccessToken =
  process.env.AMOMESSENGER_ACCESS_TOKEN || "";

let amoMessengerRefreshToken =
  process.env.AMOMESSENGER_REFRESH_TOKEN || "";

// ============================================================
// ДАННЫЕ ИНЖЕНЕРА
// ============================================================

const ENGINEER_NAME = "Марина Трафимова";

// Поле "Инженер" в сделке
const ENGINEER_FIELD_ID = 203849;

// enum_id значения "Марина Трафимова"
const ENGINEER_ENUM_ID = 1059150;

// Тип задачи "Подтв. замер(и)"
const MEASUREMENT_TASK_TYPE_ID = 2746005;

// Часовой пояс
const TIMEZONE = "Europe/Moscow";

// ============================================================
// ПРОСТОЙ ТЕСТ
// ============================================================

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Отчёт инженеров</title>
      </head>
      <body style="font-family: Arial; padding: 30px;">
        <h1>Отчёт инженеров</h1>
        <p>Сервер работает.</p>
        <p>Виджет подключён и готов к работе.</p>
      </body>
    </html>
  `);
});

// ============================================================
// ПРОВЕРКА AMOCRM TOKEN
// ============================================================

app.get("/debug/token", (req, res) => {
  res.json({
    status: AMOCRM_ACCESS_TOKEN
      ? "OK"
      : "Ошибка",
    AMOCRM_ACCESS_TOKEN:
      AMOCRM_ACCESS_TOKEN ? "ЗАДАН" : "НЕ ЗАДАН",
    AMOCRM_DOMAIN
  });
});

// ============================================================
// DEBUG: ПРОВЕРКА КОНКРЕТНОЙ ЗАДАЧИ
// ============================================================

app.get("/debug/tasks-test", async (req, res) => {
  try {
    if (!AMOCRM_ACCESS_TOKEN) {
      return res.status(500).json({
        status: "Ошибка",
        message:
          "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
      });
    }

    const taskId = 63882106;

    const url =
      `https://${AMOCRM_DOMAIN}/api/v4/tasks/${taskId}`;

    console.log("==========================================");
    console.log("DEBUG КОНКРЕТНОЙ ЗАДАЧИ");
    console.log("URL:", url);
    console.log("==========================================");

    const response = await axios.get(url, {
      headers: {
        Authorization:
          `Bearer ${AMOCRM_ACCESS_TOKEN}`,
        Accept: "application/hal+json"
      },
      timeout: 30000
    });

    const task = response.data;

    const completeTill = task.complete_till
      ? DateTime
          .fromSeconds(task.complete_till, {
            zone: TIMEZONE
          })
          .toFormat("dd.MM.yyyy, HH:mm:ss")
      : null;

    res.json({
      status: "OK",
      task_id: task.id,
      entity_id: task.entity_id,
      entity_type: task.entity_type,
      task_type_id: task.task_type_id,
      is_completed: task.is_completed,
      complete_till: task.complete_till,
      complete_till_moscow: completeTill,
      passes: {
        entity_type:
          task.entity_type === "leads",

        task_type:
          Number(task.task_type_id) ===
          Number(MEASUREMENT_TASK_TYPE_ID),

        not_completed:
          task.is_completed === false
      }
    });

  } catch (error) {

    console.error(
      "DEBUG TASK ERROR:",
      error.response?.status,
      error.response?.data ||
        error.message
    );

    res.status(500).json({
      status: "Ошибка",
      http_status:
        error.response?.status || null,
      message:
        error.response?.data ||
        error.message
    });
  }
});

// ============================================================
// DEBUG ПОИСК ЗАМЕРОВ
// ============================================================

app.get("/debug/search", async (req, res) => {

  try {

    const result =
      await findMeasurementTasks();

    res.json(result);

  } catch (error) {

    console.error(
      "DEBUG SEARCH ERROR:",
      error.response?.data ||
      error.message
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
// AMOMESSENGER OAUTH — СТАРТ
// ============================================================

app.get("/oauth/amomessenger", (req, res) => {

  if (
    !AMOMESSENGER_CLIENT_ID ||
    !AMOMESSENGER_CLIENT_SECRET
  ) {
    return res.status(500).send(`
      <h2>Ошибка</h2>
      <p>
        Не заданы AMOMESSENGER_CLIENT_ID
        или AMOMESSENGER_CLIENT_SECRET.
      </p>
    `);
  }

  const state =
    crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: AMOMESSENGER_CLIENT_ID,
    redirect_uri: AMOMESSENGER_REDIRECT_URI,
    response_type: "code",
    state
  });

  const url =
    `https://id.amo.tm/oauth?${params.toString()}`;

  console.log(
    "AMOMESSENGER OAuth URL:",
    url
  );

  res.redirect(url);
});

// ============================================================
// AMOMESSENGER OAUTH CALLBACK
// ============================================================

app.get(
  "/oauth/amomessenger/callback",
  async (req, res) => {

    try {

      const code = req.query.code;

      console.log(
        "=========================================="
      );
      console.log(
        "AMOMESSENGER OAUTH CALLBACK"
      );
      console.log(
        "code:",
        code ? "ПОЛУЧЕН" : "НЕТ"
      );
      console.log(
        "=========================================="
      );

      if (!code) {

        return res.status(400).send(`
          <html>
            <head>
              <meta charset="UTF-8">
            </head>
            <body style="font-family:Arial;padding:30px">
              <h2>Ошибка OAuth</h2>
              <p>Код авторизации не получен.</p>
              <p>
                Проверьте, что авторизация запускается
                через правильную ссылку.
              </p>
            </body>
          </html>
        `);
      }

      const tokenResponse =
        await axios.post(
          "https://id.amo.tm/oauth2/access_token",
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
        tokenResponse.data.access_token;

      amoMessengerRefreshToken =
        tokenResponse.data.refresh_token;

      console.log(
        "=========================================="
      );
      console.log(
        "AMOMESSENGER OAUTH УСПЕШНО"
      );
      console.log(
        "Access Token:",
        amoMessengerAccessToken
          ? "ДА"
          : "НЕТ"
      );
      console.log(
        "Refresh Token:",
        amoMessengerRefreshToken
          ? "ДА"
          : "НЕТ"
      );
      console.log(
        "=========================================="
      );

      res.send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>OAuth</title>
          </head>
          <body style="font-family:Arial;padding:30px">
            <h2 style="color:green">
              Авторизация amoMessenger успешно выполнена
            </h2>

            <p>
              Токен сохранён на сервере.
            </p>

            <p>
              Теперь можно закрыть это окно
              и снова запустить бота.
            </p>

            <hr>

            <p>
              Access Token получен:
              <b>ДА</b>
            </p>

            <p>
              Refresh Token получен:
              <b>ДА</b>
            </p>
          </body>
        </html>
      `);

    } catch (error) {

      console.error(
        "OAuth amoMessenger ERROR:",
        error.response?.status,
        error.response?.data ||
        error.message
      );

      res.status(500).send(`
        <html>
          <head>
            <meta charset="UTF-8">
          </head>
          <body style="font-family:Arial;padding:30px">
            <h2 style="color:red">
              Ошибка авторизации amoMessenger
            </h2>

            <pre>
${JSON.stringify(
  error.response?.data ||
  { message: error.message },
  null,
  2
)}
            </pre>
          </body>
        </html>
      `);
    }
  }
);

// ============================================================
// ПРОВЕРКА AMOMESSENGER TOKEN
// ============================================================

app.get("/debug/amomessenger-token", (req, res) => {

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
        : "НЕТ"
  });
});

// ============================================================
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
  "/webhook/amomessenger",
  async (req, res) => {

    console.log(
      "=========================================="
    );

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

    console.log(
      "=========================================="
    );

    // Сразу отвечаем amoMessenger
    res.status(200).json({
      status: "OK"
    });

    try {

      const body = req.body;

      const eventType =
        body.event_type;

      // ======================================================
      // ПЕРЕДАЧА УПРАВЛЕНИЯ ВИДЖЕТУ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_control_transferred"
      ) {

        const data =
          body?._embedded
            ?.rpa_bot_control_transferred;

        const botId =
          data?.bot_id;

        const request =
          data?._embedded
            ?.request;

        const requestId =
          request?.id;

        const contextUserId =
          body?._embedded
            ?.context
            ?.user_id;

        const receiverUserId =
          request?.responsible_id ||
          request?.author_id ||
          contextUserId;

        console.log(
          "=========================================="
        );

        console.log(
          "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ"
        );

        console.log({
          botId,
          requestId,
          receiverUserId,
          contextUserId,
          requestAuthorId:
            request?.author_id
        });

        console.log(
          "=========================================="
        );

        if (
          botId &&
          requestId &&
          receiverUserId
        ) {

          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              "Выберите задачу для выполнения:",
            buttons: [
              "Подтвердить замер",
              "Провести замер",
              "Загрузить фотоотчет",
              "Внести правки"
            ]
          });
        }

        return;
      }

      // ======================================================
      // ПОЛУЧЕНИЕ СООБЩЕНИЯ ОТ ПОЛЬЗОВАТЕЛЯ
      // ======================================================

      if (
        eventType ===
        "rpa_bot_income_message"
      ) {

        const data =
          body?._embedded
            ?.rpa_bot_income_message;

        const botId =
          data?.bot_id;

        const incomeMessage =
          data?._embedded
            ?.income_message;

        const request =
          data?._embedded
            ?.request;

        const requestId =
          request?.id;

        const text =
          incomeMessage?.text
            ?.trim();

        const receiverUserId =
          incomeMessage?.author
            ?.user_id;

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
          text ===
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

          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              "⏳ Проверяю задачи на подтверждение замера..."
          });

          try {

            const result =
              await findMeasurementTasks();

            console.log(
              "=========================================="
            );

            console.log(
              "ИТОГО ЗАМЕРОВ:",
              result.found_count
            );

            console.log(
              "=========================================="
            );

            if (
              result.found_count === 0
            ) {

              await sendBotMessage({
                botId,
                requestId,
                receiverUserId,
                text:
                  "📋 Замеров для подтверждения не найдено."
              });

            } else {

              for (
                const measurement
                of result.measurements
              ) {

                const message =
                  formatMeasurement(
                    measurement
                  );

                await sendBotMessage({
                  botId,
                  requestId,
                  receiverUserId,
                  text: message
                });
              }
            }

          } catch (error) {

            console.error(
              "ОШИБКА ПОИСКА ЗАМЕРОВ:",
              error.response?.data ||
              error.message
            );

            await sendBotMessage({
              botId,
              requestId,
              receiverUserId,
              text:
                "❌ При поиске задач произошла ошибка. Проверьте логи сервера."
            });
          }

          // Возвращаем управление amoMessenger
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
              "Ошибка возврата управления:",
              error.response?.data ||
              error.message
            );
          }

          return;
        }

        // ====================================================
        // ПРОЧИЕ КНОПКИ
        // ====================================================

        if (
          [
            "Провести замер",
            "Загрузить фотоотчет",
            "Внести правки"
          ].includes(text)
        ) {

          await sendBotMessage({
            botId,
            requestId,
            receiverUserId,
            text:
              `Вы выбрали: ${text}`
          });

          returnControl(
            botId,
            requestId
          ).catch(error => {
            console.error(
              "Ошибка возврата управления:",
              error.message
            );
          });

          return;
        }
      }

    } catch (error) {

      console.error(
        "WEBHOOK ERROR:",
        error.message
      );
    }
  }
);

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurementTasks() {

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
    "=========================================="
  );

  if (!AMOCRM_ACCESS_TOKEN) {

    throw new Error(
      "AMOCRM_ACCESS_TOKEN не задан"
    );
  }

  // ========================================================
  // ТЕКУЩЕЕ МОСКОВСКОЕ ВРЕМЯ
  // ========================================================

  const now =
    DateTime.now()
      .setZone(TIMEZONE);

  // Сегодня 00:00
  const todayStart =
    now.startOf("day");

  // Вчера 00:00
  const yesterdayStart =
    todayStart.minus({
      days: 1
    });

  // ========================================================
  // ВАЖНО:
  //
  // НЕ передаём в API фильтры:
  // filter[is_completed]
  // filter[task_type]
  //
  // Потому что именно они сейчас дают 204.
  //
  // Получаем задачи только по:
  // entity_type=leads
  // complete_till from/to
  //
  // А потом фильтруем локально.
  // ========================================================

  const fromTimestamp =
    Math.floor(
      yesterdayStart.toSeconds()
    );

  const toTimestamp =
    Math.floor(
      now.toSeconds()
    );

  console.log(
    "Дата от:",
    yesterdayStart.toFormat(
      "dd.MM.yyyy, HH:mm:ss"
    )
  );

  console.log(
    "Дата до:",
    now.toFormat(
      "dd.MM.yyyy, HH:mm:ss"
    )
  );

  console.log(
    "Timestamp from:",
    fromTimestamp
  );

  console.log(
    "Timestamp to:",
    toTimestamp
  );

  // ========================================================
  // ПОЛУЧАЕМ ВСЕ ЗАДАЧИ ЗА ПЕРИОД
  // ========================================================

  let allTasks = [];

  let page = 1;

  while (true) {

    const params = {
      "filter[entity_type]":
        "leads",

      "filter[complete_till][from]":
        fromTimestamp,

      "filter[complete_till][to]":
        toTimestamp,

      limit: 250,

      page,

      "order[complete_till]":
        "asc"
    };

    const queryString =
      new URLSearchParams(
        params
      ).toString();

    const url =
      `https://${AMOCRM_DOMAIN}/api/v4/tasks?${queryString}`;

    console.log(
      "=========================================="
    );

    console.log(
      "Запрос задач:"
    );

    console.log(
      queryString
    );

    console.log(
      "amoCRM GET:",
      url
    );

    let response;

    try {

      response =
        await axios.get(
          url,
          {
            headers: {
              Authorization:
                `Bearer ${AMOCRM_ACCESS_TOKEN}`,

              Accept:
                "application/hal+json"
            },

            timeout: 30000,

            validateStatus:
              status =>
                status >= 200 &&
                status < 300
          }
        );

    } catch (error) {

      console.error(
        "amoCRM GET ERROR:",
        error.response?.status,
        error.response?.data ||
        error.message
      );

      throw error;
    }

    // ======================================================
    // 204 = задач нет
    // ======================================================

    if (
      response.status === 204 ||
      !response.data
    ) {

      console.log(
        `Страница задач ${page}: 0`
      );

      break;
    }

    const tasks =
      response.data?._embedded
        ?.tasks || [];

    console.log(
      `Страница задач ${page}: ${tasks.length}`
    );

    if (
      tasks.length === 0
    ) {
      break;
    }

    allTasks =
      allTasks.concat(tasks);

    if (
      tasks.length < 250
    ) {
      break;
    }

    page++;

    // Защита от бесконечного цикла
    if (page > 20) {
      console.log(
        "Достигнут лимит страниц задач: 20"
      );
      break;
    }
  }

  console.log(
    "Всего задач:",
    allTasks.length
  );

  // ========================================================
  // ЛОКАЛЬНАЯ ФИЛЬТРАЦИЯ
  // ========================================================

  const validTasks =
    allTasks.filter(task => {

      const entityTypeOk =
        task.entity_type === "leads";

      const taskTypeOk =
        Number(task.task_type_id) ===
        Number(
          MEASUREMENT_TASK_TYPE_ID
        );

      const notCompleted =
        task.is_completed === false;

      const hasEntity =
        !!task.entity_id;

      const result =
        entityTypeOk &&
        taskTypeOk &&
        notCompleted &&
        hasEntity;

      console.log(
        "Проверка задачи:",
        {
          id: task.id,
          entity_id:
            task.entity_id,
          entity_type:
            task.entity_type,
          task_type_id:
            task.task_type_id,
          is_completed:
            task.is_completed,
          result
        }
      );

      return result;
    });

  console.log(
    "Найдено подходящих задач:",
    validTasks.length
  );

  // ========================================================
  // ПОЛУЧАЕМ СДЕЛКИ
  // ========================================================

  const measurements = [];

  for (
    const task of validTasks
  ) {

    try {

      const leadUrl =
        `https://${AMOCRM_DOMAIN}/api/v4/leads/${task.entity_id}?with=contacts`;

      console.log(
        "amoCRM GET:",
        leadUrl
      );

      const leadResponse =
        await axios.get(
          leadUrl,
          {
            headers: {
              Authorization:
                `Bearer ${AMOCRM_ACCESS_TOKEN}`,

              Accept:
                "application/hal+json"
            },

            timeout: 30000
          }
        );

      const lead =
        leadResponse.data;

      // ====================================================
      // ИЩЕМ ПОЛЕ "ИНЖЕНЕР"
      // ====================================================

      const engineerField =
        (
          lead.custom_fields_values ||
          []
        ).find(
          field =>
            Number(field.field_id) ===
            Number(
              ENGINEER_FIELD_ID
            )
        );

      if (!engineerField) {

        console.log(
          "Сделка",
          lead.id,
          "не содержит поле Инженер"
        );

        continue;
      }

      const engineerValue =
        (
          engineerField.values ||
          []
        )[0];

      const enumId =
        engineerValue?.enum_id;

      const textValue =
        engineerValue?.value;

      console.log(
        "Инженер в сделке:",
        {
          lead_id:
            lead.id,

          enum_id:
            enumId,

          value:
            textValue
        }
      );

      // ====================================================
      // ПРОВЕРЯЕМ МАРИНУ
      // ====================================================

      const engineerMatches =
        Number(enumId) ===
        Number(
          ENGINEER_ENUM_ID
        );

      if (!engineerMatches) {

        console.log(
          "Инженер НЕ Марина — пропускаем сделку",
          lead.id
        );

        continue;
      }

      // ====================================================
      // ДАТА ЗАДАЧИ
      // ====================================================

      const completeTill =
        task.complete_till
          ? DateTime
              .fromSeconds(
                task.complete_till,
                {
                  zone: TIMEZONE
                }
              )
              .toFormat(
                "dd.MM.yyyy, HH:mm:ss"
              )
          : "";

      // ====================================================
      // ПОЛЯ СДЕЛКИ
      // ====================================================

      const fields =
        lead.custom_fields_values ||
        [];

      function getFieldValue(
        fieldId
      ) {

        const field =
          fields.find(
            item =>
              Number(item.field_id) ===
              Number(fieldId)
          );

        if (!field) {
          return "";
        }

        const value =
          field.values?.[0];

        return (
          value?.value ??
          value?.enum_id ??
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

      // ====================================================
      // КЛИЕНТ
      // ====================================================

      let clientName = "";

      try {

        const contact =
          lead._embedded
            ?.contacts?.[0];

        if (contact?.name) {
          clientName =
            contact.name;
        }

      } catch (e) {}

      // ====================================================
      // ДОБАВЛЯЕМ РЕЗУЛЬТАТ
      // ====================================================

      measurements.push({

        task_id:
          task.id,

        lead_id:
          lead.id,

        lead_name:
          lead.name ||
          `Сделка #${lead.id}`,

        engineer:
          ENGINEER_NAME,

        task_type_id:
          task.task_type_id,

        complete_till:
          completeTill,

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

        amo_url:
          `https://${AMOCRM_DOMAIN}/leads/detail/${lead.id}`
      });

    } catch (error) {

      console.error(
        "Ошибка получения сделки",
        task.entity_id,
        error.response?.status,
        error.response?.data ||
        error.message
      );
    }
  }

  console.log(
    "=========================================="
  );

  console.log(
    "ИТОГО ЗАМЕРОВ:",
    measurements.length
  );

  console.log(
    "=========================================="
  );

  return {

    status: "OK",

    timezone:
      TIMEZONE,

    current_moscow_time:
      now.toFormat(
        "dd.MM.yyyy, HH:mm:ss"
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
        yesterdayStart.toFormat(
          "dd.MM.yyyy, HH:mm:ss"
        ),

      to:
        now.toFormat(
          "dd.MM.yyyy, HH:mm:ss"
        )
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
// ФОРМИРОВАНИЕ СООБЩЕНИЯ О ЗАМЕРЕ
// ============================================================

function formatMeasurement(
  measurement
) {

  let text =
    `📐 Замер для подтверждения\n\n`;

  text +=
    `Сделка: ${
      measurement.lead_name ||
      "—"
    }\n`;

  text +=
    `Клиент: ${
      measurement.client_name ||
      "—"
    }\n`;

  text +=
    `№ договора: ${
      measurement.contract_number ||
      "—"
    }\n`;

  text +=
    `Дата замера: ${
      measurement.measure_date ||
      "—"
    }\n`;

  text +=
    `Время замера: ${
      measurement.measure_time ||
      "—"
    }\n`;

  text +=
    `Адрес: ${
      measurement.address ||
      "—"
    }\n`;

  text +=
    `Продукт: ${
      measurement.product ||
      "—"
    }\n`;

  text +=
    `Срок задачи: ${
      measurement.complete_till ||
      "—"
    }\n`;

  text +=
    `\nОткрыть сделку:\n${
      measurement.amo_url
    }`;

  return text;
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В AMOMESSENGER
// ============================================================

async function sendBotMessage({
  botId,
  requestId,
  receiverUserId,
  text,
  buttons
}) {

  if (!amoMessengerAccessToken) {

    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}/request/${requestId}/sendMessage`;

  const body = {

    text,

    receiver: {
      user_id:
        receiverUserId
    }
  };

  if (
    buttons &&
    buttons.length
  ) {

    body.reply_markup = {
      inline_keyboard: {
        buttons:
          buttons.map(
            button => ({
              text: button
            })
          )
      }
    };
  }

  console.log(
    "=========================================="
  );

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

  console.log(
    "amoMessenger POST:",
    url
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

        timeout: 30000
      }
    );

  console.log(
    "amoMessenger response:",
    response.status,
    response.data
  );

  return response.data;
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMOMESSENGER
// ============================================================

async function returnControl(
  botId,
  requestId
) {

  if (!amoMessengerAccessToken) {

    throw new Error(
      "Токен amoMessenger не найден"
    );
  }

  const url =
    `https://api.amo.tm/v1.3/bots/${botId}/request/${requestId}/returnControl`;

  console.log(
    "amoMessenger POST:",
    url
  );

  const response =
    await axios.post(
      url,
      {
        return_code:
          "success"
      },
      {
        headers: {
          Authorization:
            `Bearer ${amoMessengerAccessToken}`,

          "Content-Type":
            "application/json"
        },

        timeout: 30000,

        validateStatus:
          status =>
            status >= 200 &&
            status < 300
      }
    );

  console.log(
    "amoMessenger response:",
    response.status,
    response.data
  );

  return response.data;
}

// ============================================================
// ЗАПУСК
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "=========================================="
    );

    console.log(
      "СЕРВЕР ЗАПУЩЕН"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "AMOCRM DOMAIN:",
      AMOCRM_DOMAIN
    );

    console.log(
      "AMOCRM TOKEN:",
      AMOCRM_ACCESS_TOKEN
        ? "ЗАДАН"
        : "НЕ ЗАДАН"
    );

    console.log(
      "AMOMESSENGER TOKEN:",
      amoMessengerAccessToken
        ? "ЗАДАН"
        : "НЕ ЗАДАН"
    );

    console.log(
      "ENGINEER:",
      ENGINEER_NAME
    );

    console.log(
      "ENGINEER FIELD:",
      ENGINEER_FIELD_ID
    );

    console.log(
      "ENGINEER ENUM:",
      ENGINEER_ENUM_ID
    );

    console.log(
      "TASK TYPE:",
      MEASUREMENT_TASK_TYPE_ID
    );

    console.log(
      "TIMEZONE:",
      TIMEZONE
    );

    console.log(
      "=========================================="
    );
  }
);
