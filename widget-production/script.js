// ============================================================
// ВИДЖЕТ "ПРОИЗВОДСТВО" — РАСШИРЕННЫЕ НАСТРОЙКИ (amoCRM)
// ============================================================
//
// Классический виджет amoCRM (AMD-модуль, jQuery доступен как зависимость).
// Вся конфигурация ТЗ (роли, связь статусов и полей, сценарии, плановая
// готовность) живёт на одной странице "Расширенные настройки"
// (callbacks.advancedSettings), т.к. локация "advanced_settings" указана
// в manifest.json.
//
// ХРАНЕНИЕ (гибрид, см. план Фазы 1):
// 1) Встроенное хранилище amoCRM — скрытое текстовое поле формы
//    "production_data" (объявлено в manifest.json → settings), куда пишется
//    JSON всех настроек целиком; читается через self.get_settings().
//    Это подтверждённый рабочий способ для классических виджетов amoCRM —
//    отдельного JS-метода записи (set_settings) в реальном рантайме нет,
//    сохранение идёт через именованные поля формы. Нужно только для
//    нативного UX (подгрузка при повторном открытии), не является
//    источником истины.
// 2) POST/GET на BACKEND_BASE + "/widget/production/settings" (наш
//    Node-сервер, Selectel) — источник истины, который читает бот в
//    рантайме. При открытии настроек сначала пробуем backend (сверить с
//    самым актуальным сохранённым состоянием), при ошибке сети падаем на
//    встроенное хранилище amoCRM как запасной вариант.
//
// ЖИВЫЕ ДАННЫЕ (воронки/статусы/поля/пользователи) виджет читает сам,
// напрямую из браузера администратора, обычным AJAX-запросом к
// "/api/v4/..." — скрипт выполняется на странице amocrm.ru, поэтому запрос
// идёт с той же сессией/куками, что и сам интерфейс amoCRM, без CORS и без
// отдельного токена.
//
// ВАЖНО ПЕРЕД ЗАГРУЗКОЙ АРХИВА В AMOCRM:
// - WIDGET_SECRET ниже должен буквально совпадать со значением переменной
//   окружения PRODUCTION_WIDGET_SECRET на Selectel — иначе backend будет
//   отвечать 403 на сохранение/чтение настроек.
// - Колбэки/структура манифеста собраны по документации amoCRM/Kommo для
//   классических виджетов; при первой реальной загрузке архива в amoCRM
//   возможны мелкие несовпадения с фактическим рантаймом — тогда
//   потребуется правка по сообщению об ошибке загрузки/валидации.

define(["jquery"], function ($) {
  return function () {
    var self = this;

    // ------------------------------------------------------------
    // КОНФИГ
    // ------------------------------------------------------------

    var BACKEND_BASE = "https://amobot.zavod-lestnic-na-metalle.ru";
    // Это же значение должно быть задано в переменной окружения
    // PRODUCTION_WIDGET_SECRET на Selectel — иначе backend будет отвечать 403.
    var WIDGET_SECRET = "kVfqiFTx4sDt3ZG02SlEdTdO0jn2Hy1WCt5mcv2YGEk";

    var ROLE_DEFS = [
      { key: "productionDirector", label: "Директор производства" },
      { key: "metalShopForeman", label: "Мастер металлического цеха" },
      { key: "woodShopForeman", label: "Мастер столярного цеха" },
      { key: "otk", label: "ОТК" }
    ];

    var BOT_STATUS_OPTIONS = [
      { value: "", label: "— не выбрано —" },
      { value: "execution", label: "Исполнение" },
      { value: "distribution", label: "Распределение" }
    ];

    // ------------------------------------------------------------
    // СОСТОЯНИЕ (в памяти, пока открыт экран настроек)
    // ------------------------------------------------------------

    var liveData = {
      pipelines: [], // [{id, name, statuses: [{id, name, pipeline_id}]}]
      statusesById: {}, // amoStatusId -> {id, name, pipeline_id, pipeline_name}
      fields: [], // [{id, name, type, enums: [{id, value}]}]
      users: [] // [{id, name}]
    };

    var settingsState = null; // текущее состояние формы (объект схемы настроек)
    var $root = null; // корневой контейнер расширенных настроек
    var activeTab = "roles";

    // ------------------------------------------------------------
    // ЗАГРУЗКА ЖИВЫХ ДАННЫХ AMOCRM (напрямую из браузера админа)
    // ------------------------------------------------------------

    function amoApiGet(path, params) {
      return $.ajax({
        url: path,
        method: "GET",
        data: params || {},
        dataType: "json"
      });
    }

    function loadPipelines() {
      return amoApiGet("/api/v4/leads/pipelines").then(function (response) {
        var pipelines = (response && response._embedded && response._embedded.pipelines) || [];

        liveData.pipelines = pipelines.map(function (p) {
          var statuses = (p._embedded && p._embedded.statuses) || [];

          statuses.forEach(function (s) {
            liveData.statusesById[s.id] = {
              id: s.id,
              name: s.name,
              pipeline_id: p.id,
              pipeline_name: p.name
            };
          });

          return {
            id: p.id,
            name: p.name,
            statuses: statuses.map(function (s) {
              return { id: s.id, name: s.name, pipeline_id: p.id };
            })
          };
        });
      });
    }

    // Список статусов обеих воронок одним плоским списком (ТЗ: без
    // отдельного переключателя воронки — см. план Фазы 1).
    function allLiveStatuses() {
      var result = [];

      liveData.pipelines.forEach(function (p) {
        p.statuses.forEach(function (s) {
          result.push({ id: s.id, name: s.name, pipelineName: p.name });
        });
      });

      return result;
    }

    function loadCustomFields() {
      liveData.fields = [];

      function loadPage(page) {
        return amoApiGet("/api/v4/leads/custom_fields", { page: page, limit: 250 }).then(function (
          response
        ) {
          var fields = (response && response._embedded && response._embedded.custom_fields) || [];

          fields.forEach(function (f) {
            liveData.fields.push({
              id: f.id,
              name: f.name,
              type: f.type,
              enums: Array.isArray(f.enums)
                ? f.enums.map(function (e) {
                    return { id: e.id, value: e.value };
                  })
                : []
            });
          });

          var hasNext = response && response._links && response._links.next;

          if (hasNext) {
            return loadPage(page + 1);
          }
        });
      }

      return loadPage(1);
    }

    function loadUsers() {
      liveData.users = [];

      function loadPage(page) {
        return amoApiGet("/api/v4/users", { page: page, limit: 250 }).then(function (response) {
          var users = (response && response._embedded && response._embedded.users) || [];

          users.forEach(function (u) {
            liveData.users.push({ id: u.id, name: u.name });
          });

          var hasNext = response && response._links && response._links.next;

          if (hasNext) {
            return loadPage(page + 1);
          }
        });
      }

      return loadPage(1);
    }

    function loadAllLiveData() {
      return $.when(loadPipelines(), loadCustomFields(), loadUsers());
    }

    // ------------------------------------------------------------
    // ЗАГРУЗКА/СОХРАНЕНИЕ НАСТРОЕК (гибрид)
    // ------------------------------------------------------------

    function emptySettings() {
      return {
        schemaVersion: 1,
        roles: {},
        statusFieldMap: [],
        readinessMatrix: { productFieldId: null, products: [], statusIds: [], cells: {} },
        scenarios: {}
      };
    }

    function backendRequest(method, body) {
      return $.ajax({
        url: BACKEND_BASE + "/widget/production/settings",
        method: method,
        headers: { "X-Widget-Secret": WIDGET_SECRET },
        contentType: "application/json",
        data: body ? JSON.stringify(body) : undefined,
        dataType: "json"
      });
    }

    // Встроенное хранилище amoCRM отдаёт объект, где значения — это то,
    // что сохранено в полях формы, описанных в manifest.json ("settings").
    // У нас там одно служебное текстовое поле "production_data" со всем
    // JSON настроек внутри (см. syncNativeSettingsField ниже).
    function parseNativeSettings() {
      try {
        var raw = self.get_settings && self.get_settings();
        var jsonText = raw && raw.production_data;

        return jsonText ? JSON.parse(jsonText) : null;
      } catch (e) {
        return null;
      }
    }

    function loadSettings() {
      // jQuery-промисы (то, что возвращает $.ajax) не всегда поддерживают
      // .catch() — используем универсальную форму .then(успех, ошибка).
      return backendRequest("GET").then(
        function (data) {
          return data || parseNativeSettings() || emptySettings();
        },
        function () {
          console.warn(
            "[Виджет Производство] Не удалось получить настройки с backend — " +
              "использую встроенное хранилище amoCRM как запасной вариант."
          );

          return parseNativeSettings() || emptySettings();
        }
      );
    }

    // Записывает текущие настройки в скрытое поле формы "production_data"
    // (объявлено в manifest.json → settings). Это и есть реальный механизм
    // сохранения во встроенное хранилище amoCRM для классических виджетов —
    // отдельного JS-метода для записи нет, amoCRM сама подхватывает значения
    // именованных полей формы при нажатии родной кнопки сохранения.
    function syncNativeSettingsField(jsonValue) {
      var $scope = $root && $root.closest("form").length ? $root.closest("form") : $("body");
      var $field = $scope.find('input[name="production_data"]');

      if (!$field.length) {
        $scope.append('<input type="text" name="production_data" style="display:none;">');
        $field = $scope.find('input[name="production_data"]');
      }

      $field.val(jsonValue).trigger("input").trigger("change");
    }

    // Клиентская валидация — быстрая обратная связь до отправки на backend.
    // Финальная проверка всё равно выполняется на backend
    // (productionBot.js: validateProductionWidgetSettings) — именно её
    // результат блокирует реальное сохранение.
    function validateClientSide(settings) {
      var activeHandles = {};

      for (var i = 0; i < ROLE_DEFS.length; i++) {
        var entries = settings.roles[ROLE_DEFS[i].key] || [];

        for (var j = 0; j < entries.length; j++) {
          var handle = (entries[j].handle || "").trim();

          if (entries[j].active && handle) {
            if (activeHandles[handle]) {
              return "Один пользователь не может одновременно состоять в двух активных ролях.";
            }

            activeHandles[handle] = true;
          }
        }
      }

      for (var k = 0; k < settings.statusFieldMap.length; k++) {
        var row = settings.statusFieldMap[k];

        if (!row.amoStatusId || !row.botStatus) {
          return "В таблице есть незаполненные данные";
        }
      }

      var matrix = settings.readinessMatrix || {};

      for (var p = 0; p < (matrix.products || []).length; p++) {
        if (!matrix.products[p].enumId) {
          return "В таблице есть незаполненные данные";
        }
      }

      for (var s = 0; s < (matrix.statusIds || []).length; s++) {
        if (!matrix.statusIds[s]) {
          return "В таблице есть незаполненные данные";
        }
      }

      var cells = matrix.cells || {};

      for (var cellKey in cells) {
        if (Object.prototype.hasOwnProperty.call(cells, cellKey)) {
          var value = cells[cellKey];

          if (typeof value !== "number" || isNaN(value) || value < 0) {
            return "Плановая готовность содержит некорректное значение (должно быть 0 или больше).";
          }
        }
      }

      return null;
    }

    function saveSettings() {
      var error = validateClientSide(settingsState);

      showSaveMessage("");

      if (error) {
        showSaveMessage(error, true);
        return;
      }

      // 1) Встроенное хранилище amoCRM — для нативного UX при переоткрытии.
      syncNativeSettingsField(JSON.stringify(settingsState));

      // 2) Backend / Redis — источник истины для бота в рантайме.
      backendRequest("POST", settingsState).then(
        function () {
          showSaveMessage("Настройки сохранены.", false);
        },
        function (xhr) {
          var message =
            (xhr && xhr.responseJSON && xhr.responseJSON.error) ||
            "Не удалось сохранить настройки на сервере.";

          showSaveMessage(message, true);
        }
      );
    }

    function showSaveMessage(text, isError) {
      if (!$root) {
        return;
      }

      var $el = $root.find(".production-widget__save-message");

      $el
        .text(text || "")
        .css("color", isError ? "#c0392b" : "#27ae60");
    }

    // ------------------------------------------------------------
    // ОБЩИЕ УТИЛИТЫ РЕНДЕРА
    // ------------------------------------------------------------

    function fieldOptionsHtml(selectedId, allowedTypes) {
      var html = '<option value="">— не выбрано —</option>';

      liveData.fields.forEach(function (f) {
        if (allowedTypes && allowedTypes.length && allowedTypes.indexOf(f.type) === -1) {
          return;
        }

        var selected = String(f.id) === String(selectedId) ? " selected" : "";

        html += '<option value="' + f.id + '"' + selected + ">" + escapeHtml(f.name) + "</option>";
      });

      return html;
    }

    function statusOptionsHtml(selectedId, excludeIds) {
      var html = '<option value="">— выбрать статус —</option>';

      allLiveStatuses().forEach(function (s) {
        if (excludeIds && excludeIds.indexOf(s.id) !== -1 && String(s.id) !== String(selectedId)) {
          return;
        }

        var selected = String(s.id) === String(selectedId) ? " selected" : "";

        html +=
          '<option value="' +
          s.id +
          '"' +
          selected +
          ">" +
          escapeHtml(s.name) +
          " (" +
          escapeHtml(s.pipelineName) +
          ")</option>";
      });

      return html;
    }

    function escapeHtml(text) {
      return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // ------------------------------------------------------------
    // КАСТОМНОЕ ОКНО ПОДТВЕРЖДЕНИЯ "ДА/НЕТ" (вместо системного confirm)
    // ------------------------------------------------------------

    var $confirmOverlay = null;

    function showConfirmDialog(message, onYes) {
      if ($confirmOverlay) {
        $confirmOverlay.remove();
      }

      $confirmOverlay = $(
        '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.35);' +
          'z-index:1000;display:flex;align-items:center;justify-content:center;"></div>'
      );

      var $box = $(
        '<div style="background:#fff;border-radius:6px;padding:20px 24px;max-width:360px;' +
          'box-shadow:0 4px 20px rgba(0,0,0,0.25);color:#333;font-size:14px;"></div>'
      );

      $box.append('<div style="margin-bottom:16px;">' + escapeHtml(message) + "</div>");

      var $btnRow = $('<div style="display:flex;gap:12px;justify-content:flex-end;"></div>');

      var $yesBtn = $(
        '<button type="button" style="padding:6px 16px;background:#2d7ff9;color:#fff;' +
          'border:none;border-radius:4px;cursor:pointer;">Да</button>'
      ).on("click", function () {
        $confirmOverlay.remove();
        $confirmOverlay = null;
        onYes();
      });

      var $noBtn = $(
        '<button type="button" style="padding:6px 16px;background:#eee;color:#333;' +
          'border:none;border-radius:4px;cursor:pointer;">Нет</button>'
      ).on("click", function () {
        $confirmOverlay.remove();
        $confirmOverlay = null;
      });

      $btnRow.append($noBtn).append($yesBtn);
      $box.append($btnRow);
      $confirmOverlay.append($box);

      $("body").append($confirmOverlay);
    }

    // ------------------------------------------------------------
    // ПОЛЕ ВЫБОРА С ПОИСКОМ ПО НАЗВАНИЮ (input + datalist, без сторонних
    // библиотек — по требованию "должен работать поиск по названию поля")
    // ------------------------------------------------------------

    var searchableFieldPickerCounter = 0;

    function buildSearchableFieldPicker(selectedId, allowedTypes, onChange) {
      searchableFieldPickerCounter++;

      var listId = "production-widget-field-list-" + searchableFieldPickerCounter;

      var options = liveData.fields.filter(function (f) {
        return !allowedTypes || !allowedTypes.length || allowedTypes.indexOf(f.type) !== -1;
      });

      var selectedField = options.filter(function (f) {
        return String(f.id) === String(selectedId);
      })[0];

      var $wrap = $('<div style="min-width:160px;"></div>');
      var $input = $(
        '<input type="text" placeholder="Поиск по названию…" list="' + listId + '" />'
      )
        .css({ width: "100%" })
        .val(selectedField ? selectedField.name : "");

      var $datalist = $('<datalist id="' + listId + '"></datalist>');

      options.forEach(function (f) {
        $datalist.append('<option value="' + escapeHtml(f.name) + '"></option>');
      });

      $input.on("change", function () {
        var text = $(this).val().trim();

        if (!text) {
          onChange(null);
          return;
        }

        var match = options.filter(function (f) {
          return f.name === text;
        })[0];

        if (match) {
          onChange(match.id);
        } else {
          // Введённый текст не совпадает ни с одним полем точно — не
          // сохраняем "мусор", возвращаем предыдущее выбранное значение.
          $(this).val(selectedField ? selectedField.name : "");
        }
      });

      $wrap.append($input).append($datalist);

      return $wrap;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "РОЛИ"
    // ------------------------------------------------------------

    // Роли назначаются по имени пользователя amoMessenger (например,
    // "@nataliya_voronich"), а НЕ по пользователю amoCRM — это два разных
    // списка людей, и список amoMessenger-пользователей браузер напрямую
    // получить не может (отдельный сервис, нужен токен бота, а не сессия
    // администратора amoCRM). Поэтому имя вводится вручную текстом —
    // администратор копирует его из мессенджера.
    function renderRolesTab() {
      var $tab = $('<div class="production-widget__roles"></div>');
      $tab.css({ display: "flex", gap: "32px", flexWrap: "wrap" });

      ROLE_DEFS.forEach(function (role) {
        var entries = settingsState.roles[role.key] || (settingsState.roles[role.key] = []);

        var $col = $('<div class="production-widget__role-col"></div>');
        $col.css({ minWidth: "220px" });

        $col.append(
          '<div style="font-weight:600;margin-bottom:8px;color:#333;">' + escapeHtml(role.label) + "</div>"
        );

        var $list = $('<div class="production-widget__role-list"></div>');

        function renderList() {
          $list.empty();

          entries.forEach(function (entry, idx) {
            var $row = $('<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"></div>');

            var $input = $('<input type="text" placeholder="Имя в amoMessenger" />')
              .css({ flex: 1 })
              .val(entry.handle || "")
              .on("change input", function () {
                entry.handle = $(this).val();
              });

            $row.append($input);

            var $checkbox = $(
              '<input type="checkbox"' + (entry.active ? " checked" : "") + " />"
            ).on("change", function () {
              entry.active = $(this).is(":checked");
            });

            $row.append($checkbox);

            var $delete = $('<span style="cursor:pointer;color:#c0392b;" title="Удалить">🗑</span>').on(
              "click",
              function () {
                if (window.confirm("Удалить «" + (entry.handle || "") + "» из роли «" + role.label + "»?")) {
                  entries.splice(idx, 1);
                  renderList();
                }
              }
            );

            $row.append($delete);

            $list.append($row);
          });
        }

        renderList();

        $col.append($list);

        var $addBtn = $('<div style="margin-top:8px;cursor:pointer;color:#2d7ff9;">+ Добавить пользователя</div>').on(
          "click",
          function () {
            entries.push({ handle: "", active: true });
            renderList();
          }
        );

        $col.append($addBtn);

        $tab.append($col);
      });

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "СВЯЗЬ ЭТАПОВ И ПОЛЕЙ"
    // ------------------------------------------------------------

    // Строки заводятся вручную администратором (кнопка "+ Добавить
    // строку"), а не автоматически по всем живым статусам — статус для
    // строки выбирается из выпадающего списка, как и в "Сценариях".
    function renderStatusFieldMapTab() {
      var $tab = $('<div class="production-widget__status-map"></div>').css({
        "overflow-x": "auto",
        "max-width": "100%"
      });
      var $table = $("<table></table>").css({ width: "100%", minWidth: "1100px", borderCollapse: "collapse" });

      var headers = [
        "Текущий статус amoCRM",
        "Статус бота",
        "Поле «Исполнитель»",
        "Поле «План готовности»",
        "Поле «Факт готовности»",
        "Поле «Цена»",
        "Следующий статус amoCRM",
        ""
      ];

      var $thead = $("<thead><tr></tr></thead>");

      headers.forEach(function (h) {
        $thead
          .find("tr")
          .append(
            '<th style="text-align:left;border:1px solid #ccc;padding:6px;color:#333;' +
              'background:#f7f7f7;">' +
              h +
              "</th>"
          );
      });

      $table.append($thead);

      var $tbody = $("<tbody></tbody>");

      function usedStatusIds(excludeRow) {
        return settingsState.statusFieldMap
          .filter(function (r) {
            return r !== excludeRow && r.amoStatusId;
          })
          .map(function (r) {
            return r.amoStatusId;
          });
      }

      function renderRow(row) {
        var $tr = $("<tr></tr>").css({ borderBottom: "1px solid #eee" });

        var $statusTd = $('<td style="padding:6px;"></td>');
        var $statusSelect = $("<select></select>").html(
          statusOptionsHtml(row.amoStatusId, usedStatusIds(row))
        );

        $statusSelect.on("change", function () {
          var value = $(this).val();

          row.amoStatusId = value ? Number(value) : null;
          row.amoPipelineId =
            row.amoStatusId && liveData.statusesById[row.amoStatusId]
              ? liveData.statusesById[row.amoStatusId].pipeline_id
              : null;
        });

        $statusTd.append($statusSelect);
        $tr.append($statusTd);

        var $botStatusTd = $('<td style="padding:6px;"></td>');
        var $botStatusSelect = $("<select></select>");

        BOT_STATUS_OPTIONS.forEach(function (opt) {
          var selected = opt.value === row.botStatus ? " selected" : "";

          $botStatusSelect.append(
            '<option value="' + opt.value + '"' + selected + ">" + opt.label + "</option>"
          );
        });

        $botStatusSelect.on("change", function () {
          row.botStatus = $(this).val();
        });

        $botStatusTd.append($botStatusSelect);
        $tr.append($botStatusTd);

        [
          { key: "executorFieldId", types: ["select", "multiselect"] },
          { key: "planDateFieldId", types: ["date", "date_time"] },
          { key: "factDateFieldId", types: ["date", "date_time"] },
          { key: "priceFieldId", types: ["numeric"] }
        ].forEach(function (fieldDef) {
          var $td = $('<td style="padding:6px;"></td>');

          var $picker = buildSearchableFieldPicker(row[fieldDef.key], fieldDef.types, function (fieldId) {
            row[fieldDef.key] = fieldId;
          });

          $td.append($picker);
          $tr.append($td);
        });

        var $nextStatusTd = $('<td style="padding:6px;"></td>');
        var $nextStatusSelect = $("<select></select>").html(statusOptionsHtml(row.nextAmoStatusId));

        $nextStatusSelect.on("change", function () {
          var value = $(this).val();
          row.nextAmoStatusId = value ? Number(value) : null;
        });

        $nextStatusTd.append($nextStatusSelect);
        $tr.append($nextStatusTd);

        var $deleteTd = $('<td style="padding:6px;"></td>');
        var $delete = $('<span style="cursor:pointer;color:#c0392b;" title="Удалить строку">🗑</span>').on(
          "click",
          function () {
            showConfirmDialog("Вы действительно хотите удалить?", function () {
              var idx = settingsState.statusFieldMap.indexOf(row);

              if (idx !== -1) {
                settingsState.statusFieldMap.splice(idx, 1);
              }

              rerenderTable();
            });
          }
        );

        $deleteTd.append($delete);
        $tr.append($deleteTd);

        return $tr;
      }

      function rerenderTable() {
        $tbody.empty();

        settingsState.statusFieldMap.forEach(function (row) {
          $tbody.append(renderRow(row));
        });
      }

      rerenderTable();

      $table.append($tbody);
      $tab.append($table);

      var $addBtn = $(
        '<div style="margin-top:12px;cursor:pointer;color:#2d7ff9;">Добавить группу</div>'
      ).on("click", function () {
        settingsState.statusFieldMap.push({
          amoStatusId: null,
          amoPipelineId: null,
          botStatus: "",
          executorFieldId: null,
          planDateFieldId: null,
          factDateFieldId: null,
          priceFieldId: null,
          nextAmoStatusId: null
        });

        rerenderTable();
      });

      $tab.append($addBtn);

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "СЦЕНАРИИ"
    // ------------------------------------------------------------

    function renderScenariosTab() {
      var $tab = $('<div class="production-widget__scenarios"></div>');

      settingsState.scenarios.metalRestock = settingsState.scenarios.metalRestock || { amoStatusId: null };
      settingsState.scenarios.woodRestock = settingsState.scenarios.woodRestock || { amoStatusId: null };

      [
        { key: "metalRestock", label: "Дозакупка Металл" },
        { key: "woodRestock", label: "Дозакупка Дерево" }
      ].forEach(function (scenario) {
        var $row = $('<div style="margin-bottom:16px;"></div>');

        $row.append(
          '<div style="font-weight:600;margin-bottom:4px;color:#333;">' + scenario.label + "</div>"
        );

        var entry = settingsState.scenarios[scenario.key];
        var $select = $("<select></select>").html(statusOptionsHtml(entry.amoStatusId));

        $select.on("change", function () {
          var value = $(this).val();
          entry.amoStatusId = value ? Number(value) : null;
        });

        $row.append($select);
        $tab.append($row);
      });

      return $tab;
    }

    // ------------------------------------------------------------
    // ВКЛАДКА "ПЛАНОВАЯ ГОТОВНОСТЬ"
    // ------------------------------------------------------------

    // Продукты (строки) и статусы (столбцы) добавляются вручную через
    // выпадающие списки — так же, как строки на "Связь этапов и полей" и
    // значения на "Сценарии", а не автоматически по всем живым значениям.
    function productOptionsHtml(productField, selectedId, excludeIds) {
      var html = '<option value="">— выбрать продукт —</option>';
      var enums = (productField && productField.enums) || [];

      enums.forEach(function (e) {
        if (excludeIds && excludeIds.indexOf(e.id) !== -1 && String(e.id) !== String(selectedId)) {
          return;
        }

        var selected = String(e.id) === String(selectedId) ? " selected" : "";

        html += '<option value="' + e.id + '"' + selected + ">" + escapeHtml(e.value) + "</option>";
      });

      return html;
    }

    function renderReadinessTab() {
      var $tab = $('<div class="production-widget__readiness"></div>');
      var matrix = settingsState.readinessMatrix;

      matrix.products = matrix.products || [];
      matrix.statusIds = matrix.statusIds || [];
      matrix.cells = matrix.cells || {};

      var $productFieldRow = $('<div style="margin-bottom:12px;"></div>');
      $productFieldRow.append(
        '<div style="font-weight:600;margin-bottom:4px;color:#333;">Поле «Продукт»</div>'
      );

      var $productFieldSelect = $("<select></select>").html(
        fieldOptionsHtml(matrix.productFieldId, ["select", "multiselect"])
      );

      $productFieldSelect.on("change", function () {
        var value = $(this).val();

        matrix.productFieldId = value ? Number(value) : null;
        matrix.products = [];
        renderReadinessMatrixTable();
      });

      $productFieldRow.append($productFieldSelect);
      $tab.append($productFieldRow);

      var $matrixContainer = $('<div class="production-widget__readiness-matrix"></div>').css({
        "overflow-x": "auto",
        "max-width": "100%"
      });
      $tab.append($matrixContainer);

      var $addProductBtn = $(
        '<div style="margin-top:12px;cursor:pointer;color:#2d7ff9;">Добавить продукт</div>'
      ).on("click", function () {
        matrix.products.push({ enumId: null, readinessValue: 0 });
        renderReadinessMatrixTable();
      });

      function currentProductField() {
        return liveData.fields.filter(function (f) {
          return f.id === matrix.productFieldId;
        })[0];
      }

      function renderReadinessMatrixTable() {
        $matrixContainer.empty();

        var productField = currentProductField();

        if (!productField) {
          $matrixContainer.append(
            '<div style="color:#999;">Выберите поле «Продукт», чтобы добавлять строки.</div>'
          );
          $addProductBtn.hide();
          return;
        }

        $addProductBtn.show();

        var usedProductIds = matrix.products
          .map(function (p) {
            return p.enumId;
          })
          .filter(Boolean);

        var usedStatusIds = matrix.statusIds.filter(Boolean);

        var $table = $("<table></table>").css({ width: "100%", minWidth: "900px", borderCollapse: "collapse" });
        var $headRow = $(
          '<tr><th style="padding:6px;"></th>' +
            '<th style="border-bottom:1px solid #ccc;padding:6px;text-align:left;">Готовность изделия</th></tr>'
        );

        matrix.statusIds.forEach(function (statusId, colIdx) {
          var $th = $('<th style="border-bottom:1px solid #ccc;padding:6px;text-align:left;"></th>');
          var $select = $("<select></select>").html(
            statusOptionsHtml(
              statusId,
              usedStatusIds.filter(function (id) {
                return id !== statusId;
              })
            )
          );

          $select.on("change", function () {
            var value = $(this).val();

            matrix.statusIds[colIdx] = value ? Number(value) : null;
            renderReadinessMatrixTable();
          });

          var $delete = $(
            '<span style="cursor:pointer;color:#c0392b;margin-left:4px;" title="Удалить столбец">🗑</span>'
          ).on("click", function () {
            showConfirmDialog("Вы действительно хотите удалить?", function () {
              matrix.statusIds.splice(colIdx, 1);
              renderReadinessMatrixTable();
            });
          });

          $th.append($select).append($delete);
          $headRow.append($th);
        });

        var $addStatusTh = $(
          '<th style="padding:6px;white-space:nowrap;"><span style="cursor:pointer;color:#2d7ff9;">' +
            "Добавить статус</span></th>"
        ).on("click", function () {
          matrix.statusIds.push(null);
          renderReadinessMatrixTable();
        });

        $headRow.append($addStatusTh);

        $table.append($("<thead></thead>").append($headRow));

        var $tbody = $("<tbody></tbody>");

        matrix.products.forEach(function (product, rowIdx) {
          var $tr = $("<tr></tr>");
          var $labelTd = $('<td style="padding:6px;"></td>');

          var $productSelect = $("<select></select>").html(
            productOptionsHtml(
              productField,
              product.enumId,
              usedProductIds.filter(function (id) {
                return id !== product.enumId;
              })
            )
          );

          $productSelect.on("change", function () {
            var value = $(this).val();

            matrix.products[rowIdx].enumId = value ? Number(value) : null;
            renderReadinessMatrixTable();
          });

          var $deleteRow = $(
            '<span style="cursor:pointer;color:#c0392b;margin-left:4px;" title="Удалить строку">🗑</span>'
          ).on("click", function () {
            showConfirmDialog("Вы действительно хотите удалить?", function () {
              matrix.products.splice(rowIdx, 1);
              renderReadinessMatrixTable();
            });
          });

          $labelTd.append($productSelect).append($deleteRow);
          $tr.append($labelTd);

          var $readinessTd = $('<td style="padding:6px;"></td>');
          var $readinessInput = $('<input type="number" min="0" step="0.01" />').val(
            product.readinessValue || 0
          );

          $readinessInput.on("change", function () {
            var num = parseFloat($(this).val());

            matrix.products[rowIdx].readinessValue = isNaN(num) || num < 0 ? 0 : Math.round(num * 100) / 100;
            $(this).val(matrix.products[rowIdx].readinessValue);
          });

          $readinessTd.append($readinessInput);
          $tr.append($readinessTd);

          matrix.statusIds.forEach(function (statusId) {
            var cellKey = product.enumId + ":" + statusId;
            var value = Object.prototype.hasOwnProperty.call(matrix.cells, cellKey)
              ? matrix.cells[cellKey]
              : 0;

            var $td = $('<td style="padding:6px;"></td>');
            var $input = $('<input type="number" min="0" step="0.01" />')
              .val(value)
              .prop("disabled", !product.enumId || !statusId);

            $input.on("change", function () {
              var num = parseFloat($(this).val());

              matrix.cells[cellKey] = isNaN(num) || num < 0 ? 0 : Math.round(num * 100) / 100;
              $(this).val(matrix.cells[cellKey]);
            });

            $td.append($input);
            $tr.append($td);
          });

          $tbody.append($tr);
        });

        $table.append($tbody);
        $matrixContainer.append($table);
      }

      renderReadinessMatrixTable();

      $tab.append($addProductBtn);

      return $tab;
    }

    // ------------------------------------------------------------
    // ОБЩИЙ КАРКАС: ЛЕВЫЙ СПИСОК БОТОВ + ВЕРХНИЕ ВКЛАДКИ ТЗ
    // ------------------------------------------------------------

    var TABS = [
      { key: "roles", label: "Роли", render: renderRolesTab },
      { key: "statusMap", label: "Связь этапов и полей", render: renderStatusFieldMapTab },
      { key: "scenarios", label: "Сценарии", render: renderScenariosTab },
      { key: "readiness", label: "Плановая готовность", render: renderReadinessTab }
    ];

    // Простая вертикальная раскладка (список ботов строкой сверху, затем
    // вкладки, затем содержимое) — намеренно без "раскладки в два столбца"
    // (сайдбар + контент рядом), т.к. реальная ширина области настроек в
    // amoCRM оказалась непредсказуемой и узкой, и любая раскладка на
    // несколько колонок на ней ломалась.
    function renderShell() {
      $root.empty();

      // "sticky" — чтобы переключатель ботов и вкладки оставались на
      // месте и были кликабельны независимо от того, насколько длинным/
      // широким окажется содержимое конкретной вкладки (защита от бага,
      // когда вкладки визуально "пропадали" при переходе на разделы с
      // большими таблицами).
      var $header = $(
        '<div style="position:sticky;top:0;background:#fff;z-index:10;padding-top:4px;"></div>'
      );

      var $botsRow = $(
        '<div style="display:flex;gap:20px;margin-bottom:16px;font-size:14px;"></div>'
      );

      $botsRow.append(
        '<span style="font-weight:600;color:#2d7ff9;border-bottom:2px solid #2d7ff9;padding-bottom:4px;">Производство</span>'
      );

      $botsRow.append(
        '<span style="color:#bbb;cursor:not-allowed;" title="Появится позже">Монтажники</span>'
      );

      $header.append($botsRow);

      var $tabsBar = $(
        '<div style="display:flex;flex-wrap:wrap;row-gap:8px;column-gap:20px;' +
          'border-bottom:2px solid #ddd;margin-bottom:20px;padding-bottom:4px;font-size:15px;"></div>'
      );
      var $tabBody = $('<div class="production-widget__tab-body"></div>').css({ "padding-top": "12px" });

      TABS.forEach(function (tab) {
        var $tabBtn = $(
          '<div style="padding:8px 4px;cursor:pointer;white-space:nowrap;' +
            (tab.key === activeTab ? "border-bottom:2px solid #2d7ff9;font-weight:600;" : "color:#666;") +
            '">' +
            tab.label +
            "</div>"
        ).on("click", function () {
          activeTab = tab.key;
          renderShell();
        });

        $tabsBar.append($tabBtn);
      });

      $header.append($tabsBar);

      $root.append($header).append($tabBody);

      var currentTab = TABS.filter(function (t) {
        return t.key === activeTab;
      })[0];

      $tabBody.append(currentTab.render());

      var $footer = $('<div style="margin-top:20px;display:flex;align-items:center;gap:12px;"></div>');
      var $saveBtn = $('<button type="button" style="padding:8px 16px;">Сохранить</button>').on(
        "click",
        saveSettings
      );

      $footer.append($saveBtn);
      $footer.append('<span class="production-widget__save-message"></span>');

      $root.append($footer);
    }

    // ------------------------------------------------------------
    // ЖИЗНЕННЫЙ ЦИКЛ ВИДЖЕТА (требуется amoCRM)
    // ------------------------------------------------------------

    this.callbacks = {
      render: function () {
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        return true;
      },

      // Вызывается при переходе на страницу "Расширенные настройки"
      // (см. manifest.json: locations содержит "advanced_settings").
      // amoCRM, скорее всего, передаёт готовый контейнер первым аргументом
      // (как и в callbacks.settings($modal_body) в других виджетах) —
      // принимаем его, а если аргумента нет, ищем контейнер по нескольким
      // вероятным селекторам как запасной вариант.
      advancedSettings: function (containerArg) {
        try {
          var $target = null;

          if (containerArg && containerArg.jquery) {
            $target = containerArg;
          } else if (containerArg && containerArg.nodeType) {
            $target = $(containerArg);
          }

          if (!$target || !$target.length) {
            $target = $(
              "#advanced_settings, .advanced-settings-holder, " +
                ".widget_settings_block__wrapper, .modal-body"
            ).first();
          }

          // Запасной вариант №2: amoCRM точно выводит заголовок страницы
          // (manifest.json → advanced.title), поэтому ищем элемент с ЭТИМ
          // ТОЧНЫМ текстом и используем его родителя как контейнер — это
          // работает независимо от того, как называется CSS-класс/ID у
          // amoCRM в конкретной версии интерфейса.
          if (!$target || !$target.length) {
            var titleCandidates = $("*").filter(function () {
              return (
                this.children.length === 0 &&
                $.trim($(this).text()) === $.trim(
                  (window.I18n && window.I18n.t && window.I18n.t("advanced.title")) ||
                    "Боты для отчетов ЗЛМК"
                )
              );
            });

            if (titleCandidates.length) {
              $target = titleCandidates.last().parent();
            }
          }

          if (!$target || !$target.length) {
            console.error(
              "[Виджет Производство] Не удалось найти контейнер расширенных настроек " +
                "(проверьте в devtools, какой элемент реально используется на этой странице)."
            );

            return true;
          }

          // color/font-size заданы явно на корневом элементе — страница
          // amoCRM может иначе "подсунуть" свой унаследованный цвет текста
          // (например, невидимо-светлый) вложенным элементам без
          // собственного явного color, из-за чего заголовки/подписи
          // пропадали визуально, хотя реально присутствовали в DOM.
          $root = $('<div class="production-widget"></div>').css({
            "margin-top": "120px",
            "padding-top": "8px",
            color: "#333",
            "font-size": "13px"
          });

          $root.append('<div style="padding:16px;color:#999;">Загрузка…</div>');

          // Общая разметка таблиц виджета (сетка ячеек) — общий <style>,
          // вынесенный ЗА пределы $root, т.к. renderShell() делает
          // $root.empty() при каждом переключении вкладки/сохранении, а
          // этот стиль должен переживать такие перерисовки.
          var $style = $(
            "<style>" +
              ".production-widget table { border-collapse: collapse; }" +
              ".production-widget table th, .production-widget table td {" +
              " border: 1px solid #ccc; color: #333; }" +
              "</style>"
          );

          $target.empty().append($style).append($root);

          $.when(loadAllLiveData(), loadSettings()).then(
            function (liveResult, loadedSettings) {
              settingsState = loadedSettings || emptySettings();
              settingsState.roles = settingsState.roles || {};
              settingsState.statusFieldMap = settingsState.statusFieldMap || [];
              settingsState.readinessMatrix =
                settingsState.readinessMatrix || { productFieldId: null, products: [], statusIds: [], cells: {} };
              settingsState.readinessMatrix.products = settingsState.readinessMatrix.products || [];
              settingsState.readinessMatrix.statusIds = settingsState.readinessMatrix.statusIds || [];
              settingsState.readinessMatrix.cells = settingsState.readinessMatrix.cells || {};
              settingsState.scenarios = settingsState.scenarios || {};

              renderShell();
            },
            function (error) {
              $root.empty();
              $root.append(
                '<div style="color:#c0392b;padding:16px;">Не удалось загрузить данные amoCRM: ' +
                  escapeHtml(error && error.statusText ? error.statusText : "неизвестная ошибка") +
                  "</div>"
              );

              console.error("[Виджет Производство] advancedSettings load error:", error);
            }
          );
        } catch (e) {
          console.error("[Виджет Производство] Ошибка в advancedSettings:", e);
        }

        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        return true;
      }
    };

    return this;
  };
});
