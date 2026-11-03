// ============================================================
// БОТ МОНТАЖНИКОВ — T-6 «Загрузить отчет» (+ расчёт стоимости T-8)
//
// ВАЖНО: ТЗ не содержит полной схемы переходов T-6 (она в Miro/CSV) и
// матрицы «продукт → вопросы». Вопросы по продуктам здесь выведены из
// формул T-8: спрашиваем ровно то, что входит в формулу стоимости
// продукта (calc.QUESTIONS_BY_GROUP), плюс фото/видео/пробег/оплата/акт/
// отзывы/хотелки из разделов ТЗ 4.5–4.14. Порядок и тексты вопросов —
// в таблице шагов ниже, их легко поправить в одном месте.
// ============================================================

const amo = require("./amo");
const calc = require("./calc");
const files = require("./files");
const channel = require("./channel");
const messenger = require("./messenger");
const settingsStore = require("./settings");
const deals = require("./deals");
const { FIELD, PIPELINE, RESULT, TASK_TYPE, USER, SLOT_FIELDS } = require("./constants");

const { mdSafe } = messenger;

const SKIP = "Пропустить";
const FINISH_UPLOAD = "Завершить загрузку";
const FINISH_REPORT = "Завершить отчет";
const YES = "Да";
const NO = "Нет";
const MOVE = "Перенос выезда";

const MSG_NOT_NUMBER = "Не удалось распознать введенное значение. Пожалуйста, введите число";

// Вопросы с числом/выбором и фото к ним.
const QUESTIONS = {
  tempSteps: {
    prompt: "Монтаж/демонтаж временных ступеней (на 1 этаж). Введите число (0 — не выполнялось).",
    photo: "Монтаж врем.ступеней"
  },
  fence: { prompt: "Установлены ограждения. Введите длину, м/п (0 — нет).", photo: "Установлены ограждения" },
  platform: { prompt: "Установлена площадка. Введите площадь, м² (0 — нет).", photo: "Установлена площадка" },
  canopy: { prompt: "Установлен навес. Введите площадь, м² (0 — нет).", photo: "Установлен навес" },
  piles: { prompt: "Установлены сваи. Введите количество, шт (0 — нет).", photo: "Установлены сваи" },
  falsefloor: {
    prompt: "Монтаж и изготовление по месту фальшпола. Введите площадь, м² (0 — не было).",
    photo: "Монтаж и изготовление по месту фальшпола"
  },
  finish: { prompt: "Чистовая отделка выполнена?", choice: true, photo: "Чистовая отделка" },
  extraHours: { prompt: "Доп.работы. Введите количество часов (0 — не было).", photo: "Доп.работы", describe: true },
  amount: { prompt: "Монтаж изделия. Введите объём монтажа, м/п или м² (в зависимости от продукта)." }
};

// Загрузки: id шага → категория (имя файла на Диске) и тип файла.
const UPLOADS = {
  photo_main: { cat: "Установленная лестница", kind: "image", required: true, prompt: "Прикрепите фото установленной лестницы." },
  photo_lekal: { cat: "Фото лекал", kind: "image", required: true, prompt: "Прикрепите фото лекал." },
  video_general: { cat: "Видео общее", kind: "video", prompt: "Прикрепите общее видео монтажа (или нажмите «Пропустить»).", ktu: "ktuVideo", ktuLabel: "Видео общее" },
  video_timelapse: { cat: "Видео таймлапс", kind: "video", prompt: "Прикрепите видео-таймлапс (или нажмите «Пропустить»).", ktu: "ktuTimelapse", ktuLabel: "Видео таймлапс" },
  navigator: { cat: "Скрин навигатора", kind: "image", prompt: "Прикрепите скриншот навигатора с пробегом (или нажмите «Пропустить»)." },
  receipt: { cat: "Фото чека", kind: "image", prompt: "Прикрепите фото чека (или нажмите «Пропустить»)." },
  review_video: { cat: "Видео-отзыв клиента", kind: "video", prompt: "Прикрепите видео-отзыв клиента (или нажмите «Пропустить»).", ktu: "ktuReviewVideo", ktuLabel: "Видео-отзыв клиента" }
};

// ------------------------------------------------------------
// Вспомогательное
// ------------------------------------------------------------

function say(env, text, buttons, markdown) {
  return messenger.send(env.ctx, env.directId, text, buttons, markdown ? { markdown: true } : undefined);
}

function stepKind(stepId) {
  return stepId.split(":")[0];
}

function stepArg(stepId) {
  return stepId.split(":")[1];
}

function currentStep(flow) {
  return flow.steps[flow.idx];
}

function insertAfterCurrent(flow, stepId) {
  if (flow.steps[flow.idx + 1] !== stepId) {
    flow.steps.splice(flow.idx + 1, 0, stepId);
  }
}

function uploadDefinition(flow, stepId) {
  if (UPLOADS[stepId]) {
    return UPLOADS[stepId];
  }

  if (stepKind(stepId) === "p") {
    return { cat: QUESTIONS[stepArg(stepId)].photo, kind: "image", prompt: `Прикрепите фото: «${QUESTIONS[stepArg(stepId)].photo}» (или нажмите «Пропустить»).` };
  }

  if (stepId === "act_upload") {
    const signed = flow.data.actKind === "signed";

    return {
      cat: signed ? "Акт выполненных работ" : "Акт отказа от подписи",
      kind: "image",
      required: true,
      prompt: signed ? "Прикрепите фото акта выполненных работ." : "Прикрепите фото акта отказа от подписи."
    };
  }

  return null;
}

function isSkippable(def) {
  return !def.required;
}

// ------------------------------------------------------------
// Старт
// ------------------------------------------------------------

async function start(env, state, lead, task) {
  const { ctx } = env;
  const pipelineId = Number(lead.pipeline_id);
  const kind = pipelineId === PIPELINE.WOOD_PRODUCTION ? "lekal" : "montage";
  const productName = deals.productText(ctx, lead);
  const group = calc.getProductGroup(productName, pipelineId, PIPELINE.WOOD_PRODUCTION);

  // Незавершённый отчёт по этой сделке — продолжаем с того же места.
  const draft = state.drafts && state.drafts[lead.id];

  if (draft) {
    state.flow = draft;
    delete state.drafts[lead.id];
    await say(env, `Продолжаем незавершённый отчёт по договору № ${mdSafe(amo.contractNumber(ctx, lead))}.`);
    await ask(env, state);
    return;
  }

  const flow = {
    name: "report",
    kind,
    leadId: lead.id,
    taskId: task ? task.id : null,
    group,
    steps: ["main"],
    idx: 0,
    data: { productName, pipelineId, values: {}, files: {}, ktu: {}, done: {} }
  };

  state.flow = flow;

  const contact = await amo.getContactInfo(ctx, lead);
  const card =
    `Договор № ${mdSafe(amo.contractNumber(ctx, lead))}\n` +
    `Сроки монтажа: ${mdSafe(deals.dateText(ctx, lead))}\n` +
    `Адрес: ${mdSafe(amo.fieldText(ctx, lead, FIELD.ADDRESS) || "—")}\n` +
    `Продукт: ${mdSafe(productName)}\n` +
    `Кол-во этажей: ${mdSafe(deals.floorsText(ctx, lead))}\n` +
    `Контакт: ${mdSafe(contact.name)} ${mdSafe(contact.phones.join(", "))}`;

  await say(env, card, undefined, true);
  await ask(env, state);
}

// ------------------------------------------------------------
// Вопросы
// ------------------------------------------------------------

async function ask(env, state) {
  const flow = state.flow;
  const stepId = currentStep(flow);
  const kind = stepKind(stepId);

  if (stepId === "main") {
    if (flow.kind === "lekal") {
      await say(env, "Лекалы сняты?", [YES, MOVE]);
    } else {
      await say(env, "Монтаж проведен?", [YES, "Частично", NO, MOVE]);
    }

    return;
  }

  if (stepId === "move_comment") {
    await say(env, "Укажите комментарий");
    return;
  }

  if (stepId === "move_absent") {
    await say(env, "Заказчик отсутствовал на объекте?", [YES, NO]);
    return;
  }

  if (stepId === "problem_comment") {
    await say(env, "Опишите, что сделано и что мешает завершить монтаж.");
    return;
  }

  if (kind === "q") {
    const question = QUESTIONS[stepArg(stepId)];

    if (question.choice) {
      await say(env, question.prompt, [YES, NO]);
      return;
    }

    const buttons = [SKIP];

    if (stepArg(stepId) === "amount" && flow.data.existingAmount > 0) {
      buttons.unshift(`Оставить ${calc.fmt(flow.data.existingAmount)}`);
    }

    await say(env, question.prompt, buttons);
    return;
  }

  if (stepId === "desc") {
    await say(env, "Опишите выполненные дополнительные работы.");
    return;
  }

  const upload = uploadDefinition(flow, stepId);

  if (upload) {
    const uploaded = (flow.data.files[stepId] || []).length;
    const buttons = [];

    if (uploaded > 0) {
      buttons.push(FINISH_UPLOAD);
    } else if (isSkippable(upload)) {
      buttons.push(SKIP);
    }

    await say(env, upload.prompt, buttons.length ? buttons : undefined);
    return;
  }

  if (stepId === "km") {
    await say(env, "Введите транспортный пробег (км, без доставки).");
    return;
  }

  if (stepId === "kmDelivery") {
    await say(env, "Введите пробег доставки (км). Если доставки не было — 0.");
    return;
  }

  if (stepId === "payment") {
    await say(
      env,
      `Остаток платежа: ${calc.fmt(flow.data.remainder)} руб. Получена ли оплата на монтаже?`,
      [YES, NO]
    );
    return;
  }

  if (stepId === "act_signed") {
    await say(env, "Акт подписан заказчиком?", [YES, NO]);
    return;
  }

  if (stepId === "review_site") {
    await say(env, "Оставил ли клиент отзыв в отзовике или на Яндексе?", [YES, NO]);
    return;
  }

  if (stepId === "wishes") {
    await say(env, "Доп. хотелки клиента: напишите текстом или нажмите «Пропустить».", [SKIP]);
    return;
  }

  if (stepId === "confirm") {
    await askConfirm(env, state);
  }
}

function summaryLines(flow) {
  const d = flow.data;
  const lines = [];
  const labels = {
    tempSteps: "Монтаж/демонтаж врем. ступеней",
    fence: "Ограждения (м/п)",
    platform: "Площадка (м²)",
    canopy: "Навес (м²)",
    piles: "Сваи (шт)",
    falsefloor: "Фальшпол (м²)",
    finish: "Чистовая отделка",
    extraHours: "Доп.работы (ч)",
    amount: "Монтаж изделия (м/п или м²)"
  };

  for (const key of Object.keys(labels)) {
    if (d.values[key] !== undefined && d.values[key] !== 0) {
      lines.push(`${labels[key]}: ${key === "finish" ? "да" : calc.fmt(d.values[key])}`);
    }
  }

  if (d.km !== undefined) {
    lines.push(`Транспортный пробег: ${calc.fmt(d.km)} км`);
  }

  if (d.kmDelivery) {
    lines.push(`Пробег доставки: ${calc.fmt(d.kmDelivery)} км`);
  }

  const fileCount = Object.values(d.files).reduce((sum, list) => sum + list.length, 0);

  lines.push(`Файлов загружено: ${fileCount}`);

  return lines;
}

async function askConfirm(env, state) {
  const flow = state.flow;
  const d = flow.data;
  let buttons;
  let head;

  if (flow.kind === "lekal") {
    buttons = [FINISH_REPORT];
    head = "Проверьте данные и завершите отчет (результат: «Лекалы сняты»).";
  } else if (d.answer === "yes") {
    buttons = [FINISH_REPORT];
    head = "Проверьте данные и завершите отчет (результат: «Монтаж завершен»).";
  } else {
    buttons = [RESULT.INTERMEDIATE, RESULT.INTERMEDIATE_DETAILS];
    head = "Выберите результат отчета. «Промежуточный отчет. Нужны детали» — руководитель получит запрос на уточнение.";
  }

  await say(env, `${head}\n${summaryLines(flow).join("\n")}`, buttons);
}

// ------------------------------------------------------------
// Переходы
// ------------------------------------------------------------

function buildStepsAfterMain(flow, answer, lead, ctx) {
  const d = flow.data;
  const steps = ["main"];
  const questions = (calc.QUESTIONS_BY_GROUP[flow.group] || []).map((q) => `q:${q}`);

  if (flow.kind === "lekal") {
    steps.push(...questions, "photo_lekal", "km", "kmDelivery", "confirm");
  } else if (answer === "yes") {
    steps.push(...questions, "photo_main", "video_general", "video_timelapse", "km", "kmDelivery", "navigator");

    if (d.remainder > 0) {
      steps.push("payment");
    }

    steps.push("act_signed", "review_video", "review_site", "wishes", "confirm");
  } else if (answer === "partial") {
    steps.push(...questions, "photo_main", "km", "kmDelivery", "navigator", "confirm");
  } else {
    steps.push("problem_comment", "km", "kmDelivery", "confirm");
  }

  return steps;
}

async function advance(env, state) {
  const flow = state.flow;

  flow.idx += 1;
  await ask(env, state);
}

async function handle(env, state, input) {
  const { ctx } = env;
  const flow = state.flow;
  const d = flow.data;
  const stepId = currentStep(flow);
  const kind = stepKind(stepId);
  const text = input.text;

  // --- первый вопрос ---
  if (stepId === "main") {
    const lead = await ctx.getLead(flow.leadId);

    if (flow.kind === "lekal" && text === YES) {
      d.answer = "yes";
    } else if (flow.kind === "montage" && text === YES) {
      d.answer = "yes";
    } else if (flow.kind === "montage" && text === "Частично") {
      d.answer = "partial";
    } else if (flow.kind === "montage" && text === NO) {
      d.answer = "no";
    } else if (text === MOVE) {
      d.answer = "move";
    } else {
      await ask(env, state);
      return true;
    }

    d.remainder = lead ? amo.fieldNumber(ctx, lead, FIELD.PAYMENT_REMAINDER) : 0;
    d.existingAmount = lead ? amo.fieldNumber(ctx, lead, FIELD.MONTAGE_AMOUNT) : 0;

    if (d.answer === "move") {
      flow.steps = ["main", "move_comment", "move_absent"];
    } else {
      flow.steps = buildStepsAfterMain(flow, d.answer, lead, ctx);
    }

    return advance(env, state).then(() => true);
  }

  // --- перенос выезда ---
  if (stepId === "move_comment") {
    if (!text) {
      await ask(env, state);
      return true;
    }

    d.comment = text;
    await advance(env, state);
    return true;
  }

  if (stepId === "move_absent") {
    if (text !== YES && text !== NO) {
      await ask(env, state);
      return true;
    }

    d.customerAbsent = text === YES;
    await finalize(env, state, RESULT.MOVED);
    return true;
  }

  if (stepId === "problem_comment") {
    if (!text) {
      await ask(env, state);
      return true;
    }

    d.comment = text;
    await advance(env, state);
    return true;
  }

  // --- числа и выбор ---
  if (kind === "q") {
    const key = stepArg(stepId);
    const question = QUESTIONS[key];
    let value;

    if (question.choice) {
      if (text !== YES && text !== NO) {
        await ask(env, state);
        return true;
      }

      value = text === YES ? 1 : 0;
    } else if (text === SKIP) {
      value = 0;
    } else if (/^Оставить /.test(text || "") && key === "amount") {
      value = d.existingAmount;
    } else {
      value = calc.parseNumber(text);

      if (value === null) {
        await say(env, MSG_NOT_NUMBER);
        return true;
      }
    }

    d.values[key] = value;

    // Сначала фото к ответу, потом описание доп. работ.
    if (value > 0 && question.photo) {
      insertAfterCurrent(flow, `p:${key}`);
    }

    if (value > 1 && question.describe) {
      const photoOffset = flow.steps[flow.idx + 1] === `p:${key}` ? 2 : 1;

      if (flow.steps[flow.idx + photoOffset] !== "desc") {
        flow.steps.splice(flow.idx + photoOffset, 0, "desc");
      }
    }

    await advance(env, state);
    return true;
  }

  if (stepId === "desc") {
    if (!text) {
      await ask(env, state);
      return true;
    }

    d.extraDescription = text;
    await advance(env, state);
    return true;
  }

  if (stepId === "km" || stepId === "kmDelivery") {
    const value = calc.parseNumber(text);

    if (value === null) {
      await say(env, MSG_NOT_NUMBER);
      return true;
    }

    if (stepId === "km") {
      d.km = value;
    } else {
      d.kmDelivery = value;
    }

    await advance(env, state);
    return true;
  }

  if (stepId === "payment") {
    if (text !== YES && text !== NO) {
      await ask(env, state);
      return true;
    }

    d.paymentReceived = text === YES;

    if (d.paymentReceived) {
      insertAfterCurrent(flow, "receipt");
    }

    await advance(env, state);
    return true;
  }

  if (stepId === "act_signed") {
    if (text !== YES && text !== NO) {
      await ask(env, state);
      return true;
    }

    d.actKind = text === YES ? "signed" : "refused";
    insertAfterCurrent(flow, "act_upload");
    await advance(env, state);
    return true;
  }

  if (stepId === "review_site") {
    if (text !== YES && text !== NO) {
      await ask(env, state);
      return true;
    }

    d.reviewSite = text === YES;
    await advance(env, state);
    return true;
  }

  if (stepId === "wishes") {
    if (!text) {
      await ask(env, state);
      return true;
    }

    if (text !== SKIP) {
      d.wishes = text;
    }

    await advance(env, state);
    return true;
  }

  // --- загрузки ---
  const upload = uploadDefinition(flow, stepId);

  if (upload) {
    return handleUpload(env, state, stepId, upload, input);
  }

  // --- подтверждение ---
  if (stepId === "confirm") {
    let result = null;

    if (flow.kind === "lekal" && text === FINISH_REPORT) {
      result = RESULT.LEKALS_DONE;
    } else if (flow.kind === "montage" && d.answer === "yes" && text === FINISH_REPORT) {
      result = RESULT.MONTAGE_DONE;
    } else if (flow.kind === "montage" && d.answer !== "yes" && (text === RESULT.INTERMEDIATE || text === RESULT.INTERMEDIATE_DETAILS)) {
      result = text;
    }

    if (!result) {
      await askConfirm(env, state);
      return true;
    }

    await finalize(env, state, result);
    return true;
  }

  return false;
}

async function handleUpload(env, state, stepId, upload, input) {
  const { ctx } = env;
  const flow = state.flow;
  const list = (flow.data.files[stepId] = flow.data.files[stepId] || []);

  if (input.attachments.length > 0) {
    const fitting = input.attachments.filter((item) => files.attachmentFits(item, upload.kind));

    if (fitting.length === 0) {
      await say(env, upload.kind === "video" ? "На этом шаге нужно прислать видео." : "На этом шаге нужно прислать фото.");
      return true;
    }

    await say(env, "Файлы получены, загружаю на Яндекс Диск");

    let uploadedNow = 0;

    for (const attachment of fitting) {
      try {
        list.push(await files.uploadFile(ctx, flow.leadId, upload.cat, attachment));
        uploadedNow += 1;
      } catch (error) {
        console.error("[Бот монтажников] Ошибка загрузки файла на Яндекс.Диск:", error.message);
        await say(env, `❌ Не удалось загрузить файл на Яндекс.Диск (${error.message.slice(0, 120)}). Отправьте его ещё раз.`);
      }
    }

    if (uploadedNow > 0) {
      await say(env, "Файл сохранен на Яндекс.Диске.\nДополните или завершите загрузку.", [FINISH_UPLOAD]);
    }

    return true;
  }

  if (input.text === FINISH_UPLOAD) {
    if (list.length === 0 && !isSkippable(upload)) {
      await say(env, "Вы ещё не прикрепили ни одного файла.");
      return true;
    }
  } else if (input.text === SKIP && list.length === 0 && isSkippable(upload)) {
    // пропуск шага
  } else {
    await ask(env, state);
    return true;
  }

  await advance(env, state);
  return true;
}

// ------------------------------------------------------------
// Завершение отчёта (идемпотентно: что уже сделано — не повторяем)
// ------------------------------------------------------------

function todayStartUnix(ctx) {
  return ctx.todayMoscowStartUnix();
}

async function resolveSlot(ctx, lead, foremanName, d) {
  let index = amo.findSlotIndex(ctx, lead, foremanName);

  if (index >= 0) {
    return index;
  }

  // Монтажник ещё не записан ни в одну группу полей — берём первую свободную
  // и записываем его туда (если в списке поля есть такое значение).
  index = SLOT_FIELDS.findIndex((slot) => !amo.fieldText(ctx, lead, slot.master));

  if (index < 0) {
    throw new Error("Во всех группах «N. Монтажник» уже указаны другие люди.");
  }

  const response = await ctx.amoCrmGet(
    `https://${ctx.AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4/leads/custom_fields/${SLOT_FIELDS[index].master}`,
    {}
  );
  const options = (response.status === 200 && response.data && response.data.enums) || [];
  const option = options.find((item) => calc.sameName(item.value, foremanName));

  if (option) {
    d.slotMasterPayload = { field_id: SLOT_FIELDS[index].master, values: [{ value: option.value, enum_id: option.id }] };
  } else {
    console.warn(`[Бот монтажников] В поле «${SLOT_FIELDS[index].master}» нет значения «${foremanName}».`);
  }

  return index;
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
  const warnings = [];

  try {
    // 1) ссылки на загруженные файлы (публикуем один раз)
    if (!done.links) {
      const imageSteps = Object.keys(d.files).filter(
        (id) => id === "photo_main" || id === "photo_lekal" || stepKind(id) === "p"
      );
      const photoPaths = imageSteps.flatMap((id) => d.files[id]);
      const actPaths = d.files.act_upload || [];

      d.photoLinks = await files.publicLinks(ctx, photoPaths);
      d.actLinks = await files.publicLinks(ctx, actPaths);
      d.allLinks = await files.publicLinks(ctx, Object.values(d.files).flat());
      d.folderUrl = await files.ensureFolderLink(ctx, lead);
      done.links = true;
    }

    // 2) запись в сделку (одним запросом)
    if (!done.fields && result !== RESULT.MOVED) {
      const payload = [];
      const slotIndex = await resolveSlot(ctx, lead, foremanName, d);
      const slotValues = {};

      for (const key of Object.keys(d.values)) {
        if (key !== "amount") {
          slotValues[key] = d.values[key];
        }
      }

      if (d.km !== undefined) {
        slotValues.kmFact = d.km;
      }

      if (d.kmDelivery !== undefined) {
        slotValues.kmDelivery = d.kmDelivery;
      }

      if (motivation) {
        if (d.km !== undefined) {
          slotValues.tariff = calc.num(motivation.transportTariff);
          slotValues.kmFactTotal = calc.round2(calc.num(motivation.transportTariff) * d.km);
        }

        if (d.kmDelivery !== undefined) {
          slotValues.tariffDelivery = calc.num(motivation.deliveryTariff);
          slotValues.kmDeliveryTotal = calc.round2(calc.num(motivation.deliveryTariff) * d.kmDelivery);
        }
      } else {
        warnings.push("для бригадира не выбрана «Мотивация роли» — тарифы не записаны");
      }

      if (result === RESULT.MONTAGE_DONE) {
        slotValues.date = todayStartUnix(ctx);
      }

      // КТУ: баллы из настроек за загруженные видео и отзыв.
      const ktuAwards = [];

      for (const stepId of ["video_general", "video_timelapse", "review_video"]) {
        if ((d.files[stepId] || []).length > 0) {
          ktuAwards.push(UPLOADS[stepId]);
        }
      }

      for (const award of ktuAwards) {
        slotValues[award.ktu] = settingsStore.ktuPoints(settings, award.ktuLabel);
      }

      if (d.reviewSite) {
        slotValues.ktuReviewSite = settingsStore.ktuPoints(settings, "Отзыв в отзовике или Яндексе");
      }

      if (d.extraDescription) {
        slotValues.note = d.extraDescription;
      }

      // Цена монтажа (T-8).
      const priceFields = {
        floors: amo.fieldNumber(ctx, lead, FIELD.FLOORS),
        budget: Number(lead.price) || 0,
        ...d.values
      };

      if (result === RESULT.MONTAGE_DONE || result === RESULT.LEKALS_DONE) {
        const pricingRow = settingsStore.findPricingRow(settings, amo.fieldEnumId(lead, FIELD.PRODUCT), d.productName);
        const calculated = flow.group && pricingRow ? calc.calcMontagePrice(flow.group, pricingRow, priceFields, motivation) : null;

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

      if (d.values.amount !== undefined && flow.group === "meter") {
        payload.push(amo.setValue(FIELD.MONTAGE_AMOUNT, d.values.amount));
      }

      // [Бот] Ссылка на фото: сначала очищаем, затем пишем ссылки через «, ».
      if (result === RESULT.MONTAGE_DONE) {
        payload.push(d.photoLinks.length ? amo.setValue(FIELD.PHOTO_LINK, d.photoLinks.join(", ")) : amo.clearField(FIELD.PHOTO_LINK));
      } else if (flow.kind === "montage" && (d.answer === "partial" || d.answer === "no")) {
        payload.push(amo.clearField(FIELD.PHOTO_LINK));
      }

      if (d.actLinks && d.actLinks.length > 0) {
        payload.push(amo.setValue(FIELD.ACT, d.actLinks.join(", ")));
      }

      if (d.wishes) {
        payload.push(amo.setValue(FIELD.BOT_NOTE, d.wishes));
      }

      if (payload.length > 0) {
        await amo.patchLead(ctx, lead.id, { custom_fields_values: payload });
      }

      done.fields = true;
    }

    // 3) примечание в сделке
    if (!done.note) {
      let noteText = null;

      if (result === RESULT.MOVED) {
        noteText = d.comment;
      } else if (flow.kind === "montage" && d.answer === "partial") {
        noteText = "Изделие частично установлено" + (d.comment ? `\n${d.comment}` : "");
      } else if (flow.kind === "montage" && d.answer === "no") {
        noteText = "Изделие не установлено" + (d.comment ? `\n${d.comment}` : "");
      }

      if (noteText) {
        await amo.addNote(ctx, lead.id, noteText);
      }

      done.note = true;
    }

    // 4) контрольные задачи
    if (!done.absentTask && result === RESULT.MOVED && d.customerAbsent) {
      await amo.createTask(ctx, {
        leadId: lead.id,
        responsibleUserId: USER.REDKINA_YULIA,
        typeId: TASK_TYPE.CONTROL,
        text: "Заказчик отсутствовал на объекте. Выслать акт электронно.",
        hours: 1
      });
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
    // 5а) публикация в канал amoMessenger (вместо Telegram). Сбой не мешает
    // отчёту: уже отправленное повторно не уходит.
    if (!done.channel && result === RESULT.MONTAGE_DONE) {
      d.channelDone = d.channelDone || {};

      try {
        const channelPaths = ["photo_main", "video_general", "video_timelapse", "review_video"].flatMap((id) => d.files[id] || []);
        const folderUrl = d.folderUrl ? `[Папка на Яндекс Диске](${d.folderUrl})` : "";

        d.channelSkipped = await channel.publishReport(ctx, {
          text:
            `**Договор / замерный лист:** ${mdSafe(number)}
` +
            `**Бюджет:** ${mdSafe(calc.fmt(Number(lead.price) || 0))}
` +
            `**Продукт:** ${mdSafe(d.productName)}
` +
            `**Фотоотчет:** ${folderUrl}`,
          paths: channelPaths,
          done: d.channelDone
        });
        done.channel = true;
      } catch (error) {
        console.error("[Бот монтажников] Ошибка публикации в канал:", error.message);
        warnings.push("файлы не удалось отправить в канал amoMessenger");
        d.channelFailed = true;
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

  // 6) уведомление руководителю
  if (!done.notify) {
    const managerNames = managerRow ? [managerRow.managerHandle] : [];
    const folderText = d.folderUrl ? `[Папка на Яндекс Диске](${d.folderUrl})` : deals.folderLink(ctx, lead);
    const who = mdSafe(foremanName);

    if (result === RESULT.INTERMEDIATE) {
      await messenger.notify(
        ctx,
        managerNames,
        `Монтаж по договору № ${mdSafe(number)} не завершен. Монтажник ${who}. ${folderText}`,
        { markdown: true }
      );
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

  // 7) ответ пользователю, отчёт завершён
  const leadId = flow.leadId;

  state.flow = null;

  if (state.drafts) {
    delete state.drafts[leadId];
  }

  await say(
    env,
    `Задача amoCRM "Отчет о монтаже" закрыта с результатом "${result}".\nДоговор № ${mdSafe(number)}.`,
    undefined,
    true
  );
}

module.exports = { start, handle, ask, FINISH_REPORT };
