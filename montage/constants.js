// ============================================================
// БОТ МОНТАЖНИКОВ — КОНСТАНТЫ (ID воронок, задач, полей amoCRM)
// Источник: ТЗ «Монтажники», таблицы 1–3 и разделы 3.1–3.3.
// ============================================================

const PIPELINE = {
  METAL: 207259, // Металл
  WOOD: 585508, // Дерево
  RECLAMATION: 4689981, // Рекламации
  WOOD_PRODUCTION: 3797814, // Дерево производство
  METAL_PRODUCTION: 3285168 // Производство (металл) — нужна только для отчётов
};

// Воронки, где ищем сделки для T-6 / T-9 / T-11.
const SALES_PIPELINE_IDS = [PIPELINE.METAL, PIPELINE.WOOD, PIPELINE.RECLAMATION, PIPELINE.WOOD_PRODUCTION];

// Воронки, по которым строится отчёт (T-10).
const REPORT_PIPELINE_IDS = [
  PIPELINE.METAL_PRODUCTION,
  PIPELINE.WOOD_PRODUCTION,
  PIPELINE.METAL,
  PIPELINE.WOOD,
  PIPELINE.RECLAMATION
];

// T-3: статусы «предстоящий монтаж» по воронкам.
const UPCOMING_STATUS = {
  [PIPELINE.METAL]: 12776226, // «Договорились о монтаже»
  [PIPELINE.WOOD]: 14750962, // «Договорились о монтаже»
  [PIPELINE.RECLAMATION]: 54291361, // «Монтаж назначен»
  [PIPELINE.WOOD_PRODUCTION]: 55729833 // «Лекалы назначены» (только у бригадира)
};

// Таблица 3. Типы задач amoCRM.
const TASK_TYPE = {
  CONTROL: 1874499,
  ACCEPT_REPORT: 1874568, // «Принять отчет»
  FIXES: 3193621, // «Правки в отчет»
  CONFIRM_MONTAGE: 3172977, // «Подт-ть монтаж»
  MONTAGE_REPORT: 3178069 // «Отчет о монтаже»
};

// Результаты закрытия задач (названия — строго из ТЗ).
const RESULT = {
  MONTAGE_DONE: "Монтаж завершен",
  LEKALS_DONE: "Лекалы сняты",
  MOVED: "Перенос выезда",
  INTERMEDIATE: "Промежуточный отчет",
  INTERMEDIATE_DETAILS: "Промежуточный отчет нужны детали",
  CONFIRMED: "Выезд подтвержден",
  TRIP_MOVED: "Выезд перенесен",
  DEFECT: "Дефект изделия",
  REPORT_ACCEPTED: "Отчет принят",
  SEND_BACK: "Отдать на доработку",
  FIXES_DONE: "Правки внесены"
};

// Поля сделки с известными ID.
const FIELD = {
  MONTAGER: 446003, // «Монтажник» (список)
  LEKALSHIK: 552052, // «Лекальщик» (список)
  PRODUCT: 172572, // «Продукт»
  PHOTO_LINK: 555164, // «[Бот] Ссылка на фото»
  BOT_NOTE: 557530, // «[Бот] Примечание»
  ACT: 543272, // «Акт приема-передачи»
  PAYMENT_REMAINDER: 557528, // «Остаток платежа»
  CONTRACT_NUMBER: 412776, // «№ Дог/Зам. листа» (текст)
  CONTRACT_LINK: 543268, // «Проект в производство pdf» (ссылка)
  MONTAGE_FOLDER: 557522, // «Ссылка на папку Монтаж»
  TERMS: 415784, // «Сроки монтажа» (дата)
  FLOORS: 415782, // «Количество этажей?»
  ADDRESS: 175412, // «Адрес объекта»
  LEKAL_DATE: 552050, // «Дата снятия лекал»
  MONTAGE_AMOUNT: 557700, // «Монтаж изделия (м/п или м2)»
  MASTER_COMMENT: 557660, // «Комментарий для монтажника»
  COST_APPROVAL_FLAG: 555158 // «[Бот] Согласование стоимости» (запасной вариант, если «(new)» не найдено)
};

const COST_APPROVAL_NEW_FIELD_NAME = "[Бот] Согласование стоимости(new)";
const COST_APPROVAL_REQUESTED = "Согласовать стоимость";
const COST_APPROVAL_NOT_NEEDED = "Согласование не нужно";

// Таблица 2. Группы полей: «1. …», «2. …», «3. …» (слот монтажника).
const SLOT_FIELDS = [
  {
    master: 551818, price: 551820, extra: 557714, date: 551822, kmDelivery: 557558, kmFact: 551824,
    tempSteps: 557702, finish: 557708, fence: 557564, extraHours: 557570, platform: 557576, canopy: 557582,
    piles: 557588, falsefloor: 557594, tariff: 551826, tariffDelivery: 557768, kmFactTotal: 551828,
    kmDeliveryTotal: 561262, ktuVideo: 557664, ktuTimelapse: 557670, ktuReviewVideo: 557678,
    ktuRegulations: 557684, ktuReport: 557688, ktuReviewSite: 557694, note: 551860
  },
  {
    master: 551834, price: 551836, extra: 557716, date: 551838, kmDelivery: 557560, kmFact: 551840,
    tempSteps: 557704, finish: 557710, fence: 557566, extraHours: 557572, platform: 557578, canopy: 557584,
    piles: 557590, falsefloor: 557596, tariff: 551842, tariffDelivery: 557770, kmFactTotal: 551844,
    kmDeliveryTotal: 561264, ktuVideo: 557666, ktuTimelapse: 557672, ktuReviewVideo: 557676,
    ktuRegulations: 557686, ktuReport: 557690, ktuReviewSite: 557696, note: 551862
  },
  {
    master: 551846, price: 551848, extra: 557718, date: 551850, kmDelivery: 557562, kmFact: 551852,
    tempSteps: 557706, finish: 557712, fence: 557568, extraHours: 557574, platform: 557580, canopy: 557586,
    piles: 557592, falsefloor: 557598, tariff: 551854, tariffDelivery: 557772, kmFactTotal: 551856,
    kmDeliveryTotal: 561266, ktuVideo: 557668, ktuTimelapse: 557674, ktuReviewVideo: 557680,
    ktuRegulations: 557682, ktuReport: 557692, ktuReviewSite: 557698, note: 551864
  }
];

// Баллы КТУ: соответствие «для баллов КТУ сделано» (настройки виджета) ↔ ключ поля слота.
const KTU_KINDS = [
  { label: "Видео общее", slotKey: "ktuVideo" },
  { label: "Видео таймлапс", slotKey: "ktuTimelapse" },
  { label: "Видео-отзыв клиента", slotKey: "ktuReviewVideo" },
  { label: "Исполнение регламентов", slotKey: "ktuRegulations" },
  { label: "Отчёт у монтажника", slotKey: "ktuReport" },
  { label: "Отзыв в отзовике или Яндексе", slotKey: "ktuReviewSite" }
];

module.exports = {
  PIPELINE,
  SALES_PIPELINE_IDS,
  REPORT_PIPELINE_IDS,
  UPCOMING_STATUS,
  TASK_TYPE,
  RESULT,
  FIELD,
  COST_APPROVAL_NEW_FIELD_NAME,
  COST_APPROVAL_REQUESTED,
  COST_APPROVAL_NOT_NEEDED,
  SLOT_FIELDS,
  KTU_KINDS
};
