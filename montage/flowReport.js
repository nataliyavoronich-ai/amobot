// ============================================================
// БОТ МОНТАЖНИКОВ — T-6 «Загрузить отчет» и T-9 «Внести правки»
// (общий движок шагов; расчёт стоимости — T-8, calc.js)
//
// Сценарий реализован по описанию Т6/Т9 (уточнённая версия). Каждый шаг —
// один из четырёх блоков: выбор кнопкой (choice), число (number), текст
// (text), загрузка файлов (upload). Текущий блок хранится в flow.cur, а
// «что дальше» — именем шага (строкой), поэтому незавершённый отчёт
// целиком сохраняется в Redis и продолжается после перезапуска.
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const files = require("./files");
const channel = require("./channel");
const sensei = require("./sensei");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { recalculatePrice } = require("./ui");
const { FIELD, PIPELINE, RESULT, TASK_TYPE, USER, SLOT_FIELDS } = require("./constants");

const { mdSafe } = messenger;

const B = {
  CONTINUE: "Продолжить",
  FINISH_REPORT: "Завершить отчёт",
  SKIP: "Пропустить",
  NEXT: "Далее",
  YES: "Да",
  NO: "Нет"
};

const MSG_NOT_NUMBER = "Не удалось распознать введённое значение, пожалуйста, введите число.";
const MSG_NOT_INTEGER = "Не удалось распознать введённое значение, пожалуйста, введите целое число.";
const MSG_ADD_FILES = "Дополните фотоотчёт новыми файлами или воспользуйтесь кнопкой ниже для перехода на следующий шаг.";

// ------------------------------------------------------------
// Справочники блоков
// ------------------------------------------------------------

// Доп. работы по группам продуктов: type "flag" — в поле 1; "int" — целое число.
const HOURS = { id: "hours", label: "Доп. работы", key: "extraHours", type: "int", prompt: "Укажите количество часов." };

const EXTRA_OPTIONS = {
  g1: [
    { id: "temp", label: "Монтаж врем. ступеней", key: "tempSteps", type: "flag" },
    { id: "finish", label: "Чистовая отделка", key: "finish", type: "flag" },
    { id: "fence", label: "Установленные ограждения", key: "fence", type: "int", prompt: "Укажите количество, м/п." },
    HOURS
  ],
  g2: [{ id: "untemp", label: "Демонтаж временных ступеней", key: "tempSteps", type: "flag" }],
  g3: [
    { id: "platform", label: "Установлена площадка", key: "platform", type: "int", prompt: "Укажите количество, м²." },
    { id: "canopy", label: "Установлен навес", key: "canopy", type: "int", prompt: "Укажите количество, м²." },
    { id: "piles", label: "Установлены сваи", key: "piles", type: "int", prompt: "Укажите количество, шт." },
    { id: "fence", label: "Установлены ограждения", key: "fence", type: "int", prompt: "Укажите количество, м/п." },
    HOURS
  ],
  g4: [HOURS],
  g5: [HOURS],
  g6: [
    { id: "falsefloor", label: "Монтаж и Изгот-е по месту", key: "falsefloor", type: "int", prompt: "Укажите количество, м²." },
    HOURS
  ]
};

// Категории КТУ: подпись кнопки/папки → поле слота и название в настройках «Баллы КТУ».
const KTU_CATEGORIES = [
  { label: "Видео общее", slotKey: "ktuVideo", settingsLabel: "Видео общее" },
  { label: "Видео таймлапс", slotKey: "ktuTimelapse", settingsLabel: "Видео таймлапс" },
  { label: "Видео отзыв клиента", slotKey: "ktuReviewVideo", settingsLabel: "Видео-отзыв клиента" },
  { label: "Отзывы", slotKey: "ktuReviewSite", settingsLabel: "Отзыв в отзовике или Яндексе" }
];

// ------------------------------------------------------------
// Отправка и блоки
// ------------------------------------------------------------

function say(env, text, buttons, markdown) {
  return messenger.send(env.ctx, env.directId, text, buttons, markdown ? { markdown: true } : undefined);
}

function data(state) {
  return state.flow.data;
}

// Показать текущий блок пользователю (и при повторном вопросе после ошибки/перезапуска).
async function present(env, state) {
  const cur = state.flow.cur;

  if (cur.type === "upload") {
    const buttons = [];

    if (cur.files.length > 0) {
      buttons.push(cur.finishLabel || B.CONTINUE);
    } else if (cur.skipLabel) {
      buttons.push(cur.skipLabel);
    }

    await say(env, cur.prompt, buttons.length ? buttons : undefined);
    return;
  }

  if (cur.type === "number" || cur.type === "text") {
    await say(env, cur.prompt, cur.skipLabel ? [cur.skipLabel] : undefined);
    return;
  }

  await say(env, cur.prompt, cur.buttons, cur.markdown);
}

async function setCur(env, state, cur) {
  state.flow.cur = cur;
  await present(env, state);
}

function choice(env, state, prompt, buttons, next, extra) {
  return setCur(env, state, { type: "choice", prompt, buttons, next, ...(extra || {}) });
}

function number(env, state, prompt, next, { integer = false, skipLabel = null } = {}) {
  return setCur(env, state, { type: "number", prompt, next, integer, skipLabel });
}

function text(env, state, prompt, next) {
  return setCur(env, state, { type: "text", prompt, next });
}

// kind: "image" | "video" | "any"
function upload(env, state, { prompt, cat, kind = "image", next, finishLabel = B.CONTINUE, skipLabel = null }) {
  return setCur(env, state, { type: "upload", prompt, cat, kind, next, finishLabel, skipLabel, files: [] });
}

function fits(attachment, kind) {
  if (kind === "any") {
    return attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "other";
  }

  return files.attachmentFits(attachment, kind);
}

async function advance(env, state, next, value) {
  const step = STEPS[next];

  if (!step) {
    throw new Error(`Неизвестный шаг сценария: ${next}`);
  }

  await step(env, state, value);
}

// ------------------------------------------------------------
// Список сделок (T-6.1–6.2) и старт
// ------------------------------------------------------------

async function showList(env, state) {
  const { ctx } = env;
  const found = await deals.findReportDeals(ctx, state.foremanName);

  if (found.length === 0) {
    await say(env, "Задачи по загрузке фотоотчёта не найдены.");
    return;
  }

  const isLekal = (item) => Number(item.lead.pipeline_id) === PIPELINE.WOOD_PRODUCTION;
  const work = deals.sortByTerms(ctx, found.filter((item) => !isLekal(item))).map((item) => item.lead);
  const lekal = deals.sortByTerms(ctx, found.filter(isLekal)).map((item) => item.lead);
  const lines = ["Незавершённые монтажи:"];
  const ordered = [];

  async function addGroup(title, leads) {
    if (leads.length === 0) {
      return;
    }

    lines.push(title);

    for (let i = 0; i < leads.length; i++) {
      lines.push(`${i + 1}) ${await deals.dealLine(ctx, leads[i], "report")}`);
    }

    ordered.push(...leads);
  }

  await addGroup("Монтажи в работе:", work);
  await addGroup("Снятие лекал:", lekal);

  const emoji = (lead) => {
    const id = Number(lead.pipeline_id);

    return id === PIPELINE.WOOD_PRODUCTION ? "📐 " : id === PIPELINE.RECLAMATION ? "↩️ " : "🔧 ";
  };
  const { map, buttons } = deals.buildDealButtons(ctx, ordered, emoji);

  state.list = { kind: "report", map };
  await say(env, lines.join("\n"), buttons, true);
}

async function start(env, state, lead, task) {
  const { ctx } = env;
  const pipelineId = Number(lead.pipeline_id);
  const draft = state.drafts && state.drafts[lead.id];

  // Незавершённый отчёт по этой сделке — продолжаем с того же места.
  if (draft && draft.cur) {
    state.flow = draft;
    delete state.drafts[lead.id];
    await say(env, `Продолжаем незавершённый отчёт по договору № ${mdSafe(amo.contractNumber(ctx, lead))}.`);
    await present(env, state);
    return;
  }

  const productName = deals.productText(ctx, lead);

  state.flow = {
    name: "report",
    mode: "report",
    kind: pipelineId === PIPELINE.WOOD_PRODUCTION ? "lekal" : "montage",
    leadId: lead.id,
    taskId: task ? task.id : null,
    group: calc.getProductGroup(productName, pipelineId, PIPELINE.WOOD_PRODUCTION),
    extrasGroup: calc.getExtrasGroup(productName),
    cur: null,
    data: {
      productName,
      pipelineId,
      remainder: amo.fieldNumber(ctx, lead, FIELD.PAYMENT_REMAINDER),
      values: {},
      files: {},
      ktuDone: [],
      usedExtras: [],
      done: {}
    }
  };

  if (state.flow.kind === "lekal") {
    await STEPS.lekal_card(env, state);
  } else {
    await STEPS.montage_card(env, state);
  }
}

async function contactLines(env, lead) {
  const contact = await amo.getContactInfo(env.ctx, lead);

  return { name: mdSafe(contact.name), phone: mdSafe(contact.phones.join(", ")) };
}

// ------------------------------------------------------------
// Шаги
// ------------------------------------------------------------

const STEPS = {
  // ---------- Дерево производства: снятие лекал ----------
  async lekal_card(env, state) {
    const { ctx } = env;
    const lead = (await amo.getLeadsByIds(ctx, [state.flow.leadId]))[0];
    const contact = await contactLines(env, lead);

    await choice(
      env,
      state,
      `Лекала сняты\n` +
        `Монтаж каркаса: ${deals.folderLink(ctx, lead, "Папка на Яндекс Диске")}\n` +
        `Адрес объекта: ${mdSafe(amo.fieldText(ctx, lead, FIELD.ADDRESS) || "—")}\n` +
        `${deals.contractLabel(ctx, lead)}\n` +
        `Продукт: ${mdSafe(deals.productText(ctx, lead))}\n` +
        `Контакт: ${contact.name}\n` +
        `Телефон: ${contact.phone}`,
      ["Лекала сняты", "Перенос выезда"],
      "lekal_choice",
      { markdown: true }
    );
  },

  async lekal_choice(env, state, value) {
    data(state).progress = true;

    if (value === "Перенос выезда") {
      await text(env, state, "Укажите комментарий", "move_comment");
    } else {
      await number(env, state, "Укажите числовое значение пробега.", "lekal_km");
    }
  },

  async lekal_km(env, state, value) {
    data(state).values.km = value;
    await upload(env, state, { prompt: "Загрузите скрин навигатора.", cat: "Скрин навигатора", next: "lekal_nav" });
  },

  async lekal_nav(env, state) {
    await upload(env, state, { prompt: "Загрузите фото лекал.", cat: "Фото лекал", next: "lekal_templates" });
  },

  async lekal_templates(env, state) {
    await upload(env, state, {
      prompt: "Загрузите фото лестницы.",
      cat: "Фото лестницы",
      next: "lekal_finish",
      finishLabel: B.FINISH_REPORT
    });
  },

  async lekal_finish(env, state) {
    await finalize(env, state, RESULT.LEKALS_DONE);
  },

  // ---------- Перенос выезда (общий) ----------
  async move_comment(env, state, value) {
    data(state).comment = value;
    await finalize(env, state, RESULT.MOVED);
  },

  // ---------- Обычный монтаж ----------
  async montage_card(env, state) {
    const { ctx } = env;
    const lead = (await amo.getLeadsByIds(ctx, [state.flow.leadId]))[0];
    const contact = await contactLines(env, lead);
    const remainder = amo.fieldNumber(ctx, lead, FIELD.PAYMENT_REMAINDER);

    await choice(
      env,
      state,
      "Монтаж проведён.\n" +
        (remainder > 0 ? `Остаток платежа: ${calc.fmt(remainder)}\n` : "") +
        `Адрес объекта: ${mdSafe(amo.fieldText(ctx, lead, FIELD.ADDRESS) || "—")}\n` +
        `${deals.contractLabel(ctx, lead)}\n` +
        `Продукт: ${mdSafe(deals.productText(ctx, lead))}\n` +
        `Имя контакта: ${contact.name}\n` +
        `Телефон: ${contact.phone}`,
      ["Перенос монтажа", "Промежуточный отчёт", "Монтаж завершён", "Доп хотелки"],
      "montage_choice",
      { markdown: true }
    );
  },

  async montage_choice(env, state, value) {
    if (value === "Перенос монтажа") {
      data(state).progress = true;
      await text(env, state, "Укажите комментарий", "move_comment");
    } else if (value === "Доп хотелки") {
      await text(env, state, "Укажите комментарий", "wishes");
    } else if (value === "Промежуточный отчёт") {
      data(state).progress = true;
      data(state).intermediate = true;
      await choice(env, state, "Часть изделия установлена?", ["Частично", "Не установлено"], "part");
    } else {
      data(state).progress = true;
      await choice(
        env,
        state,
        "Акт клиентом подписан?",
        ["Да", "Загрузить акт отказа от подписи", "Заказчик отсутствует"],
        "act_choice"
      );
    }
  },

  // «Доп хотелки»: записываем в «[Бот] Примечание» и возвращаемся к карточке.
  async wishes(env, state, value) {
    await amo.patchLead(env.ctx, state.flow.leadId, { custom_fields_values: [amo.setValue(FIELD.BOT_NOTE, value)] });
    await sensei.startProcess(sensei.PROCESS.WISHES, state.flow.leadId);
    await say(env, "Информация отправлена");
    await STEPS.montage_card(env, state);
  },

  // ---------- Промежуточный отчёт ----------
  async part(env, state, value) {
    data(state).partial = value;
    await choice(env, state, "Нужны ли детали?", [B.YES, B.NO], "need_details");
  },

  async need_details(env, state, value) {
    data(state).needDetails = value === B.YES;

    if (value === B.YES) {
      await text(env, state, "Укажите комментарий", "details_comment");
    } else {
      await STEPS.inter_km(env, state);
    }
  },

  async details_comment(env, state, value) {
    data(state).detailsComment = value;
    await choice(env, state, "Добавить фото?", [B.YES, B.NO], "details_photo_q");
  },

  async details_photo_q(env, state, value) {
    if (value === B.YES) {
      await upload(env, state, { prompt: "Загрузите фото.", cat: "Нужны детали", next: "inter_km_after_photo" });
    } else {
      await STEPS.inter_km(env, state);
    }
  },

  async inter_km_after_photo(env, state) {
    await STEPS.inter_km(env, state);
  },

  async inter_km(env, state) {
    await number(env, state, "Укажите числовое значение пробега.", "inter_km_val");
  },

  async inter_km_val(env, state, value) {
    data(state).values.km = value;
    await upload(env, state, { prompt: "Загрузите скрин навигатора.", cat: "Скрин навигатора", next: "inter_ladder" });
  },

  async inter_ladder(env, state) {
    await upload(env, state, {
      prompt: "Загрузите фото/видео установленной лестницы.",
      cat: "Установленная лестница",
      kind: "any",
      next: "inter_finish",
      finishLabel: B.FINISH_REPORT
    });
  },

  async inter_finish(env, state) {
    await finalize(env, state, data(state).needDetails ? RESULT.INTERMEDIATE_DETAILS : RESULT.INTERMEDIATE);
  },

  // ---------- Монтаж завершён: акт → оплата → пробеги → КТУ → доп. работы ----------
  async act_choice(env, state, value) {
    const d = data(state);

    if (value === B.YES) {
      d.actKind = "signed";
      await upload(env, state, { prompt: "Загрузите фото акта выполненных работ.", cat: "Акт выполненных работ", next: "pay_check" });
    } else if (value === "Загрузить акт отказа от подписи") {
      d.actKind = "refused";
      await upload(env, state, { prompt: "Загрузите фото акта отказа от подписи.", cat: "Акт отказа от подписи", next: "pay_check" });
    } else {
      d.customerAbsent = true;
      await STEPS.pay_check(env, state);
    }
  },

  async pay_check(env, state) {
    if (data(state).remainder > 0) {
      await choice(env, state, "Оплата от клиента получена.", ["Получил", "Не получил"], "pay_choice");
    } else {
      await STEPS.delivery(env, state);
    }
  },

  async pay_choice(env, state, value) {
    if (value === "Получил") {
      data(state).paymentReceived = true;
      await upload(env, state, { prompt: "Загрузите фото чека.", cat: "Фото чека", next: "delivery" });
    } else {
      await text(env, state, "Укажите комментарий", "pay_comment");
    }
  },

  async pay_comment(env, state, value) {
    data(state).paymentComment = value;
    await STEPS.delivery(env, state);
  },

  async delivery(env, state) {
    await number(env, state, "Укажите числовое значение пробега доставки.", "delivery_val", { skipLabel: B.SKIP });
  },

  async delivery_val(env, state, value) {
    if (value !== null) {
      data(state).values.kmDelivery = value;
    }

    await number(env, state, "Укажите числовое значение транспортного пробега (без доставки).", "km_val");
  },

  async km_val(env, state, value) {
    data(state).values.km = value;
    await upload(env, state, { prompt: "Загрузите скрин навигатора.", cat: "Скрин навигатора", next: "ktu_menu" });
  },

  // ---------- Блок КТУ (T-6 после пробегов; T-9 «Балл КТУ») ----------
  async ktu_menu(env, state) {
    const d = data(state);
    const rest = KTU_CATEGORIES.filter((item) => !d.ktuDone.includes(item.label));

    await choice(
      env,
      state,
      "Укажите, что сделано для баллов КТУ.",
      [d.ktuDone.length ? B.NEXT : B.SKIP, ...rest.map((item) => item.label)],
      "ktu_pick"
    );
  },

  async ktu_pick(env, state, value) {
    const category = KTU_CATEGORIES.find((item) => item.label === value);

    if (!category) {
      // «Пропустить» / «Далее»
      if (state.flow.mode === "fixes") {
        await STEPS.fixes_menu(env, state);
      } else {
        await STEPS.extras_start(env, state);
      }

      return;
    }

    data(state).tmp = category.label;
    await upload(env, state, {
      prompt: `Загрузите файл или файлы: «${category.label}».`,
      cat: category.label,
      kind: category.label === "Отзывы" ? "any" : "video",
      next: "ktu_done"
    });
  },

  async ktu_done(env, state) {
    const d = data(state);

    d.ktuDone.push(d.tmp);
    await STEPS.ktu_menu(env, state);
  },

  // ---------- Доп. работы по группам продуктов ----------
  async extras_start(env, state) {
    const group = state.flow.extrasGroup;

    if (!group) {
      await STEPS.extras_done(env, state);
    } else if (group === "g4") {
      await number(env, state, "Укажите объём проделанной работы.", "extras_amount");
    } else {
      await STEPS.extras_menu(env, state);
    }
  },

  async extras_amount(env, state, value) {
    data(state).values.amount = value;
    await STEPS.extras_menu(env, state);
  },

  async extras_menu(env, state) {
    const d = data(state);
    const options = (EXTRA_OPTIONS[state.flow.extrasGroup] || []).filter((item) => !d.usedExtras.includes(item.id));

    await choice(
      env,
      state,
      "Укажите доп. работы.",
      [d.usedExtras.length ? B.NEXT : B.SKIP, ...options.map((item) => item.label)],
      "extras_pick"
    );
  },

  async extras_pick(env, state, value) {
    const d = data(state);
    const option = (EXTRA_OPTIONS[state.flow.extrasGroup] || []).find((item) => item.label === value);

    if (value === B.SKIP) {
      await STEPS.extras_done(env, state);
    } else if (value === B.NEXT) {
      await text(env, state, "Укажите общий комментарий к дополнительным работам.", "extras_comment");
    } else if (option) {
      d.tmp = option.id;

      if (option.type === "flag") {
        d.values[option.key] = 1;
        await STEPS.extras_photo(env, state);
      } else {
        await number(env, state, option.prompt, "extras_value", { integer: true });
      }
    } else {
      await STEPS.extras_menu(env, state);
    }
  },

  async extras_value(env, state, value) {
    const d = data(state);
    const option = EXTRA_OPTIONS[state.flow.extrasGroup].find((item) => item.id === d.tmp);

    d.values[option.key] = value;
    await STEPS.extras_photo(env, state);
  },

  async extras_photo(env, state) {
    const d = data(state);
    const option = EXTRA_OPTIONS[state.flow.extrasGroup].find((item) => item.id === d.tmp);

    await upload(env, state, {
      prompt: "Загрузите фото дополнительной работы.",
      cat: option.label,
      next: "extras_photo_done"
    });
  },

  async extras_photo_done(env, state) {
    const d = data(state);

    d.usedExtras.push(d.tmp);
    await STEPS.extras_menu(env, state);
  },

  async extras_comment(env, state, value) {
    data(state).extraDescription = value;
    await STEPS.extras_done(env, state);
  },

  async extras_done(env, state) {
    if (state.flow.mode === "fixes") {
      await STEPS.fixes_menu(env, state);
      return;
    }

    // Шаг 179: фото/видео установленной лестницы → «Завершить отчёт».
    await upload(env, state, {
      prompt: "Загрузите фото/видео установленной лестницы.",
      cat: "Установленная лестница",
      kind: "any",
      next: "montage_finish",
      finishLabel: B.FINISH_REPORT
    });
  },

  async montage_finish(env, state) {
    await finalize(env, state, RESULT.MONTAGE_DONE);
  },

  // ---------- T-9 «Внести правки» ----------
  async fixes_menu(env, state) {
    await choice(
      env,
      state,
      "Что нужно исправить?",
      ["Завершить отчёт", "Добавить комментарий", "Загрузить общее фото", "Доп. работы", "Балл КТУ", "Пробег"],
      "fixes_pick"
    );
  },

  async fixes_pick(env, state, value) {
    const d = data(state);

    if (value === "Завершить отчёт") {
      await finalizeFixes(env, state);
    } else if (value === "Добавить комментарий") {
      await text(env, state, "Укажите комментарий.", "fixes_comment");
    } else if (value === "Загрузить общее фото") {
      await upload(env, state, { prompt: "Загрузите файлы.", cat: "Фото общее", next: "fixes_menu" });
    } else if (value === "Доп. работы") {
      d.usedExtras = [];
      await STEPS.extras_start(env, state);
    } else if (value === "Балл КТУ") {
      d.ktuDone = [];
      await STEPS.ktu_menu(env, state);
    } else {
      d.mileageDone = false;
      await STEPS.fixes_mileage(env, state);
    }
  },

  async fixes_comment(env, state, value) {
    const flow = state.flow;

    await amo.patchLead(env.ctx, flow.leadId, {
      custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { note: value })
    });
    await say(env, "Ваши комментарии приняты");
    await STEPS.fixes_menu(env, state);
  },

  async fixes_mileage(env, state) {
    const d = data(state);

    await choice(
      env,
      state,
      "Укажите, в какой пробег необходимо внести правки.",
      [d.mileageDone ? B.NEXT : B.SKIP, "Доставка", "Транспортный"],
      "fixes_mileage_pick"
    );
  },

  async fixes_mileage_pick(env, state, value) {
    if (value === "Доставка" || value === "Транспортный") {
      data(state).tmp = value;
      await number(env, state, "Введите новое значение пробега.", "fixes_mileage_val");
    } else {
      await STEPS.fixes_menu(env, state);
    }
  },

  async fixes_mileage_val(env, state, value) {
    const d = data(state);

    d.values[d.tmp === "Доставка" ? "kmDelivery" : "km"] = value;
    d.mileageDone = true;
    await STEPS.fixes_mileage(env, state);
  }
};

// ------------------------------------------------------------
// Обработка ответа пользователя на текущий блок
// ------------------------------------------------------------

async function handle(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const cur = flow.cur;

  if (!cur) {
    return false;
  }

  const txt = input.text;

  if (cur.type === "choice") {
    if (cur.buttons.includes(txt)) {
      await advance(env, state, cur.next, txt);
    } else {
      await present(env, state);
    }

    return true;
  }

  if (cur.type === "text") {
    if (!txt) {
      await present(env, state);
    } else {
      await advance(env, state, cur.next, txt);
    }

    return true;
  }

  if (cur.type === "number") {
    if (cur.skipLabel && txt === cur.skipLabel) {
      await advance(env, state, cur.next, null);
      return true;
    }

    const value = cur.integer ? calc.parseInteger(txt) : calc.parseNumber(txt);

    if (value === null) {
      await say(env, cur.integer ? MSG_NOT_INTEGER : MSG_NOT_NUMBER);
      return true;
    }

    await advance(env, state, cur.next, value);
    return true;
  }

  if (cur.type === "upload") {
    if (input.attachments.length > 0) {
      const fitting = input.attachments.filter((item) => fits(item, cur.kind));

      if (fitting.length === 0) {
        await say(env, cur.kind === "video" ? "На этом шаге нужно прислать видео." : "На этом шаге нужно прислать фото.");
        return true;
      }

      await say(env, "Файлы получены, загружаю на Яндекс Диск");

      const d = flow.data;
      let uploaded = 0;

      for (const attachment of fitting) {
        try {
          const path = await files.uploadFile(ctx, flow.leadId, cur.cat, attachment);

          cur.files.push(path);
          (d.files[cur.cat] = d.files[cur.cat] || []).push(path);
          uploaded += 1;
        } catch (error) {
          console.error("[Бот монтажников] Ошибка загрузки файла на Яндекс.Диск:", error.message);
          await say(env, `❌ Не удалось загрузить файл на Яндекс.Диск (${error.message.slice(0, 120)}). Отправьте его ещё раз.`);
        }
      }

      if (uploaded > 0) {
        await say(env, MSG_ADD_FILES, [cur.finishLabel || B.CONTINUE]);
      }

      return true;
    }

    if (txt === (cur.finishLabel || B.CONTINUE) && cur.files.length > 0) {
      await advance(env, state, cur.next, cur.files);
    } else if (cur.skipLabel && txt === cur.skipLabel && cur.files.length === 0) {
      await advance(env, state, cur.next, []);
    } else {
      await present(env, state);
    }

    return true;
  }

  return false;
}

// ------------------------------------------------------------
// Завершение (идемпотентно: что уже сделано — повторно не делаем)
// ------------------------------------------------------------

async function resolveSlot(ctx, lead, foremanName, d) {
  let index = amo.findSlotIndex(ctx, lead, foremanName);

  if (index >= 0) {
    return index;
  }

  // Монтажник ещё не записан ни в одну группу полей — берём первую свободную.
  index = SLOT_FIELDS.findIndex((slot) => !amo.fieldText(ctx, lead, slot.master));

  if (index < 0) {
    throw new Error("Во всех группах «N. Монтажник» уже указаны другие люди.");
  }

  const response = await ctx.amoCrmGet(
    `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/custom_fields/${SLOT_FIELDS[index].master}`,
    {}
  );
  const option = ((response.status === 200 && response.data && response.data.enums) || []).find((item) =>
    calc.sameName(item.value, foremanName)
  );

  if (option) {
    d.slotMasterPayload = { field_id: SLOT_FIELDS[index].master, values: [{ value: option.value, enum_id: option.id }] };
  } else {
    console.warn(`[Бот монтажников] В поле «${SLOT_FIELDS[index].master}» нет значения «${foremanName}».`);
  }

  return index;
}

// Значения слота из накопленных ответов (пробеги + тарифы + КТУ).
function buildSlotValues(d, motivation, settings, ktuEnabled) {
  const out = {};

  for (const key of Object.keys(d.values)) {
    if (key === "km" || key === "kmDelivery" || key === "amount") {
      continue;
    }

    out[key] = d.values[key];
  }

  if (d.values.km !== undefined) {
    out.kmFact = d.values.km;

    if (motivation) {
      out.tariff = calc.num(motivation.transportTariff);
      out.kmFactTotal = calc.round2(calc.num(motivation.transportTariff) * d.values.km);
    }
  }

  if (d.values.kmDelivery !== undefined) {
    out.kmDelivery = d.values.kmDelivery;

    if (motivation) {
      out.tariffDelivery = calc.num(motivation.deliveryTariff);
      out.kmDeliveryTotal = calc.round2(calc.num(motivation.deliveryTariff) * d.values.kmDelivery);
    }
  }

  if (ktuEnabled) {
    for (const label of d.ktuDone) {
      const category = KTU_CATEGORIES.find((item) => item.label === label);

      out[category.slotKey] = settingsStore.ktuPoints(settings, category.settingsLabel);
    }
  }

  if (d.extraDescription) {
    out.note = d.extraDescription;
  }

  return out;
}

async function finishCommon(env, state, resultLabel) {
  const flow = state.flow;
  const leadId = flow.leadId;

  state.flow = null;

  if (state.drafts) {
    delete state.drafts[leadId];
  }

  await say(env, resultLabel, undefined, true);
}

async function finalize(env, state, result) {
  const { ctx } = env;
  const flow = state.flow;
  const d = flow.data;
  const done = d.done;
  const settings = settingsStore.get();
  const foremanName = state.foremanName;
  const lead = await ctx.getLead(flow.leadId);

  if (!lead) {
    throw new Error(`Сделка ${flow.leadId} не найдена`);
  }

  const number = amo.contractNumber(ctx, lead);
  const managerRow = settingsStore.findRowByForemanName(settings, foremanName);
  const motivation = settingsStore.findMotivation(settings, managerRow);
  const managerNames = managerRow ? [managerRow.managerHandle] : [];
  const warnings = [];
  const isMove = result === RESULT.MOVED;

  try {
    // 1) ссылки на файлы и папка (публикуем один раз)
    if (!done.links) {
      d.folderUrl = await files.ensureFolderLink(ctx, lead);
      d.actLinks = d.actKind === "signed" ? await files.publicLinks(ctx, d.files["Акт выполненных работ"] || []) : [];
      d.detailsLinks = await files.publicLinks(ctx, d.files["Нужны детали"] || []);
      done.links = true;
    }

    // 2) запись в сделку одним запросом
    if (!done.fields && !isMove) {
      const payload = [];
      const slotIndex = await resolveSlot(ctx, lead, foremanName, d);
      const slotValues = buildSlotValues(d, motivation, settings, result === RESULT.MONTAGE_DONE);

      if (!motivation) {
        warnings.push("для бригадира не выбрана «Мотивация роли» — тарифы не записаны");
      }

      if (result === RESULT.MONTAGE_DONE) {
        slotValues.date = ctx.todayMoscowStartUnix();
      }

      // Цена монтажа (T-8) — только по итогам монтажа/снятия лекал.
      if (result === RESULT.MONTAGE_DONE || result === RESULT.LEKALS_DONE) {
        const pricingRow = settingsStore.findPricingRow(settings, amo.fieldEnumId(lead, FIELD.PRODUCT), d.productName);
        const calculated =
          flow.group && pricingRow
            ? calc.calcMontagePrice(
                flow.group,
                pricingRow,
                { floors: amo.fieldNumber(ctx, lead, FIELD.FLOORS), budget: Number(lead.price) || 0, ...d.values },
                motivation
              )
            : null;

        if (calculated) {
          slotValues.price = calculated.price;
        } else {
          d.noPrice = true;
        }
      }

      payload.push(...amo.slotFieldsPayload(slotIndex, slotValues));

      if (d.slotMasterPayload) {
        payload.push(d.slotMasterPayload);
      }

      if (d.values.amount !== undefined) {
        payload.push(amo.setValue(FIELD.MONTAGE_AMOUNT, d.values.amount));
      }

      // «[Бот] Ссылка на фото»: при незавершённом монтаже сначала очищаем,
      // затем (если были фото «Нужны детали») пишем ссылки через «, ».
      if (d.intermediate) {
        payload.push(
          d.detailsLinks.length ? amo.setValue(FIELD.PHOTO_LINK, d.detailsLinks.join(", ")) : amo.clearField(FIELD.PHOTO_LINK)
        );
      }

      if (d.actLinks && d.actLinks.length > 0) {
        payload.push(amo.setValue(FIELD.ACT, d.actLinks.join(", ")));
      }

      if (payload.length > 0) {
        await amo.patchLead(ctx, lead.id, { custom_fields_values: payload });
      }

      done.fields = true;
    }

    // 3) примечания в сделке
    if (!done.note) {
      const notes = [];

      if (isMove) {
        notes.push(d.comment);
      }

      if (d.intermediate) {
        notes.push(d.partial === "Частично" ? "Изделие частично установлено" : "Изделие не установлено");

        if (d.detailsComment) {
          notes.push(d.detailsComment);
        }
      }

      if (d.paymentComment) {
        notes.push(d.paymentComment);
      }

      for (const note of notes) {
        await amo.addNote(ctx, lead.id, note);
      }

      done.note = true;
    }

    // 4) контрольные задачи
    // «Заказчик отсутствует» — процесс Sensei 78045; если запустить не удалось
    // (нет токена/ошибка) — создаём задачу «Контроль» для Редькиной Юлии сами.
    if (!done.absentTask && d.customerAbsent) {
      if (!(await sensei.startProcess(sensei.PROCESS.CUSTOMER_ABSENT, lead.id))) {
        await amo.createTask(ctx, {
          leadId: lead.id,
          responsibleUserId: USER.REDKINA_YULIA,
          typeId: TASK_TYPE.CONTROL,
          text: "Заказчик отсутствовал на объекте. Выслать акт электронно.",
          hours: 1
        });
      }

      done.absentTask = true;
    }

    if (!done.paymentTask && d.paymentReceived) {
      await amo.createTask(ctx, {
        leadId: lead.id,
        responsibleUserId: USER.ACCOUNTANT,
        typeId: TASK_TYPE.CONTROL,
        text: "Получена оплата на монтаже.",
        hours: 1
      });
      done.paymentTask = true;
    }

    // 5) закрытие задачи «Отчет о монтаже»
    if (!done.task) {
      if (flow.taskId) {
        await amo.closeTask(ctx, flow.taskId, result);
      } else {
        console.warn(`[Бот монтажников] У отчёта по сделке ${lead.id} нет id задачи — закрывать нечего.`);
      }

      done.task = true;
    }

    // 5а) файлы и информация в канал amoMessenger (вместо Telegram): фото/видео
    // установленной лестницы и файлы блока КТУ. Сбой не мешает отчёту.
    if (!done.channel && result === RESULT.MONTAGE_DONE) {
      d.channelDone = d.channelDone || {};

      try {
        const paths = ["Установленная лестница", ...KTU_CATEGORIES.map((item) => item.label)].flatMap(
          (category) => d.files[category] || []
        );
        const folderUrl = d.folderUrl ? `[Папка на Яндекс Диске](${d.folderUrl})` : "";

        await channel.publishReport(ctx, {
          text:
            `**Договор / замерный лист:** ${mdSafe(number)}\n` +
            `**Бюджет:** ${mdSafe(calc.fmt(Number(lead.price) || 0))}\n` +
            `**Продукт:** ${mdSafe(d.productName)}\n` +
            `**Фотоотчет:** ${folderUrl}`,
          paths,
          done: d.channelDone
        });
        done.channel = true;
      } catch (error) {
        console.error("[Бот монтажников] Ошибка публикации в канал:", error.message);
        warnings.push("файлы не удалось отправить в канал amoMessenger");
      }
    }
  } catch (error) {
    console.error("[Бот монтажников] Ошибка завершения отчёта:", error.stack || error.message);
    await say(
      env,
      "❌ Не удалось полностью сохранить отчёт. Уже записанное повторно записываться не будет — " +
        "нажмите кнопку завершения ещё раз или обратитесь к администратору."
    );
    return;
  }

  // 6) уведомления руководителю
  if (!done.notify) {
    const who = mdSafe(foremanName);
    const folderText = d.folderUrl ? `[Папка на Яндекс Диске](${d.folderUrl})` : deals.folderLink(ctx, lead);

    if (result === RESULT.INTERMEDIATE) {
      await messenger.notify(ctx, managerNames, `Монтаж по договору № ${mdSafe(number)} не завершен. Монтажник ${who}. ${folderText}`, { markdown: true });
    } else if (result === RESULT.INTERMEDIATE_DETAILS) {
      await messenger.notify(
        ctx,
        managerNames,
        `Монтаж по договору № ${mdSafe(number)} не завершен. Нужны детали. Монтажник ${who}. ${folderText}`,
        { markdown: true }
      );
    }

    if (d.noPrice) {
      await messenger.notify(
        ctx,
        managerNames,
        `По договору № ${mdSafe(number)} (монтажник ${who}) не удалось рассчитать стоимость работ: ` +
          `продукт «${mdSafe(d.productName)}» не найден в таблице «Расчет стоимости монтажа». Цена монтажа не заполнена.`,
        { markdown: true }
      );
    }

    if (warnings.length > 0) {
      await messenger.notify(ctx, managerNames, `По договору № ${mdSafe(number)}: ${mdSafe(warnings.join("; "))}.`, { markdown: true });
    }

    done.notify = true;
  }

  // 7) ответ пользователю и возврат к началу T-6 (поиск сделок)
  await finishCommon(env, state, `Задача amoCRM "Отчет о монтаже" закрыта с результатом "${result}".\nДоговор № ${mdSafe(number)}.`);
  await showList(env, state);
}

// T-9: «Завершить отчёт» — запись правок, перерасчёт цены (T-8), закрытие задачи, уведомление.
async function finalizeFixes(env, state) {
  const { ctx } = env;
  const flow = state.flow;
  const d = flow.data;
  const done = d.done;
  const settings = settingsStore.get();
  const foremanName = state.foremanName;
  const managerRow = settingsStore.findRowByForemanName(settings, foremanName);
  const motivation = settingsStore.findMotivation(settings, managerRow);

  try {
    if (!done.fields) {
      const slotValues = buildSlotValues(d, motivation, settings, true);
      const payload = amo.slotFieldsPayload(flow.slotIndex, slotValues);

      if (d.values.amount !== undefined) {
        payload.push(amo.setValue(FIELD.MONTAGE_AMOUNT, d.values.amount));
      }

      if (payload.length > 0) {
        await amo.patchLead(ctx, flow.leadId, { custom_fields_values: payload });
      }

      done.fields = true;
    }

    // Перерасчёт цены монтажа (T-8) по данным, уже лежащим в сделке.
    if (!done.price) {
      const lead = (await amo.getLeadsByIds(ctx, [flow.leadId]))[0];
      const { calculated } = recalculatePrice(ctx, lead, flow.slotIndex, foremanName);

      if (calculated) {
        await amo.patchLead(ctx, flow.leadId, {
          custom_fields_values: amo.slotFieldsPayload(flow.slotIndex, { price: calculated.price })
        });
      }

      done.price = true;
    }

    if (!done.task) {
      await amo.closeTask(ctx, flow.taskId, RESULT.FIXES_DONE);
      done.task = true;
    }
  } catch (error) {
    console.error("[Бот монтажников] Ошибка завершения правок:", error.stack || error.message);
    await say(env, "❌ Не удалось сохранить правки. Уже записанное повторно записываться не будет — нажмите «Завершить отчёт» ещё раз.");
    return;
  }

  if (!done.notify) {
    const lead = await ctx.getLead(flow.leadId);

    await messenger.notify(
      ctx,
      managerRow ? [managerRow.managerHandle] : [],
      `Монтажник ${mdSafe(foremanName)} внёс правки в отчёт по договору № ${mdSafe(amo.contractNumber(ctx, lead))}.`
    );
    done.notify = true;
  }

  await finishCommon(env, state, `Задача "Правки в отчёт" закрыта с результатом "${RESULT.FIXES_DONE}".`);
}

// Запуск T-9 из flowFixes (после выбора сделки).
async function startFixes(env, state, { leadId, taskId, slotIndex }) {
  state.flow = {
    name: "fixes",
    mode: "fixes",
    kind: "montage",
    leadId,
    taskId,
    slotIndex,
    cur: null,
    data: { values: {}, files: {}, ktuDone: [], usedExtras: [], done: {}, productName: "" }
  };

  const lead = (await amo.getLeadsByIds(env.ctx, [leadId]))[0];
  const productName = deals.productText(env.ctx, lead);

  state.flow.data.productName = productName;
  state.flow.extrasGroup = calc.getExtrasGroup(productName);

  await STEPS.fixes_menu(env, state);
}

module.exports = { start, startFixes, handle, showList, B };
