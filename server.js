const express = require("express");
const axios = require("axios");
const qs = require("querystring");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// НАСТРОЙКИ
// ============================================================

const AMOCRM_SUBDOMAIN = "zlmk";
const AMOCRM_BASE_URL = "https://zlmk.amocrm.ru";

const AMOMESSENGER_API = "https://api.amo.tm";

const ENGINEER_NAME = "Марина Трафимова";
const ENGINEER_FIELD_ID = 203849;
const ENGINEER_ENUM_ID = 1059150;

const MEASUREMENT_TASK_TYPE_ID = 2746005;

const TIMEZONE = "Europe/Moscow";

// ============================================================
// ENV
// ============================================================

const AMOCRM_ACCESS_TOKEN =
    process.env.AMOCRM_ACCESS_TOKEN || "";

const AMOMESSENGER_ACCESS_TOKEN =
    process.env.AMOMESSENGER_ACCESS_TOKEN || "";

const AMOMESSENGER_CLIENT_ID =
    process.env.AMOMESSENGER_CLIENT_ID || "";

const AMOMESSENGER_CLIENT_SECRET =
    process.env.AMOMESSENGER_CLIENT_SECRET || "";

const AMOMESSENGER_REDIRECT_URI =
    process.env.AMOMESSENGER_REDIRECT_URI ||
    "https://amobot-cpck.onrender.com/oauth/amomessenger/callback";

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({
    limit: "2mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "2mb"
}));

// ============================================================
// ПАМЯТЬ ТОКЕНА AMOMESSENGER
// ============================================================

let messengerToken = AMOMESSENGER_ACCESS_TOKEN || null;
let messengerRefreshToken = process.env.AMOMESSENGER_REFRESH_TOKEN || null;

// ============================================================
// ЛОГ
// ============================================================

function log(title, data) {
    console.log("");
    console.log("==========================================");
    console.log(title);

    if (data !== undefined) {
        if (typeof data === "string") {
            console.log(data);
        } else {
            console.log(
                JSON.stringify(data, null, 2)
            );
        }
    }

    console.log("==========================================");
}

// ============================================================
// ПРОВЕРКА TOKENS
// ============================================================

function getMessengerToken() {
    return messengerToken || process.env.AMOMESSENGER_ACCESS_TOKEN || null;
}

// ============================================================
// ВРЕМЯ МОСКВЫ
// ============================================================

function getMoscowDateParts() {

    const now = new Date();

    const formatter = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23"
        }
    );

    const parts = formatter.formatToParts(now);

    const result = {};

    for (const part of parts) {
        if (part.type !== "literal") {
            result[part.type] = part.value;
        }
    }

    return {
        year: Number(result.year),
        month: Number(result.month),
        day: Number(result.day),
        hour: Number(result.hour),
        minute: Number(result.minute),
        second: Number(result.second)
    };
}

// ============================================================
// UNIX TIMESTAMP ДЛЯ МОСКОВСКОГО ВРЕМЕНИ
// ============================================================

function moscowToUnix(
    year,
    month,
    day,
    hour = 0,
    minute = 0,
    second = 0
) {

    // Москва = UTC+3
    const utcMs = Date.UTC(
        year,
        month - 1,
        day,
        hour - 3,
        minute,
        second
    );

    return Math.floor(utcMs / 1000);
}

// ============================================================
// НАЧАЛО СУТОК В МОСКВЕ
// ============================================================

function getMoscowDayStartUnix() {

    const now = getMoscowDateParts();

    return moscowToUnix(
        now.year,
        now.month,
        now.day,
        0,
        0,
        0
    );
}

// ============================================================
// ВЧЕРАШНИЕ СУТКИ + СЕГОДНЯ ДО ТЕКУЩЕГО МОМЕНТА
// ============================================================

function getTaskDateRange() {

    const now = getMoscowDateParts();

    const todayStart = moscowToUnix(
        now.year,
        now.month,
        now.day,
        0,
        0,
        0
    );

    // 24 часа назад
    const from = todayStart - 24 * 60 * 60;

    const to = moscowToUnix(
        now.year,
        now.month,
        now.day,
        now.hour,
        now.minute,
        now.second
    );

    return {
        from,
        to
    };
}

// ============================================================
// ФОРМАТ ДАТЫ
// ============================================================

function formatMoscow(unix) {

    if (!unix) {
        return "";
    }

    const date = new Date(Number(unix) * 1000);

    return new Intl.DateTimeFormat(
        "ru-RU",
        {
            timeZone: TIMEZONE,
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }
    ).format(date);
}

// ============================================================
// ЗНАЧЕНИЕ ПОЛЯ СДЕЛКИ
// ============================================================

function getLeadField(
    lead,
    fieldId
) {

    const fields =
        lead.custom_fields_values || [];

    const field = fields.find(
        item =>
            Number(item.field_id) ===
            Number(fieldId)
    );

    if (!field) {
        return null;
    }

    if (!field.values || !field.values.length) {
        return null;
    }

    return field.values[0];
}

// ============================================================
// ПОЛУЧЕНИЕ ТЕКСТОВОГО ЗНАЧЕНИЯ ПОЛЯ
// ============================================================

function getFieldText(
    lead,
    fieldId
) {

    const value =
        getLeadField(
            lead,
            fieldId
        );

    if (!value) {
        return "";
    }

    if (value.value === undefined ||
        value.value === null) {
        return "";
    }

    return String(value.value);
}

// ============================================================
// ПРОВЕРКА ИНЖЕНЕРА
// ============================================================

function isMarinaLead(lead) {

    const fields =
        lead.custom_fields_values || [];

    const field = fields.find(
        item =>
            Number(item.field_id) ===
            ENGINEER_FIELD_ID
    );

    if (!field) {
        return false;
    }

    const values =
        field.values || [];

    return values.some(
        value =>
            Number(value.enum_id) ===
            ENGINEER_ENUM_ID
    );
}

// ============================================================
// AMOCRM GET
// ============================================================

async function amoCrmGet(
    path,
    params = {}
) {

    if (!AMOCRM_ACCESS_TOKEN) {

        throw new Error(
            "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
        );
    }

    const url =
        `${AMOCRM_BASE_URL}${path}`;

    console.log(
        "amoCRM GET:",
        url,
        params
    );

    try {

        const response =
            await axios.get(
                url,
                {
                    params,
                    headers: {
                        Authorization:
                            `Bearer ${AMOCRM_ACCESS_TOKEN}`,
                        Accept:
                            "application/hal+json"
                    },
                    timeout: 25000
                }
            );

        return response.data;

    } catch (error) {

        console.error(
            "amoCRM ERROR:",
            error.response?.status,
            error.response?.data ||
            error.message
        );

        throw error;
    }
}

// ============================================================
// ПОЛУЧЕНИЕ ОДНОЙ СДЕЛКИ
// ============================================================

async function getLead(
    leadId
) {

    return amoCrmGet(
        `/api/v4/leads/${leadId}`,
        {
            with: "contacts"
        }
    );
}

// ============================================================
// ПОЛУЧЕНИЕ КОНТАКТА
// ============================================================

async function getContact(
    contactId
) {

    try {

        return await amoCrmGet(
            `/api/v4/contacts/${contactId}`
        );

    } catch (error) {

        console.error(
            "Ошибка получения контакта:",
            contactId,
            error.response?.status
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

    const fields =
        contact.custom_fields_values || [];

    const phoneField =
        fields.find(
            field =>
                String(field.field_name || "")
                    .toLowerCase()
                    .includes("телефон")
        );

    if (!phoneField) {
        return [];
    }

    return (phoneField.values || [])
        .map(item => item.value)
        .filter(Boolean)
        .map(String);
}

// ============================================================
// ИМЯ КОНТАКТА
// ============================================================

function getContactName(
    contact
) {

    if (!contact) {
        return "";
    }

    return contact.name || "";
}

// ============================================================
// ПОЛУЧЕНИЕ ЗАДАЧ
// ============================================================

async function getMeasurementTasks() {

    const range =
        getTaskDateRange();

    const allTasks = [];

    let page = 1;

    const limit = 250;

    while (true) {

        const params = {
            "filter[entity_type]": "leads",

            // НЕЗАВЕРШЁННАЯ ЗАДАЧА
            "filter[is_completed][]": 0,

            // ТОЛЬКО "ПОДТВ. ЗАМЕР(И)"
            "filter[task_type][]":
                MEASUREMENT_TASK_TYPE_ID,

            // ДАТА ИСПОЛНЕНИЯ ЗАДАЧИ
            "filter[complete_till][from]":
                range.from,

            "filter[complete_till][to]":
                range.to,

            limit,

            page,

            "order[complete_till]": "asc"
        };

        console.log(
            "Запрос задач:",
            qs.stringify(params)
        );

        let data;

        try {

            data =
                await amoCrmGet(
                    "/api/v4/tasks",
                    params
                );

        } catch (error) {

            console.error(
                "Ошибка получения задач:",
                error.response?.status,
                error.response?.data
            );

            throw error;
        }

        const tasks =
            data?._embedded?.tasks || [];

        console.log(
            `Страница задач ${page}: ${tasks.length}`
        );

        allTasks.push(...tasks);

        if (tasks.length < limit) {
            break;
        }

        page++;

        // Защита от бесконечного цикла
        if (page > 20) {
            console.log(
                "Остановлено после 20 страниц задач"
            );
            break;
        }
    }

    return {
        tasks: allTasks,
        range
    };
}

// ============================================================
// ПОИСК ЗАМЕРОВ
// ============================================================

async function findMeasurements() {

    log(
        "ПОИСК ЗАМЕРОВ",
        {
            engineer: ENGINEER_NAME,
            field_id: ENGINEER_FIELD_ID,
            enum_id: ENGINEER_ENUM_ID,
            task_type_id:
                MEASUREMENT_TASK_TYPE_ID
        }
    );

    const result =
        await getMeasurementTasks();

    const tasks =
        result.tasks;

    const range =
        result.range;

    console.log(
        "Всего задач:",
        tasks.length
    );

    // ========================================================
    // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА
    // ========================================================

    const validTasks =
        tasks.filter(task => {

            if (
                task.entity_type !==
                "leads"
            ) {
                return false;
            }

            if (
                Number(task.task_type_id) !==
                MEASUREMENT_TASK_TYPE_ID
            ) {
                return false;
            }

            if (
                task.is_completed === true
            ) {
                return false;
            }

            if (!task.entity_id) {
                return false;
            }

            return true;
        });

    console.log(
        "Подходящих задач:",
        validTasks.length
    );

    // ========================================================
    // НЕ ДЕЛАЕМ ЗАПРОС ВСЕХ СДЕЛОК
    // Берём только сделки, к которым привязаны найденные задачи
    // ========================================================

    const measurements = [];

    for (const task of validTasks) {

        const leadId =
            Number(task.entity_id);

        try {

            const lead =
                await getLead(leadId);

            if (!lead) {
                continue;
            }

            // =================================================
            // ПРОВЕРЯЕМ МАРИНУ
            // =================================================

            if (!isMarinaLead(lead)) {

                console.log(
                    `Сделка ${leadId}: другой инженер`
                );

                continue;
            }

            // =================================================
            // ПОЛЯ СДЕЛКИ
            //
            // ВАЖНО:
            // ПУСТЫЕ ПОЛЯ НЕ ИСКЛЮЧАЮТ СДЕЛКУ.
            // =================================================

            const contractNumber =
                getFieldText(
                    lead,
                    412776
                );

            const measureDateValue =
                getLeadField(
                    lead,
                    175370
                );

            let measureDate = "";

            if (
                measureDateValue &&
                measureDateValue.value
            ) {

                const raw =
                    Number(
                        measureDateValue.value
                    );

                if (!Number.isNaN(raw)) {

                    measureDate =
                        new Intl.DateTimeFormat(
                            "ru-RU",
                            {
                                timeZone:
                                    TIMEZONE,
                                day: "2-digit",
                                month: "2-digit",
                                year: "numeric"
                            }
                        ).format(
                            new Date(
                                raw * 1000
                            )
                        );
                } else {

                    measureDate =
                        String(
                            measureDateValue.value
                        );
                }
            }

            const measureTime =
                getFieldText(
                    lead,
                    413828
                );

            const address =
                getFieldText(
                    lead,
                    175412
                );

            const product =
                getFieldText(
                    lead,
                    172572
                );

            // =================================================
            // КОНТАКТ
            // =================================================

            let clientName = "";

            let clientPhones = [];

            const contacts =
                lead?._embedded?.contacts ||
                [];

            const mainContact =
                contacts.find(
                    contact =>
                        contact.is_main === true
                ) ||
                contacts[0];

            if (mainContact?.id) {

                const contact =
                    await getContact(
                        mainContact.id
                    );

                clientName =
                    getContactName(
                        contact
                    );

                clientPhones =
                    getContactPhones(
                        contact
                    );
            }

            // =================================================
            // ССЫЛКА НА СДЕЛКУ
            // =================================================

            const leadLink =
                `${AMOCRM_BASE_URL}/leads/detail/${leadId}`;

            measurements.push({

                task_id:
                    task.id,

                task_complete_till:
                    task.complete_till,

                task_complete_till_moscow:
                    formatMoscow(
                        task.complete_till
                    ),

                lead_id:
                    leadId,

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

                lead_link:
                    leadLink,

                engineer:
                    ENGINEER_NAME
            });

        } catch (error) {

            console.error(
                `Ошибка обработки сделки ${leadId}:`,
                error.response?.status,
                error.response?.data ||
                error.message
            );
        }
    }

    console.log(
        "ИТОГО ЗАМЕРОВ:",
        measurements.length
    );

    return {
        measurements,
        tasksLoaded:
            tasks.length,
        validTasks:
            validTasks.length,
        range
    };
}

// ============================================================
// AMOMESSENGER API
// ============================================================

async function messengerRequest(
    method,
    path,
    body = undefined
) {

    const token =
        getMessengerToken();

    if (!token) {

        throw new Error(
            "Токен amoMessenger не найден"
        );
    }

    const url =
        `${AMOMESSENGER_API}${path}`;

    console.log(
        "amoMessenger",
        method,
        url
    );

    if (body) {
        console.log(
            "BODY:",
            JSON.stringify(
                body,
                null,
                2
            )
        );
    }

    try {

        const response =
            await axios({
                method,
                url,
                data: body,
                headers: {
                    Authorization:
                        `Bearer ${token}`,

                    "Content-Type":
                        "application/json",

                    Accept:
                        "application/json"
                },

                timeout: 20000,

                validateStatus:
                    () => true
            });

        console.log(
            "amoMessenger response:",
            response.status,
            response.data
        );

        if (
            response.status < 200 ||
            response.status >= 300
        ) {

            const error =
                new Error(
                    `amoMessenger HTTP ${response.status}`
                );

            error.response =
                response;

            throw error;
        }

        return response.data;

    } catch (error) {

        console.error(
            "amoMessenger ERROR:",
            error.response?.status,
            error.response?.data ||
            error.message
        );

        throw error;
    }
}

// ============================================================
// ОТПРАВКА СООБЩЕНИЯ В ЗАЯВКУ
// ============================================================

async function sendBotMessage(
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
        }
    };

    // ========================================================
    // КНОПКИ
    // ========================================================

    if (
        Array.isArray(buttons) &&
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

    return messengerRequest(
        "POST",
        `/v1.3/bots/${botId}/request/${requestId}/sendMessage`,
        body
    );
}

// ============================================================
// ВОЗВРАТ УПРАВЛЕНИЯ
// ============================================================

async function returnControl(
    botId,
    requestId,
    code = "success"
) {

    return messengerRequest(
        "POST",
        `/v1.3/bots/${botId}/request/${requestId}/returnControl`,
        {
            return_code: code
        }
    );
}

// ============================================================
// ФОРМАТ ОДНОГО ЗАМЕРА
// ============================================================

function measurementText(
    item,
    index,
    total
) {

    let text =
        `📋 Замер ${index} из ${total}\n\n`;

    text +=
        `📄 № договора: ${
            item.contract_number || "—"
        }\n`;

    text +=
        `📅 Дата замера: ${
            item.measure_date || "—"
        }\n`;

    text +=
        `⏰ Время замера: ${
            item.measure_time || "—"
        }\n`;

    text +=
        `📍 Адрес: ${
            item.measure_address || "—"
        }\n`;

    text +=
        `🏗 Продукт: ${
            item.product || "—"
        }\n`;

    text +=
        `👤 Клиент: ${
            item.client_name || "—"
        }\n`;

    if (
        item.client_phones &&
        item.client_phones.length
    ) {

        text +=
            `📞 Телефон: ${
                item.client_phones.join(", ")
            }\n`;

    } else {

        text +=
            `📞 Телефон: —\n`;
    }

    text +=
        `\n👷 Инженер: ${
            item.engineer || "—"
        }\n`;

    text +=
        `🕐 Срок исполнения задачи: ${
            item.task_complete_till_moscow ||
            "—"
        }\n`;

    text +=
        `\n🔗 Сделка:\n${
            item.lead_link
        }`;

    return text;
}

// ============================================================
// WEBHOOK AMOMESSENGER
// ============================================================

app.post(
    "/webhook/amomessenger",
    async (req, res) => {

        log(
            "AMOMESSENGER WEBHOOK",
            req.body
        );

        // Отвечаем amo сразу
        res.status(200).json({
            status: "ok"
        });

        try {

            const body =
                req.body || {};

            const eventType =
                body.event_type;

            const embedded =
                body?._embedded || {};

            // =================================================
            // ПЕРЕДАЧА УПРАВЛЕНИЯ ВИДЖЕТУ
            // =================================================

            if (
                eventType ===
                "rpa_bot_control_transferred"
            ) {

                const context =
                    embedded.context || {};

                const transferred =
                    embedded
                        .rpa_bot_control_transferred;

                const transferredEmbedded =
                    transferred?._embedded || {};

                const transferredContext =
                    transferredEmbedded.context ||
                    context;

                const request =
                    transferredEmbedded.request;

                if (!request) {

                    console.error(
                        "Не найден request"
                    );

                    return;
                }

                const botId =
                    transferred.bot_id;

                const requestId =
                    request.id;

                /*
                 * ВАЖНО:
                 *
                 * Пользователь, которому нужно
                 * отправлять сообщение, — это
                 * автор заявки.
                 *
                 * В ваших вебхуках это:
                 *
                 * request.author_id
                 */

                const receiverUserId =
                    request.author_id ||
                    transferredContext.user_id ||
                    context.user_id;

                log(
                    "ПЕРЕДАНО УПРАВЛЕНИЕ ВИДЖЕТУ",
                    {
                        botId,
                        requestId,
                        receiverUserId
                    }
                );

                // ------------------------------------------------
                // Сначала показываем пользователю кнопку.
                // НЕ запускаем тяжёлый поиск сразу.
                // ------------------------------------------------

                try {

                    await sendBotMessage(
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

                    console.log(
                        "Главное меню отправлено"
                    );

                } catch (error) {

                    console.error(
                        "Ошибка отправки меню:",
                        error.response?.data ||
                        error.message
                    );

                    try {

                        await returnControl(
                            botId,
                            requestId,
                            "error"
                        );

                    } catch (returnError) {

                        console.error(
                            "Ошибка возврата управления:",
                            returnError.message
                        );
                    }
                }

                return;
            }

            // =================================================
            // ВХОДЯЩЕЕ СООБЩЕНИЕ В БОТЕ
            // =================================================

            if (
                eventType ===
                "rpa_bot_income_message"
            ) {

                const context =
                    embedded.context || {};

                const income =
                    embedded
                        .rpa_bot_income_message;

                const incomeEmbedded =
                    income?._embedded || {};

                const request =
                    incomeEmbedded.request;

                const message =
                    incomeEmbedded.income_message;

                if (
                    !request ||
                    !message
                ) {

                    console.error(
                        "Нет request или income_message"
                    );

                    return;
                }

                const botId =
                    income.bot_id;

                const requestId =
                    request.id;

                const receiverUserId =
                    request.author_id ||
                    context.user_id;

                const text =
                    String(
                        message.text || ""
                    ).trim();

                log(
                    "ПОЛУЧЕНО СООБЩЕНИЕ",
                    {
                        text,
                        botId,
                        requestId,
                        receiverUserId
                    }
                );

                // =================================================
                // ПОДТВЕРДИТЬ ЗАМЕР
                // =================================================

                if (
                    text.toLowerCase() ===
                    "подтвердить замер"
                        .toLowerCase()
                ) {

                    console.log(
                        "ПОЛЬЗОВАТЕЛЬ ВЫБРАЛ: ПОДТВЕРДИТЬ ЗАМЕР"
                    );

                    // ---------------------------------------------
                    // Сразу сообщаем пользователю, что начали поиск
                    // ---------------------------------------------

                    try {

                        await sendBotMessage(
                            botId,
                            requestId,
                            receiverUserId,
                            "⏳ Проверяю задачи на подтверждение замера..."
                        );

                    } catch (error) {

                        console.error(
                            "Не удалось отправить сообщение о начале:",
                            error.response?.data ||
                            error.message
                        );
                    }

                    // ---------------------------------------------
                    // Поиск
                    // ---------------------------------------------

                    try {

                        const result =
                            await findMeasurements();

                        const measurements =
                            result.measurements;

                        // -----------------------------------------
                        // НИЧЕГО НЕ НАЙДЕНО
                        // -----------------------------------------

                        if (
                            measurements.length === 0
                        ) {

                            await sendBotMessage(
                                botId,
                                requestId,
                                receiverUserId,

                                "📋 Замеров для подтверждения не найдено."
                            );

                        } else {

                            // -------------------------------------
                            // ОТПРАВЛЯЕМ КАЖДУЮ СДЕЛКУ
                            // -------------------------------------

                            for (
                                let i = 0;
                                i < measurements.length;
                                i++
                            ) {

                                const item =
                                    measurements[i];

                                await sendBotMessage(
                                    botId,
                                    requestId,
                                    receiverUserId,

                                    measurementText(
                                        item,
                                        i + 1,
                                        measurements.length
                                    )
                                );
                            }

                            // -------------------------------------
                            // Возвращаем меню
                            // -------------------------------------

                            await sendBotMessage(
                                botId,
                                requestId,
                                receiverUserId,

                                "\nВыберите следующую задачу:",

                                [
                                    "Подтвердить замер",
                                    "Провести замер",
                                    "Загрузить фотоотчет",
                                    "Внести правки"
                                ]
                            );
                        }

                    } catch (error) {

                        console.error(
                            "ОШИБКА ПОИСКА ЗАМЕРОВ:",
                            error.response?.status,
                            error.response?.data ||
                            error.message
                        );

                        try {

                            await sendBotMessage(
                                botId,
                                requestId,
                                receiverUserId,

                                "❌ Не удалось получить данные из amoCRM.\n\nПроверьте подключение amoCRM и токен."
                            );

                        } catch (sendError) {

                            console.error(
                                "Ошибка отправки ошибки пользователю:",
                                sendError.message
                            );
                        }
                    }

                    // ---------------------------------------------
                    // Возвращаем управление amo
                    // ---------------------------------------------

                    try {

                        await returnControl(
                            botId,
                            requestId,
                            "success"
                        );

                        console.log(
                            "Управление возвращено amo"
                        );

                    } catch (error) {

                        console.error(
                            "Ошибка returnControl:",
                            error.response?.data ||
                            error.message
                        );
                    }

                    return;
                }

                // =================================================
                // /START
                // =================================================

                if (
                    text === "/start"
                ) {

                    try {

                        await sendBotMessage(
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

                    } catch (error) {

                        console.error(
                            "Ошибка /start:",
                            error.response?.data ||
                            error.message
                        );
                    }

                    return;
                }

                // =================================================
                // ДРУГИЕ КНОПКИ
                // =================================================

                if (
                    text ===
                    "Провести замер"
                ) {

                    try {

                        await sendBotMessage(
                            botId,
                            requestId,
                            receiverUserId,

                            "🛠 Функция «Провести замер» пока находится в разработке."
                        );

                        await returnControl(
                            botId,
                            requestId,
                            "success"
                        );

                    } catch (error) {

                        console.error(
                            error.message
                        );
                    }

                    return;
                }

                if (
                    text ===
                    "Загрузить фотоотчет"
                ) {

                    try {

                        await sendBotMessage(
                            botId,
                            requestId,
                            receiverUserId,

                            "📷 Функция «Загрузить фотоотчет» пока находится в разработке."
                        );

                        await returnControl(
                            botId,
                            requestId,
                            "success"
                        );

                    } catch (error) {

                        console.error(
                            error.message
                        );
                    }

                    return;
                }

                if (
                    text ===
                    "Внести правки"
                ) {

                    try {

                        await sendBotMessage(
                            botId,
                            requestId,
                            receiverUserId,

                            "✏️ Функция «Внести правки» пока находится в разработке."
                        );

                        await returnControl(
                            botId,
                            requestId,
                            "success"
                        );

                    } catch (error) {

                        console.error(
                            error.message
                        );
                    }

                    return;
                }

                // =================================================
                // НЕИЗВЕСТНАЯ КОМАНДА
                // =================================================

                try {

                    await sendBotMessage(
                        botId,
                        requestId,
                        receiverUserId,

                        "Пожалуйста, выберите действие:",

                        [
                            "Подтвердить замер",
                            "Провести замер",
                            "Загрузить фотоотчет",
                            "Внести правки"
                        ]
                    );

                } catch (error) {

                    console.error(
                        "Ошибка отправки меню:",
                        error.message
                    );
                }

                return;
            }

            // =================================================
            // УДАЛЕНИЕ ПРИЛОЖЕНИЯ
            // =================================================

            if (
                eventType ===
                "app.deleted"
            ) {

                log(
                    "AMOMESSENGER APP DELETED"
                );

                messengerToken = null;
                messengerRefreshToken = null;

                return;
            }

        } catch (error) {

            console.error(
                "WEBHOOK ERROR:",
                error.response?.data ||
                error.message
            );
        }
    }
);

// ============================================================
// ГЛАВНАЯ СТРАНИЦА
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Отчёт инженеров</title>
<style>
body {
    font-family: Arial, sans-serif;
    padding: 40px;
}
.ok {
    color: green;
}
</style>
</head>
<body>

<h1>Отчёт инженеров</h1>

<p class="ok">
Виджет подключён и готов к работе.
</p>

<p>
Сервер работает.
</p>

</body>
</html>
        `);
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({
            status: "OK",
            server: "amobot-cpck",
            time: new Date().toISOString()
        });
    }
);

// ============================================================
// ПРОВЕРКА AMOCRM
// ============================================================

app.get(
    "/debug/amocrm-test",
    async (req, res) => {

        try {

            if (!AMOCRM_ACCESS_TOKEN) {

                return res.status(500).json({
                    status: "Ошибка",
                    message:
                        "AMOCRM_ACCESS_TOKEN не задан в Environment Variables"
                });
            }

            const data =
                await amoCrmGet(
                    "/api/v4/account"
                );

            res.json({
                status:
                    "Связь с amoCRM работает!",

                account_name:
                    data.name || null,

                account_id:
                    data.id || null,

                subdomain:
                    AMOCRM_SUBDOMAIN
            });

        } catch (error) {

            res.status(
                error.response?.status || 500
            ).json({
                status: "Ошибка",
                message:
                    `amoCRM HTTP ${
                        error.response?.status ||
                        500
                    }`,
                details:
                    error.response?.data ||
                    null
            });
        }
    }
);

// ============================================================
// ПРОВЕРКА ПОЛЯ ИНЖЕНЕРА
// ============================================================

app.get(
    "/debug/engineer-field",
    async (req, res) => {

        try {

            const data =
                await amoCrmGet(
                    `/api/v4/leads/custom_fields/${ENGINEER_FIELD_ID}`
                );

            const values =
                data.enums ||
                data.values ||
                [];

            const found =
                values.find(
                    item =>
                        Number(item.id) ===
                        ENGINEER_ENUM_ID
                );

            res.json({
                status: "OK",

                field: {
                    id:
                        data.id,

                    name:
                        data.name,

                    type:
                        data.type
                },

                expected_engineer: {
                    name:
                        ENGINEER_NAME,

                    enum_id:
                        ENGINEER_ENUM_ID
                },

                found_engineer:
                    found || null,

                all_values:
                    values
            });

        } catch (error) {

            res.status(
                error.response?.status || 500
            ).json({
                status: "Ошибка",

                message:
                    `amoCRM HTTP ${
                        error.response?.status ||
                        500
                    }`,

                details:
                    error.response?.data ||
                    null
            });
        }
    }
);

// ============================================================
// TEST ЗАДАЧ
// ============================================================

app.get(
    "/debug/tasks-test",
    async (req, res) => {

        try {

            const result =
                await getMeasurementTasks();

            const now =
                getMoscowDateParts();

            res.json({

                status: "OK",

                timezone:
                    TIMEZONE,

                current_moscow_time:
                    `${String(now.day).padStart(2, "0")}.${String(now.month).padStart(2, "0")}.${now.year}, ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}:${String(now.second).padStart(2, "0")}`,

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
                        formatMoscow(
                            result.range.from
                        ),

                    to:
                        formatMoscow(
                            result.range.to
                        )
                },

                tasks_loaded:
                    result.tasks.length,

                valid_tasks:
                    result.tasks.filter(
                        task =>
                            task.entity_type === "leads" &&
                            Number(task.task_type_id) === MEASUREMENT_TASK_TYPE_ID &&
                            task.is_completed === false
                    ).length,

                found_count:
                    result.measurements.length,

                measurements:
                    result.measurements
            });

        } catch (error) {

            res.status(
                error.response?.status || 500
            ).json({

                status: "Ошибка",

                message:
                    error.message,

                details:
                    error.response?.data ||
                    null
            });
        }
    }
);

// ============================================================
// TEST КОНКРЕТНОЙ ЗАДАЧИ
// ============================================================

app.get(
    "/debug/task-test/:taskId",
    async (req, res) => {

        try {

            const taskId =
                Number(
                    req.params.taskId
                );

            if (!taskId) {

                return res.status(400).json({
                    status: "Ошибка",
                    message:
                        "Неверный taskId"
                });
            }

            const task =
                await amoCrmGet(
                    `/api/v4/tasks/${taskId}`
                );

            const range =
                getTaskDateRange();

            const entityType =
                task.entity_type ===
                "leads";

            const taskType =
                Number(task.task_type_id) ===
                MEASUREMENT_TASK_TYPE_ID;

            const notCompleted =
                task.is_completed === false;

            const date =
                Number(task.complete_till) >=
                    range.from &&
                Number(task.complete_till) <=
                    range.to;

            res.json({

                status: "OK",

                task_id:
                    task.id,

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
                    formatMoscow(
                        task.complete_till
                    ),

                date_mode:
                    "до 18:00",

                date_range: {

                    from:
                        formatMoscow(
                            range.from
                        ),

                    to:
                        formatMoscow(
                            range.to
                        )
                },

                passes: {

                    entity_type:
                        entityType,

                    task_type:
                        taskType,

                    not_completed:
                        notCompleted,

                    date:
                        date
                }

            });

        } catch (error) {

            res.status(
                error.response?.status || 500
            ).json({

                status: "Ошибка",

                message:
                    `amoCRM HTTP ${
                        error.response?.status ||
                        500
                    }`,

                details:
                    error.response?.data ||
                    null
            });
        }
    }
);

// ============================================================
// ПРОВЕРКА AMOMESSENGER TOKEN
// ============================================================

app.get(
    "/debug/amomessenger-token",
    (req, res) => {

        res.json({

            status:
                getMessengerToken()
                    ? "OK"
                    : "Токен не найден",

            access_token:
                getMessengerToken()
                    ? "ДА"
                    : "НЕТ",

            refresh_token:
                messengerRefreshToken
                    ? "ДА"
                    : "НЕТ"
        });
    }
);

// ============================================================
// OAUTH AMOMESSENGER
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

        const params =
            new URLSearchParams({
                client_id:
                    AMOMESSENGER_CLIENT_ID,

                redirect_uri:
                    AMOMESSENGER_REDIRECT_URI,

                response_type:
                    "code"
            });

        const url =
            `https://www.amo.tm/oauth?${params.toString()}`;

        res.redirect(url);
    }
);

// ============================================================
// OAUTH CALLBACK
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

        if (
            !AMOMESSENGER_CLIENT_ID ||
            !AMOMESSENGER_CLIENT_SECRET
        ) {

            return res.status(500).send(`
                <h2>Ошибка OAuth</h2>
                <p>
                Не заданы AMOMESSENGER_CLIENT_ID
                или AMOMESSENGER_CLIENT_SECRET.
                </p>
            `);
        }

        try {

            const response =
                await axios.post(
                    "https://api.amo.tm/oauth2/access_token",

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

                        timeout: 20000
                    }
                );

            const data =
                response.data;

            messengerToken =
                data.access_token;

            messengerRefreshToken =
                data.refresh_token ||
                null;

            console.log(
                "AMOMESSENGER OAuth УСПЕШНО"
            );

            res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Авторизация amoMessenger</title>
</head>

<body style="
font-family:Arial;
padding:40px;
">

<h2>
Авторизация amoMessenger успешно выполнена
</h2>

<p>
<b>Токен получен:</b> ДА
</p>

<p>
Теперь можно закрыть это окно и снова запустить бота.
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
<h2>Ошибка авторизации amoMessenger</h2>

<pre>
${JSON.stringify(
    error.response?.data ||
    error.message,
    null,
    2
)}
</pre>
            `);
        }
    }
);

// ============================================================
// AMOMESSENGER TEST
// ============================================================

app.get(
    "/debug/amomessenger-test",
    async (req, res) => {

        try {

            const token =
                getMessengerToken();

            if (!token) {

                return res.json({
                    status:
                        "Токен не найден"
                });
            }

            res.json({

                status: "OK",

                message:
                    "Токен amoMessenger найден",

                access_token:
                    "ДА",

                refresh_token:
                    messengerRefreshToken
                        ? "ДА"
                        : "НЕТ"
            });

        } catch (error) {

            res.status(500).json({

                status: "Ошибка",

                message:
                    error.message
            });
        }
    }
);

// ============================================================
// WIDGET POST
// ============================================================

app.post(
    "/",
    (req, res) => {

        log(
            "AMOMESSENGER POST /",
            req.body
        );

        res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Отчёт инженеров</title>
</head>
<body>

<h2>Отчёт инженеров</h2>

<p>
Виджет подключён и готов к работе.
</p>

</body>
</html>
        `);
    }
);

// ============================================================
// ОШИБКИ
// ============================================================

app.use(
    (err, req, res, next) => {

        console.error(
            "SERVER ERROR:",
            err
        );

        res.status(500).json({
            status: "Ошибка",
            message:
                err.message
        });
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
            "AMOBOT SERVER ЗАПУЩЕН"
        );

        console.log(
            "PORT:",
            PORT
        );

        console.log(
            "AMOCRM:",
            AMOCRM_BASE_URL
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
            "Task type:",
            MEASUREMENT_TASK_TYPE_ID
        );

        console.log(
            "Timezone:",
            TIMEZONE
        );

        console.log(
            "AMOCRM TOKEN:",
            AMOCRM_ACCESS_TOKEN
                ? "ДА"
                : "НЕТ"
        );

        console.log(
            "AMOMESSENGER TOKEN:",
            getMessengerToken()
                ? "ДА"
                : "НЕТ"
        );

        console.log(
            "=========================================="
        );
    }
);
