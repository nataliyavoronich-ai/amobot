const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL, URLSearchParams } = require("url");

/*
========================================================
 БОТ ИНЖЕНЕРОВ
 amoMessenger + amoCRM
========================================================

 ОСНОВНЫЕ НАСТРОЙКИ
--------------------------------------------------------
 amoCRM:
   Домен: zlmk.amocrm.ru
   Поле Инженер: 203849
   Марина Трафимова: enum_id 1059150
   Тип задачи "Подтв. замер": 2746005

 amoMessenger:
   OAuth:
   https://id.amo.tm/access

   Token:
   https://id.amo.tm/oauth2/access_token

   API:
   https://api.amo.tm

 Время:
   Europe/Moscow
========================================================
*/


// ======================================================
// НАСТРОЙКИ
// ======================================================

const PORT = process.env.PORT || 3000;

const AMOCRM_DOMAIN =
    process.env.AMOCRM_DOMAIN ||
    "zlmk.amocrm.ru";

const AMOCRM_TOKEN =
    process.env.AMOCRM_TOKEN ||
    process.env.AMOCRM_ACCESS_TOKEN ||
    "";

const AMOMESSENGER_CLIENT_ID =
    process.env.AMOMESSENGER_CLIENT_ID ||
    "";

const AMOMESSENGER_CLIENT_SECRET =
    process.env.AMOMESSENGER_CLIENT_SECRET ||
    "";

const AMOMESSENGER_REDIRECT_URI =
    process.env.AMOMESSENGER_REDIRECT_URI ||
    "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

const AMOMESSENGER_API =
    "https://api.amo.tm";

const AMOMESSENGER_ID =
    "https://id.amo.tm";


// ======================================================
// ДАННЫЕ БОТА
// ======================================================

const ENGINEER_NAME = "Марина Трафимова";

const ENGINEER_FIELD_ID = 203849;

const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;


// ======================================================
// ПОЛЯ СДЕЛКИ
// ======================================================

const FIELD_CONTRACT = 412776;
const FIELD_MEASURE_DATE = 175370;
const FIELD_MEASURE_TIME = 413828;
const FIELD_ADDRESS = 175412;
const FIELD_PRODUCT = 172572;


// ======================================================
// ЧАСОВОЙ ПОЯС
// ======================================================

const TIMEZONE = "Europe/Moscow";


// ======================================================
// ХРАНИЛИЩЕ OAUTH ТОКЕНОВ
//
// ВАЖНО:
// Render может очистить локальный файл после
// перезапуска/нового deploy.
//
// Поэтому после нового deploy при необходимости
// просто снова откройте /oauth/amomessenger
// и авторизуйте приложение.
// ======================================================

const TOKEN_FILE =
    process.env.AMOMESSENGER_TOKEN_FILE ||
    path.join(__dirname, "amomessenger_tokens.json");

let amomessengerTokens = null;


// ======================================================
// OAUTH STATE
// ======================================================

let oauthState = null;


// ======================================================
// ЗАГРУЗКА ТОКЕНА
// ======================================================

function loadTokens() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const raw = fs.readFileSync(TOKEN_FILE, "utf8");

            if (raw) {
                amomessengerTokens = JSON.parse(raw);

                console.log("==========================================");
                console.log("AMOMESSENGER TOKEN");
                console.log("Токен загружен из файла");
                console.log(
                    "Access Token:",
                    amomessengerTokens.access_token ? "ДА" : "НЕТ"
                );
                console.log(
                    "Refresh Token:",
                    amomessengerTokens.refresh_token ? "ДА" : "НЕТ"
                );
                console.log("==========================================");
            }
        }
    } catch (error) {
        console.error(
            "Ошибка загрузки amoMessenger token:",
            error.message
        );

        amomessengerTokens = null;
    }
}


function saveTokens(tokens) {
    amomessengerTokens = tokens;

    try {
        fs.writeFileSync(
            TOKEN_FILE,
            JSON.stringify(tokens, null, 2),
            "utf8"
        );

        console.log("amoMessenger токены сохранены.");
    } catch (error) {
        console.error(
            "Не удалось сохранить токены:",
            error.message
        );
    }
}


function clearTokens() {
    amomessengerTokens = null;

    try {
        if (fs.existsSync(TOKEN_FILE)) {
            fs.unlinkSync(TOKEN_FILE);
        }
    } catch (error) {
        console.error(
            "Ошибка удаления токена:",
            error.message
        );
    }
}


// ======================================================
// HTTP REQUEST HELPER
// ======================================================

function requestHttp(
    urlString,
    options = {},
    body = null
) {
    return new Promise((resolve, reject) => {

        const url = new URL(urlString);

        const isHttps = url.protocol === "https:";

        const transport = isHttps
            ? https
            : http;

        const requestOptions = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method || "GET",
            headers: options.headers || {},
        };

        const req = transport.request(
            requestOptions,
            (res) => {

                let data = "";

                res.on(
                    "data",
                    chunk => {
                        data += chunk;
                    }
                );

                res.on(
                    "end",
                    () => {

                        let parsed = data;

                        try {
                            parsed = data
                                ? JSON.parse(data)
                                : null;
                        } catch (_) {
                            // Не JSON — оставляем строкой
                        }

                        resolve({
                            status: res.statusCode,
                            headers: res.headers,
                            body: parsed,
                            raw: data,
                        });
                    }
                );
            }
        );

        req.on(
            "error",
            error => {
                reject(error);
            }
        );

        if (body) {
            req.write(body);
        }

        req.end();
    });
}


// ======================================================
// AMOMESSENGER OAUTH
// ======================================================

function getOAuthUrl() {

    if (!AMOMESSENGER_CLIENT_ID) {
        throw new Error(
            "AMOMESSENGER_CLIENT_ID не задан"
        );
    }

    oauthState =
        crypto.randomBytes(24).toString("hex");

    const params = new URLSearchParams();

    params.set(
        "client_id",
        AMOMESSENGER_CLIENT_ID
    );

    params.set(
        "redirect_uri",
        AMOMESSENGER_REDIRECT_URI
    );

    params.set(
        "response_type",
        "code"
    );

    params.set(
        "state",
        oauthState
    );

    return (
        AMOMESSENGER_ID +
        "/access?" +
        params.toString()
    );
}


// ======================================================
// ОБМЕН CODE НА TOKEN
// ======================================================

async function exchangeAuthorizationCode(code) {

    console.log("==========================================");
    console.log("OAUTH AMOMESSENGER");
    console.log("Обмениваем authorization code на token");
    console.log("Token URL:");
    console.log(
        AMOMESSENGER_ID +
        "/oauth2/access_token"
    );
    console.log("Redirect URI:");
    console.log(AMOMESSENGER_REDIRECT_URI);
    console.log("==========================================");


    if (!AMOMESSENGER_CLIENT_ID) {
        throw new Error(
            "AMOMESSENGER_CLIENT_ID не задан в Environment Variables"
        );
    }


    if (!AMOMESSENGER_CLIENT_SECRET) {
        throw new Error(
            "AMOMESSENGER_CLIENT_SECRET не задан в Environment Variables"
        );
    }


    const params = new URLSearchParams();

    params.set(
        "grant_type",
        "authorization_code"
    );

    params.set(
        "client_id",
        AMOMESSENGER_CLIENT_ID
    );

    params.set(
        "client_secret",
        AMOMESSENGER_CLIENT_SECRET
    );

    params.set(
        "redirect_uri",
        AMOMESSENGER_REDIRECT_URI
    );

    params.set(
        "code",
        code
    );


    const response =
        await requestHttp(
            AMOMESSENGER_ID +
            "/oauth2/access_token",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",

                    "Accept":
                        "application/json",

                    "Content-Length":
                        Buffer.byteLength(
                            params.toString()
                        ),
                },
            },

            params.toString()
        );


    console.log(
        "OAuth HTTP:",
        response.status
    );


    if (
        response.status < 200 ||
        response.status >= 300
    ) {

        console.error(
            "OAuth amoMessenger ERROR:",
            response.status,
            response.body
        );

        throw new Error(
            "OAuth amoMessenger HTTP " +
            response.status +
            ": " +
            JSON.stringify(response.body)
        );
    }


    if (
        !response.body ||
        !response.body.access_token
    ) {

        throw new Error(
            "amoMessenger не вернул access_token: " +
            JSON.stringify(response.body)
        );
    }


    const tokenData = {
        access_token:
            response.body.access_token,

        refresh_token:
            response.body.refresh_token || null,

        token_type:
            response.body.token_type || "Bearer",

        expires_in:
            response.body.expires_in ||
            response.body.expires ||
            null,

        created_at:
            Date.now(),

        expires_at:
            response.body.expires_in
                ? Date.now() +
                  Number(response.body.expires_in) * 1000
                : null,
    };


    saveTokens(tokenData);


    return tokenData;
}


// ======================================================
// REFRESH TOKEN
// ======================================================

async function refreshAmomessengerToken() {

    if (
        !amomessengerTokens ||
        !amomessengerTokens.refresh_token
    ) {

        throw new Error(
            "Refresh Token отсутствует. Требуется повторная OAuth авторизация."
        );
    }


    console.log(
        "Обновляем Access Token amoMessenger..."
    );


    const params = new URLSearchParams();

    params.set(
        "grant_type",
        "refresh_token"
    );

    params.set(
        "client_id",
        AMOMESSENGER_CLIENT_ID
    );

    params.set(
        "client_secret",
        AMOMESSENGER_CLIENT_SECRET
    );

    params.set(
        "refresh_token",
        amomessengerTokens.refresh_token
    );


    const response =
        await requestHttp(
            AMOMESSENGER_ID +
            "/oauth2/access_token",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",

                    "Accept":
                        "application/json",

                    "Content-Length":
                        Buffer.byteLength(
                            params.toString()
                        ),
                },
            },

            params.toString()
        );


    console.log(
        "Refresh HTTP:",
        response.status
    );


    if (
        response.status < 200 ||
        response.status >= 300
    ) {

        console.error(
            "Refresh Token ERROR:",
            response.status,
            response.body
        );

        clearTokens();

        throw new Error(
            "Не удалось обновить amoMessenger token"
        );
    }


    const newTokens = {
        access_token:
            response.body.access_token,

        refresh_token:
            response.body.refresh_token ||
            amomessengerTokens.refresh_token,

        token_type:
            response.body.token_type ||
            "Bearer",

        expires_in:
            response.body.expires_in ||
            response.body.expires ||
            null,

        created_at:
            Date.now(),

        expires_at:
            response.body.expires_in
                ? Date.now() +
                  Number(response.body.expires_in) * 1000
                : null,
    };


    saveTokens(newTokens);

    return newTokens;
}


// ======================================================
// ПОЛУЧЕНИЕ РАБОЧЕГО AMOMESSENGER TOKEN
// ======================================================

async function getAmomessengerToken() {

    if (
        !amomessengerTokens ||
        !amomessengerTokens.access_token
    ) {

        throw new Error(
            "Токен amoMessenger не найден. Откройте /oauth/amomessenger"
        );
    }


    // Если знаем срок действия и он закончился —
    // обновляем заранее.

    if (
        amomessengerTokens.expires_at &&
        Date.now() >
        amomessengerTokens.expires_at - 60000
    ) {

        try {
            await refreshAmomessengerToken();
        } catch (error) {

            console.error(
                "Автоматическое обновление токена не удалось:",
                error.message
            );

            throw error;
        }
    }


    return amomessengerTokens.access_token;
}


// ======================================================
// AMOMESSENGER API
// ======================================================

async function amoMessengerRequest(
    method,
    endpoint,
    body = null,
    retry = true
) {

    let token =
        await getAmomessengerToken();


    const bodyString =
        body !== null
            ? JSON.stringify(body)
            : null;


    const headers = {
        "Authorization":
            "Bearer " + token,

        "Accept":
            "application/json",
    };


    if (bodyString !== null) {

        headers["Content-Type"] =
            "application/json";

        headers["Content-Length"] =
            Buffer.byteLength(
                bodyString
            );
    }


    console.log(
        "amoMessenger",
        method,
        AMOMESSENGER_API + endpoint
    );


    const response =
        await requestHttp(
            AMOMESSENGER_API + endpoint,
            {
                method,
                headers,
            },
            bodyString
        );


    console.log(
        "amoMessenger response:",
        response.status,
        response.body
    );


    // Access Token протух.
    // Пытаемся обновить и повторить запрос.

    if (
        response.status === 401 &&
        retry
    ) {

        await refreshAmomessengerToken();

        return amoMessengerRequest(
            method,
            endpoint,
            body,
            false
        );
    }


    if (
        response.status < 200 ||
        response.status >= 300
    ) {

        throw new Error(
            "amoMessenger HTTP " +
            response.status +
            ": " +
            JSON.stringify(response.body)
        );
    }


    return response;
}


// ======================================================
// AMOCRM API
// ======================================================

async function amoCrmRequest(
    method,
    endpoint,
    body = null
) {

    if (!AMOCRM_TOKEN) {

        throw new Error(
            "AMOCRM_TOKEN не задан в Environment Variables"
        );
    }


    const bodyString =
        body !== null
            ? JSON.stringify(body)
            : null;


    const headers = {

        "Authorization":
            "Bearer " + AMOCRM_TOKEN,

        "Accept":
            "application/json",
    };


    if (bodyString !== null) {

        headers["Content-Type"] =
            "application/json";

        headers["Content-Length"] =
            Buffer.byteLength(
                bodyString
            );
    }


    const url =
        "https://" +
        AMOCRM_DOMAIN +
        endpoint;


    console.log(
        "amoCRM",
        method,
        url
    );


    const response =
        await requestHttp(
            url,
            {
                method,
                headers,
            },
            bodyString
        );


    console.log(
        "amoCRM response:",
        response.status
    );


    if (
        response.status < 200 ||
        response.status >= 300
    ) {

        throw new Error(
            "amoCRM HTTP " +
            response.status +
            ": " +
            JSON.stringify(response.body)
        );
    }


    return response.body;
}


// ======================================================
// МОСКОВСКОЕ ВРЕМЯ
// ======================================================

function getMoscowParts(date = new Date()) {

    const formatter =
        new Intl.DateTimeFormat(
            "ru-RU",
            {
                timeZone: TIMEZONE,

                year: "numeric",
                month: "2-digit",
                day: "2-digit",

                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",

                hourCycle: "h23",
            }
        );


    const parts =
        formatter.formatToParts(date);


    const result = {};


    for (const part of parts) {

        if (
            part.type !== "literal"
        ) {

            result[part.type] =
                part.value;
        }
    }


    return {
        year: Number(result.year),
        month: Number(result.month),
        day: Number(result.day),
        hour: Number(result.hour),
        minute: Number(result.minute),
        second: Number(result.second),
    };
}


// ======================================================
// СОЗДАНИЕ TIMESTAMP ДЛЯ МОСКВЫ
//
// Москва = UTC+3.
// ======================================================

function moscowTimestamp(
    year,
    month,
    day,
    hour,
    minute,
    second
) {

    return Math.floor(
        (
            Date.UTC(
                year,
                month - 1,
                day,
                hour,
                minute,
                second
            ) -
            3 * 60 * 60 * 1000
        ) / 1000
    );
}


// ======================================================
// ФОРМАТ ДАТЫ
// ======================================================

function formatMoscowDate(
    date = new Date()
) {

    const p =
        getMoscowParts(date);


    return (
        String(p.day).padStart(2, "0") +
        "." +
        String(p.month).padStart(2, "0") +
        "." +
        p.year +
        ", " +
        String(p.hour).padStart(2, "0") +
        ":" +
        String(p.minute).padStart(2, "0") +
        ":" +
        String(p.second).padStart(2, "0")
    );
}


// ======================================================
// ДИАПАЗОН ЗАДАЧ
//
// От вчера 00:00 Москвы
// до текущего времени, но не позже 18:00.
// ======================================================

function getTaskDateRange() {

    const now =
        new Date();

    const p =
        getMoscowParts(now);


    const toHour =
        p.hour >= 18
            ? 18
            : p.hour;


    const toMinute =
        p.hour >= 18
            ? 0
            : p.minute;


    const toSecond =
        p.hour >= 18
            ? 0
            : p.second;


    const currentDayStart =
        new Date(
            Date.UTC(
                p.year,
                p.month - 1,
                p.day
            )
        );


    const previousDay =
        new Date(
            currentDayStart.getTime() -
            24 * 60 * 60 * 1000
        );


    const previousYear =
        previousDay.getUTCFullYear();

    const previousMonth =
        previousDay.getUTCMonth() + 1;

    const previousDate =
        previousDay.getUTCDate();


    const from =
        moscowTimestamp(
            previousYear,
            previousMonth,
            previousDate,
            0,
            0,
            0
        );


    const to =
        moscowTimestamp(
            p.year,
            p.month,
            p.day,
            toHour,
            toMinute,
            toSecond
        );


    return {
        from,
        to,

        from_moscow:
            `${String(previousDate).padStart(2, "0")}.` +
            `${String(previousMonth).padStart(2, "0")}.` +
            `${previousYear}, 00:00:00`,

        to_moscow:
            `${String(p.day).padStart(2, "0")}.` +
            `${String(p.month).padStart(2, "0")}.` +
            `${p.year}, ` +
            `${String(toHour).padStart(2, "0")}:` +
            `${String(toMinute).padStart(2, "0")}:` +
            `${String(toSecond).padStart(2, "0")}`,
    };
}


// ======================================================
// ЗАГРУЗКА ВСЕХ ЗАДАЧ
// ======================================================

async function loadMeasurementTasks() {

    const range =
        getTaskDateRange();


    const allTasks = [];

    let page = 1;


    while (true) {

        const params =
            new URLSearchParams();


        params.set(
            "filter[entity_type]",
            "leads"
        );


        params.append(
            "filter[is_completed][]",
            "0"
        );


        params.append(
            "filter[task_type][]",
            String(
                MEASUREMENT_TASK_TYPE_ID
            )
        );


        params.set(
            "filter[complete_till][from]",
            String(range.from)
        );


        params.set(
            "filter[complete_till][to]",
            String(range.to)
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


        console.log(
            "=========================================="
        );

        console.log(
            "Запрос задач:"
        );

        console.log(
            params.toString()
        );


        const result =
            await amoCrmRequest(
                "GET",
                "/api/v4/tasks?" +
                params.toString()
            );


        const tasks =
            result &&
            result._embedded &&
            result._embedded.tasks
                ? result._embedded.tasks
                : [];


        console.log(
            `Страница задач ${page}: ${tasks.length}`
        );


        allTasks.push(
            ...tasks
        );


        if (
            tasks.length < 250
        ) {
            break;
        }


        page++;


        if (page > 20) {

            console.log(
                "Остановлено после 20 страниц задач."
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
        range,
    };
}


// ======================================================
// ПОЛУЧЕНИЕ ЗНАЧЕНИЯ CUSTOM FIELD
// ======================================================

function getCustomField(
    lead,
    fieldId
) {

    const fields =
        lead.custom_fields_values || [];


    const field =
        fields.find(
            item =>
                Number(item.field_id) ===
                Number(fieldId)
        );


    if (!field) {
        return null;
    }


    return field;
}


// ======================================================
// ПОЛУЧЕНИЕ ТЕКСТА CUSTOM FIELD
// ======================================================

function getCustomFieldText(
    lead,
    fieldId
) {

    const field =
        getCustomField(
            lead,
            fieldId
        );


    if (
        !field ||
        !field.values ||
        !field.values.length
    ) {
        return "";
    }


    const values =
        field.values;


    const result = [];


    for (const value of values) {

        if (
            value.value !== undefined &&
            value.value !== null
        ) {

            result.push(
                String(value.value)
            );

            continue;
        }


        if (
            value.enum_id !== undefined
        ) {

            result.push(
                String(value.enum_id)
            );
        }
    }


    return result.join(", ");
}


// ======================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ======================================================

function leadHasEngineer(
    lead
) {

    const field =
        getCustomField(
            lead,
            ENGINEER_FIELD_ID
        );


    if (!field) {
        return false;
    }


    if (
        !field.values ||
        !field.values.length
    ) {
        return false;
    }


    return field.values.some(
        value => {

            if (
                value.enum_id !== undefined &&
                Number(value.enum_id) ===
                Number(ENGINEER_ENUM_ID)
            ) {

                return true;
            }


            if (
                value.value &&
                String(value.value).trim() ===
                ENGINEER_NAME
            ) {

                return true;
            }


            return false;
        }
    );
}


// ======================================================
// КОНТАКТ КЛИЕНТА
// ======================================================

function getClientFromLead(
    lead
) {

    const contacts =
        lead &&
        lead._embedded &&
        lead._embedded.contacts
            ? lead._embedded.contacts
            : [];


    if (!contacts.length) {

        return {
            name: "",
            phone: "",
        };
    }


    const contact =
        contacts[0];


    let phone = "";


    const fields =
        contact.custom_fields_values ||
        [];


    for (const field of fields) {

        const code =
            String(
                field.field_code || ""
            ).toUpperCase();


        if (
            code === "PHONE" &&
            field.values &&
            field.values.length
        ) {

            phone =
                field.values
                    .map(
                        v => v.value
                    )
                    .filter(Boolean)
                    .join(", ");

            break;
        }
    }


    return {
        name:
            contact.name || "",

        phone,
    };
}


// ======================================================
// ПОЛУЧЕНИЕ СДЕЛКИ
// ======================================================

async function getLead(
    leadId
) {

    return amoCrmRequest(
        "GET",
        `/api/v4/leads/${leadId}?with=contacts`
    );
}


// ======================================================
// ПОИСК ЗАМЕРОВ
// ======================================================

async function findMeasurements() {

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


    const loaded =
        await loadMeasurementTasks();


    const tasks =
        loaded.tasks;


    const validTasks = [];


    for (const task of tasks) {

        if (
            !task.entity_id
        ) {

            continue;
        }


        if (
            String(task.entity_type) !==
            "leads"
        ) {

            continue;
        }


        if (
            Number(task.task_type_id) !==
            Number(MEASUREMENT_TASK_TYPE_ID)
        ) {

            continue;
        }


        if (
            task.is_completed !== false &&
            task.is_completed !== 0
        ) {

            continue;
        }


        validTasks.push(task);
    }


    console.log(
        "Найдено подходящих задач:",
        validTasks.length
    );


    const measurements = [];


    // Убираем дубли сделок.
    const uniqueLeadIds =
        [
            ...new Set(
                validTasks.map(
                    task =>
                        String(
                            task.entity_id
                        )
                )
            )
        ];


    for (const leadId of uniqueLeadIds) {

        try {

            console.log(
                "Получаем сделку:",
                leadId
            );


            const lead =
                await getLead(
                    leadId
                );


            if (!lead) {

                console.log(
                    "Сделка не получена:",
                    leadId
                );

                continue;
            }


            const engineerMatch =
                leadHasEngineer(
                    lead
                );


            console.log(
                "Сделка",
                leadId,
                "Инженер подходит:",
                engineerMatch
            );


            if (!engineerMatch) {

                continue;
            }


            const task =
                validTasks.find(
                    item =>
                        String(
                            item.entity_id
                        ) ===
                        String(leadId)
                );


            const client =
                getClientFromLead(
                    lead
                );


            const measurement = {

                task_id:
                    task
                        ? task.id
                        : null,

                lead_id:
                    lead.id,

                lead_name:
                    lead.name ||
                    `Сделка #${lead.id}`,

                contract_number:
                    getCustomFieldText(
                        lead,
                        FIELD_CONTRACT
                    ),

                measure_date:
                    getCustomFieldText(
                        lead,
                        FIELD_MEASURE_DATE
                    ),

                measure_time:
                    getCustomFieldText(
                        lead,
                        FIELD_MEASURE_TIME
                    ),

                address:
                    getCustomFieldText(
                        lead,
                        FIELD_ADDRESS
                    ),

                product:
                    getCustomFieldText(
                        lead,
                        FIELD_PRODUCT
                    ),

                client_name:
                    client.name,

                client_phone:
                    client.phone,

                complete_till:
                    task
                        ? task.complete_till
                        : null,

                complete_till_moscow:
                    task &&
                    task.complete_till
                        ? formatMoscowDate(
                            new Date(
                                Number(
                                    task.complete_till
                                ) * 1000
                            )
                        )
                        : "",

                lead_url:
                    `https://${AMOCRM_DOMAIN}/leads/detail/${lead.id}`,
            };


            measurements.push(
                measurement
            );

        } catch (error) {

            console.error(
                "Ошибка обработки сделки",
                leadId,
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
        tasks_loaded:
            tasks.length,

        valid_tasks:
            validTasks.length,

        found_count:
            measurements.length,

        measurements,

        range:
            loaded.range,
    };
}


// ======================================================
// ТЕКСТ ОДНОГО ЗАМЕРА
// ======================================================

function measurementToText(
    item,
    index
) {

    return (
        `📐 Замер ${index + 1}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +

        `🏠 Сделка: ${item.lead_name || "—"}\n` +

        `📄 № договора: ` +
        `${item.contract_number || "—"}\n` +

        `📅 Дата замера: ` +
        `${item.measure_date || "—"}\n` +

        `🕐 Время замера: ` +
        `${item.measure_time || "—"}\n` +

        `📍 Адрес: ` +
        `${item.address || "—"}\n` +

        `🧱 Продукт: ` +
        `${item.product || "—"}\n` +

        `👤 Клиент: ` +
        `${item.client_name || "—"}\n` +

        `📞 Телефон: ` +
        `${item.client_phone || "—"}\n` +

        `🔗 Сделка: ` +
        `${item.lead_url}\n`
    );
}


// ======================================================
// ОТПРАВКА СООБЩЕНИЯ В ЗАЯВКУ БОТА
// ======================================================

async function sendBotRequestMessage(
    botId,
    requestId,
    receiverUserId,
    text,
    buttons = null
) {

    const body = {

        text,

        receiver: {
            user_id:
                receiverUserId
        },
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
                            text: button,
                        })
                    ),
            },
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


    return amoMessengerRequest(
        "POST",
        `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
        body
    );
}


// ======================================================
// ВОЗВРАТ УПРАВЛЕНИЯ AMOMESSENGER
// ======================================================

async function returnControl(
    botId,
    requestId
) {

    try {

        console.log(
            "Возвращаем управление amoMessenger..."
        );


        await amoMessengerRequest(
            "POST",
            `/v1.3/bots/${botId}/request/${requestId}/returnControl`,
            {
                return_code:
                    "success",
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


// ======================================================
// ОБРАБОТКА НАЖАТИЯ "ПОДТВЕРДИТЬ ЗАМЕР"
// ======================================================

async function handleMeasurementRequest(
    botId,
    requestId,
    receiverUserId
) {

    // Сначала отправляем сообщение,
    // чтобы пользователь видел, что бот работает.

    try {

        await sendBotRequestMessage(
            botId,
            requestId,
            receiverUserId,

            "⏳ Проверяю задачи на подтверждение замера..."
        );

    } catch (error) {

        console.error(
            "Не удалось отправить сообщение о начале:",
            error.message
        );
    }


    try {

        const result =
            await findMeasurements();


        if (
            !result.measurements.length
        ) {

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "📋 Замеров для подтверждения не найдено."
            );

            return;
        }


        let text =
            `📋 Найдено замеров: ` +
            `${result.measurements.length}\n\n`;


        result.measurements.forEach(
            (item, index) => {

                text +=
                    measurementToText(
                        item,
                        index
                    ) +
                    "\n";
            }
        );


        await sendBotRequestMessage(
            botId,
            requestId,
            receiverUserId,
            text
        );


    } catch (error) {

        console.error(
            "Ошибка поиска замеров:",
            error
        );


        try {

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "❌ Произошла ошибка при проверке задач.\n\n" +
                error.message
            );

        } catch (sendError) {

            console.error(
                "Не удалось отправить ошибку:",
                sendError.message
            );
        }

    } finally {

        await returnControl(
            botId,
            requestId
        );
    }
}


// ======================================================
// PARSE REQUEST BODY
// ======================================================

function parseRequestBody(
    req,
    rawBody
) {

    const contentType =
        String(
            req.headers["content-type"] ||
            ""
        );


    if (
        contentType.includes(
            "application/json"
        )
    ) {

        try {

            return rawBody
                ? JSON.parse(rawBody)
                : {};

        } catch (error) {

            return {
                _parse_error:
                    error.message,

                raw:
                    rawBody,
            };
        }
    }


    if (
        contentType.includes(
            "application/x-www-form-urlencoded"
        )
    ) {

        const params =
            new URLSearchParams(
                rawBody
            );


        const result = {};


        for (
            const [key, value]
            of params.entries()
        ) {

            result[key] =
                value;
        }


        // input_values приходит JSON-строкой.
        if (
            result.input_values
        ) {

            try {

                result.input_values =
                    JSON.parse(
                        result.input_values
                    );

            } catch (_) {
                // Оставляем строкой.
            }
        }


        return result;
    }


    return {
        raw:
            rawBody,
    };
}


// ======================================================
// WEBHOOK AMOMESSENGER
// ======================================================

async function handleAmomessengerWebhook(
    body
) {

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


    const eventType =
        body.event_type;


    // --------------------------------------------------
    // УДАЛЕНИЕ ПРИЛОЖЕНИЯ
    // --------------------------------------------------

    if (
        eventType === "app.deleted" ||
        eventType === "app_uninstalled"
    ) {

        console.log(
            "AMOMESSENGER APP DELETED"
        );


        clearTokens();


        return;
    }


    // --------------------------------------------------
    // ПЕРЕДАЧА УПРАВЛЕНИЯ ВИДЖЕТУ
    // --------------------------------------------------

    if (
        eventType ===
        "rpa_bot_control_transferred"
    ) {

        const data =
            body &&
            body._embedded &&
            body._embedded
                .rpa_bot_control_transferred;


        if (!data) {

            console.log(
                "Данные rpa_bot_control_transferred отсутствуют"
            );

            return;
        }


        const context =
            data._embedded &&
            data._embedded.context
                ? data._embedded.context
                : {};


        const request =
            data._embedded &&
            data._embedded.request
                ? data._embedded.request
                : {};


        const botId =
            data.bot_id;


        const requestId =
            request.id;


        // Очень важно:
        // в ваших предыдущих рабочих логах
        // сообщение успешно отправлялось
        // request.author_id.

        const receiverUserId =
            request.author_id ||
            context.user_id;


        console.log(
            "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ"
        );


        console.log(
            JSON.stringify(
                {
                    botId,
                    requestId,
                    receiverUserId,
                    contextUserId:
                        context.user_id,
                    requestAuthorId:
                        request.author_id,
                },
                null,
                2
            )
        );


        // Не выполняем поиск сразу.
        //
        // Управление уже передано виджету,
        // поэтому здесь просто подтверждаем,
        // что виджет получил управление.

        try {

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "Выберите задачу для выполнения:",

                [
                    "Подтвердить замер",
                    "Провести замер",
                    "Загрузить фотоотчет",
                    "Внести правки",
                ]
            );

        } catch (error) {

            console.error(
                "Не удалось отправить меню:",
                error.message
            );
        }


        return;
    }


    // --------------------------------------------------
    // ВХОДЯЩЕЕ СООБЩЕНИЕ В ЗАЯВКЕ БОТА
    // --------------------------------------------------

    if (
        eventType ===
        "rpa_bot_income_message"
    ) {

        const data =
            body &&
            body._embedded &&
            body._embedded
                .rpa_bot_income_message;


        if (!data) {

            console.log(
                "Данные rpa_bot_income_message отсутствуют"
            );

            return;
        }


        const context =
            data._embedded &&
            data._embedded.context
                ? data._embedded.context
                : {};


        const incomeMessage =
            data._embedded &&
            data._embedded.income_message
                ? data._embedded.income_message
                : {};


        const request =
            data._embedded &&
            data._embedded.request
                ? data._embedded.request
                : {};


        const botId =
            data.bot_id;


        const requestId =
            request.id;


        const text =
            String(
                incomeMessage.text ||
                ""
            ).trim();


        const receiverUserId =
            request.author_id ||
            incomeMessage.author &&
            incomeMessage.author.user_id ||
            context.user_id;


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


        // ----------------------------------------------
        // ПОДТВЕРДИТЬ ЗАМЕР
        // ----------------------------------------------

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


            await handleMeasurementRequest(
                botId,
                requestId,
                receiverUserId
            );


            return;
        }


        // ----------------------------------------------
        // ДРУГИЕ КНОПКИ
        // ----------------------------------------------

        if (
            text ===
            "Провести замер"
        ) {

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "Функция «Провести замер» пока не настроена."
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

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "Функция «Загрузить фотоотчет» пока не настроена."
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

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "Функция «Внести правки» пока не настроена."
            );


            await returnControl(
                botId,
                requestId
            );


            return;
        }


        // ----------------------------------------------
        // НЕИЗВЕСТНОЕ СООБЩЕНИЕ
        // ----------------------------------------------

        console.log(
            "Неизвестная команда:",
            text
        );


        try {

            await sendBotRequestMessage(
                botId,
                requestId,
                receiverUserId,

                "Пожалуйста, выберите одну из кнопок."
            );

        } catch (error) {

            console.error(
                "Ошибка отправки:",
                error.message
            );
        }


        return;
    }


    // --------------------------------------------------
    // СТАРЫЙ ФОРМАТ income_message
    // --------------------------------------------------

    if (
        eventType ===
        "income_message"
    ) {

        console.log(
            "Обычное входящее сообщение:"
        );


        const message =
            body &&
            body._embedded &&
            body._embedded.message
                ? body._embedded.message
                : {};


        console.log(
            message.text || ""
        );


        return;
    }


    console.log(
        "Событие обработано без специального действия:",
        eventType
    );
}


// ======================================================
// DEBUG TASKS
// ======================================================

async function debugTasksTest() {

    if (!AMOCRM_TOKEN) {

        return {
            status:
                "Ошибка",

            message:
                "AMOCRM_TOKEN не задан в Environment Variables",
        };
    }


    const range =
        getTaskDateRange();


    const loaded =
        await loadMeasurementTasks();


    const tasks =
        loaded.tasks;


    const result = {

        status:
            "OK",

        timezone:
            TIMEZONE,

        current_moscow_time:
            formatMoscowDate(),

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
                range.from_moscow,

            to:
                range.to_moscow,
        },

        tasks_loaded:
            tasks.length,

        valid_tasks:
            0,

        found_count:
            0,

        measurements:
            [],
    };


    for (const task of tasks) {

        if (
            Number(task.task_type_id) !==
            Number(MEASUREMENT_TASK_TYPE_ID)
        ) {
            continue;
        }


        if (
            task.is_completed !== false &&
            task.is_completed !== 0
        ) {
            continue;
        }


        if (
            String(task.entity_type) !==
            "leads"
        ) {
            continue;
        }


        result.valid_tasks++;


        try {

            const lead =
                await getLead(
                    task.entity_id
                );


            if (
                !lead
            ) {
                continue;
            }


            const engineerMatch =
                leadHasEngineer(
                    lead
                );


            if (
                !engineerMatch
            ) {
                continue;
            }


            const client =
                getClientFromLead(
                    lead
                );


            result.measurements.push({

                task_id:
                    task.id,

                entity_id:
                    task.entity_id,

                lead_name:
                    lead.name ||
                    `Сделка #${lead.id}`,

                engineer_match:
                    true,

                complete_till:
                    task.complete_till,

                complete_till_moscow:
                    task.complete_till
                        ? formatMoscowDate(
                            new Date(
                                Number(
                                    task.complete_till
                                ) * 1000
                            )
                        )
                        : "",

                contract_number:
                    getCustomFieldText(
                        lead,
                        FIELD_CONTRACT
                    ),

                measure_date:
                    getCustomFieldText(
                        lead,
                        FIELD_MEASURE_DATE
                    ),

                measure_time:
                    getCustomFieldText(
                        lead,
                        FIELD_MEASURE_TIME
                    ),

                address:
                    getCustomFieldText(
                        lead,
                        FIELD_ADDRESS
                    ),

                product:
                    getCustomFieldText(
                        lead,
                        FIELD_PRODUCT
                    ),

                client_name:
                    client.name,

                client_phone:
                    client.phone,
            });


        } catch (error) {

            console.error(
                "DEBUG task error:",
                error.message
            );
        }
    }


    result.found_count =
        result.measurements.length;


    return result;
}


// ======================================================
// HTTP SERVER
// ======================================================

const server =
    http.createServer(
        async (req, res) => {

            try {

                // --------------------------------------
                // CORS
                // --------------------------------------

                res.setHeader(
                    "Access-Control-Allow-Origin",
                    "*"
                );


                res.setHeader(
                    "Access-Control-Allow-Headers",
                    "Content-Type, Authorization"
                );


                // --------------------------------------
                // GET /
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url === "/"
                ) {

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "text/html; charset=utf-8",
                        }
                    );


                    res.end(
                        `
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <title>Бот инженеров</title>
                        </head>
                        <body style="font-family:Arial;padding:40px">
                            <h1>Отчёт инженеров</h1>

                            <p>
                                Сервер работает.
                            </p>

                            <p>
                                <a href="/oauth/amomessenger">
                                    Авторизовать amoMessenger
                                </a>
                            </p>

                            <p>
                                <a href="/debug/amomessenger-token">
                                    Проверить токен amoMessenger
                                </a>
                            </p>

                            <p>
                                <a href="/debug/tasks-test">
                                    Проверить задачи amoCRM
                                </a>
                            </p>

                            <p>
                                <a href="/health">
                                    Проверить сервер
                                </a>
                            </p>
                        </body>
                        </html>
                        `
                    );

                    return;
                }


                // --------------------------------------
                // HEALTH
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url === "/health"
                ) {

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "application/json; charset=utf-8",
                        }
                    );


                    res.end(
                        JSON.stringify(
                            {
                                status:
                                    "OK",

                                server:
                                    "amobot-cpck",

                                timezone:
                                    TIMEZONE,

                                time:
                                    formatMoscowDate(),
                            },
                            null,
                            2
                        )
                    );

                    return;
                }


                // --------------------------------------
                // OAUTH START
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url === "/oauth/amomessenger"
                ) {

                    try {

                        const url =
                            getOAuthUrl();


                        console.log(
                            "OAuth URL:",
                            url
                        );


                        res.writeHead(
                            302,
                            {
                                Location:
                                    url,
                            }
                        );


                        res.end();


                    } catch (error) {

                        res.writeHead(
                            500,
                            {
                                "Content-Type":
                                    "application/json; charset=utf-8",
                            }
                        );


                        res.end(
                            JSON.stringify(
                                {
                                    status:
                                        "Ошибка OAuth",

                                    message:
                                        error.message,
                                },
                                null,
                                2
                            )
                        );
                    }


                    return;
                }


                // --------------------------------------
                // OAUTH CALLBACK
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url.startsWith(
                        "/oauth/amomessenger/callback"
                    )
                ) {

                    const requestUrl =
                        new URL(
                            req.url,
                            "https://" +
                            (
                                req.headers.host ||
                                "amobot-cpck.onrender.com"
                            )
                        );


                    const code =
                        requestUrl.searchParams.get(
                            "code"
                        );


                    const state =
                        requestUrl.searchParams.get(
                            "state"
                        );


                    const error =
                        requestUrl.searchParams.get(
                            "error"
                        );


                    console.log(
                        "=========================================="
                    );

                    console.log(
                        "OAUTH CALLBACK"
                    );

                    console.log(
                        "code:",
                        code
                            ? "ПОЛУЧЕН"
                            : "НЕТ"
                    );

                    console.log(
                        "state:",
                        state
                            ? "ПОЛУЧЕН"
                            : "НЕТ"
                    );

                    console.log(
                        "error:",
                        error || "нет"
                    );

                    console.log(
                        "=========================================="
                    );


                    if (error) {

                        res.writeHead(
                            400,
                            {
                                "Content-Type":
                                    "text/html; charset=utf-8",
                            }
                        );


                        res.end(
                            `
                            <html>
                            <meta charset="utf-8">

                            <body style="font-family:Arial;padding:40px">

                            <h2>Ошибка OAuth</h2>

                            <pre>${escapeHtml(
                                error
                            )}</pre>

                            </body>
                            </html>
                            `
                        );

                        return;
                    }


                    if (!code) {

                        res.writeHead(
                            400,
                            {
                                "Content-Type":
                                    "text/html; charset=utf-8",
                            }
                        );


                        res.end(
                            `
                            <html>
                            <meta charset="utf-8">

                            <body style="font-family:Arial;padding:40px">

                            <h2>Ошибка OAuth</h2>

                            <p>
                                Код авторизации не получен.
                            </p>

                            </body>
                            </html>
                            `
                        );

                        return;
                    }


                    /*
                     * Если state был создан нашим сервером,
                     * проверяем его.
                     *
                     * Но если Render перезапустился между
                     * началом OAuth и callback, state может
                     * исчезнуть. В таком случае не блокируем
                     * авторизацию — главное получить токен.
                     */

                    if (
                        oauthState &&
                        state &&
                        oauthState !== state
                    ) {

                        console.error(
                            "OAuth state отличается."
                        );


                        res.writeHead(
                            400,
                            {
                                "Content-Type":
                                    "text/html; charset=utf-8",
                            }
                        );


                        res.end(
                            `
                            <html>
                            <meta charset="utf-8">

                            <body style="font-family:Arial;padding:40px">

                            <h2>Ошибка OAuth</h2>

                            <p>
                                Некорректный OAuth state.
                            </p>

                            <p>
                                Запустите авторизацию заново.
                            </p>

                            </body>
                            </html>
                            `
                        );

                        return;
                    }


                    try {

                        const tokens =
                            await exchangeAuthorizationCode(
                                code
                            );


                        // Проверяем полученный токен.

                        let validation =
                            null;


                        try {

                            const validationResponse =
                                await requestHttp(
                                    AMOMESSENGER_ID +
                                    "/oauth2/validate",
                                    {
                                        method:
                                            "GET",

                                        headers: {
                                            "Authorization":
                                                "Bearer " +
                                                tokens.access_token,

                                            "Accept":
                                                "application/json",
                                        },
                                    }
                                );


                            validation =
                                validationResponse.body;


                            console.log(
                                "OAuth validate:",
                                validationResponse.status,
                                validation
                            );

                        } catch (validationError) {

                            console.error(
                                "OAuth validate error:",
                                validationError.message
                            );
                        }


                        res.writeHead(
                            200,
                            {
                                "Content-Type":
                                    "text/html; charset=utf-8",
                            }
                        );


                        res.end(
                            `
                            <html>
                            <head>
                                <meta charset="utf-8">
                                <title>OAuth успешно</title>
                            </head>

                            <body style="font-family:Arial;padding:40px">

                                <h2>
                                    Авторизация amoMessenger успешно выполнена
                                </h2>

                                <p>
                                    <b>Access Token:</b> ДА
                                </p>

                                <p>
                                    <b>Refresh Token:</b>
                                    ${
                                        tokens.refresh_token
                                            ? "ДА"
                                            : "НЕТ"
                                    }
                                </p>

                                ${
                                    validation
                                        ? `
                                        <hr>

                                        <h3>
                                            Контекст авторизации
                                        </h3>

                                        <p>
                                            User ID:
                                            ${
                                                validation.user_uuid ||
                                                "—"
                                            }
                                        </p>

                                        <p>
                                            Company ID:
                                            ${
                                                validation.company_uuid ||
                                                "—"
                                            }
                                        </p>

                                        <p>
                                            Client ID:
                                            ${
                                                validation.client_uuid ||
                                                "—"
                                            }
                                        </p>
                                        `
                                        : ""
                                }

                                <hr>

                                <p>
                                    Теперь можно закрыть это окно
                                    и снова запустить бота.
                                </p>

                            </body>
                            </html>
                            `
                        );


                    } catch (error) {

                        console.error(
                            "OAuth amoMessenger ERROR:",
                            error
                        );


                        res.writeHead(
                            500,
                            {
                                "Content-Type":
                                    "text/html; charset=utf-8",
                            }
                        );


                        res.end(
                            `
                            <html>
                            <head>
                                <meta charset="utf-8">
                                <title>Ошибка OAuth</title>
                            </head>

                            <body style="font-family:Arial;padding:40px">

                                <h2>
                                    Ошибка авторизации amoMessenger
                                </h2>

                                <pre style="white-space:pre-wrap">
${escapeHtml(
    error.message
)}
                                </pre>

                                <hr>

                                <p>
                                    Redirect URI:
                                </p>

                                <pre>${escapeHtml(
                                    AMOMESSENGER_REDIRECT_URI
                                )}</pre>

                                <p>
                                    Token endpoint:
                                </p>

                                <pre>${escapeHtml(
                                    AMOMESSENGER_ID +
                                    "/oauth2/access_token"
                                )}</pre>

                            </body>
                            </html>
                            `
                        );
                    }


                    return;
                }


                // --------------------------------------
                // DEBUG TOKEN
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url ===
                        "/debug/amomessenger-token"
                ) {

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "application/json; charset=utf-8",
                        }
                    );


                    res.end(
                        JSON.stringify(
                            {
                                status:
                                    amomessengerTokens &&
                                    amomessengerTokens.access_token
                                        ? "OK"
                                        : "Токен не найден",

                                access_token:
                                    amomessengerTokens &&
                                    amomessengerTokens.access_token
                                        ? "ДА"
                                        : "НЕТ",

                                refresh_token:
                                    amomessengerTokens &&
                                    amomessengerTokens.refresh_token
                                        ? "ДА"
                                        : "НЕТ",

                                token_file:
                                    TOKEN_FILE,

                                client_id:
                                    AMOMESSENGER_CLIENT_ID
                                        ? "ЗАДАН"
                                        : "НЕТ",

                                client_secret:
                                    AMOMESSENGER_CLIENT_SECRET
                                        ? "ЗАДАН"
                                        : "НЕТ",

                                redirect_uri:
                                    AMOMESSENGER_REDIRECT_URI,
                            },
                            null,
                            2
                        )
                    );

                    return;
                }


                // --------------------------------------
                // DEBUG TASKS
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url ===
                        "/debug/tasks-test"
                ) {

                    try {

                        const result =
                            await debugTasksTest();


                        res.writeHead(
                            200,
                            {
                                "Content-Type":
                                    "application/json; charset=utf-8",
                            }
                        );


                        res.end(
                            JSON.stringify(
                                result,
                                null,
                                2
                            )
                        );


                    } catch (error) {

                        res.writeHead(
                            500,
                            {
                                "Content-Type":
                                    "application/json; charset=utf-8",
                            }
                        );


                        res.end(
                            JSON.stringify(
                                {
                                    status:
                                        "Ошибка",

                                    message:
                                        error.message,

                                    stack:
                                        error.stack,
                                },
                                null,
                                2
                            )
                        );
                    }


                    return;
                }


                // --------------------------------------
                // DEBUG ENGINEER
                // --------------------------------------

                if (
                    req.method === "GET" &&
                    req.url ===
                        "/debug/engineer"
                ) {

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "application/json; charset=utf-8",
                        }
                    );


                    res.end(
                        JSON.stringify(
                            {
                                status:
                                    "OK",

                                engineer:
                                    ENGINEER_NAME,

                                field_id:
                                    ENGINEER_FIELD_ID,

                                enum_id:
                                    ENGINEER_ENUM_ID,

                                task_type_id:
                                    MEASUREMENT_TASK_TYPE_ID,

                                timezone:
                                    TIMEZONE,
                            },
                            null,
                            2
                        )
                    );

                    return;
                }


                // --------------------------------------
                // WEBHOOK
                // --------------------------------------

                if (
                    req.method === "POST" &&
                    (
                        req.url ===
                            "/amomessenger/webhook" ||

                        req.url ===
                            "/webhook" ||

                        req.url ===
                            "/oauth/amomessenger/webhook"
                    )
                ) {

                    let rawBody = "";


                    req.on(
                        "data",
                        chunk => {

                            rawBody +=
                                chunk.toString();
                        }
                    );


                    req.on(
                        "end",
                        async () => {

                            try {

                                const body =
                                    parseRequestBody(
                                        req,
                                        rawBody
                                    );


                                await handleAmomessengerWebhook(
                                    body
                                );


                                res.writeHead(
                                    200,
                                    {
                                        "Content-Type":
                                            "application/json; charset=utf-8",
                                    }
                                );


                                res.end(
                                    JSON.stringify(
                                        {
                                            status:
                                                "OK",
                                        }
                                    )
                                );


                            } catch (error) {

                                console.error(
                                    "WEBHOOK ERROR:",
                                    error
                                );


                                // Важно:
                                // amo должен получить HTTP 200,
                                // иначе webhook будет считаться
                                // неуспешным.

                                res.writeHead(
                                    200,
                                    {
                                        "Content-Type":
                                            "application/json; charset=utf-8",
                                    }
                                );


                                res.end(
                                    JSON.stringify(
                                        {
                                            status:
                                                "ERROR",

                                            message:
                                                error.message,
                                        }
                                    )
                                );
                            }
                        }
                    );


                    return;
                }


                // --------------------------------------
                // WIDGET POST
                // --------------------------------------

                if (
                    req.method === "POST" &&
                    (
                        req.url === "/" ||
                        req.url === "/widget"
                    )
                ) {

                    let rawBody = "";


                    req.on(
                        "data",
                        chunk => {

                            rawBody +=
                                chunk.toString();
                        }
                    );


                    req.on(
                        "end",
                        () => {

                            const body =
                                parseRequestBody(
                                    req,
                                    rawBody
                                );


                            console.log(
                                "=========================================="
                            );

                            console.log(
                                "AMOMESSENGER POST /"
                            );

                            console.log(
                                "BODY:"
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


                            res.writeHead(
                                200,
                                {
                                    "Content-Type":
                                        "application/json; charset=utf-8",
                                }
                            );


                            res.end(
                                JSON.stringify(
                                    {
                                        status:
                                            "OK",

                                        message:
                                            "POST / получен",

                                        body,
                                    },
                                    null,
                                    2
                                )
                            );
                        }
                    );


                    return;
                }


                // --------------------------------------
                // 404
                // --------------------------------------

                res.writeHead(
                    404,
                    {
                        "Content-Type":
                            "application/json; charset=utf-8",
                    }
                );


                res.end(
                    JSON.stringify(
                        {
                            status:
                                "404",

                            message:
                                "Страница не найдена",
                        }
                    )
                );


            } catch (error) {

                console.error(
                    "SERVER ERROR:",
                    error
                );


                if (!res.headersSent) {

                    res.writeHead(
                        500,
                        {
                            "Content-Type":
                                "application/json; charset=utf-8",
                        }
                    );


                    res.end(
                        JSON.stringify(
                            {
                                status:
                                    "Ошибка",

                                message:
                                    error.message,
                            }
                        )
                    );
                }
            }
        }
    );


// ======================================================
// HTML ESCAPE
// ======================================================

function escapeHtml(
    value
) {

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}


// ======================================================
// START
// ======================================================

loadTokens();


server.listen(
    PORT,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            "БОТ ИНЖЕНЕРОВ ЗАПУЩЕН"
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
            "TIMEZONE:",
            TIMEZONE
        );

        console.log(
            "AMOCRM_TOKEN:",
            AMOCRM_TOKEN
                ? "ЗАДАН"
                : "НЕТ"
        );

        console.log(
            "AMOMESSENGER_CLIENT_ID:",
            AMOMESSENGER_CLIENT_ID
                ? "ЗАДАН"
                : "НЕТ"
        );

        console.log(
            "AMOMESSENGER_CLIENT_SECRET:",
            AMOMESSENGER_CLIENT_SECRET
                ? "ЗАДАН"
                : "НЕТ"
        );

        console.log(
            "AMOMESSENGER_REDIRECT_URI:",
            AMOMESSENGER_REDIRECT_URI
        );

        console.log(
            "AMOMESSENGER TOKEN:",
            amomessengerTokens &&
            amomessengerTokens.access_token
                ? "ЕСТЬ"
                : "НЕТ"
        );

        console.log(
            "=========================================="
        );
    }
);
