// ============================================================
// БОТ МОНТАЖНИКОВ — общие кнопки/тексты и расчёт цены по данным сделки
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const { FIELD, PIPELINE, SLOT_FIELDS, KTU_KINDS } = require("./constants");

const BTN = {
  SKIP: "Пропустить",
  FINISH_UPLOAD: "Завершить загрузку",
  CONTINUE: "Продолжить",
  YES: "Да",
  NO: "Нет",
  NEXT: "Далее",
  BACK: "Назад"
};

const MSG_NOT_NUMBER = "Не удалось распознать введённое значение, пожалуйста, введите число.";
const MSG_NOT_INTEGER = "Не удалось распознать введённое значение, пожалуйста, введите целое число.";

function say(env, text, buttons, markdown) {
  return messenger.send(env.ctx, env.directId, text, buttons, markdown ? { markdown: true } : undefined);
}

// Данные для формул T-8 из слота монтажника и полей сделки.
function priceInputs(ctx, lead, slot) {
  return {
    floors: amo.fieldNumber(ctx, lead, FIELD.FLOORS),
    budget: Number(lead.price) || 0,
    amount: amo.fieldNumber(ctx, lead, FIELD.MONTAGE_AMOUNT),
    tempSteps: slot.tempSteps,
    fence: slot.fence,
    extraHours: slot.extraHours,
    finish: slot.finish,
    platform: slot.platform,
    canopy: slot.canopy,
    piles: slot.piles,
    falsefloor: slot.falsefloor
  };
}

// Расчёт цены по данным, уже записанным в сделку (T-7.7, T-9).
// Возвращает { calculated|null, group, motivation } — null, если продукт
// не найден в таблице расчёта.
function recalculatePrice(ctx, lead, slotIndex, foremanName) {
  const settings = settingsStore.get();
  const slot = amo.readSlot(ctx, lead, slotIndex);
  const productName = amo.fieldText(ctx, lead, FIELD.PRODUCT);
  const group = calc.getProductGroup(productName, lead.pipeline_id, PIPELINE.WOOD_PRODUCTION);
  const row = settingsStore.findPricingRow(settings, amo.fieldEnumId(lead, FIELD.PRODUCT), productName);
  const motivation = settingsStore.findMotivation(settings, settingsStore.findRowByForemanName(settings, foremanName));
  const calculated = group && row ? calc.calcMontagePrice(group, row, priceInputs(ctx, lead, slot), motivation) : null;

  return { calculated, group, motivation, slot };
}

// Строки КТУ слота с ненулевыми баллами: [{label, slotKey, value}].
function filledKtu(slot) {
  return KTU_KINDS.map((kind) => ({ ...kind, value: calc.num(slot[kind.slotKey]) })).filter((item) => item.value > 0);
}

// Тариф: записанный в сделке, иначе из «Мотивации роли».
function tariffs(slot, motivation) {
  return {
    transport: slot.tariff || calc.num(motivation && motivation.transportTariff),
    delivery: slot.tariffDelivery || calc.num(motivation && motivation.deliveryTariff)
  };
}

module.exports = {
  BTN,
  MSG_NOT_NUMBER,
  MSG_NOT_INTEGER,
  say,
  priceInputs,
  recalculatePrice,
  filledKtu,
  tariffs,
  SLOT_FIELDS
};
