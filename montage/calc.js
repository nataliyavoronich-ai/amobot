// ============================================================
// БОТ МОНТАЖНИКОВ — ЧИСТЫЕ ФУНКЦИИ (без обращений к amoCRM/Redis)
// Расчёт стоимости (ТЗ T-8), сравнение имён, разбор чисел и периодов.
// Здесь нет ничего, что ходило бы в сеть, поэтому всё проверяется
// автоматическими тестами (montageBot.test.js).
// ============================================================

// ------------------------------------------------------------
// Имена
// ------------------------------------------------------------

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

// Слова имени/ника: «@ivanov_ivan2023», «Иванов Иван» → набор слов без «@».
function nameTokens(value) {
  return normalizeName(value)
    .split(/[\s,;]+/)
    .map((token) => token.replace(/^@/, ""))
    .filter(Boolean);
}

// ВСЕ слова имени пользователя должны входить в значение поля («Иван
// Иванов» ↔ «Иванов Иван @ivan_tg»). Регистр, «ё» и «@» не важны.
function namesMatch(fieldValue, userName) {
  const field = nameTokens(fieldValue);
  const user = nameTokens(userName);

  return field.length > 0 && user.length > 0 && user.every((token) => field.includes(token));
}

// Полное совпадение набора слов (для сопоставления значения поля amoCRM
// «Иванов Иван» с настройкой «Иванов Иван»).
function sameName(a, b) {
  const x = nameTokens(a).sort().join(" ");
  const y = nameTokens(b).sort().join(" ");

  return x !== "" && x === y;
}

// ------------------------------------------------------------
// Числа
// ------------------------------------------------------------

// «12,5», «12.5», «8%», « 100 » → число; всё остальное → null.
function parseNumber(text) {
  const cleaned = String(text === null || text === undefined ? "" : text)
    .trim()
    .replace(/\s+/g, "")
    .replace(/%$/, "")
    .replace(",", ".");

  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const value = Number(cleaned);

  return Number.isFinite(value) ? value : null;
}

function parseInteger(text) {
  const value = parseNumber(text);

  return value !== null && Number.isInteger(value) ? value : null;
}

function num(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// Число для сообщений: без хвоста «.00», запятая как у людей.
function fmt(value) {
  return String(round2(value)).replace(".", ",");
}

function formatMoney(value) {
  return round2(value).toLocaleString("ru-RU").replace(/\s/g, " ");
}

// ------------------------------------------------------------
// Группы продуктов для формул T-8
// ------------------------------------------------------------

function normalizeProduct(value) {
  return normalizeName(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/проф\.? трубы/g, "профильной трубы")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCTS_FLOORS = [
  "закрытый каркас",
  "закрытый каркас 2 мм",
  "закрытый каркас на листе",
  "консольная лестница",
  "винтовая лестница",
  "открытый каркас из листа",
  "открытый каркас 2 мм",
  "открытый каркас из профильной трубы",
  "монокосоур из профильной трубы",
  "монокосоур из листа",
  "нестандарт",
  "лестница дпк",
  "дпк с огр дпк",
  "дпк с ограждениями",
  "закрытый каркас с ограждениями",
  "комбо металл",
  "loft"
];

// В исходном ТЗ эти продукты есть в обоих первых списках; считаем по
// формуле «за единицу» (м/п, м2) — она для них осмысленна.
const PRODUCTS_METER = [
  "металлические ограждения",
  "ограждения из листа",
  "перила нержавейка",
  "перила из нержавейки",
  "фальшпол",
  "терраса",
  "навес"
];

const PRODUCTS_WOOD = [
  "закрытый каркас в дереве",
  "закрытый каркас 2 мм в дереве",
  "деревянная лестница",
  "консольная лестница в дереве",
  "открытый каркас в дереве",
  "монокосоур в дереве",
  "подоконники",
  "подсветка",
  "цельнометаллическая",
  "пожарная/эвакуационная",
  "дерево с ограждениями из металла",
  "обшивка бетонной лестницы",
  "обшивка бетонной лестниц",
  "комбо дерево"
];

// Группа формулы: "floors" | "meter" | "woodProduction" | "woodSales" | null.
function getProductGroup(productName, pipelineId, woodProductionPipelineId) {
  const name = normalizeProduct(productName);

  if (!name) {
    return null;
  }

  if (PRODUCTS_METER.includes(name)) {
    return "meter";
  }

  if (PRODUCTS_FLOORS.includes(name)) {
    return "floors";
  }

  if (PRODUCTS_WOOD.includes(name)) {
    return Number(pipelineId) === Number(woodProductionPipelineId) ? "woodProduction" : "woodSales";
  }

  return null;
}

// Какие вопросы нужны для расчёта по группе (то, что входит в формулу).
// Порядок — порядок вопросов в отчёте.
const QUESTIONS_BY_GROUP = {
  floors: ["tempSteps", "fence", "platform", "canopy", "piles", "falsefloor", "finish", "extraHours"],
  meter: ["amount", "falsefloor", "extraHours"],
  woodSales: ["tempSteps"],
  woodProduction: ["extraHours"]
};

// ------------------------------------------------------------
// Расчёт стоимости (T-8)
// ------------------------------------------------------------

// row — строка таблицы «Расчет стоимости монтажа» {X1, X2, A, Y1…Y7, B};
// v — введённые значения {floors, fence, tempSteps, extraHours, finish,
//     platform, canopy, piles, falsefloor, amount, budget};
// motivation — {personalBonus, mentoring} из «Мотивация роли».
// Пустые значения = 0 (ТЗ T-8.1).
function calcMontagePrice(group, row, v, motivation) {
  const R = row || {};
  const terms = []; // слагаемые базового тарифа: {value, text}
  const pTerms = []; // слагаемые P
  const floors = num(v.floors);

  function add(list, value, text) {
    if (value !== 0) {
      list.push({ value, text });
    }
  }

  // «Доп.работы (ч)»: первые 2 часа бесплатно; при ≤ 1 — не учитываем.
  function extraHoursTerm() {
    const hours = num(v.extraHours);

    if (hours <= 1) {
      return;
    }

    add(terms, Math.max(0, hours - 2) * num(R.Y3), `(${fmt(hours)}(Доп.работы, ч) − 2) × ${fmt(R.Y3)}`);
  }

  let P = 0;

  if (group === "floors") {
    const a = num(R.X1) * floors;
    const b = num(R.Y1) * num(v.fence);

    add(pTerms, a, `${fmt(R.X1)} × ${fmt(floors)}(этажей)`);
    add(pTerms, b, `${fmt(R.Y1)} × ${fmt(v.fence)}(ограждения м/п)`);
    P = a + b;

    add(terms, a, `${fmt(R.X1)} × ${fmt(floors)}(этажей)`);
    add(terms, b, `${fmt(R.Y1)} × ${fmt(v.fence)}(ограждения м/п)`);
    add(
      terms,
      num(v.tempSteps) * floors * num(R.Y2),
      `${fmt(v.tempSteps)}(монтаж/демонтаж врем. ступеней) × ${fmt(floors)}(этажей) × ${fmt(R.Y2)}`
    );
    extraHoursTerm();
    // B — процент: «Чистовая отделка» = B% от P.
    add(
      terms,
      (num(R.B) / 100) * num(v.finish) * P,
      `${fmt(R.B)}%(чистовая) × ${fmt(v.finish)}(чистовая отделка) × ${fmt(P)}(P)`
    );
    add(terms, num(v.platform) * num(R.Y4), `${fmt(v.platform)}(площадка м2) × ${fmt(R.Y4)}`);
    add(terms, num(v.canopy) * num(R.Y5), `${fmt(v.canopy)}(навес м2) × ${fmt(R.Y5)}`);
    add(terms, num(v.piles) * num(R.Y6), `${fmt(v.piles)}(сваи шт) × ${fmt(R.Y6)}`);
    add(terms, num(v.falsefloor) * num(R.Y7), `${fmt(v.falsefloor)}(фальшпол м2) × ${fmt(R.Y7)}`);
  } else if (group === "meter") {
    const a = num(R.X2) * num(v.amount);

    add(pTerms, a, `${fmt(R.X2)} × ${fmt(v.amount)}(монтаж изделия м/п или м2)`);
    P = a;

    add(terms, a, `${fmt(R.X2)} × ${fmt(v.amount)}(монтаж изделия м/п или м2)`);
    extraHoursTerm();
    add(terms, num(v.falsefloor) * num(R.Y7), `${fmt(v.falsefloor)}(фальшпол м2) × ${fmt(R.Y7)}`);
  } else if (group === "woodProduction") {
    // Бюджет/100*A (A — процент за снятие лекал).
    const a = (num(v.budget) / 100) * num(R.A);

    add(pTerms, a, `${fmt(v.budget)}(бюджет)/100 × ${fmt(R.A)}%`);
    P = a;

    add(terms, a, `${fmt(v.budget)}(бюджет)/100 × ${fmt(R.A)}%`);
    extraHoursTerm();
  } else if (group === "woodSales") {
    const a = (num(v.budget) / 100) * num(R.X1);

    add(pTerms, a, `${fmt(v.budget)}(бюджет)/100 × ${fmt(R.X1)}%`);
    P = a;

    add(terms, a, `${fmt(v.budget)}(бюджет)/100 × ${fmt(R.X1)}%`);
    add(
      terms,
      num(v.tempSteps) * floors * num(R.Y2),
      `${fmt(v.tempSteps)}(монтаж/демонтаж врем. ступеней) × ${fmt(floors)}(этажей) × ${fmt(R.Y2)}`
    );
  } else {
    return null;
  }

  const base = terms.reduce((sum, item) => sum + item.value, 0);
  const bonus = num(motivation && motivation.personalBonus);
  // «Наставничество» в настройках — доля надбавки (0,02 = +2%), поэтому
  // множитель 1 + значение; не заполнено — множитель 1 (ТЗ T-8.2).
  const mentoring = num(motivation && motivation.mentoring);
  const multiplier = 1 + mentoring;
  const price = Math.round((base + P * bonus) * multiplier);

  return {
    price,
    base,
    P,
    bonus,
    mentoring,
    multiplier,
    baseText: terms.map((item) => item.text).join(" + ") || "0",
    pText: pTerms.map((item) => item.text).join(" + ") || "0"
  };
}

// Текст «Описание расчета» (T-7.7): параметры, равные нулю, не выводим.
function describePriceCalc(result) {
  const lines = [];
  const bonusPart = result.bonus ? ` + (${fmt(result.P)}(P) × ${fmt(result.bonus)}(Персональная надбавка))` : "";
  const mentoringPart = result.mentoring ? ` × (1 + ${fmt(result.mentoring)}(Наставничество))` : "";

  lines.push(
    `Стоимость работ = (${fmt(result.base)}(Базовый тариф)${bonusPart})${mentoringPart} = ${fmt(result.price)}`
  );
  lines.push(`Базовый тариф = ${result.baseText} = ${fmt(result.base)}`);

  if (result.bonus) {
    lines.push(`P = ${result.pText} = ${fmt(result.P)}`);
  }

  return lines.join("\n");
}

// ------------------------------------------------------------
// Периоды отчётов (границы дней — по Москве, UTC+3)
// ------------------------------------------------------------

const MSK_OFFSET_SEC = 3 * 3600;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDate(y, m, d) {
  return `${pad2(d)}.${pad2(m + 1)}.${y}`;
}

function dayStartUnix(y, m, d) {
  return Date.UTC(y, m, d) / 1000 - MSK_OFFSET_SEC;
}

function buildPeriod(from, to) {
  const label =
    from.y === to.y && from.m === to.m && from.d === to.d
      ? formatDate(from.y, from.m, from.d)
      : `${formatDate(from.y, from.m, from.d)} - ${formatDate(to.y, to.m, to.d)}`;

  return {
    label,
    fromUnix: dayStartUnix(from.y, from.m, from.d),
    toUnix: dayStartUnix(to.y, to.m, to.d) + 86400 - 1,
    days: Math.round((dayStartUnix(to.y, to.m, to.d) - dayStartUnix(from.y, from.m, from.d)) / 86400) + 1
  };
}

// Кнопки T-10.1: «1-15 текущего месяца» и «16-конец предыдущего месяца».
// moscowNow — Date, сдвинутая на +3 часа (как getMoscowDate в amoSharedUtils).
function firstHalfOfCurrentMonth(moscowNow) {
  const y = moscowNow.getUTCFullYear();
  const m = moscowNow.getUTCMonth();

  return buildPeriod({ y, m, d: 1 }, { y, m, d: 15 });
}

function secondHalfOfPreviousMonth(moscowNow) {
  const prev = new Date(Date.UTC(moscowNow.getUTCFullYear(), moscowNow.getUTCMonth() - 1, 1));
  const y = prev.getUTCFullYear();
  const m = prev.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  return buildPeriod({ y, m, d: 16 }, { y, m, d: lastDay });
}

// «ДД.ММ.ГГГГ - ДД.ММ.ГГГГ» или «ДД.ММ.ГГГГ»; null — не распознано.
function parsePeriodText(text) {
  const match = String(text || "")
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s*-\s*(\d{2})\.(\d{2})\.(\d{4}))?$/);

  if (!match) {
    return null;
  }

  const toPart = (d, m, y) => {
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const valid =
      date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);

    return valid ? { y: Number(y), m: Number(m) - 1, d: Number(d) } : null;
  };

  const from = toPart(match[1], match[2], match[3]);
  const to = match[4] ? toPart(match[4], match[5], match[6]) : from;

  if (!from || !to) {
    return null;
  }

  const period = buildPeriod(from, to);

  return period.toUnix >= period.fromUnix ? period : null;
}

// Разбить длинный текст на сообщения по строкам.
function splitText(text, maxLength = 3500) {
  const parts = [];
  let current = "";

  for (const line of String(text).split("\n")) {
    if (current && current.length + line.length + 1 > maxLength) {
      parts.push(current);
      current = "";
    }

    current = current ? `${current}\n${line}` : line;

    while (current.length > maxLength) {
      parts.push(current.slice(0, maxLength));
      current = current.slice(maxLength);
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

module.exports = {
  normalizeName,
  nameTokens,
  namesMatch,
  sameName,
  parseNumber,
  parseInteger,
  num,
  round2,
  fmt,
  formatMoney,
  normalizeProduct,
  getProductGroup,
  QUESTIONS_BY_GROUP,
  calcMontagePrice,
  describePriceCalc,
  buildPeriod,
  firstHalfOfCurrentMonth,
  secondHalfOfPreviousMonth,
  parsePeriodText,
  splitText
};
