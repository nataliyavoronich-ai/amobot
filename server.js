// ============================================================
// ПОЛУЧИТЬ ЗАМЕРЫ ДЛЯ МАРИНЫ
// ============================================================
//
// НОВЫЙ АЛГОРИТМ:
//
// 1. Получаем только НЕЗАВЕРШЁННЫЕ задачи.
// 2. Из них оставляем только задачи типа 2746005.
// 3. Проверяем дату исполнения complete_till
//    в нашем коде, по московскому времени.
// 4. Из задач получаем ID сделок.
// 5. Получаем только эти сделки.
// 6. Проверяем поле "Инженер".
// 7. Оставляем только Марину.
//
// ВАЖНО:
// Мы больше НЕ загружаем все сделки аккаунта.
// ============================================================

async function getMeasurementTasksForMarina() {

  console.log(
    "=========================================="
  );

  console.log(
    "БЫСТРЫЙ ПОИСК ЗАДАЧ МАРИНЫ"
  );

  console.log(
    "Инженер:",
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
    "Тип задачи:",
    TASK_TYPE_ID
  );

  console.log(
    "Ищем только НЕЗАВЕРШЁННЫЕ задачи"
  );

  // ----------------------------------------------------------
  // Получаем нужный диапазон времени.
  //
  // До 18:00:
  // вчера 00:00 -> сейчас
  //
  // После 18:00:
  // сегодня 00:00 -> завтра 23:59:59
  // ----------------------------------------------------------

  const range =
    getTaskDateRange();

  console.log(
    "Режим:",
    range.mode
  );

  console.log(
    "Диапазон:",
    formatMoscowDate(range.from),
    "->",
    formatMoscowDate(range.to)
  );

  // ----------------------------------------------------------
  // Получаем НЕЗАВЕРШЁННЫЕ задачи.
  //
  // Здесь намеренно НЕ используем фильтр:
  //
  // filter[task_type]
  // filter[complete_till]
  //
  // потому что именно сложные комбинации фильтров
  // в вашем аккаунте давали Invalid filter.
  //
  // Используем только:
  //
  // entity_type = leads
  // is_completed = 0
  //
  // А тип задачи и дату проверяем сами.
  // ----------------------------------------------------------

  const allTasks = [];

  let page = 1;

  while (true) {

    const params =
      new URLSearchParams();

    params.set(
      "filter[entity_type]",
      "leads"
    );

    params.set(
      "filter[is_completed][0]",
      "0"
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

    const data =
      await amocrmRequest(
        `/api/v4/tasks?${params.toString()}`
      );

    const current =
      data &&
      data._embedded &&
      Array.isArray(
        data._embedded.tasks
      )
        ? data._embedded.tasks
        : [];

    console.log(
      `Страница незавершённых задач ${page}: ${current.length}`
    );

    allTasks.push(
      ...current
    );

    // Если получили меньше 250,
    // это последняя страница.
    if (
      current.length < 250
    ) {

      break;
    }

    page++;

    // Защита от бесконечной загрузки.
    if (
      page > 100
    ) {

      console.log(
        "Остановлено после 100 страниц задач."
      );

      break;
    }
  }

  console.log(
    "Всего получено незавершённых задач:",
    allTasks.length
  );

  // ----------------------------------------------------------
  // Оставляем только:
  //
  // entity_type = leads
  // task_type_id = 2746005
  // is_completed = false
  // есть complete_till
  // ----------------------------------------------------------

  const measurementTasks =
    allTasks.filter(
      task => {

        const correctEntity =
          String(
            task.entity_type
          ) === "leads";

        const correctType =
          Number(
            task.task_type_id
          ) ===
          Number(
            TASK_TYPE_ID
          );

        const notCompleted =
          task.is_completed === false ||
          task.is_completed === 0 ||
          task.is_completed === "0";

        const hasDeadline =
          task.complete_till !== null &&
          task.complete_till !== undefined &&
          Number.isFinite(
            Number(
              task.complete_till
            )
          );

        return (
          correctEntity &&
          correctType &&
          notCompleted &&
          hasDeadline
        );
      }
    );

  console.log(
    "Задач типа Подтв. замер(и):",
    measurementTasks.length
  );

  // ----------------------------------------------------------
  // Теперь проверяем дату ИСПОЛНЕНИЯ ЗАДАЧИ.
  //
  // ВАЖНО:
  // Используем complete_till.
  //
  // Поле "Дата замера" сделки здесь НЕ используется.
  // ----------------------------------------------------------

  const dateTasks =
    measurementTasks.filter(
      task => {

        const deadline =
          Number(
            task.complete_till
          );

        return (
          deadline >= range.from &&
          deadline <= range.to
        );
      }
    );

  console.log(
    "Задач после фильтра по complete_till:",
    dateTasks.length
  );

  // ----------------------------------------------------------
  // Если подходящих задач нет,
  // сделки вообще не запрашиваем.
  // ----------------------------------------------------------

  if (
    !dateTasks.length
  ) {

    console.log(
      "Подходящих задач нет."
    );

    console.log(
      "=========================================="
    );

    return {

      leads: [],

      tasks: [],

    };
  }

  // ----------------------------------------------------------
  // Получаем уникальные ID сделок.
  // ----------------------------------------------------------

  const leadIds = [
    ...new Set(
      dateTasks
        .map(
          task =>
            Number(
              task.entity_id
            )
        )
        .filter(
          id =>
            Number.isFinite(id) &&
            id > 0
        )
    ),
  ];

  console.log(
    "Сделок, связанных с подходящими задачами:",
    leadIds.length
  );

  // ----------------------------------------------------------
  // Получаем только нужные сделки.
  //
  // НЕ загружаем все сделки аккаунта.
  // ----------------------------------------------------------

  const leads = [];

  for (
    const leadId of
    leadIds
  ) {

    try {

      const lead =
        await getLead(
          leadId
        );

      if (
        lead &&
        lead.id
      ) {

        leads.push(
          lead
        );

      }

    } catch (
      error
    ) {

      console.error(
        `Ошибка получения сделки ${leadId}:`,
        error.message
      );

    }
  }

  console.log(
    "Получено конкретных сделок:",
    leads.length
  );

  // ----------------------------------------------------------
  // Оставляем только сделки Марины.
  //
  // Проверяем:
  // field_id = 203849
  // enum_id = 1059150
  //
  // API-фильтр amoCRM здесь НЕ используем.
  // ----------------------------------------------------------

  const marinaLeads =
    leads.filter(
      lead =>
        isMarina(
          lead
        )
    );

  console.log(
    "Сделок Марины:",
    marinaLeads.length
  );

  // ----------------------------------------------------------
  // ID сделок Марины.
  // ----------------------------------------------------------

  const marinaLeadIds =
    new Set(
      marinaLeads.map(
        lead =>
          Number(
            lead.id
          )
      )
    );

  // ----------------------------------------------------------
  // Оставляем только задачи,
  // которые принадлежат сделкам Марины.
  // ----------------------------------------------------------

  const marinaTasks =
    dateTasks.filter(
      task =>
        marinaLeadIds.has(
          Number(
            task.entity_id
          )
        )
    );

  console.log(
    "Задач Марины:",
    marinaTasks.length
  );

  // ----------------------------------------------------------
  // Показываем найденные задачи в логах.
  // Это очень поможет при тестировании.
  // ----------------------------------------------------------

  for (
    const task of
    marinaTasks
  ) {

    console.log(
      "НАЙДЕНА ЗАДАЧА:",
      {
        task_id:
          task.id,

        lead_id:
          task.entity_id,

        task_type_id:
          task.task_type_id,

        is_completed:
          task.is_completed,

        complete_till:
          task.complete_till,

        complete_till_moscow:
          formatMoscowDate(
            task.complete_till
          ),
      }
    );
  }

  console.log(
    "=========================================="
  );

  return {

    leads:
      marinaLeads,

    tasks:
      marinaTasks,

  };
}
