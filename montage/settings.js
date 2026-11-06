// ============================================================
// БОТ МОНТАЖНИКОВ — НАСТРОЙКИ ВИДЖЕТА (хранение в Redis, проверка,
// поиск пользователя и тарифов)
// Источник — раздел «Монтажники» виджета в amoCRM (4 вкладки):
//   motivations — «Мотивация роли»
//   users       — «Пользователи бота Монтажники»
//   pricing     — «Расчет стоимости монтажа»
//   ktu         — «Баллы КТУ»
// ============================================================

const calc = require("./calc");
const { KTU_KINDS } = require("./constants");

const SETTINGS_KEY = "widget_montage_settings";

let cache = null;

function get() {
  return cache;
}

function set(value) {
  cache = value;
}

async function load(ctx) {
  try {
    const response = await ctx.redisRequest(["GET", SETTINGS_KEY]);

    if (response && response.result) {
      cache = JSON.parse(response.result);
      console.log("[Бот монтажников] Настройки виджета загружены из Redis.");
    } else {
      console.log("[Бот монтажников] В Redis пока нет настроек виджета «Монтажники».");
    }
  } catch (error) {
    console.error("[Бот монтажников] Ошибка загрузки настроек виджета:", error.message);
  }
}

async function save(ctx, settings) {
  const payload = { ...settings, updatedAt: new Date().toISOString() };

  await ctx.redisRequest(["SET", SETTINGS_KEY, JSON.stringify(payload)]);
  cache = payload;
  console.log("[Бот монтажников] Настройки виджета сохранены в Redis.");

  return payload;
}

function isNullOrNumber(value) {
  return value === null || value === undefined || value === "" || (typeof value === "number" && Number.isFinite(value));
}

const PRICING_KEYS = ["X1", "X2", "A", "Y1", "Y2", "Y3", "B", "Y4", "Y5", "Y6", "Y7"];

function validate(settings) {
  if (!settings || typeof settings !== "object") {
    return { valid: false, error: "Настройки имеют неверный формат." };
  }

  const motivations = settings.motivations || [];
  const users = settings.users || [];
  const pricing = settings.pricing || [];
  const ktu = settings.ktu || [];

  if (![motivations, users, pricing, ktu].every(Array.isArray)) {
    return { valid: false, error: "Настройки имеют неверный формат." };
  }

  const names = new Set();

  for (const item of motivations) {
    const name = calc.normalizeName(item && item.name);

    if (!name) {
      return { valid: false, error: "«Мотивация роли»: у строки не заполнено название." };
    }

    if (names.has(name)) {
      return { valid: false, error: `«Мотивация роли»: название «${item.name}» повторяется.` };
    }

    names.add(name);

    for (const key of ["transportTariff", "deliveryTariff", "personalBonus", "mentoring"]) {
      if (!isNullOrNumber(item[key]) || (typeof item[key] === "number" && item[key] < 0)) {
        return { valid: false, error: `«Мотивация роли» (${item.name}): значения должны быть числами от 0.` };
      }
    }
  }

  const foremen = new Set();

  for (const row of users) {
    if (!row || !String(row.foremanName || "").trim()) {
      return { valid: false, error: "«Пользователи бота»: не выбран бригадир (поле в amoCRM)." };
    }

    if (!String(row.managerHandle || "").trim()) {
      return { valid: false, error: `«Пользователи бота» (${row.foremanName}): заполните руководителя (имя и/или telegram).` };
    }

    const key = calc.normalizeName(row.foremanName);

    if (foremen.has(key)) {
      return { valid: false, error: `«Пользователи бота»: бригадир «${row.foremanName}» указан дважды.` };
    }

    foremen.add(key);

    if (row.motivation && !names.has(calc.normalizeName(row.motivation))) {
      return { valid: false, error: `«Пользователи бота» (${row.foremanName}): нет мотивации «${row.motivation}».` };
    }
  }

  const products = new Set();

  for (const row of pricing) {
    if (!row || !row.enumId) {
      return { valid: false, error: "«Расчет стоимости монтажа»: в строке не выбран продукт." };
    }

    if (products.has(Number(row.enumId))) {
      return { valid: false, error: `«Расчет стоимости монтажа»: продукт «${row.productName}» указан дважды.` };
    }

    products.add(Number(row.enumId));

    for (const key of PRICING_KEYS) {
      if (!isNullOrNumber(row[key]) || (typeof row[key] === "number" && row[key] < 0)) {
        return { valid: false, error: `«Расчет стоимости монтажа» (${row.productName}): ${key} — число от 0.` };
      }
    }
  }

  const kinds = new Set();

  for (const row of ktu) {
    if (!row || !KTU_KINDS.some((item) => item.label === row.kind)) {
      return { valid: false, error: "«Баллы КТУ»: не выбрано, за что начисляются баллы." };
    }

    if (kinds.has(row.kind)) {
      return { valid: false, error: `«Баллы КТУ»: «${row.kind}» указано дважды.` };
    }

    kinds.add(row.kind);

    if (typeof row.points !== "number" || !Number.isFinite(row.points) || row.points < 0) {
      return { valid: false, error: `«Баллы КТУ» (${row.kind}): баллы — число от 0.` };
    }
  }

  return { valid: true };
}

// ------------------------------------------------------------
// Поиск по настройкам
// ------------------------------------------------------------

// Бригадир: ник в настройках или имя в amoCRM совпадает с именем в мессенджере.
function findForemanRow(settings, userName) {
  return (
    ((settings && settings.users) || []).find(
      (row) => calc.namesMatch(row.foremanHandle, userName) || calc.namesMatch(row.foremanName, userName)
    ) || null
  );
}

// Руководитель: строки всех его бригадиров.
function findManagerRows(settings, userName) {
  return ((settings && settings.users) || []).filter((row) => calc.namesMatch(row.managerHandle, userName));
}

function resolveRoles(settings, userName) {
  const roles = [];

  if (findForemanRow(settings, userName)) {
    roles.push("foreman");
  }

  if (findManagerRows(settings, userName).length > 0) {
    roles.push("manager");
  }

  return roles;
}

function findMotivation(settings, row) {
  if (!row || !row.motivation) {
    return null;
  }

  return (
    ((settings && settings.motivations) || []).find(
      (item) => calc.normalizeName(item.name) === calc.normalizeName(row.motivation)
    ) || null
  );
}

// Строка бригадира по имени в amoCRM (значение поля «Монтажник»).
function findRowByForemanName(settings, foremanName) {
  return ((settings && settings.users) || []).find((row) => calc.sameName(row.foremanName, foremanName)) || null;
}

function findPricingRow(settings, enumId, productName) {
  const rows = (settings && settings.pricing) || [];

  return (
    (enumId && rows.find((row) => Number(row.enumId) === Number(enumId))) ||
    rows.find((row) => calc.normalizeProduct(row.productName) === calc.normalizeProduct(productName)) ||
    null
  );
}

function ktuPoints(settings, kindLabel) {
  const row = ((settings && settings.ktu) || []).find((item) => item.kind === kindLabel);

  return row ? calc.num(row.points) : 0;
}

module.exports = {
  get,
  set,
  load,
  save,
  validate,
  findForemanRow,
  findManagerRows,
  resolveRoles,
  findMotivation,
  findRowByForemanName,
  findPricingRow,
  ktuPoints
};
