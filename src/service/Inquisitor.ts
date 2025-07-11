/** @file: src/service/Inquisitor.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 2.3.3 */
/**
 * @changelog
 *
 * # 2.3.3 - Рефакторинг
 *
 * # 2.3.2 - Рефакторинг
 *
 * # 2.3.1 - check_criteria - теперь генератор
 *
 * # 2.3.0 - Изменена логика формирования отчета
 *           в режиме Report.
 *           Теперь в отчет попадают все записи из
 *           исходного списка, независимо от
 *           совпадений.
 *
 * # 2.2.2 - Стабильная версия
 *         - Рефакторинг
 *
 * # 2.2.1 - Теперь список обрабатывается через splice.
 *           - Список будет "съеден" во время обработки.
 *
 * # 2.0.1 - Рефакторинг
 *
 * # 2.0.0 - Изменен интерфейс для работы с Inquisitor
 *           - inspect_to_report
 *           - inspect_to_signal
 *           - do_process - теперь приватный метод
 *         - Изменилось поведение
 *         - Исправлена документация
 *
 * # 1.3.2 - Исправлен тип `get criteria()`
 *
 * # 1.3.1 - Стабильная версия
 *         - Рефакторинг
 *
 * # 1.3.0 - Реализации конкурентно-безопасной
 *           архитектуры для set_criteria (правильной)
 *
 * # 1.2.0 - Реализации конкурентно-безопасной
 *           архитектуры для set_criteria (не правильной)
 *
 * # 1.1.0 - Отказ от ошибки EmptyCriteriaError
 *         - Исправлено поведение при пустом списке критериев
 *         - get criteria возвращает пустой массив при пустом списке критериев
 *
 * # 1.0.2 - Документация
 *
 * # 1.0.1 - Исправлены и дополнены типы ошибок
 *
 * # 1.0.0 - Стабильная версия
 */

import GObject from 'gi://GObject?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    IDecommissionable,
    DecommissionedError,
    DECOMMISSIONED,
    DecommissionType
} from '../Ljs/Decommissionable.js';
import {
    GDecorator
} from '../Ljs/GObjectDecorators.js';
import type {
    SourceID,
    PromiseController,
    RecentItemTuple,
    Report,
    CriteriaType,
    SinInfo,
    ReportItem,
} from '../shared/common-types.js';
import {
    NO_SOURCE,
} from '../shared/common-types.js';

/** Карта типов критериев фильтрации файлов.
 *
 * Определяет доступные типы критериев и их параметры.
 * Каждый ключ интерфейса соответствует типу критерия,
 * а значение - объекту с параметрами этого критерия. */
interface CriteriaMap {
    /** Фильтр на основе glob-шаблона */
    glob: {
        /** Glob-шаблон для сопоставления с именами файлов
         * @example "*.jpg", "document-*.pdf" */
        pattern: string,
        /** Метка критерия для идентификации.
         * Используется в отчётах о совпадениях.
         * Если не задана, в качестве метки используется сам шаблон */
        label?: string | null;
    },
};

/** Карта скомпилированных критериев фильтрации.
 *
 * Содержит предварительно обработанные данные критериев
 * для эффективной проверки файлов. */
interface CompiledCriteriaMap {
    /** Скомпилированный критерий glob */
    glob: {
        /** Скомпилированный glob-шаблон для быстрого сопоставления */
        pattern_spec: GLib.PatternSpec,
    },
};

/** Спецификация критерия фильтрации.
 *
 * Объединяет тип критерия с его параметрами.
 * Используется для передачи критериев в методы класса.
 *
 * @template CriteriaType Тип критерия из CriteriaMap */
export type CriteriaSpec<CriteriaType extends keyof CriteriaMap> = {
    /** Тип критерия фильтрации */
    type: CriteriaType,
} & CriteriaMap[CriteriaType];

/** Скомпилированная спецификация критерия.
 *
 * Внутреннее представление критерия после компиляции.
 * Содержит оптимизированные структуры данных для проверки.
 *
 * @template CriteriaType Тип критерия из CompiledCriteriaMap */
type CompiledCriteriaSpec<CriteriaType extends keyof CompiledCriteriaMap> = {
    /** Тип критерия фильтрации */
    type: CriteriaType,
    /** Метка критерия для идентификации в результатах */
    label: string,
} & CompiledCriteriaMap[CriteriaType];

/** Режимы проверки */
export enum ProcessMode {
    /** Ленивый режим.
     * - Останавливается на первом совпадении
     * - Делает паузы между проверками файлов
     * - Низкая скорость обработки
     * - Минимальная нагрузка на систему */
    LAZY,
    /** Тщательный режим.
     * - Проверяет все критерии для каждого файла
     * - Собирает полный список всех совпадений
     * - Обрабатывает файлы максимально быстро
     * - Высокая нагрузка на систему */
    REPORT
}

export interface ProcessOperation<T = unknown> {
    source: SourceID;
    controller: PromiseController<T>;
    report?: Report;
}

/** Ошибка прерывания процесса проверки.
 *
 * Выбрасывается когда активный процесс проверки файлов был принудительно
 * остановлен вызовом метода `process_abort()`. Это может произойти по
 * следующим причинам:
 *
 * - Явный вызов `process_abort()` из внешнего кода
 * - Автоматическое прерывание при вызове `set_criteria()`
 * - Автоматическое прерывание при повторном вызове `do_process()`
 * - Вызов `decommission()` во время активной проверки
 *
 * @extends {Error}
 *
 * @example
 * ```typescript
 * // Обработка прерывания проверки
 * try {
 *     await inquisitor.do_process(largeFileList);
 * } catch (error) {
 *     if (error instanceof ProcessAbortError) {
 *         console.log('Проверка была прервана:', error.message);
 *         // Это нормальная ситуация, не требует особой обработки
 *     }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Прерывание с пользовательским сообщением
 * inquisitor.process_abort('Отменено пользователем');
 * // Promise от do_process будет отклонён с new ProcessAbortError('Отменено пользователем')
 * ``` */
export class ProcessAbortError extends Error {
    constructor(message = 'Process aborted', options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProcessAbortError';
    }
}

/** Ошибка валидации критериев фильтрации.
 *
 * Выбрасывается методом `set_criteria()` при обнаружении невалидных данных
 * в массиве критериев. Ошибка содержит общее описание проблемы.
 * Исходная причина доступна через свойство `cause`.
 *
 * ## Возможные причины ошибки:
 *
 * - `criteria` не является массивом
 * - Элемент массива не является объектом или равен null
 * - Поле `label` указано, но не является строкой
 * - Для типа 'glob': `pattern` отсутствует, пустой или не является строкой
 * - Указан неподдерживаемый тип критерия
 *
 * При возникновении этой ошибки старые критерии сбрасываются, но новые
 * не устанавливаются. Объект остаётся в состоянии без критериев.
 *
 * @extends {Error}
 *
 * @property {Error} [cause] - Исходная ошибка с детальной информацией
 *
 * @example
 * ```typescript
 * // Обработка различных ошибок валидации
 * try {
 *     await inquisitor.set_criteria([
 *         { type: 'unknown', data: 'test' } // Неподдерживаемый тип
 *     ]);
 * } catch (error) {
 *     if (error instanceof CriteriaValidateError) {
 *         console.error('Ошибка валидации:', error.message);
 *
 *         // Получаем детальную информацию
 *         if (error.cause instanceof Error) {
 *             console.error('Причина:', error.cause.message);
 *             // Выведет: "Unsupported criteria type: 'unknown'"
 *         }
 *     }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Валидация различных полей
 * const invalidCriteria = [
 *     { type: 'glob' }, // Отсутствует pattern
 *     { type: 'glob', pattern: '' }, // Пустой pattern
 *     { type: 'glob', pattern: 123 }, // pattern не строка
 *     { type: 'glob', pattern: '*.tmp', label: 123 }, // label не строка
 *     null, // null вместо объекта
 *     'not an object' // Строка вместо объекта
 * ];
 *
 * for (const criteria of invalidCriteria) {
 *     try {
 *         await inquisitor.set_criteria([criteria]);
 *     } catch (error) {
 *         if (error instanceof CriteriaValidateError) {
 *             console.log('Невалидный критерий:', error.cause?.message);
 *         }
 *     }
 * }
 * ```
 *
 * @see {@link Inquisitor.set_criteria} Метод, который выбрасывает эту ошибку
 * @see {@link CriteriaSpec} Формат валидных критериев */
export class CriteriaValidateError extends Error {
    constructor(message = 'Invalid criteria', options?: ErrorOptions) {
        super(message, options);
        this.name = 'CriteriaValidateError';
    }
}

/** Ошибка отмены операции установки критериев.
 *
 * Выбрасывается когда операция `set_criteria()` была отменена
 * более новым вызовом того же метода. */
export class SetCriteriaCancelledError extends Error {
    constructor(message = 'Criteria operation was cancelled', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SetCriteriaCancelledError';
    }
}



/** Inquisitor - Проверяет список на соответствие заданным критериям фильтрации.
 *
 * ## Назначение
 *
 * Класс реализует асинхронный механизм проверки списка данных на соответствие
 * заданным критериям. Работает как детектор, выявляя совпадения и уведомляя
 * о них, не выполняя никаких действий над самими данными.
 *
 * ## Основные возможности
 *
 * - Асинхронная проверка
 * - Поддержка различных типов критериев
 *   Реализовано:
 *   - glob (Gtk.PatternSpec)
 * - Два режима работы с разным балансом производительности и типом уведомления
 * - Кэширование "чистых" файлов для оптимизации
 * - Прерывание процесса проверки в любой момент
 * - Детальная информация о совпавших критериях
 *
 * ## Архитектура и интеграция
 *
 * ### API
 *
 * #### Параметры конструктора:
 *  - Не принимает параметров
 *
 * #### Сигналы:
 * - `'matched-result'` Генерируется в режиме LAZY после проверки каждого файла, если были совпадения.
 *   Параметры
 *   - `URI: string` URI файла
 *   - `sin: SinsInfo` первый совпавший критерий
 *
 * #### Константы:
 * - `MAX_CACHE_SIZE` Максимальный размер кэша для хранения URI "чистых" файлов.
 * - `BATCH_SIZE` Размер пакета для обработки (в режиме REPORT).
 * - `PROCESS_INTERVAL` Интервал между обработкой (в режиме LAZY).
 *
 * #### Свойства:
 * - `criteria: CompiledCriteriaSpec<CriteriaType>[]` Возвращает текущие скомпилированные критерии фильтрации. Только чтение.
 *
 * #### Методы:
 * - `set_criteria(criteria: CriteriaSpec<CriteriaType>[]): Promise<void>` Устанавливает новые критерии фильтрации.
 * - `process_abort(msg): boolean` Немедленно прерывает текущий процесс проверки.
 * - `inspect_to_report(items_info: RecentItemTuple[]): Promise<Report>` Проверяет список на соответствие заданным критериям в режиме REPORT.
 * - `inspect_to_signals(items_info: RecentItemTuple[]): Promise<void>` Проверяет список на соответствие заданным критериям в режиме LAZY.
 * - `decommission(): void` Выводит объект из эксплуатации.
 *
 * #### Ошибки:
 * - `CriteriaValidateError` - ошибка валидации при установке критериев
 * - `ProcessAbortError` - процесс был прерван вызовом `process_abort()`
 * - `DecommissionedError` - попытка использовать выведенный из эксплуатации объект
 *
 * Класс спроектирован как компонент сервиса. Он не управляет
 * списками или критериями самостоятельно, а получает их извне.
 * Результаты проверки "отдаются как есть", позволяя
 * внешнему коду реагировать на совпадения любым необходимым способом.
 *
 * ## Типичный сценарий использования
 *
 * ```typescript
 * // 1. Создание экземпляра
 * const inquisitor = new Inquisitor();
 *
 * // 2. Подписка на результаты
 * inquisitor.connect('matched-result', (obj, uri, sin) => {
 *     console.log(`Файл ${uri} соответствует критериям:`, sin);
 * });
 *
 * // 3. Установка критериев
 * await inquisitor.set_criteria([
 *     { type: 'glob', pattern: '*.tmp', label: 'Временные файлы' },
 *     { type: 'glob', pattern: '~*', label: 'Резервные копии' }
 * ]);
 *
 * // 4. Запуск проверки
 * await inquisitor.inspect_to_signals(filesList);
 * ```
 *
 * ## Режимы проверки
 *
 * ### `inspect_to_report()` (Для UI. Для сбора полного отчета по всем критериям)
 * - Проверяет записи по всем критериям
 * - Выполняет проверку пакетами по `BATCH_SIZE` в каждом интервале
 * - Собирает полную информацию обо всех совпадениях
 * - Обрабатывает список максимально быстро без пауз
 * - Возвращает отчет как результат
 * - Подходит для быстрого анализа, для отображения результатов в UI
 *
 * ### `inspect_to_signals()` (Для фоновой работы. Для генерации сигналов)
 * - Останавливает проверку записи на критерии после первого совпадения
 * - Вставляет паузы между проверками (`PROCESS_INTERVAL` мс)
 * - Для каждого совпадения генерирует сигнал `matched-result`
 * - Минимизирует нагрузку на систему
 * - Подходит для фоновой обработки без нагрузки на систему
 *
 * ## Кэширование
 *
 * Для оптимизации повторных проверок класс ведёт кэш "чистых" файлов -
 * тех, которые были проверены, и не соответствуют ни одному критерию:
 *
 * - Использует `Set` для быстрой проверки наличия
 * - Максимальный размер ограничен `MAX_CACHE_SIZE`
 * - При превышении лимита удаляется самая старая запись (FIFO)
 * - Кэш сбрасывается при изменении критериев (@see {@link set_criteria})
 * - Файлы из кэша пропускаются при последующих проверках
 *   если критерии не менялись
 *
 * Это особенно /и только/ эффективно при частых проверках одного и того же
 * списка данных с небольшими изменениями если критерии не меняются (режим LAZY).
 *
 * Эта стратегия хорошо работает со списком истории, поскольку системный
 * менеджер всегда отдает полный список файлов в истории, а изменения в нем,
 * как правило, затрагивают только одну запись, или вообще отсутствуют.
 *
 * ## Критерии фильтрации
 *
 * ### Поддерживаемые типы критериев
 *
 * #### glob
 * Сопоставление путей файлов с шаблоном в стиле shell glob (упрощённый):
 * - `*` - любое количество любых символов
 * - `?` - один любой символ
 *
 * @see {@link GLib.PatternSpec Для дополнительной информации смотри `GLib.PatternSpec`}.
 *
 * Примеры:
 * - `*.tmp` - все файлы с расширением .tmp
 * - `~*` - все файлы, начинающиеся с ~
 * - `*\.cache\*` - все файлы, в директории .cache и ее поддиректориях
 *
 * ### Специальный внутренний критерий `'lint'`
 *
 * Автоматически применяется к записям с проблемами валидации.
 *
 * Если у файла отсутствует или пустое поле `uri_display`, генерируется
 * совпадение с критерием:
 * ```typescript
 * {
 *     type: 'lint',
 *     label: 'MISSING-DISPLAY-URI'
 * }
 * ```
 *
 * При этом `uri_display` возвращается в отчете как строка `'<unknown>'` или  `'<empty>'`.
 *
 * Это помогает выявлять некорректные записи в списке недавних файлов,
 * которые невозможно проверить на совпадение критериям.
 *
 * Критерий `'lint'` будет срабатывать всегда, независимо от режима, даже если
 * критерии не заданы.
 *
 * Критерий `'lint'` проверяется до проверки каждого другого критерия, и, если
 * он срабатывает, проверка критериев прекращается. Такое поведение обусловлено
 * тем, что срабатывание критерия `'lint'` означает (как правило) невозможность
 * получения из данных информации, достаточной для проверки других критериев.
 *
 * ## Производительность
 *
 * - Использует скомпилированные `GLib.PatternSpec` для быстрого сопоставления
 * - Кэширует результаты для избежания повторных проверок
 * - В ленивом режиме распределяет нагрузку по времени
 * - Поддерживает возможность прерывание длительных операций
 * */
@GDecorator.Class({
    Signals: {
        /** Генерируется после проверки каждого файла, если были совпадения с критериями. */
        'matched-result': {
            param_types: [
                /** matched-result::uri:string URI файла */
                GObject.TYPE_STRING,
                /** matched-result::sin:SinsInfo первый совпавший критерий */
                GObject.TYPE_JSOBJECT,
            ],
        },
    },
    GTypeFlags: GObject.TypeFlags.FINAL,
    GTypeName: 'Inquisitor',
})
export class Inquisitor extends GObject.Object implements IDecommissionable {

    /** Максимальный размер кэша для хранения "чистых" URI.
     *
     * Определяет предельное количество записей в кэше, которые
     * не соответствуют ни одному критерию. При достижении этого лимита
     * самая старая запись вытесняется по принципу FIFO.
     *
     * Значение 1000 выбрано в соответствии с ограничением GNOME на
     * количество недавних файлов, что обеспечивает оптимальный баланс
     * между использованием памяти и эффективностью кэширования.
     *
     * @example
     * ```typescript
     * // Кэш автоматически поддерживает размер <= MAX_CACHE_SIZE
     * // При проверке 2000 файлов в кэше останутся последние 1000 "чистых"
     * console.log(`Максимум файлов в кэше: ${Inquisitor.MAX_CACHE_SIZE}`);
     * ```
     *
     * @see {@link add_to_trustworthy_list} Метод управления кэшем */
    static MAX_CACHE_SIZE = 1000 as const;

    /** Количество записей, обрабатываемых за один проход в режиме REPORT.
     * @see {@link do_process}  */
    static BATCH_SIZE = 25 as const;

    /** Интервал между проверками файлов в миллисекундах.
     *
     * Определяет задержку между обработкой отдельных записей в режиме LAZY.
     *
     * ## Рекомендации по изменению:
     *
     * - 1-5 мс: оптимально для большинства случаев
     * - 10-50 мс: для очень больших списков или слабых систем
     * - 0 мс: только для режима REPORT (быстрая обработка)
     *
     * @see {@link do_process} Использование в процессе проверки */
    static PROCESS_INTERVAL = 8 as const;

    /** Скомпилированный набор критериев фильтрации.
     *
     * Содержит предварительно обработанные критерии для эффективной
     * проверки файлов. Критерии компилируются при вызове `set_criteria()`
     * и используются во всех последующих проверках до следующего изменения.
     *
     * - Пустой массив означает отсутствие критериев
     * - `undefined` будет означать, что объект выведен из эксплуатации (@see {@link decommission `decommission()`})
     *
     * @see {@link set_criteria} Установка критериев
     * @see {@link criteria} Публичный геттер */
    private eligibility_criteria = [] as CompiledCriteriaSpec<CriteriaType>[];

    /** Кэш URI, не соответствующих критериям.
     *
     * Для оптимизации повторных проверок.
     *
     * Особенности:
     * - Сбрасывается при изменении критериев
     * - Ограничен размером MAX_CACHE_SIZE
     * - Использует FIFO для вытеснения старых записей
     *
     * @see {@link add_to_trustworthy_list} Добавление в кэш */
    private trustworthy_list = new Set<string>();

    /** Состояние текущего процесса проверки.
     *
     * Хранит контроллер Promise для возможности прерывания
     * и дополнительные данные процесса.
     * */
    private process_operation: ProcessOperation = {
        /** Источник таймера для интервальной обработки файлов.
         *
         * Хранит ссылку на активный интервал, созданный через `setInterval()`.
         * Используется для контроля процесса проверки и его прерывания.
         *
         * - `null` - нет активной проверки
         * - `GLib.Source` - идёт процесс проверки
         * */
        source: NO_SOURCE,
        /** Контроллер Promise текущей операции */
        controller: {},
        report: undefined,
    };


    /** Состояние текущего процесса установки критериев. */
    private criteria_operation = {
        /** Источник таймера для интервальной установки критериев.
         *
         * Хранит ссылку на активный интервал, созданный через `setInterval()`.
         * Используется для контроля процесса и его прерывания.
         *
         * - `null` - нет
         * - `GLib.Source` - идёт процесс
         * */
        source: NO_SOURCE as SourceID,
        /** Текущий индекс */
        current_index: 0 as number,
        /** Контроллер Promise текущей операции */
        controller: {
            reject: undefined,
            resolve: undefined
        } as PromiseController<void>,
    };


    /** Создаёт новый экземпляр `Inquisitor`.
     *
     * Объект создается с пустым списком критериев.
     * Перед использованием необходимо вызвать `set_criteria()`.
     *
     * @example
     * ```typescript
     * const inquisitor = new Inquisitor();
     * // Объект создан, но ещё не готов к работе
     * await inquisitor.set_criteria([...]); // Теперь готов
     * ``` */
    constructor() {
        super();
    }

    /** Возвращает текущие скомпилированные критерии фильтрации.
     *
     * _GObject-свойство_: `ParamFlags.READABLE`
     *
     * @returns Массив скомпилированных критериев
     *
     * @throws {ObjectDecommissionedError} Если объект выведен из эксплуатации
     *
     * @example
     * ```typescript
     * const criteria = inquisitor.criteria;
     * if (criteria) {
     *     console.log(`Установлено ${criteria.length} критериев`);
     * }
     * ``` */
    @GDecorator.JSObjectProperty({
        flags: GObject.ParamFlags.READABLE
    })
    public get criteria(): CompiledCriteriaSpec<CriteriaType>[] {

        // проверяем, не выведен ли объект из эксплуатации
        if (this.eligibility_criteria === undefined) {
            throw new DecommissionedError();
        }

        return this.eligibility_criteria;
    }

    /** Устанавливает новые критерии фильтрации.
     *
     * Реализация конкурентно-безопасного API в условиях среды GJS.
     *
     * Старается гарантировать атомарность:
     * - только актуальная операция  может записать в `this.eligibility_criteria`.
     * - Все отклоненные попытки установить критерии оставляют
     *   `this.eligibility_criteria` пустым.
     * - Все ошибки валидации оставляют `this.eligibility_criteria` пустым.
     *
     * Будет выполнено:
     * 1. Прерывает текущую проверку (`do_process()`, если выполняется)
     * 2. Сбрасывает старые критерии
     * 3. Очищает кэш проверенных ("чистых")
     * 4. Валидирует и компилирует новые критерии
     * 5. Устанавливает новые критерии (если валидация успешна)
     *
     * Нет специализированного метода для прерывания установки критериев,
     * используй `set_criteria([])`.
     *
     * @param criteria Массив критериев для установки
     *
     * @returns {Promise<void>} Promise, который разрешается после успешной
     *                          установки критериев
     *
     * @throws {CriteriaValidateError} При ошибках валидации критериев:
     *         - Если criteria не является массивом
     *         - Если элемент массива не является объектом
     *         - Если label не является строкой (когда указан)
     *         - Если pattern пустой или не является строкой (для glob)
     *         - Если указан неподдерживаемый тип критерия
     *
     *         _Конкретная причина доступна через `error.cause`_
     *
     * @throws {SetCriteriaCancelledError} При отмене текущей установки критериев следующим вызовом `set_criteria()`.
     *
     * @throws {ObjectDecommissionedError} Если объект выведен из эксплуатации
     *
     * @fires notify::criteria Может генерироваться дважды:
     *        1. После сброса старых критериев (будет генерироваться в любом случае)
     *        2. После установки новых критериев (только если список валиден и не пуст)
     *
     * @example
     * ```typescript
     * try {
     *     await inquisitor.set_criteria([
     *         { type: 'glob', pattern: '*.tmp' },
     *         { type: 'glob', pattern: '~*', label: 'Резервные копии' }
     *     ]);
     *     console.log('Критерии установлены успешно');
     * } catch (error) {
     *     if (error instanceof CriteriaValidateError) {
     *         console.error('Ошибка валидации:', error.cause);
     *     }
     * }
     * ```
     * */ // @todo Нужны более четкие описания ошибок валидации и информация о проблемном критерии
    public set_criteria(criteria: readonly CriteriaSpec<CriteriaType>[]): Promise<void> {

        // Новая операция отменяет все предыдущие

        return new Promise<void>((resolve, reject) => {

            // отменяем предыдущую операцию, если она выполняется
            if (this.criteria_operation.source) {
                this.criteria_operation.controller.reject!(new SetCriteriaCancelledError('Superseded by newer operation'));
                clearInterval(this.criteria_operation.source);
                this.criteria_operation.source = null;
            }
            // отклоняем предыдущий промис

            // -- немедленные действия (неотменяемые) --
            this.process_abort('Stopping for criteria update');

            // атомарно: обнуляем критерии сразу
            this.eligibility_criteria = [];
            this.notify('criteria'); // уведомление о сбросе критериев
            this.trustworthy_list.clear();
            // Работаем во временном массиве
            const _eligibility_criteria = [] as CompiledCriteriaSpec<CriteriaType>[];

            { // начинаем проверки

                // Валидация. должен быть массив
                if (!Array.isArray(criteria)) {
                    reject(new CriteriaValidateError('Criterion must be an Array'));
                }

                // сохраняем, настраиваемся и начинаем цикл валидации
                this.criteria_operation.controller.reject = reject;
                this.criteria_operation.controller.resolve = resolve;
                this.criteria_operation.current_index = 0;

                this.criteria_operation.source = setInterval(() => {

                    try {

                        // проверяем что все критерии уже проверены
                        if (this.criteria_operation.current_index >= criteria.length) {

                            // финальное атомарное переливание массива
                            this.eligibility_criteria = _eligibility_criteria.splice(0, Infinity);

                            if (this.eligibility_criteria.length > 0) {
                                this.notify('criteria'); // уведомление о новых критериях
                            }

                            this.criteria_operation.controller.resolve!();
                            clearInterval(this.criteria_operation.source!);
                            this.criteria_operation.source = null;
                            return;
                        }

                        const criterion = criteria[this.criteria_operation.current_index];


                        // #region валидация и компиляция criterion в temp_criteria...

                        // проверка на объект
                        if (typeof criterion !== 'object' || criterion === null) {
                            throw new CriteriaValidateError('Criterion must be non null object');
                        }

                        if (criterion.label) {
                            if (typeof criterion.label !== 'string') {
                                // если указана метка, то она должна быть строкой
                                throw new CriteriaValidateError(`Invalid label: '${criterion.label}'. Label must be a string`);
                            }
                        }

                        switch (criterion.type) {
                            case 'glob':
                                if (typeof (criterion as CriteriaSpec<'glob'>).pattern === 'string'
                                    && (criterion as CriteriaSpec<'glob'>).pattern.length > 0) {

                                    _eligibility_criteria.push({
                                        type: 'glob',
                                        pattern_spec: new GLib.PatternSpec((criterion as CriteriaSpec<'glob'>).pattern),
                                        label: (criterion as CriteriaSpec<'glob'>).label ?? (criterion as CriteriaSpec<'glob'>).pattern
                                    } as CompiledCriteriaSpec<'glob'>);

                                } else {
                                    throw new CriteriaValidateError(`Invalid glob pattern: '${(criterion as CriteriaSpec<'glob'>).pattern}'. Glob pattern must be a non-empty string`);
                                }
                                break;
                            default:
                                throw new CriteriaValidateError(`Unsupported criteria type: '${criterion.type}'`);
                        }

                        // #endregion

                        // переходим к следующему
                        this.criteria_operation.current_index++;

                    } catch (error) {
                        if (error instanceof SetCriteriaCancelledError) {
                            this.criteria_operation.controller.reject!(error);
                        } else if (error instanceof CriteriaValidateError) {
                            this.criteria_operation.controller.reject!(error);
                        } else {
                            this.criteria_operation.controller.reject!(new Error('Failed to set criteria: Unknown error.', { cause: error }));
                        }

                        clearInterval(this.criteria_operation.source!);
                        this.criteria_operation.source = null;
                        return;
                    }

                }, 0);

            }

        });
    }

    /** Немедленно прерывает текущий процесс проверки.
     *
     * Метод безопасен для вызова в любой момент, даже если проверка не запущена.
     *
     * При прерывании активной проверки, Promise от `do_process()` будет отклонён
     * с ошибкой `ProcessAbortError`.
     *
     * @param [msg='aborted'] Сообщение для `ProcessAbortError`. По умолчанию `Process aborted`
     *        Специфичное сообщение для возможности различения причин прерывания
     *
     * @returns true, если процесс был прерван;
     *          false, если активного процесса не было
     *
     * @example
     * ```typescript
     * // Запускаем длительную проверку
     * const processPromise = inquisitor.do_process(largeFileList);
     *
     * // Прерываем через некоторое время
     * setTimeout(() => {
     *     const wasAborted = inquisitor.process_abort('Прервано пользователем');
     *     console.log(wasAborted ? 'Процесс прерван' : 'Нечего прерывать');
     * }, 1000);
     *
     * // Обрабатываем отклонение
     * try {
     *     await processPromise;
     * } catch (error) {
     *     if (error instanceof ProcessAbortError) {
     *         console.log('Проверка прервана:', error.message);
     *     }
     * }
     * ``` */
    public process_abort(msg = 'Process aborted'): boolean {
        if (this.process_operation.source) {

            clearInterval(this.process_operation.source);
            this.process_operation.source = null;

            this.process_operation.controller.reject!(new ProcessAbortError(msg));
            this.process_operation.controller.reject = undefined;

            return true;
        }
        return false;
    }

    /** Запускает асинхронную проверку переданного списка.
     *
     * Проверяет каждую запись из списка на соответствие установленным критериям.
     *
     * Работает в двух режимах: LAZY и REPORT
     *
     * В режиме LAZY (для фоновой работы)
     * - Проверяет записи по одной
     * - Останавливается на первом совпадении
     * - Делает паузу перед проверкой следующей записи (@see {@link Inquisitor.PROCESS_INTERVAL})
     * - Генерирует сигнал `'matched-result'` после совпадения
     * - Не возвращает результат
     *
     * В режиме REPORT (для интерактивной работы)
     * - Проверяет записи пакетно (@see {@link Inquisitor.BATCH_SIZE})
     * - Проверяет на соответствие всем критериям
     * - Работает без пауз (минимальная пауза `setInterval`)
     * - Не генерирует сигнал `'matched-result'`
     * - Возвращает результат как карту с отчетом о совпадениях
     *
     * URI без совпадений добавляются в кэш для оптимизации повторных проверок.
     *
     * Если в момент вызова уже выполняется другая проверка, она будет прервана
     * с ошибкой `ProcessAbortError('New process will be initiated')`.
     *
     * @param items_infos Список для проверки (кортеж кортежей `[uri, uri_display]`)
     *                    ВНИМАНИЕ: Архитектура предполагает, что Inquisitor единственный/крайний
     *                    потребитель этого списка. И, в угоду производительности, он
     *                    будет очищать его по мере обработки.
     *                    Поэтому, если этот список разделяемый ресурс - передавай
     *                    сюда копию:
     *                    `await inquisitor.inspect_to_report([...test_list_500]);`
     *                    Внимательно в тестах!
     * @param mode Режим проверки
     *
     * @returns Promise, который разрешается после проверки всех записей:
     *                    - `Promise<void>` в режиме LAZY
     *                    - `Promise<Report>` в режиме REPORT
     *
     * @throws {ProcessAbortError} Если проверка была прервана вызовом `process_abort()`
     *                             Происходит в том числе и при повторном вызове `do_process()`
     *
     * @fires 'matched-result' Для каждого файла с совпадениями в режиме LAZY.
     *        Передается информация о первом найденном совпадении.
     *        Параметры:
     *        - `uri`: `string`
     *        - `sin`: `SinsInfo`
     *
     * @example
     * ```typescript
     *
     * @affects items_infos Будет очищен после обработки. Процесс "съедает" переданный
     *                      список по мере обработки через splice(), освобождая память.
     *
     * ``` */
    private do_process<T = unknown>(
        items_infos: RecentItemTuple[],
        mode: ProcessMode
    ): Promise<T> {

        // Прерываем текущую обработку, если она запущена
        this.process_abort('New process will be initiated');

        if (mode === ProcessMode.REPORT) {
            this.process_operation.report = [];
        } else {
            this.process_operation.report = undefined;
        }

        // Возвращаем Promise
        return new Promise<T>((resolve, reject) => {

            // Сохраняем контроллеры
            this.process_operation.controller.reject = reject;
            (this.process_operation.controller as PromiseController<T>).resolve = resolve;

            // Запускаем интервал для обработки
            // --------------------------------
            this.process_operation.source = setInterval(
                this.process_interval_cb.bind(this),
                (mode === ProcessMode.REPORT) ? 0 : Inquisitor.PROCESS_INTERVAL,  // пауза, в зависимости от режима
                items_infos,
                mode
            );
        });
    }

    /** Колбек setInterval`а процесса проверки на соответствие критериям */
    private process_interval_cb(items_infos: RecentItemTuple[], mode: ProcessMode) {

        try {

            // Обрабатываем пакет элементов
            // Определяем количество элементов для обработки (пакета) в этом цикле
            // "Съедаем" список по мере обработки
            const items_batch = items_infos.splice(0, (mode === ProcessMode.REPORT) ? Inquisitor.BATCH_SIZE : 1);
            for (const item_tuple of items_batch) {

                const [uri, uri_display] = item_tuple;

                const sins: SinInfo[] = [];

                // Проверяем, не находится ли файл уже в кэше чистых,
                // если да - пропускаем. Если нет - проверяем
                if (!this.trustworthy_list.has(uri)) {

                    // Проверяем на совпадение критериев, собираем грехи
                    const check_criteria = this.check_criteria(uri_display);
                    for (const sin of check_criteria) {
                        sins.push(sin);
                        // Для ленивого режима прерываем проверку после любого первого совпадения
                        if (mode === ProcessMode.LAZY) {
                            console.assert(sins.length === 1, 'В режиме LAZY должно быть только одно совпадение!');
                            // В режиме LAZY - Если есть совпадения (всегда одно в режиме LAZY), генерируем сигнал 'matched-result'
                            this.emit('matched-result', uri, sins[0]);
                            check_criteria.return();
                            break;
                        }
                    }

                    if (sins.length === 0) {
                        // Если совпадений не было - добавляем в кэш чистых файлов ...
                        this.add_to_trustworthy_list(uri);
                    }

                }

                if (mode === ProcessMode.REPORT) {
                    // в режиме REPORT, добавляем в отчет каждый элемент с его результатом проверки
                    console.assert(this.process_operation.report !== undefined, 'process_operation.report !== undefined');
                    this.process_operation.report!.push([
                        uri,
                        (uri_display === null) ? '<unknown>' : (uri_display.length > 0) ? uri_display : '<empty>',
                        sins
                    ] as ReportItem);
                }
            }

            // Проверяем завершение (список пуст?)...
            if (items_infos.length === 0) {

                clearInterval(this.process_operation.source!);
                this.process_operation.source = null;
                if (mode === ProcessMode.REPORT) {
                    (this.process_operation.controller as PromiseController<Report>).resolve!(this.process_operation.report!);
                } else {
                    (this.process_operation.controller as PromiseController<void>).resolve!();
                }
                return;
            }

        } catch (error) {
            clearInterval(this.process_operation.source!);
            this.process_operation.source = null;
            this.process_operation.controller.reject?.(
                new Error('Processing failed! Unknown error', { cause: error })
            );
        }
    };

    private *check_criteria(uri_display: string | null): Generator<SinInfo, void, unknown> {

        // guard condition - проверка предварительных условий
        if (uri_display !== null && uri_display.length > 0) {
            // Проверяем файл по критериям
            for (const criterion of this.eligibility_criteria) {

                const sin = this.get_sin(criterion, uri_display);

                if (sin) {
                    yield sin;
                }
            }

        } else {
            yield ['lint', 'MISSING-DISPLAY-URI'];
        }

        return;
    }

    private get_sin(criterion: CompiledCriteriaSpec<CriteriaType>, uri_display: string): SinInfo | undefined {
        switch (criterion.type) {
            // GLOB
            case 'glob': {
                if ((criterion as CompiledCriteriaSpec<'glob'>).pattern_spec.match_string(uri_display)) {
                    return [criterion.type, criterion.label];
                }
                break;
            }
            // ---
            default: {
                const _type: never = criterion.type;
                console.assert(false, `Unknown CriteriaType: ${_type}`);
                break;
            }
        }

        return undefined;
    }

    /** Запускает обработку, генерируя отчет (без сигналов).
     *
     * @affects items_infos Будет очищен после обработки.
     *
     * @see {@link do_process} */
    public inspect_to_report(items_info: RecentItemTuple[]): Promise<Report> {
        return this.do_process<Report>(items_info, ProcessMode.REPORT);
    }

    /** Запускает "фоновую" проверку, генерируя сигналы `matched-result` (без отчета).
     *
     * @affects items_infos Будет очищен после обработки.
     *
     * @fires 'matched-result'
     *
     * @see {@link do_process} */
    public inspect_to_signals(items_info: RecentItemTuple[]): Promise<void> {
        return this.do_process<void>(items_info, ProcessMode.LAZY);
    }

    /** Добавляет в кэш "чистых" URI (не попадающих под текущие критерии).
     *
     * Реализует FIFO-стратегию вытеснения: при достижении максимального
     * размера кэша (`MAX_CACHE_SIZE`) удаляется самая старая запись.
     *
     * @param uri URI для добавления в кэш
     *
     * @private
     * @example
     * ```typescript
     * // Внутреннее использование
     * if (sin.length === 0) {
     *     this.add_to_trustworthy_list(current_file.uri);
     * }
     * ```*/
    private add_to_trustworthy_list(uri: string): void {
        // Если кэш достиг максимального размера, удаляем самую старую запись
        if (this.trustworthy_list.size >= Inquisitor.MAX_CACHE_SIZE) {
            // В Set порядок обхода соответствует порядку вставки,
            // поэтому первый элемент - самый старый
            const oldest_uri = this.trustworthy_list.values().next().value;
            if (oldest_uri) {
                this.trustworthy_list.delete(oldest_uri);
            }
        }

        // Добавляем новую запись
        this.trustworthy_list.add(uri);
    }

    /** Выводит объект из эксплуатации, освобождая все ресурсы.
     *
     * После вызова этого метода объект становится неработоспособным.
     * Любые попытки использовать публичные методы приведут к выбросу
     * `ObjectDecommissionedError`.
     *
     * Выполняет следующие действия:
     * - Прерывает текущую проверку (если выполняется)
     * - Освобождает все внутренние ресурсы
     * - Делает все публичные методы неработоспособными
     * - Удаляет ссылки на внутренние структуры данных
     *
     * @warning После вызова объект не подлежит восстановлению
     * @warning Объект становится не работоспособным, и не должен больше использоваться
     *
     * @example
     * ```typescript
     * // Использование объекта
     * await inquisitor.do_process(files);
     *
     * // Вывод из эксплуатации
     * inquisitor.decommission();
     *
     * // Дальнейшее использование вызовет ошибку
     * try {
     *     await inquisitor.do_process(files); // Выбросит ObjectDecommissionedError
     * } catch (error) {
     *     console.error('Объект выведен из эксплуатации');
     * }
     * ``` */
    public decommission: DecommissionType = () => {

        this.process_abort('Object is being decommissioned');

        // отменяем операцию установки критериев, если она выполняется
        if (this.criteria_operation.source) {
            clearInterval(this.criteria_operation.source);
            this.criteria_operation.source = null;
            this.criteria_operation.controller.reject!(new SetCriteriaCancelledError('Object is being decommissioned'));
        }

        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.do_process = (throw_decommissioned as typeof this.do_process);
        this.process_abort = (throw_decommissioned as typeof this.process_abort);
        this.set_criteria = (throw_decommissioned as typeof this.set_criteria);

        // шобы Клодик не ругался
        this.trustworthy_list.clear();

        this.eligibility_criteria = (undefined as unknown as typeof this.eligibility_criteria);
        this.trustworthy_list = (undefined as unknown as typeof this.trustworthy_list);
        this.process_operation = (undefined as unknown as typeof this.process_operation);
        this.criteria_operation = (undefined as unknown as typeof this.criteria_operation);

        this.decommission = DECOMMISSIONED;
    };
}
