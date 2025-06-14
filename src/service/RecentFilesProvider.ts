/** @file: src/service/RecentFilesProvider.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 2.0.0 */
/**
 * @changelog
 *
 * # 2.0.0 - Новая сигнатура get_items()
 *           - Рефакторинг
 *           - Убраны get_items_* методы
 *
 * # 1.3.2 - Рефакторинг
 *
 * # 1.3.1 - Стабильная версия
 *           - Рефакторинг
 *           - Производительность
 *
 * # 1.3.0 - Добавлен get_items_tuple()
 *
 * # 1.2.0 - get_items() теперь асинхронный
 *
 * # 1.1.1 - Стабильная версия
 *           - Рефакторинг
 *
 * # 1.1.0 - Сигнал `'history-changed'` переименован
 *           в `'history-changes-settled'`
 *
 * # 1.0.2 - Рефакторинг
 *           - Теперь все свойства будут генерировать DecommissionedError
 *             после decommission().
 *           - ensure_monitoring_inactive теперь отменяет возможный
 *             запланированный сигнал (cancel), а не принудительно
 *             отправляет его (flush).
 *
 * # 1.0.1 - Документация
 *
 * # 1.0.0 - Стабильная версия
 *
 * # 0.99.1 - Исправлены и дополнены типы ошибок
 *  */

import GObject from 'gi://GObject?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    HandlerID,
    PromiseControllers
} from '../shared/common-types.js';
import type {
    RecentItem
} from '../shared/common-types.js';
import {
    NO_HANDLER
} from '../shared/common-types.js';
import {
    Decommissionable,
    DecommissionedError,
    decommission_signals
} from '../shared/Decommissionable.interface.js';
import {
    DelayedSignal
} from '../shared/DelayedSignal.js';
import {
    GObjectDecorator
} from '../shared/gobject-decorators.js';


/** Состояния мониторинга истории файлов. */
export enum MonitoringState {
    /** Мониторинг не запрошен и не активен.
     * Начальное состояние или состояние после вызова `withdraw_monitoring()`. */
    INACTIVE,
    /** Мониторинг запрошен, но не может быть активирован.
     * Возникает когда `monitoring_requested=true`, но `recent_files_enabled=false`.
     * При включении истории автоматически переходит в ACTIVE. */
    PENDING,
    /** Мониторинг запрошен и активен.
     * Объект отслеживает изменения и генерирует сигналы `history-changes-settled`. */
    ACTIVE
}

// Специфичные типы ошибок
/** Ошибка, возникающая при попытке операции с отключенной историей файлов */
export class HistoryDisabledError extends Error {
    constructor(message = 'Recent files history is disabled', options?: ErrorOptions) {
        super(message, options);
        this.name = 'HistoryDisabledError';
    }
}

/** Ошибка, которая передается при очистке очереди обработки */
export class QueueCleanupError extends Error {
    constructor(message = 'Queue cleanup error', options?: ErrorOptions) {
        super(message, options);
        this.name = 'QueueCleanupError';
    }
}

/** Ошибка при работе с недопустимым URI */
export class InvalidUriError extends Error {
    constructor(message = 'Invalid or non-existent URI', options?: ErrorOptions) {
        super(message, options);
        this.name = 'InvalidUriError';
    }
}

/** Ошибка при попытке добавить в очередь уже существующий URI */
export class DuplicateUriError extends Error {
    constructor(message = 'URI already exists in queue', options?: ErrorOptions) {
        super(message, options);
        this.name = 'DuplicateUriError';
    }
}

/** RecentFilesProvider - взаимодействие с системным менеджером недавних файлов в GNOME.
 *
 * ### Описание
 *
 * Класс предоставляет централизованный интерфейс для работы с недавно использованными файлами:
 * - Мониторинг изменений в истории файлов (через публичный сигнал `'history-changes-settled'`)
 * - Получение пути к файлу истории (через свойство `history_file_path`)
 * - Удаление элементов из истории (через метод `remove_item`)
 * - И другие возможности
 *
 * ### API
 *
 * #### Параметры конструктора:
 * - `debounce_timeout?: number` Таймаут дебаунса. Это значение будет принято только если оно больше DEBOUNCE_TIMEOUT
 * - `recent_manager?: Gtk.RecentManager` Инстанс системного менеджера истории (в основном для тестирования)
 * - `settings_manager?: Gtk.Settings` Инстанс системного менеджера настроек (в основном для тестирования)
 *
 * #### Сигналы:
 * - `'history-changes-settled'` Сигнал. Сообщает об факте изменениях в истории
 * - `'notify::state'` Уведомление о изменении состояния
 * - `'notify::recent-files-enabled'` Уведомление о изменении доступности истории
 * - `'notify::history-items-count'` Уведомление о возможном изменении размера истории
 *
 * #### Константы:
 * - `DEBOUNCE_TIMEOUT` Минимальное значения для таймаута дебаунса сигнала `'history-changes-settled'`
 *
 * #### Свойства:
 * - `recent_files_enabled: boolean` Включена ли история в системе. Только чтение.
 * - `history_file_path: string` Путь к файлу-истории. Только чтение.
 * - `history_items_count: number` Количество записей в истории. Только чтение.
 * - `state: MonitoringState` Состояние мониторинга. Только чтение.
 *
 * #### Методы:
 * - `request_monitoring(): void` Запрос на запуск слежения за историей.
 * - `withdraw_monitoring(): void` Останавливает мониторинг или отменяет запрос на запуск мониторинга.
 * - `remove_item(uri: string): Promise<void>` Удаляет указанный файл из системной истории недавних файлов.
 * - `get_items(start_index = 0, items_count = 0): Promise<RecentItem[]>` Получает список недавно использованных файлов из системной истории.
 * - `decommission(): void` Выводит объект из эксплуатации.
 *
 * #### Ошибки:
 * - `HistoryDisabledError` Ошибка, возникающая при попытке операции с отключенной историей файлов
 * - `QueueCleanupError` Ошибка, которая передается при очистке очереди обработки
 * - `InvalidUriError` Ошибка при работе с недопустимым URI
 * - `DuplicateUriError` Ошибка при попытке добавить в очередь уже существующий URI
 * - `DecommissionedError`
 *
 * ### Архитектура
 *
 * Класс использует реактивную архитектуру состояний с разделением намерений и возможностей:
 *
 * 1. Мониторинг истории управляется двумя факторами:
 *    - `monitoring_requested`: намерение пользователя (управляется через API `request_monitoring`/`withdraw_monitoring`)
 *    - `recent_files_enabled`: системная настройка доступности истории
 *
 * 2. Удаление элементов:
 *    - Не зависит от состояния мониторинга
 *    - Зависит от системной настройки `recent_files_enabled`
 *    - Обрабатывается через асинхронную очередь
 *
 * ### Особенности реализации
 *
 * - **Отложенные сигналы**: Класс использует механизм отложенных сигналов для предотвращения
 *   спама уведомлениями при массовых изменениях в истории файлов
 *
 * - **Асинхронная очередь удаления**: Обеспечивает надежное и последовательное удаление
 *   элементов из истории даже при многочисленных запросах
 *
 * - **Защита от неправильного использования**: Деструктивный метод `decommission`
 *   намеренно делает объект непригодным для дальнейшего использования
 *
 * ### Состояния
 *
 * Класс использует систему управления состояниями, которая
 * разделяет запрошенное и фактическое состояние мониторинга:
 *
 * - `monitoring_requested` (приватный флаг):
 *   Отражает намерение пользователя включить мониторинг
 *   Управляется методами `request_monitoring()` и `withdraw_monitoring()`
 *
 * - `recent_files_enabled` (публичное свойство):
 *   Отражает системную настройку "разрешены ли недавние файлы"
 *   Получается из `Gtk.Settings.get_default().gtk_recent_files_enabled`
 *
 * ~~~
 *
 *               ┌────────────────────────────┐
 *               │ INACTIVE                   │ - мониторинг не запрошен и не активен
 *               │ monitoring_requested=false │
 *               │ recent_files_enabled=*     │
 *               └──────┬────────────────┬────┘
 *                      ▲                │
 *                      │                │request_monitoring()
 *      withdraw_monitoring()            ▼
 *                      │      ┌─────────┴──────────────────┐
 *                      │      │ PENDING                    │ - мониторинг запрошен, но не может
 *                      │      │ monitoring_requested=true  │   быть активирован (история отключена)
 *                      │      │ recent_files_enabled=false ├◄──┐
 *                      │      └─────────┬──────────────────┘   │
 *                      │                │settings_changed      │settings_changed
 *                      │                │(enable)              │(disable)
 *                      │                ▼                      │
 *               ┌──────┴────────────────┴─────┐                │
 *               │ ACTIVE                      ├────────────────┘
 *               │ monitoring_requested = true │
 *               │ recent_files_enabled=true   │ - мониторинг запрошен и активен
 *               └─────────────────────────────┘
 *
 * ~~~
 *
 * ### Логика обработки состояний
 *
 * ~~~
 *
 *           monitoring_requested          recent_files_enabled
 *           ──────────┬─────────          ──────────┬─────────
 *                 изменение                      изменение
 *                     │                             │
 *                     └─────► notify('state') ◄─────┘
 *                                   │
 *                                   ▼
 *                           state_changed_cb()
 *                        Централизованное изменение
 *                                состояния
 *                     ───────────┬──────┬───────────
 *                                │      │
 *                        Переход в новое состояние
 *                    ┌───────────┘      └────────────┐
 *                    ▼                               ▼
 *        ensure_monitoring_active()     ensure_monitoring_inactive()
 *
 *
 * ~~~
 *
 * #### Переключение состояний:
 *
 * `request_monitoring()` и `withdraw_monitoring()`:
 *
 * Вызывается пользователем, как намерение запустить или остановить мониторинг.
 * Устанавливает `monitoring_requested` в соответствующее значение.
 *
 * Фактическое состояние мониторинга будет зависеть от `recent_files_enabled` и `monitoring_requested`.
 *
 * #### Требования к архитектуре состояний:
 *
 * - Разделение намерения и возможности:
 * Позволяет сохранять "намерение" пользователя, даже если его нельзя выполнить в данный момент
 *
 * - Реакция на внешние изменения:
 *   Корректно реагирует на изменения системных настроек (возможность)
 *   Корректно реагирует на запрос пользователя (намерение)
 *
 * - Поддержание согласованности:
 * Гарантирует, что мониторинг активен только если он запрошен и история включена
 *
 * #### Реактивный подход:
 *
 * ~~~
 *        Событие вызывает изменение состояния
 *                        │
 *                        ▼
 *     Изменение состояния генерирует уведомление
 *                        │
 *                        ▼
 * Обработчик уведомления реагирует на новое состояние
 *
 * ~~~
 *
 * NOTICE: Следует разделять _намерение_ "следить" и _намерение_ "удалять"!
 *         Это два разных намерения и они не пересекаются - "следить" и
 *         "удалять" можно в любом порядке не зависимо от друг друга.
 *         Но, _возможность_ "следить" и _возможность_ "удалять" зависит от общего
 *         фактора - системная настройка `gtk_recent_files_enabled`.
 *
 * @example
 * ```typescript
 * const provider = new RecentFilesProvider();
 *
 * // Запуск мониторинга изменений истории
 * provider.request_monitoring();
 * provider.connect('history-changes-settled', () => {
 *     console.log('История файлов изменилась');
 * });
 *
 * // Удаление элемента из истории
 * provider.remove_item('file:///path/to/file.txt')
 *     .then(() => console.log('Элемент удален'))
 *     .catch((error) => console.error('Ошибка удаления:', error));
 *
 * // Освобождение ресурсов при завершении
 * provider.decommission();
 * ```
 *
 * ВАЖНО: После вызова `decommission()` объект нельзя использовать!
 *
 * @example Работа с состояниями мониторинга
 * ```typescript
 * const provider = new RecentFilesProvider();
 *
 * // Отслеживание изменений состояния
 * provider.connect('notify::state', () => {
 *     switch (provider.state) {
 *         case MonitoringState.INACTIVE:
 *             console.log('Мониторинг выключен');
 *             break;
 *         case MonitoringState.PENDING:
 *             console.log('Мониторинг запрошен, но история отключена в системе');
 *             break;
 *         case MonitoringState.ACTIVE:
 *             console.log('Мониторинг активен');
 *             break;
 *     }
 * });
 *
 * // Запрос мониторинга
 * provider.request_monitoring(); // state может стать PENDING или ACTIVE
 * ```
 * @example Комплексный сценарий использования
 * ```typescript
 * const provider = new RecentFilesProvider();
 *
 * // Проверка доступности истории
 * if (!provider.recent_files_enabled) {
 *     console.warn('История файлов отключена в системе');
 *     return;
 * }
 *
 * // Подписка на изменение состояния
 * provider.connect('notify::recent-files-enabled', () => {
 *     if (provider.recent_files_enabled) {
 *         console.log('История файлов теперь доступна');
 *         provider.request_monitoring();
 *     } else {
 *         console.log('История файлов отключена');
 *     }
 * });
 *
 * // Работа с состояниями
 * provider.connect('notify::state', () => {
 *     console.log(`Новое состояние: ${MonitoringState[provider.state]}`);
 * });
 *
 * // Пакетное удаление файлов
 * const files_to_remove = [
 *     'file:///tmp/temp1.txt',
 *     'file:///tmp/temp2.txt',
 *     'file:///tmp/temp3.txt'
 * ];
 *
 * const removal_promises = files_to_remove.map(uri =>
 *     provider.remove_item(uri).catch(error => {
 *         console.error(`Не удалось удалить ${uri}:`, error.message);
 *         return null;
 *     })
 * );
 *
 * await Promise.all(removal_promises);
 * console.log('Пакетное удаление завершено');
 *
 * // Завершение работы
 * provider.decommission();
 * ```
 *
 * @example Обработка ошибок
 * ```typescript
 * try {
 *     await provider.remove_item('invalid://uri');
 * } catch (error) {
 *     if (error instanceof HistoryDisabledError) {
 *         console.log('Включите историю файлов в настройках системы');
 *     } else if (error instanceof InvalidUriError) {
 *         console.log('Файл не найден в истории');
 *     } else if (error instanceof DuplicateUriError) {
 *         console.log('Файл уже обрабатывается');
 *     } else {
 *         console.error('Неожиданная ошибка:', error);
 *     }
 * }
 * ```
 *
 * ### Контекст выполнения
 *
 * Класс работает в контексте основного цикла событий GLib (Main Loop).
 * Все асинхронные операции (Promise, setTimeout) выполняются в рамках
 * этого же цикла событий.
 *
 * ### Асинхронность
 *
 * - Методы, возвращающие Promise, не блокируют основной поток
 * - Обработка очереди удаления происходит в idle-обработчиках
 * - Сигналы могут приходить в любой момент цикла событий
 *
 * ### Производительность
 *
 * - Дебаунс сигналов: минимум `DEBOUNCE_TIMEOUT` мс между событиями `history-changes-settled`
 * - Очередь удаления: обрабатывается последовательно через setInterval(0)
 * - Получение элементов: O(n) где n - количество запрошенных элементов
 * - Массовые операции могут временно блокировать UI
 *
 * ### Ограничения
 *
 * - Размер истории ограничен системными настройками (1000 элементов)
 * - Нет прямого контроля над сортировкой (определяется поведением `Gtk.RecentManager`)
 * - Нет фильтрации на уровне провайдера (нужно фильтровать результат)
 *  */
@GObjectDecorator.Class({
    GTypeName: 'RecentFilesProvider',
    GTypeFlags: GObject.TypeFlags.FINAL,
    Signals: {
        /** Сообщает об изменениях в истории */
        'history-changes-settled': {}
    },
})
export class RecentFilesProvider extends GObject.Object implements Decommissionable {

    /** Минимальное значения для таймаута дебаунса сигнала `'history-changes-settled'` */
    static DEBOUNCE_TIMEOUT = 330 as const;

    /** Отложенный сигнал */
    private delayed_signal: {
        /** Объект-эмиттер отложенного сигнала */
        emitter: InstanceType<typeof DelayedSignal>;
        /** ID обработчика отложенного сигнала */
        handler_id: HandlerID,
    };

    /** Контекст процесса удаления */
    private remove_process_context = {
        /** Источник процесса обработки очереди удаления */
        source: undefined as GLib.Source | undefined,
        /** Очередь промисов для удаления */
        remove_queue: new Map<string, PromiseControllers<void>>(),
        promise_controllers: undefined as PromiseControllers<void> | undefined,
    };

    /** ID обработчиков */
    private handlers_ids = {
        /** ID обработчика сигнала 'settings-changed' от Gtk.Settings */
        settings_manager: NO_HANDLER as HandlerID,
        /** ID обработчика сигнала 'changed' от Gtk.RecentManager */
        recent_manager: NO_HANDLER as HandlerID,
    };

    /** Контекст состояния */
    // Инициализация контекста состояния
    private state_context = {
        handler_id: NO_HANDLER as HandlerID,
        monitoring_requested: false,
        previous_state: undefined as unknown as MonitoringState, // синхронизируемся с текущим состоянием
    };

    /** Системный менеджер истории файлов */
    private default_recent_manager: Gtk.RecentManager;

    /** Системный менеджер настроек */
    private default_settings_manager: Gtk.Settings | null;

    /** Constructor */
    constructor(constructor_options: {
        /** Таймаут дебаунса. Это значение будет принято только если оно больше DEBOUNCE_TIMEOUT */
        debounce_timeout?: number,
        /** Инстанс системного менеджера истории (в основном для тестирования) */
        recent_manager?: Gtk.RecentManager,
        /** Инстанс системного менеджера настроек (в основном для тестирования) */
        settings_manager?: Gtk.Settings,
    } = {}) {

        super();

        // Инициализация системных менеджеров
        this.default_recent_manager = constructor_options.recent_manager ?? Gtk.RecentManager.get_default();
        this.default_settings_manager = constructor_options.settings_manager ?? Gtk.Settings.get_default();

        if (!this.default_settings_manager) {
            throw new Error('GTK Settings unavailable: display server environment may be missing');
        }

        this.state_context.previous_state = this.state;

        // Инициализация отложенного сигнала
        this.delayed_signal = {
            emitter: new DelayedSignal(
                Math.max(RecentFilesProvider.DEBOUNCE_TIMEOUT, (constructor_options.debounce_timeout ?? 0))
            ),
            handler_id: NO_HANDLER,
        };

        // дебаунс для сигнала 'history-changes-settled'
        this.delayed_signal.handler_id = this.delayed_signal.emitter.connect(
            'occurred',
            this.history_changed_cb.bind(this)
        );

        // слежение за изменением доступности истории
        this.handlers_ids.settings_manager = this.default_settings_manager.connect(
            'notify::gtk-recent-files-enabled',
            this.settings_changed_cb.bind(this)
        );

        // слежение за изменением состояния
        this.state_context.handler_id = this.connect_after(
            'notify::state',
            this.state_changed_cb.bind(this)
        );

    }

    // #region ПУБЛИЧНЫЙ API

    // #region СВОЙСТВА

    /** Включена ли история в системе.
     *
     * Свойство отражает системную настройку `gtk-recent-files-enabled`.
     * При изменении этой настройки автоматически генерируется уведомление
     * и может измениться состояние мониторинга.
     * */
    @GObjectDecorator.BooleanProperty({
        flags: GObject.ParamFlags.READABLE, default_value: false
    })
    public get recent_files_enabled(): boolean {
        if (this.state_context === undefined) {
            throw new DecommissionedError();
        }

        return this.default_settings_manager!.gtk_recent_files_enabled;
    }

    /** Путь к файлу-истории */
    @GObjectDecorator.StringProperty({
        flags: GObject.ParamFlags.READABLE
    })
    public get history_file_path(): string {
        if (this.state_context === undefined) {
            throw new DecommissionedError();
        }

        return this.default_recent_manager.filename;
    }

    /** Количество записей в истории */
    @GObjectDecorator.UIntProperty({
        flags: GObject.ParamFlags.READABLE,
        minimum: 0,
        maximum: GLib.MAXUINT32,
        default_value: 0
    })
    public get history_items_count(): number {
        if (this.state_context === undefined) {
            throw new DecommissionedError();
        }
        return this.default_recent_manager.size;
    }

    /** Состояние мониторинга.
     *
     * Вычислимое свойство state */
    @GObjectDecorator.UIntProperty({
        flags: GObject.ParamFlags.READABLE,
        minimum: MonitoringState.INACTIVE,
        maximum: MonitoringState.ACTIVE,
        default_value: MonitoringState.INACTIVE
    })
    public get state(): MonitoringState {
        if (this.state_context === undefined) {
            throw new DecommissionedError();
        }

        if (this.state_context) {
            if (!this.state_context.monitoring_requested) {
                return MonitoringState.INACTIVE;
            } else if (this.recent_files_enabled) {
                return MonitoringState.ACTIVE;
            } else {
                return MonitoringState.PENDING;
            }
        }
        return MonitoringState.INACTIVE;

    }

    // #endregion

    // методы

    /** Запрос на запуск слежения за историей.
     *
     * Мониторинг не обязан запустится сразу же. Если история не включена в системе,
     * то это сохраняет намерение, и если история станет доступна, то мониторинг будет запущен.
     * */
    public request_monitoring(): void {
        this.set_monitoring_requested(true);
    };

    /** Останавливает мониторинг или отменяет запрос на запуск мониторинга. */
    public withdraw_monitoring(): void {
        this.set_monitoring_requested(false);
    };

    /** Удаляет указанный файл из системной истории недавних файлов.
     *
     * Метод использует асинхронную очередь обработки для надежного удаления.
     * Даже если сразу поставлено в очередь несколько файлов, их удаление
     * будет выполнено последовательно в цикле событий GLib.
     *
     * NOTICE: Сигнал `history-changes-settled` во время выполнения очереди:
     *         Множественные выбросы сигнала 'changed' от Gtk.RecentManager будут объединены в один,
     *         и будет выброшено только одно событие 'history-changes-settled' в конце
     *         обработки очереди (с задержкой). Что позволяет избежать и спама и
     *         возможной потери информации о изменении истории произошедшей
     *         во время выполнения очереди.
     *
     * NOTICE: Сигнал `history-changes-settled` после выполнения очереди:
     *         После завершения очереди, если в историю были внесены изменения,
     *         обязательно будет выброшен сигнал 'history-changes-settled'.
     *         Этот момент следует учитывать при проектировании взаимодействий
     *         с этим классом.
     *
     * @param uri URI файла для удаления (должен существовать в истории)
     *
     * @returns Промис, разрешающийся при успешном удалении
     *
     * @throws {HistoryDisabledError} Если история недавних файлов отключена в системе
     * @throws {InvalidUriError} Если uri "пустой" или не существует в истории
     * @throws {DuplicateUriError} Если uri уже добавлен в очередь обработки
     * @throws {Gtk.RecentManagerError} Ошибки Gtk.RecentManager
     * @throws {*Error} Другие ошибки
     *
     * @fires this#'history-changes-settled'
     *
     * @example
     * try {
     *   await provider.remove_item('file:///home/user/document.txt');
     *   console.log('Файл успешно удален из истории');
     * } catch (error) {
     *   console.error('Ошибка при удалении:', error.message);
     * }  */
    public remove_item(uri: string): Promise<void> {
        return new Promise((resolve, reject) => {

            if (!this.recent_files_enabled) {
                return reject(new HistoryDisabledError('Recent history is now disabled, history file is empty'));
            }

            // Проверяем существование элемента
            if (!uri || !this.default_recent_manager.has_item(uri)) {
                return reject(new InvalidUriError('Gets non-existent or empty item'));
            }

            // ставим в очередь если это не повтор
            if (!this.remove_process_context.remove_queue.has(uri)) {
                this.remove_process_context.remove_queue.set(uri, { resolve, reject },);
            } else {
                return reject(new DuplicateUriError('Item already in queue'));
            }

            if (!this.remove_process_context.source) {
                // если не в процессе удаления

                // планируем удаление в следующем цикле
                // Используется setInterval вместо GLib.timeout_add для совместимости
                // с современными стандартами GJS и более предсказуемого поведения
                // в контексте Promise-based архитектуры
                this.remove_process_context.source = setInterval(() => {

                    // ...в начале цикла берем первый
                    const [uri, promise_controllers] = this.remove_process_context.remove_queue.entries().next().value!;
                    this.remove_process_context.remove_queue.delete(uri); // ... и сразу удаляем его из очереди
                    this.remove_process_context.promise_controllers = promise_controllers;

                    try {

                        // удаление из истории
                        this.default_recent_manager.remove_item(uri);

                        // разрешаем промис
                        this.remove_process_context.promise_controllers.resolve!(); // @todo

                    } catch (error) {
                        // отклоняем промис
                        this.remove_process_context.promise_controllers.reject!(error as Error); // @todo
                    }

                    // удаляем контроллеры
                    this.remove_process_context.promise_controllers = undefined;

                    // проверяем очередь
                    if (this.remove_process_context.remove_queue.size > 0) {
                        // если очередь не пуста начинаем новый цикл...
                        return;
                    }

                    // прекращаем цикл
                    if (this.remove_process_context.source) {
                        clearInterval(this.remove_process_context.source);
                        this.remove_process_context.source = undefined;
                    }
                    return;

                }, 0);
            }

        });
    };

    /** Получает список недавно использованных файлов из системной истории.
     *
     * Метод асинхронно возвращает массив объектов типа `RecentItem`, содержащих
     * информацию о каждом файле в истории недавних файлов GNOME.
     *
     * @param converter Функция преобразования элемента истории.
     *                  Принимает элемент истории и возвращает его преобразованное представление.
     *
     * @param start_index Начальный индекс (0-based)
     *                    Должен быть в диапазоне [0, history_items_count).
     * @param items_count Количество элементов для получения
     *                    (Infinity означает "все элементы после `start_index`")
     *
     * @returns Промис, разрешающийся массивом элементов истории
     *
     * @throws {HistoryDisabledError} Если история недавних файлов отключена в системе
     * @throws {TypeError} Если `start_index` не валиден или выходит за пределы допустимого диапазона
     * @throws {*Error} Другие ошибки
     *
     * @note Порядок элементов определяется реализацией Gtk.RecentManager.
     *       Обычно это порядок по времени последнего доступа, но это
     *       следует проверить для конкретной версии GTK.
     *       Правильным будет вообще не полагаться на этот порядок.
     *
     * @example Получение всех элементов
     * ```typescript
     * const all_items = await provider.get_items((item) => ({
     *                               uri: item.get_uri(),
     *                               uri_display: item.get_uri_display()
     *                           }));
     * console.log(`Всего ${all_items.length} файлов в истории`);
     * ```
     *
     * @example Пагинация
     * ```typescript
     * const page_size = 10;
     * const page = 2;
     * const items = await provider.get_items((item) => ([
     *                   item.get_uri(),
     *                   item.get_uri_display() ?? ''
     *               ]), page * page_size, page_size);
     * ```
     *
     * @example Получение 5 файлов
     * ```typescript
     * const recent_5 = await provider.get_items((item) => ({
     *                               uri: item.get_uri(),
     *                               uri_display: item.get_uri_display()
     *                           }), 0, 5);
     * recent_5.forEach((item, index) => {
     *     console.log(`${index + 1}. ${item.uri_display || item.uri}`);
     * });
     * ```
     *  */
    public get_items<T>(converter: (item: Gtk.RecentInfo) => T, start_index = 0, items_count = Infinity): Promise<T[]> {
        return new Promise((resolve, reject) => {
            // Проверка включенной истории
            if (!this.recent_files_enabled) {
                reject(new HistoryDisabledError('Recent history is now disabled, history file is empty'));
                return;
            }

            // Проверка корректности индекса
            if (start_index < 0 || start_index >= this.default_recent_manager.size) {
                reject(new TypeError(`Start index out of range: ${start_index} (valid range is 0 to ${this.default_recent_manager.size - 1})`));
                return;
            }

            setTimeout(() => {
                try {
                    // Получаем все элементы истории
                    const items = this.default_recent_manager.get_items().splice(start_index, items_count);

                    setTimeout(() => {
                        resolve(items.map(item => (
                            converter(item)
                        )));
                    }, 0);

                } catch (error) {
                    reject(error);
                }
            }, 0);

        });
    };

    //#endregion

    // #region СЛУШАТЕЛИ СИГНАЛОВ

    /** Реакция на изменение системных настроек истории файлов.
     *
     * Вызывается при изменении `gtk-recent-files-enabled`.
     * При отключении истории выполняет экстренную очистку очереди удаления.
     *
     * @fires notify::recent-files-enabled
     * @fires notify::state */
    private settings_changed_cb(): void {
        if (!this.recent_files_enabled) {
            // при this.recent_files_enabled === false файл с
            // записями истории становится пустым, не имеет смысла
            // продолжать что-то из него удалять. Любые действия с
            // ним будут заканчиваться ошибкой
            this.handle_history_disabled();
        }
        this.notify('recent-files-enabled'); // уведомление о изменении доступности
        this.notify('state'); // уведомление о изменении состояния
    }

    /** Эмиттит заторможенный сигнал `history-changes-settled`.
     *
     * Вызывается после истечения таймаута дебаунса.
     * Также уведомляет об изменении количества элементов.
     *
     * @fires notify::history-items-count
     * @fires history-changes-settled */
    private history_changed_cb(): void {
        this.notify('history-items-count'); // уведомление о возможном изменении размера истории
        this.emit('history-changes-settled'); // сигнал 'history-changes-settled'
    };

    //#endregion

    // #region УПРАВЛЕНИЕ СОСТОЯНИЕМ

    /** Устанавливает флаг запроса мониторинга и уведомляет о возможном изменении состояния.
     *
     * Метод является частью реактивной архитектуры - изменение флага
     * автоматически вызывает пересчёт состояния и соответствующие реакции.
     *
     * @param value Новое значение для флага `monitoring_requested` */
    private set_monitoring_requested(value: boolean): void {
        if (this.state_context.monitoring_requested !== value) {
            this.state_context.monitoring_requested = value;
            this.notify('state'); // уведомление о изменении состояния
        }
    }

    /** Обрабатывает изменение состояния мониторинга.
     *
     * Вызывается автоматически при изменении вычисляемого свойства `state`.
     * Метод является центральным элементом реактивной архитектуры класса:
     *
     * Активирует/деактивирует мониторинг в зависимости от состояния
     * */
    private state_changed_cb(): void {

        if (this.state_context.previous_state === this.state) {
            // если фактически состояние не изменилось - ничего не делаем
            return;
        }

        const state = this.state;
        // Реагируем на новое состояние
        switch (state) {
            case MonitoringState.ACTIVE:
                this.ensure_monitoring_active();
                break;
            case MonitoringState.INACTIVE:
            case MonitoringState.PENDING:
                if (this.state_context.previous_state === MonitoringState.ACTIVE) {
                    this.ensure_monitoring_inactive();
                }
                break;
            default: {
                const _state: never = state;
                console.assert(false, `Unknown state: ${_state}`);
                break;
            }
        }

        this.state_context.previous_state = this.state;
    }

    /** Запуск слежения за историей.
     *
     * @fires this#'history-changes-settled' */
    private ensure_monitoring_active(): void {

        if (this.handlers_ids.recent_manager === NO_HANDLER) {
            // подключаем обработчик
            this.handlers_ids.recent_manager = this.default_recent_manager.connect(
                'changed',
                this.retarded_history_changed.bind(this)
            );
        }
        // Принудительно отправить сигнал 'history-changes-settled' после подключения
        this.delayed_signal.emitter.invoke();

    }

    /** Планирует отправку отложенного сигнала `'history-changes-settled'`.
     *
     * Метод является обработчиком сигнала `'changed'` от `Gtk.RecentManager`.
     * Использует механизм отложенных сигналов для предотвращения спама уведомлениями
     * при массовых изменениях истории (например, при импорте файлов).
     *
     * @fires this#'history-changes-settled' После истечения таймаута дебаунса */
    private retarded_history_changed() {
        this.delayed_signal.emitter.pending_invoke();
    }

    /** Остановка слежения за историей.
     *
     * @fires this#'history-changes-settled' */
    private ensure_monitoring_inactive(): void {

        if (this.handlers_ids.recent_manager > NO_HANDLER) {
            if (GObject.signal_handler_is_connected(this.default_recent_manager, this.handlers_ids.recent_manager)) {
                this.default_recent_manager.disconnect(this.handlers_ids.recent_manager);
            }
            this.handlers_ids.recent_manager = NO_HANDLER;

            // // Принудительно отправить сигнал 'history-changes-settled', если был запланирован отложенный сигнал
            // this.delayed_signal.emitter.flush();
            // @todo или... или... - определится что правильней
            // отменить возможный запланированный сигнал 'history-changes-settled'
            this.delayed_signal.emitter.cancel();
        }
    }

    //#endregion

    // #region ОЧИСТКА

    /** Обрабатывает ситуацию отключения истории файлов в системе.
     *
     * Выполняет экстренную остановку всех процессов и очистку ресурсов:
     * - Останавливает процесс удаления элементов
     * - Отклоняет все ожидающие промисы с соответствующей ошибкой
     * - Очищает очередь обработки
     * */
    private handle_history_disabled(): void {
        // Если процесс удаления активен
        if (this.remove_process_context.source) {
            clearInterval(this.remove_process_context.source);
            this.remove_process_context.source = undefined;
        }
        // Отклонить все ожидающие промисы
        this.queue_cleanup('Recent history is now disabled');

    }

    /** Очищает очередь удаления и отклоняет все ожидающие промисы. */
    private queue_cleanup(msg = 'Queue cleanup'): void {
        if (this.remove_process_context.remove_queue.size > 0) {
            const cleanup_error = new QueueCleanupError(msg);
            for (const [_uri, promise_controllers] of this.remove_process_context.remove_queue) {
                promise_controllers.reject!(cleanup_error);
            }
            // Отклоняем возможный ожидающий промис
            if (this.remove_process_context.promise_controllers) {
                this.remove_process_context.promise_controllers.reject!(cleanup_error);
                this.remove_process_context.promise_controllers = undefined;
            }
            this.remove_process_context.remove_queue = new Map();
        }
    }

    //#endregion

    /** Выводит объект из эксплуатации.
     *
     * Завершает работу с объектом. Освобождает все ресурсы, используемые объектом.
     *
     * @warning После вызова этого метода объект становится непригодным для использования!
     * Все попытки вызвать методы объекта приведут к ошибкам.
     *
     * ПРИМЕЧАНИЕ: Завершение очереди удаления при очистке объекта
     * НЕ гарантируется и не требуется для данного использования
     *
     * Метод выполняет:
     * 1. Отклонение всех ожидающих операций удаления
     * 2. Остановку процесса удаления элементов
     * 3. Отключение всех обработчиков сигналов
     * 4. Намеренную "порчу" объекта для предотвращения дальнейшего использования
     */
    public decommission(): void {
        // Метод намеренно 'разрушает' объект для немедленного
        // выявления неправильного использования.
        // Небезопасная типизация сделана намеренно.

        // отключение всех сигналов
        decommission_signals(this, this.state_context.handler_id);
        decommission_signals(this.default_settings_manager!, this.handlers_ids.settings_manager);
        decommission_signals(this.default_recent_manager, this.handlers_ids.recent_manager);
        decommission_signals(this.delayed_signal.emitter, this.delayed_signal.handler_id);

        this.delayed_signal.emitter.cancel();

        // остановка возможного процесса удаления
        if (this.remove_process_context.source) {
            clearInterval(this.remove_process_context.source);
        }

        // Отклоняем все ожидающие операции
        this.queue_cleanup('Provider will be decommissioned');

        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.request_monitoring = (throw_decommissioned as typeof this.request_monitoring);
        this.withdraw_monitoring = (throw_decommissioned as typeof this.withdraw_monitoring);
        this.remove_item = (throw_decommissioned as typeof this.remove_item);
        this.get_items = (throw_decommissioned as typeof this.get_items);
        this.decommission = (throw_decommissioned as typeof this.decommission);

        this.state_context.handler_id = (undefined as unknown as typeof this.state_context.handler_id);
        this.state_context = (undefined as unknown as typeof this.state_context);

        this.default_settings_manager = (undefined as unknown as typeof this.default_settings_manager);
        this.handlers_ids.settings_manager = (undefined as unknown as typeof this.handlers_ids.settings_manager);

        this.handlers_ids.recent_manager = (undefined as unknown as typeof this.handlers_ids.recent_manager);
        this.default_recent_manager = (undefined as unknown as typeof this.default_recent_manager);

        this.delayed_signal.emitter = (undefined as unknown as typeof this.delayed_signal.emitter);
        this.delayed_signal.handler_id = (undefined as unknown as typeof this.delayed_signal.handler_id);

        this.handlers_ids = (undefined as unknown as typeof this.handlers_ids);
        this.delayed_signal = (undefined as unknown as typeof this.delayed_signal);

        // Дополнительная гарантия, что source не будет повторно использован
        this.remove_process_context.source = undefined;
        this.remove_process_context = (undefined as unknown as typeof this.remove_process_context);

    }




}
