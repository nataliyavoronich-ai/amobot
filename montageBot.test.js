// Проверка бота монтажников на заглушках: поддельные amoCRM, Яндекс.Диск,
// Redis и amoMessenger. Запуск: node montageBot.test.js
// Реальные amoCRM/мессенджер не используются.

process.env.AMOMESSENGER_MONTAGE_ACCESS_TOKEN = "test-token";
process.env.SENSEI_TOKEN = "sensei-test";

const assert = require("assert");
const axios = require("axios");

const calc = require("./montage/calc");

let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((error) => {
      console.error(`  ✗ ${name}\n    ${error.stack || error.message}`);
      process.exitCode = 1;
    });
}

// ---------------- заглушки сети ----------------

const sent = []; // сообщения бота: {text, buttons}

const channelPosts = [];
let uploads = 0;

const senseiCalls = [];

axios.post = async (url, body, config) => {
  if (String(url).includes("api.sensei.plus")) {
    senseiCalls.push({ url, body, token: config.headers["X-Auth-Sensei-Token"] });
    return { status: 200, data: {} };
  }

  if (String(url).includes("/files/upload")) {
    uploads += 1;
    return { status: 200, data: { file_id: `file-${uploads}` } };
  }

  if (String(url).includes("/channels/")) {
    channelPosts.push(body);
    return { status: 200, data: { msg_id: "m" } };
  }

  if (String(url).includes("api.amo.tm")) {
    sent.push({
      text: body.text,
      buttons: ((body.reply_markup && body.reply_markup.inline_keyboard.buttons) || []).map((b) => b.text)
    });
    return { status: 200, data: {} };
  }

  throw new Error(`Неожиданный axios.post ${url}`);
};

axios.get = async (url) => {
  if (String(url).includes("resources/download")) {
    return { status: 200, data: { href: "https://download.test/file" } };
  }

  if (String(url).startsWith("https://download.test/")) {
    return { status: 200, data: new Uint8Array([1, 2, 3]).buffer };
  }

  if (String(url).includes("cloud-api.yandex.net")) {
    return { status: 200, data: { _embedded: { items: [] } } };
  }

  throw new Error(`Неожиданный axios.get ${url}`);
};

const redis = new Map();
const lists = new Map();
const sets = new Map();

async function redisRequest(command) {
  const [op, key, ...rest] = command;

  if (op === "GET") {
    return { result: redis.has(key) ? redis.get(key) : null };
  }

  if (op === "SET") {
    if (rest.includes("NX") && redis.has(key)) {
      return { result: null };
    }

    redis.set(key, rest[0]);
    return { result: "OK" };
  }

  if (op === "KEYS") {
    const prefix = key.replace("*", "");

    return { result: [...redis.keys()].filter((k) => k.startsWith(prefix)) };
  }

  if (op === "LPUSH") {
    lists.set(key, [rest[0], ...(lists.get(key) || [])]);
    return { result: 1 };
  }

  if (op === "LRANGE") {
    return { result: (lists.get(key) || []).slice(rest[0], rest[1] + 1) };
  }

  if (op === "SADD") {
    sets.set(key, new Set([...(sets.get(key) || []), rest[0]]));
    return { result: 1 };
  }

  if (op === "SREM") {
    (sets.get(key) || new Set()).delete(rest[0]);
    return { result: 1 };
  }

  if (op === "SMEMBERS") {
    return { result: [...(sets.get(key) || [])] };
  }

  return { result: "OK" }; // LTRIM, EXPIRE …
}

// ---------------- поддельная amoCRM ----------------

const F = require("./montage/constants");
const NOW = Math.floor(Date.now() / 1000);

function field(id, value, enumId) {
  return { field_id: id, values: [enumId ? { value, enum_id: enumId } : { value }] };
}

const leads = {
  101: {
    id: 101,
    pipeline_id: F.PIPELINE.WOOD_PRODUCTION,
    status_id: F.UPCOMING_STATUS[F.PIPELINE.WOOD_PRODUCTION],
    price: 200000,
    _embedded: { contacts: [{ id: 5, is_main: true }] },
    custom_fields_values: [
      field(F.FIELD.LEKALSHIK, "Иванов Иван", 11),
      field(F.FIELD.PRODUCT, "Деревянная лестница", 3),
      field(F.FIELD.CONTRACT_NUMBER, "777"),
      field(F.FIELD.FLOORS, "1"),
      field(F.FIELD.ADDRESS, "ул. Ленина, 32"),
      field(F.FIELD.LEKAL_DATE, NOW),
      field(F.SLOT_FIELDS[0].master, "Иванов Иван", 11)
    ]
  },
  100: {
    id: 100,
    status_id: F.UPCOMING_STATUS[F.PIPELINE.METAL],
    pipeline_id: F.PIPELINE.METAL,
    price: 100000,
    _embedded: { contacts: [{ id: 5, is_main: true }] },
    custom_fields_values: [
      field(F.FIELD.MONTAGER, "Иванов Иван", 11),
      field(F.FIELD.PRODUCT, "Закрытый каркас", 1),
      field(F.FIELD.CONTRACT_NUMBER, "1234"),
      field(F.FIELD.FLOORS, "2"),
      field(F.FIELD.ADDRESS, "ул. Тестовая, 16"),
      field(F.FIELD.TERMS, NOW),
      field(F.FIELD.PAYMENT_REMAINDER, 50000),
      field(F.SLOT_FIELDS[0].master, "Иванов Иван", 11)
    ]
  }
};

let tasks = [
  { id: 900, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW }
];

const patches = [];
const notes = [];
const createdTasks = [];

function applyPatch(lead, body) {
  for (const item of body.custom_fields_values || []) {
    lead.custom_fields_values = lead.custom_fields_values.filter((f) => f.field_id !== item.field_id);

    if (item.values !== null) {
      lead.custom_fields_values.push(item);
    }
  }
}

function readSlotValue(key, slot = 0, leadId = 100) {
  const f = leads[leadId].custom_fields_values.find((x) => x.field_id === F.SLOT_FIELDS[slot][key]);

  return f ? f.values[0].value : undefined;
}

const ctx = {
  AMOCRM_SUBDOMAIN: "zlmk",
  YANDEX_DISK_ROOT_FOLDER: "amoCRM",
  redisRequest,
  isStartCommand: (t) => ["старт", "start"].includes(String(t).toLowerCase()),
  getMoscowDate: () => new Date(Date.now() + 3 * 3600 * 1000),
  todayMoscowDateText: () => "01.01.2026",
  todayMoscowStartUnix: () => NOW - (NOW % 86400),
  getFieldValues: (entity, id) => {
    const f = ((entity && entity.custom_fields_values) || []).find((x) => Number(x.field_id) === Number(id));

    return f ? f.values.map((v) => v.value) : [];
  },
  getFieldValueJoined: (entity, id) => ctx.getFieldValues(entity, id).join(", "),
  formatDateFieldValue: (entity, id) => {
    const v = ctx.getFieldValues(entity, id)[0];

    return v ? "15.12.2026" : "";
  },
  getLead: async (id) => leads[id] || null,
  getUrlExtension: () => "jpg",
  escapeRegExp: (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  yandexDiskHeaders: () => ({}),
  ydEnsureFolderPath: async () => {},
  ydEnsureFolder: async () => {},
  ydUploadFromUrlAndWait: async () => {},
  ydGetFolderPublicUrl: async (path) => `https://disk.test/${encodeURIComponent(path)}`,
  extractImageUrlsFromMessage: () => [],
  amoCrmGet: async (url, params = {}) => {
    if (url.endsWith("/tasks")) {
      const typeId = Number(params["filter[task_type][0]"]);
      const completed = Number(params["filter[is_completed]"]) === 1;
      let list = tasks.filter((t) => t.task_type_id === typeId && t.is_completed === completed);
      const ids = Object.keys(params).filter((k) => k.startsWith("filter[entity_id]")).map((k) => Number(params[k]));

      if (ids.length) {
        list = list.filter((t) => ids.includes(t.entity_id));
      }

      return list.length ? { status: 200, data: { _embedded: { tasks: list } } } : { status: 204, data: null };
    }

    if (url.endsWith("/leads")) {
      const ids = Object.keys(params).filter((k) => k.startsWith("filter[id]")).map((k) => Number(params[k]));
      let list = Object.values(leads).filter((l) => ids.includes(l.id));

      if (params["filter[statuses][0][status_id]"]) {
        list = Object.values(leads).filter(
          (l) =>
            Number(l.pipeline_id) === Number(params["filter[statuses][0][pipeline_id]"]) &&
            Number(l.status_id) === Number(params["filter[statuses][0][status_id]"])
        );
      }

      return list.length ? { status: 200, data: { _embedded: { leads: list } } } : { status: 204, data: null };
    }

    if (url.includes("/contacts/")) {
      return {
        status: 200,
        data: { name: "Екатерина", custom_fields_values: [{ field_code: "PHONE", values: [{ value: "+74951111111" }] }] }
      };
    }

    if (url.includes("/custom_fields")) {
      return { status: 200, data: { _embedded: { custom_fields: [] }, enums: [{ id: 11, value: "Иванов Иван" }] } };
    }

    throw new Error(`Неожиданный GET ${url}`);
  },
  amoCrmPost: async (url, body) => {
    if (url.endsWith("/notes")) {
      notes.push(body[0].params.text);
    } else if (url.endsWith("/tasks")) {
      createdTasks.push(body[0]);
    }

    return { status: 200, data: {} };
  },
  amoCrmPatch: async (url, body) => {
    const taskMatch = url.match(/tasks\/(\d+)$/);

    if (taskMatch) {
      const task = tasks.find((t) => t.id === Number(taskMatch[1]));

      task.is_completed = true;
      task.updated_at = NOW;
      task.result = body.result.text;
      return { status: 200, data: {} };
    }

    patches.push(body);
    applyPatch(leads[Number(url.match(/leads\/(\d+)$/)[1])], body);
    return { status: 200, data: {} };
  }
};

// ---------------- запуск ----------------

async function main() {
  console.log("Расчёт стоимости (T-8):");

  await check("пример из ТЗ «Навес»: 6050", () => {
    const result = calc.calcMontagePrice("meter", { X2: 1000, Y3: 1000 }, { amount: 5, extraHours: 3 }, { personalBonus: 0.01 });

    assert.strictEqual(result.price, 6050);
    assert.strictEqual(result.base, 6000);
    assert.strictEqual(result.P, 5000);
  });

  await check("доп. работы: 2 часа = 0, ≤1 час не считаем, 1.5 ч не уходит в минус", () => {
    const price = (hours) => calc.calcMontagePrice("meter", { X2: 100, Y3: 1000 }, { amount: 1, extraHours: hours }, null).price;

    assert.strictEqual(price(2), 100);
    assert.strictEqual(price(1), 100);
    assert.strictEqual(price(1.5), 100);
    assert.strictEqual(price(4), 2100);
  });

  await check("дерево: бюджет/100*X1 (+ врем. ступени), дерево-производство: бюджет/100*A", () => {
    assert.strictEqual(
      calc.calcMontagePrice("woodSales", { X1: 8, Y2: 500 }, { budget: 100000, tempSteps: 1, floors: 2 }, null).price,
      9000
    );
    assert.strictEqual(
      calc.calcMontagePrice("woodProduction", { A: 1.5, Y3: 1000 }, { budget: 100000, extraHours: 3 }, null).price,
      2500
    );
  });

  await check("группы продуктов", () => {
    const W = 3797814;

    assert.strictEqual(calc.getProductGroup("Закрытый каркас", 207259, W), "floors");
    assert.strictEqual(calc.getProductGroup("Монокосоур из проф трубы (1эт.)", 207259, W), "floors");
    assert.strictEqual(calc.getProductGroup("Навес", 207259, W), "meter");
    assert.strictEqual(calc.getProductGroup("Деревянная лестница", 585508, W), "woodSales");
    assert.strictEqual(calc.getProductGroup("Деревянная лестница", W, W), "woodProduction");
    assert.strictEqual(calc.getProductGroup("Уличная лестница", 207259, W), null);
  });

  await check("имена, числа, периоды", () => {
    assert.ok(calc.namesMatch("Иванов Иван @ivan_tg", "Иван Иванов"));
    assert.ok(calc.namesMatch("@ivanov_ivan2023", "ivanov_ivan2023"));
    assert.ok(!calc.namesMatch("Александр", "Закаров Александр"));
    assert.strictEqual(calc.parseNumber("12,5"), 12.5);
    assert.strictEqual(calc.parseNumber("8%"), 8);
    assert.strictEqual(calc.parseNumber("abc"), null);
    assert.strictEqual(calc.parseInteger("12,5"), null);

    const period = calc.parsePeriodText("01.01.2023 - 22.01.2023");

    assert.strictEqual(period.days, 22);
    assert.strictEqual(calc.parsePeriodText("32.01.2023"), null);
    assert.strictEqual(calc.secondHalfOfPreviousMonth(new Date(Date.UTC(2026, 0, 10))).label, "16.12.2025 - 31.12.2025");
  });

  // --- бот ---
  const montageBot = require("./montageBot");
  const settingsStore = require("./montage/settings");

  const settings = {
    motivations: [{ name: "Стандарт", transportTariff: 20, deliveryTariff: 10, personalBonus: 0.01, mentoring: 0.02 }],
    users: [{ managerHandle: "@boss", foremanName: "Иванов Иван", foremanHandle: "@ivanov_ivan2023", motivation: "Стандарт" }],
    pricing: [
      { enumId: 1, productName: "Закрытый каркас", X1: 7000, Y1: 1000, Y2: 2000, Y3: 1000, B: 20 },
      { enumId: 3, productName: "Деревянная лестница", A: 1.5, Y3: 1000 }
    ],
    ktu: [{ kind: "Видео общее", points: 5 }]
  };

  console.log("Настройки виджета:");
  await check("проверка настроек", () => {
    assert.ok(settingsStore.validate(settings).valid);
    assert.ok(!settingsStore.validate({ ...settings, ktu: [{ kind: "Что-то", points: 1 }] }).valid);
    assert.ok(!settingsStore.validate({ ...settings, users: [{ ...settings.users[0], motivation: "Нет такой" }] }).valid);
  });

  settingsStore.set(settings);

  let n = 0;

  async function say(who, text, attachments = []) {
    sent.length = 0;
    n += 1;
    await montageBot.processMessage(ctx, {
      directId: who.directId,
      userKey: who.userKey,
      userName: who.userName,
      text,
      attachments
    });

    return sent.map((m) => m.text).join("\n---\n");
  }

  const foreman = { directId: "d1", userKey: 1, userName: "Иванов Иван" };
  const manager = { directId: "d2", userKey: 2, userName: "boss" };
  const stranger = { directId: "d3", userKey: 3, userName: "Посторонний" };
  const photo = [{ url: "https://files.test/a.jpg", kind: "image", ext: "jpg" }];

  console.log("Сценарии:");

  const video = [{ url: "https://files.test/v.mp4", kind: "video", ext: "mp4" }];

  async function uploadAndContinue(who, label = "Продолжить", files = photo) {
    assert.match(await say(who, "", files), /Дополните фотоотчёт новыми файлами/);

    return say(who, label);
  }

  await check("T-1: чужого не пускаем, своего — в меню", async () => {
    assert.match(await say(stranger, "старт"), /Пользователь не найден/);

    const out = await say(foreman, "старт");

    assert.match(out, /Бригадир монтажной бригады/);
    assert.ok(sent[0].buttons.includes("Загрузить отчет") && sent[0].buttons.includes("Уведомления"));
  });

  await check("T-6: список («🔧») и карточка «Монтаж проведён»", async () => {
    const list = await say(foreman, "Загрузить отчет");

    assert.match(list, /Незавершённые монтажи:\nМонтажи в работе:\n1\) /);
    assert.deepStrictEqual(sent[0].buttons, ["🔧 1234"]);

    const card = await say(foreman, "🔧 1234");

    assert.match(card, /Монтаж проведён\.\nОстаток платежа: 50000\nАдрес объекта: ул\. Тестовая, 16/);
    assert.deepStrictEqual(sent[0].buttons, ["Перенос монтажа", "Промежуточный отчёт", "Монтаж завершён", "Доп хотелки"]);
  });

  await check("T-6: «Монтаж завершён» — акт, оплата, пробеги, КТУ, доп. работы, лестница, канал", async () => {
    assert.match(await say(foreman, "Монтаж завершён"), /Акт клиентом подписан\?/);
    assert.deepStrictEqual(sent[0].buttons, ["Да", "Загрузить акт отказа от подписи", "Заказчик отсутствует"]);
    assert.match(await say(foreman, "Да"), /фото акта выполненных работ/);
    assert.match(await uploadAndContinue(foreman), /Оплата от клиента получена\./);
    assert.match(await say(foreman, "Получил"), /фото чека/);
    assert.match(await uploadAndContinue(foreman), /пробега доставки/);
    assert.deepStrictEqual(sent[0].buttons, ["Пропустить"]);
    assert.match(await say(foreman, "20"), /транспортного пробега \(без доставки\)/);
    assert.match(await say(foreman, "abc"), /введите число\./);
    assert.match(await say(foreman, "100"), /скрин навигатора/);

    // блок КТУ
    assert.match(await uploadAndContinue(foreman), /Укажите, что сделано для баллов КТУ\./);
    assert.deepStrictEqual(sent[0].buttons, ["Пропустить", "Видео общее", "Видео таймлапс", "Видео отзыв клиента", "Отзывы"]);
    assert.match(await say(foreman, "Видео общее"), /Видео общее/);
    assert.match(await say(foreman, "", photo), /нужно прислать видео/);
    assert.match(await uploadAndContinue(foreman, "Продолжить", video), /баллов КТУ/);
    assert.deepStrictEqual(sent[0].buttons, ["Далее", "Видео таймлапс", "Видео отзыв клиента", "Отзывы"]);

    // доп. работы (группа 1 — металл)
    assert.match(await say(foreman, "Далее"), /Укажите доп\. работы\./);
    assert.deepStrictEqual(sent[0].buttons, ["Пропустить", "Монтаж врем. ступеней", "Чистовая отделка", "Установленные ограждения", "Доп. работы"]);
    assert.match(await say(foreman, "Монтаж врем. ступеней"), /фото дополнительной работы/);
    await uploadAndContinue(foreman);
    assert.deepStrictEqual(sent[0].buttons, ["Далее", "Чистовая отделка", "Установленные ограждения", "Доп. работы"]);
    await say(foreman, "Чистовая отделка");
    await uploadAndContinue(foreman);
    assert.match(await say(foreman, "Установленные ограждения"), /м\/п/);
    assert.match(await say(foreman, "10.5"), /введите целое число\./);
    await say(foreman, "10");
    await uploadAndContinue(foreman);
    assert.match(await say(foreman, "Доп. работы"), /часов/);
    await say(foreman, "3");
    await uploadAndContinue(foreman);
    assert.deepStrictEqual(sent[0].buttons, ["Далее"]);
    assert.match(await say(foreman, "Далее"), /общий комментарий/);
    assert.match(await say(foreman, "Монтаж полок"), /фото\/видео установленной лестницы/);
    assert.match(await say(foreman, "", photo), /Дополните фотоотчёт/);
    assert.deepStrictEqual(sent[sent.length - 1].buttons, ["Завершить отчёт"]);

    const done = await say(foreman, "Завершить отчёт");

    assert.match(done, /закрыта с результатом "Монтаж завершен"/);
    assert.match(done, /Задач по загрузке отчета не найдено\.[\s\S]*Бригадир монтажной бригады, выберите тип задач/); // возврат к началу Т6

    // Цена: (33800 + 24000*0.01) * 1.02 = 34721
    assert.strictEqual(readSlotValue("price"), 34721);
    assert.strictEqual(readSlotValue("kmFact"), 100);
    assert.strictEqual(readSlotValue("kmFactTotal"), 2000);
    assert.strictEqual(readSlotValue("kmDeliveryTotal"), 200);
    assert.strictEqual(readSlotValue("tariff"), 20);
    assert.strictEqual(readSlotValue("ktuVideo"), 5);
    assert.ok(readSlotValue("date") > 0);
    assert.strictEqual(readSlotValue("note"), "Монтаж полок");
    assert.strictEqual(readSlotValue("tempSteps"), 1);
    assert.strictEqual(readSlotValue("fence"), 10);
    assert.ok(leads[100].custom_fields_values.some((f) => f.field_id === F.FIELD.ACT));
    const folderLink = leads[100].custom_fields_values.find((f) => f.field_id === F.FIELD.MONTAGE_FOLDER).values[0].value;

    assert.ok(decodeURIComponent(folderLink).endsWith("Сделка (id 100)/Отчеты и проекты/Монтаж"), folderLink);
    assert.ok(!leads[100].custom_fields_values.some((f) => f.field_id === F.FIELD.PHOTO_LINK));
    assert.strictEqual(tasks.find((t) => t.id === 900).result, "Монтаж завершен");
    assert.strictEqual(createdTasks.length, 1);
    assert.strictEqual(createdTasks[0].responsible_user_id, F.USER.ACCOUNTANT);
    assert.strictEqual(createdTasks[0].text, "Получена оплата на монтаже.");

    // канал: текст по шаблону + фото лестницы + видео КТУ (по одному вложению в сообщении)
    assert.strictEqual(channelPosts.length, 3);
    assert.match(channelPosts[0].text, /\*\*Договор \/ замерный лист:\*\* 1234[\s\S]*\*\*Бюджет:\*\* 100000[\s\S]*Закрытый каркас[\s\S]*Фотоотчет/);
    assert.deepStrictEqual(channelPosts[1].attachments, [{ file_id: "file-1" }]);
  });

  await check("T-7: руководитель принимает отчёт", async () => {
    tasks.push({ id: 901, task_type_id: F.TASK_TYPE.ACCEPT_REPORT, is_completed: false, entity_id: 100, updated_at: NOW });

    assert.match(await say(manager, "старт"), /Руководитель монтажной бригады/);
    assert.match(await say(manager, "Принять отчет"), /Принять отчет:\n1\)/);
    assert.match(await say(manager, "1234"), /Отчет принят\?[\s\S]*Стоимость работ: 34721[\s\S]*Сумма баллов КТУ: 5/);
    assert.match(await say(manager, "Принять отчет"), /Начислены баллы КТУ[\s\S]*Видео общее: 5/);
    assert.match(await say(manager, "Далее"), /Стоимость работ: 34721[\s\S]*Описание расчета[\s\S]*Базовый тариф/);
    assert.match(await say(manager, "Внести правки стоимость"), /Введите новую стоимость/);
    assert.match(await say(manager, "12 тысяч"), /только из цифр|целое/i);
    assert.match(await say(manager, "35000"), /Правки внесены/);
    assert.strictEqual(readSlotValue("price"), 35000);
    assert.match(await say(manager, "Внести правки км транспортный"), /Введите новое значение/);
    assert.match(await say(manager, "150"), /Правки внесены/);
    assert.strictEqual(readSlotValue("kmFactTotal"), 3000);

    await say(manager, "Принять");
    assert.strictEqual(tasks.find((t) => t.id === 901).result, "Отчет принят");
    assert.match(await say(foreman, "Уведомления"), /Ваш отчет по 1234 принят руководителем[\s\S]*Стоимость работ: 35000/);
  });

  await check("T-9: правки — пробег, доп. работы, комментарий, КТУ, общее фото, завершение", async () => {
    tasks.push({ id: 902, task_type_id: F.TASK_TYPE.FIXES, is_completed: false, entity_id: 100, updated_at: NOW });

    assert.match(await say(foreman, "Внести правки"), /Необходимо дополнить отчет/);
    assert.match(await say(foreman, "1234"), /Что нужно исправить\?/);
    assert.deepStrictEqual(sent[0].buttons, ["Завершить отчёт", "Добавить комментарий", "Загрузить общее фото", "Доп. работы", "Балл КТУ", "Пробег"]);

    assert.match(await say(foreman, "Пробег"), /в какой пробег необходимо внести правки/);
    assert.deepStrictEqual(sent[0].buttons, ["Пропустить", "Доставка", "Транспортный"]);
    await say(foreman, "Доставка");
    await say(foreman, "30");
    assert.deepStrictEqual(sent[0].buttons, ["Далее", "Доставка", "Транспортный"]);
    assert.match(await say(foreman, "Далее"), /Что нужно исправить/);

    assert.match(await say(foreman, "Доп. работы"), /Укажите доп\. работы\./);
    await say(foreman, "Доп. работы");
    await say(foreman, "4");
    await uploadAndContinue(foreman);
    assert.match(await say(foreman, "Далее"), /общий комментарий/);
    assert.match(await say(foreman, "Доп. комментарий"), /Что нужно исправить/); // возврат к шагу 5

    assert.match(await say(foreman, "Добавить комментарий"), /Укажите комментарий\./);
    assert.match(await say(foreman, "Исправлено"), /Ваши комментарии приняты/);

    assert.match(await say(foreman, "Балл КТУ"), /баллов КТУ/);
    assert.match(await say(foreman, "Пропустить"), /Что нужно исправить/);

    assert.match(await say(foreman, "Загрузить общее фото"), /Загрузите файлы\./);
    assert.match(await uploadAndContinue(foreman), /Что нужно исправить/);

    const out = await say(foreman, "Завершить отчёт");

    assert.match(out, /закрыта с результатом "Правки внесены"/);
    assert.strictEqual(tasks.find((t) => t.id === 902).result, "Правки внесены");
    assert.strictEqual(readSlotValue("kmDeliveryTotal"), 300);
    assert.strictEqual(readSlotValue("extraHours"), 4);
    // (34800 + 24000*0.01) * 1.02 = 35740.8
    assert.strictEqual(readSlotValue("price"), 35741);
    assert.match(await say(manager, "Уведомления"), /внёс правки в отчёт по договору № 1234/);
  });

  await check("T-11: бригадир запрашивает пересмотр, руководитель правит и завершает", async () => {
    const approvalField = { id: 777, type: "select", enums: [{ id: 1, value: "Согласовать стоимость" }, { id: 2, value: "Согласование не нужно" }] };
    const baseGet = ctx.amoCrmGet;

    ctx.amoCrmGet = async (url, params) =>
      url.includes("/leads/custom_fields")
        ? { status: 200, data: { _embedded: { custom_fields: [{ name: "[Бот] Согласование стоимости(new)", ...approvalField }] } } }
        : baseGet(url, params);

    assert.match(await say(foreman, "Пересмотр стоимости"), /доступен в течение 24 часов[\s\S]*Пересмотр доступен в сделках/);
    assert.match(await say(foreman, "1234"), /Ваш отчёт по договору № 1234 принят руководителем\.[\s\S]*Стоимость работ: 35741/);
    assert.deepStrictEqual(sent[0].buttons, ["Запросить пересмотр"]);
    assert.match(await say(foreman, "Запросить пересмотр"), /желаемую стоимость работы и обоснование[\s\S]*Стоимость:/);
    assert.match(await say(foreman, "50000. Сложный подъём"), /Дополните запрос файлами/);
    assert.match(await say(foreman, "Продолжить"), /Ваш запрос принят/);
    assert.strictEqual(leads[100].custom_fields_values.find((f) => f.field_id === 777).values[0].value, "Согласовать стоимость");
    assert.strictEqual(readSlotValue("note"), "50000. Сложный подъём");

    assert.match(await say(manager, "Уведомления"), /Монтажник Иванов Иван просит пересмотреть стоимость работ\.[\s\S]*Обоснование для пересмотра: 50000/);
    assert.match(await say(manager, "Пересмотр стоимости"), /Требуется пересмотр стоимости работ в сделках/);
    assert.match(await say(manager, "1234"), /Обоснование для пересмотра/);
    assert.deepStrictEqual(sent[0].buttons, ["Изменить стоимость работ", "Изменить километры", "Изменить баллы КТУ", "Изменить тариф", "Отклонить"]);
    await say(manager, "Изменить стоимость работ");
    assert.match(await say(manager, "40000"), /Стоимость работы изменена\.\n\nНовая стоимость работ: 40000\./);
    assert.strictEqual(sent[sent.length - 1].buttons.slice(-1)[0], "Завершить правки");

    assert.match(await say(manager, "Изменить баллы КТУ"), /новое значение баллов КТУ/);
    assert.deepStrictEqual(sent[0].buttons, ["Пропустить", "КТУ видео общее"]);
    await say(manager, "КТУ видео общее");
    assert.match(await say(manager, "7"), /Правки внесены/);
    assert.strictEqual(readSlotValue("ktuVideo"), 7);
    assert.deepStrictEqual(sent[sent.length - 1].buttons, ["Далее", "КТУ видео общее"]);
    await say(manager, "Далее");

    await say(manager, "Завершить правки");
    assert.strictEqual(readSlotValue("price"), 40000);
    assert.strictEqual(leads[100].custom_fields_values.find((f) => f.field_id === 777).values[0].value, "Согласование не нужно");
    assert.match(await say(foreman, "Уведомления"), /Стоимость по договору № 1234 пересмотрена\.[\s\S]*Финальное значение[\s\S]*Стоимость работ: 40000/);

    ctx.amoCrmGet = baseGet;
  });

  await check("T-10: отчёт за период", async () => {
    const baseGet = ctx.amoCrmGet;

    ctx.amoCrmGet = async (url, params) =>
      url.endsWith("/leads") && params["filter[updated_at][from]"] && String(params["filter[pipeline_id]"]) === String(F.PIPELINE.METAL)
        ? { status: 200, data: { _embedded: { leads: [leads[100]] } } }
        : url.endsWith("/leads") && params["filter[updated_at][from]"]
          ? { status: 204, data: null }
          : baseGet(url, params);

    const today = ctx.getMoscowDate();
    const pad = (v) => String(v).padStart(2, "0");
    const day = `${pad(today.getUTCDate())}.${pad(today.getUTCMonth() + 1)}.${today.getUTCFullYear()}`;

    await say(foreman, "Отчет");
    await say(foreman, "Выбрать период");
    assert.match(await say(foreman, "вчера"), /Не удалось распознать/);

    const out = await say(foreman, day);

    assert.match(out, /Кол-во выполненных монтажей: 1/);
    assert.match(out, /Договор № 1234/);

    await say(manager, "Отчет");
    await say(manager, "Выбрать период");
    assert.match(await say(manager, day), /Иванов Иван:[\s\S]*Общий отчет\. Воронка Металл/);

    ctx.amoCrmGet = baseGet;
  });

  await check("T-3: предстоящие монтажи (бригадир и руководитель)", async () => {
    const out = await say(foreman, "Предстоящие монтажи");

    assert.match(out, /15\.12\.2026, 1234, Закрытый каркас, Кол-во этажей: 2\./);
    assert.match(out, /15\.12\.2026, 777, Деревянная лестница/);
    assert.match(await say(manager, "Предстоящие монтажи"), /Иванов Иван\n1\. [^\n]*1234/);
  });

  await check("T-4: подтвердить монтаж — перенос выезда и дефект", async () => {
    tasks.push({ id: 904, task_type_id: F.TASK_TYPE.CONFIRM_MONTAGE, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW });
    tasks.push({ id: 910, task_type_id: F.TASK_TYPE.CONFIRM_MONTAGE, is_completed: false, entity_id: 100, complete_till: NOW - 5 * 86400, updated_at: NOW });

    assert.match(await say(foreman, "Подтвердить монтаж"), /Подтвердите выезд:\n1\) 15\.12\.2026/);
    assert.match(await say(foreman, "1234"), /Уточнить у Заказчика/);
    assert.match(await say(foreman, "Выезд перенесен"), /Укажите комментарий/);

    const out = await say(foreman, "Клиент болеет");

    assert.match(out, /закрыта с результатом "Выезд перенесен"/);
    assert.match(out, /Задач по подтверждению монтажей не найдено/);
    assert.strictEqual(tasks.find((t) => t.id === 904).result, "Выезд перенесен");
    assert.ok(notes.includes("Клиент болеет"));

    tasks.push({ id: 905, task_type_id: F.TASK_TYPE.CONFIRM_MONTAGE, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW });
    await say(foreman, "Подтвердить монтаж");
    await say(foreman, "1234");
    await say(foreman, "Дефект изделия");
    assert.match(await say(foreman, "Вмятина на ступени"), /Прикрепите фото дефекта/);
    assert.match(await say(foreman, "", photo), /Файл сохранен/);
    assert.match(await say(foreman, "Завершить загрузку"), /Ваши замечания приняты/);
    assert.strictEqual(tasks.find((t) => t.id === 905).result, "Дефект изделия");
    assert.ok(notes.some((t) => t.startsWith("Вмятина на ступени\nФото дефекта: https://disk.test/")));
    assert.ok(leads[100].custom_fields_values.some((f) => f.field_id === F.FIELD.PHOTO_LINK));
  });

  await check("T-6 лекала: «Перенос выезда» (комментарий → примечание → список)", async () => {
    tasks.push({ id: 906, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 101, complete_till: NOW, updated_at: NOW });

    const list = await say(foreman, "Загрузить отчет");

    assert.match(list, /Снятие лекал:\n1\) 15\.12\.2026/);
    assert.ok(sent[0].buttons.includes("📐 777"));

    const card = await say(foreman, "📐 777");

    assert.match(card, /Лекала сняты[\s\S]*Монтаж каркаса[\s\S]*ул\. Ленина, 32[\s\S]*Договор № 777/);
    assert.deepStrictEqual(sent[0].buttons, ["Лекала сняты", "Перенос выезда"]);
    assert.match(await say(foreman, "Перенос выезда"), /Укажите комментарий/);

    const out = await say(foreman, "Нет доступа в дом");

    assert.match(out, /закрыта с результатом "Перенос выезда"/);
    assert.strictEqual(tasks.find((t) => t.id === 906).result, "Перенос выезда");
    assert.ok(notes.includes("Нет доступа в дом"));
  });

  await check("T-6 лекала: «Лекала сняты» — пробег, скрин, фото лекал, фото лестницы, цена «Бюджет/100*A»", async () => {
    tasks.push({ id: 907, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 101, complete_till: NOW, updated_at: NOW });

    await say(foreman, "Загрузить отчет");
    await say(foreman, "📐 777");
    assert.match(await say(foreman, "Лекала сняты"), /числовое значение пробега/);
    assert.match(await say(foreman, "xx"), /введите число\./);
    assert.match(await say(foreman, "50"), /скрин навигатора/);
    assert.match(await uploadAndContinue(foreman), /фото лекал/);
    assert.match(await uploadAndContinue(foreman), /фото лестницы/);
    assert.match(await say(foreman, "", photo), /Дополните фотоотчёт/);
    assert.deepStrictEqual(sent[sent.length - 1].buttons, ["Завершить отчёт"]);

    const out = await say(foreman, "Завершить отчёт");

    assert.match(out, /результатом "Лекалы сняты"/);
    // (200000/100*1.5 + 3000*0.01) * 1.02 = 3090.6 → 3091
    assert.strictEqual(readSlotValue("price", 0, 101), 3091);
    assert.strictEqual(readSlotValue("kmFact", 0, 101), 50);
    assert.strictEqual(tasks.find((t) => t.id === 907).result, "Лекалы сняты");
    assert.strictEqual(readSlotValue("date", 0, 101), undefined);
  });

  await check("T-6: «Заказчик отсутствует» и «Не получил» (Контроль для Юлии, примечание)", async () => {
    tasks.push({ id: 909, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW });
    const before = createdTasks.length;
    const senseiBefore = senseiCalls.length;

    await say(foreman, "Загрузить отчет");
    await say(foreman, "🔧 1234");
    await say(foreman, "Монтаж завершён");
    assert.match(await say(foreman, "Заказчик отсутствует"), /Оплата от клиента получена\./);
    assert.match(await say(foreman, "Не получил"), /Укажите комментарий/);
    assert.match(await say(foreman, "Заплатит позже"), /пробега доставки/);
    assert.match(await say(foreman, "Пропустить"), /транспортного пробега/);
    await say(foreman, "10");
    await uploadAndContinue(foreman);
    assert.match(await say(foreman, "Пропустить"), /Укажите доп\. работы\./);
    assert.match(await say(foreman, "Пропустить"), /фото\/видео установленной лестницы/);
    await say(foreman, "", photo);

    assert.match(await say(foreman, "Завершить отчёт"), /"Монтаж завершен"/);
    // запущен процесс Sensei 78045 — своя задача не создаётся
    assert.strictEqual(createdTasks.length, before);
    assert.strictEqual(senseiCalls.length, senseiBefore + 1);
    assert.strictEqual(senseiCalls[senseiBefore].url, "https://api.sensei.plus/v1/process/start/78045");

    // запасной вариант: без токена Sensei — «Контроль» для Юлии
    delete process.env.SENSEI_TOKEN;
    tasks.push({ id: 911, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW });
    await say(foreman, "Загрузить отчет");
    await say(foreman, "🔧 1234");
    await say(foreman, "Монтаж завершён");
    await say(foreman, "Заказчик отсутствует");
    await say(foreman, "Получил");
    await uploadAndContinue(foreman);
    await say(foreman, "Пропустить");
    await say(foreman, "10");
    await uploadAndContinue(foreman);
    await say(foreman, "Пропустить");
    await say(foreman, "Пропустить");
    await say(foreman, "", photo);
    await say(foreman, "Завершить отчёт");
    process.env.SENSEI_TOKEN = "sensei-test";
    assert.strictEqual(createdTasks.length, before + 2); // + «Получена оплата» + «Контроль» для Юлии
    assert.ok(createdTasks.some((t) => t.responsible_user_id === F.USER.REDKINA_YULIA && t.text === "Заказчик отсутствовал на объекте. Выслать акт электронно."));
    assert.ok(notes.includes("Заплатит позже"));
    assert.strictEqual(readSlotValue("kmFact"), 10);
  });

  await check("T-6: «Доп хотелки» и «Промежуточный отчёт» (частично, нужны детали, фото)", async () => {
    tasks.push({ id: 908, task_type_id: F.TASK_TYPE.MONTAGE_REPORT, is_completed: false, entity_id: 100, complete_till: NOW, updated_at: NOW });
    leads[100].custom_fields_values.push(field(F.FIELD.PHOTO_LINK, "https://old"));

    await say(foreman, "Загрузить отчет");
    await say(foreman, "🔧 1234");
    assert.match(await say(foreman, "Доп хотелки"), /Укажите комментарий/);
    assert.match(await say(foreman, "Хочу розетку"), /Информация отправлена[\s\S]*Монтаж проведён\./);
    const lastCall = senseiCalls[senseiCalls.length - 1];

    assert.strictEqual(lastCall.url, "https://api.sensei.plus/v1/process/start/72111");
    assert.deepStrictEqual(lastCall.body, { data: [{ entity_id: 100, entity_type: 1 }] });
    assert.strictEqual(lastCall.token, "sensei-test");
    assert.strictEqual(leads[100].custom_fields_values.find((f) => f.field_id === F.FIELD.BOT_NOTE).values[0].value, "Хочу розетку");

    assert.match(await say(foreman, "Промежуточный отчёт"), /Часть изделия установлена\?/);
    assert.deepStrictEqual(sent[0].buttons, ["Частично", "Не установлено"]);
    assert.match(await say(foreman, "Частично"), /Нужны ли детали\?/);
    assert.match(await say(foreman, "Да"), /Укажите комментарий/);
    assert.match(await say(foreman, "Нужны кронштейны"), /Добавить фото\?/);
    assert.match(await say(foreman, "Да"), /Загрузите фото/);
    assert.match(await uploadAndContinue(foreman), /числовое значение пробега/);
    assert.match(await say(foreman, "10"), /скрин навигатора/);
    assert.match(await uploadAndContinue(foreman), /фото\/видео установленной лестницы/);
    assert.match(await say(foreman, "", photo), /Дополните фотоотчёт/);

    const out = await say(foreman, "Завершить отчёт");

    assert.match(out, /результатом "Промежуточный отчет\. Нужны детали"/);
    assert.ok(notes.includes("Изделие частично установлено"));
    assert.ok(notes.includes("Нужны кронштейны"));
    const link = leads[100].custom_fields_values.find((f) => f.field_id === F.FIELD.PHOTO_LINK);

    assert.ok(link && decodeURIComponent(link.values[0].value).includes("Нужны детали"), "ссылки «Нужны детали» должны заменить старую");
    assert.strictEqual(tasks.find((t) => t.id === 908).result, "Промежуточный отчет. Нужны детали");
    assert.match(await say(manager, "Уведомления"), /Монтаж по договору № 1234 не завершен\. Нужны детали\. Монтажник Иванов Иван/);
  });

  await check("повторное «Завершить» не плодит задачи и записи", async () => {
    const before = createdTasks.length;

    await say(foreman, "Завершить отчёт");
    assert.strictEqual(createdTasks.length, before);
  });

  await check("группы доп. работ: дерево, уличные, ограждения, фальшпол", () => {
    assert.strictEqual(calc.getExtrasGroup("Деревянная лестница"), "g2");
    assert.strictEqual(calc.getExtrasGroup("Лестница ДПК"), "g3");
    assert.strictEqual(calc.getExtrasGroup("Терраса"), "g4");
    assert.strictEqual(calc.getExtrasGroup("Подоконники"), "g5");
    assert.strictEqual(calc.getExtrasGroup("Фальшпол (1-м2)"), "g6");
    assert.strictEqual(calc.getExtrasGroup("Нестандарт"), null);
  });

  console.log(`\nПройдено проверок: ${passed}${process.exitCode ? " — ЕСТЬ ОШИБКИ" : " — всё хорошо"}`);
  process.exit(process.exitCode || 0);
}

main();
