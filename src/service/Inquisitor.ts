/** @file: src/service/Inquisitor.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.3.2 */
/**
 * @changelog
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
    Decommissionable,
    DecommissionedError
} from '../shared/Decommissionable.interface.js';
import {
    GObjectDecorator
} from '../shared/gobject-decorators.js';
import type {
    RecentItem,
    SourceID,
    PromiseControllers
} from '../shared/common-types.js';
import {
    NO_SOURCE,
} from '../shared/common-types.js';


/** Тип критерия */
export type CriteriaType =
    /** Фильтр на основе glob-шаблона */
    'glob';

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
        /** Метка критерия для идентификации в результатах */
        label: string,
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
} & CompiledCriteriaMap[CriteriaType];


/** Информация о совпавшем критерии.
 *
 * Передаётся в сигнале `'matched-result'` для каждого
 * критерия, которому соответствует проверяемый файл. */
export interface SinsInfo {
    /** Тип сработавшего критерия.
     * Может быть как пользовательский тип (из CriteriaType),
     * так и внутренний тип 'lint' для файлов с проблемами */
    type: CriteriaType | 'lint',
    /** Метка сработавшего критерия.
     * Для типа 'lint' может быть 'MISSING-DISPLAY-URI' */
    label: string,
}

/** Режимы проверки файлов.
 *
 * Определяет баланс между скоростью обработки и нагрузкой на систему. */
export enum Thoroughness {
    /** Тщательный режим.
     * - Проверяет все критерии для каждого файла
     * - Собирает полный список всех совпадений
     * - Обрабатывает файлы максимально быстро
     * - Высокая нагрузка на систему */
    thorough = 0,
    /** Ленивый режим.
     * - Останавливается на первом совпадении
     * - Делает паузы между проверками файлов
     * - Низкая скорость обработки
     * - Минимальная нагрузка на систему */
    lazy = 1,
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

/** Inquisitor - Проверяет URI файлов на соответствие заданным критериям фильтрации.
 *
 * ## Назначение
 *
 * Класс реализует асинхронный механизм проверки списка данных на соответствие
 * заданным критериям. Работает как детектор, выявляя совпадения и уведомляя
 * о них через сигналы, не выполняя никаких действий над самими данными.
 *
 * ## Основные возможности
 *
 * - Асинхронная проверка
 * - Поддержка различных типов критериев
 *   Реализовано:
 *   - glob (Gtk.PatternSpec)
 * - Два режима работы с разным балансом производительности
 * - Кэширование "чистых" файлов для оптимизации
 * - Прерывание процесса проверки в любой момент
 * - Детальная информация о совпадениях через сигналы
 *
 * ## Архитектура и интеграция
 *
 * ### API
 *
 * #### Параметры конструктора:
 *  - Не принимает параметров
 *
 * #### Сигналы:
 * - `'matched-result'` Генерируется после проверки каждого файла, если были совпадения.
 *   Параметры
 *   - `URI: string` URI файла
 *   - `mode: Thoroughness` режим проверки
 *   - `sins: SinsInfo[]` массив совпавших критериев
 *
 * #### Константы:
 * - `MAX_CACHE_SIZE` Максимальный размер кэша для хранения URI "чистых" файлов.
 *
 * #### Свойства:
 * - `criteria: CompiledCriteriaSpec<CriteriaType>[] | undefined` Возвращает текущие скомпилированные критерии фильтрации. Только чтение.
 *
 * #### Методы:
 * - `set_criteria(criteria: CriteriaSpec<CriteriaType>[]): Promise<void>` Устанавливает новые критерии фильтрации.
 * - `process_abort(msg): boolean` Немедленно прерывает текущий процесс проверки.
 * - `do_process(items_info: RecentItem[], thoroughness: Thoroughness = Thoroughness.lazy): Promise<void>` Запускает проверку списка.
 * - `decommission(): void` Выводит объект из эксплуатации.
 *
 * #### Ошибки:
 * - `CriteriaValidateError` - ошибка валидации при установке критериев
 * - `ProcessAbortError` - процесс был прерван вызовом `process_abort()`
 * - `DecommissionedError` - попытка использовать выведенный из эксплуатации объект
 *
 * Класс спроектирован как компонент сервиса. Он не управляет
 * списками или критериями самостоятельно, а получает их извне.
 * Результаты проверки передаются через сигнал `'matched-result'`, позволяя
 * внешнему коду реагировать на совпадения любым необходимым способом.
 *
 * ## Типичный сценарий использования
 *
 * ```typescript
 * // 1. Создание экземпляра
 * const inquisitor = new Inquisitor();
 *
 * // 2. Подписка на результаты
 * inquisitor.connect('matched-result', (obj, uri, mode, sins) => {
 *     console.log(`Файл ${uri} соответствует критериям:`, sins);
 * });
 *
 * // 3. Установка критериев
 * await inquisitor.set_criteria([
 *     { type: 'glob', pattern: '*.tmp', label: 'Временные файлы' },
 *     { type: 'glob', pattern: '~*', label: 'Резервные копии' }
 * ]);
 *
 * // 4. Запуск проверки
 * await inquisitor.do_process(filesList, Thoroughness.thorough);
 * ```
 *
 * ## Режимы проверки
 *
 * ### Thoroughness.thorough (Тщательный)
 * - Проверяет файл по всем критериям
 * - Собирает полную информацию обо всех совпадениях
 * - Обрабатывает список максимально быстро без пауз
 * - Подходит для быстрого анализа при изменении списка файлов
 *   для отображения результатов в UI
 *
 * ### Thoroughness.lazy (Ленивый)
 * - Останавливает проверку файла после первого совпадения
 * - Вставляет паузы между проверками (`PROCESS_INTERVAL` мс)
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
 * - Кэш сбрасывается при изменении критериев `set_criteria()`
 * - Файлы из кэша пропускаются при последующих проверках
 *   если критерии не менялись
 *
 * Это особенно /и только/ эффективно при частых проверках одного и того же
 * списка данных с небольшими изменениями если критерии не меняются.
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
 * Сопоставление имён файлов с шаблоном в стиле shell glob (упрощённый):
 * - `*` - любое количество любых символов
 * - `?` - один любой символ
 *
 * Для дополнительной информации смотри `GLib.PatternSpec`.
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
 * - Поддерживает прерывание длительных операций
 * */
@GObjectDecorator.Class({
    Signals: {
        /** Генерируется после проверки каждого файла, если были совпадения с критериями. */
        'matched-result': {
            param_types: [
                /** matched-result::uri:string URI файла */
                GObject.TYPE_STRING,
                /** matched-result::mode:Thoroughness режим проверки */
                GObject.TYPE_UINT,
                /** matched-result::sins:SinsInfo[] массив совпавших критериев */
                GObject.TYPE_JSOBJECT,
            ],
        },
    },
    GTypeFlags: GObject.TypeFlags.FINAL,
    GTypeName: 'Inquisitor',
})
export class Inquisitor extends GObject.Object implements Decommissionable {

    /** Максимальный размер кэша для хранения URI "чистых" файлов.
     *
     * Определяет предельное количество записей в кэше файлов, которые
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

    /** Интервал между проверками файлов в миллисекундах.
     *
     * Определяет задержку между обработкой отдельных файлов в процессе
     * проверки. Фактическая задержка зависит от выбранного режима:
     *
     * - **Thoroughness.thorough** (0): задержка = 0 * PROCESS_INTERVAL = 0 мс (всегда без пауз)
     * - **Thoroughness.lazy** (1): задержка = 1 * PROCESS_INTERVAL = PROCESS_INTERVAL мс
     *
     * Малое значение (2 мс) обеспечивает плавную работу в ленивом режиме,
     * позволяя системе обрабатывать другие задачи между проверками файлов,
     * при этом не создавая заметных задержек для пользователя.
     *
     * ## Рекомендации по изменению:
     *
     * - **1-5 мс**: оптимально для большинства случаев
     * - **10-50 мс**: для очень больших списков или слабых систем
     * - **0 мс**: только для режима thorough (быстрая обработка)
     *
     * @example
     * ```typescript
     * // Расчёт времени обработки 1000 файлов
     * const filesCount = 1000;
     * const lazyTime = filesCount * Inquisitor.PROCESS_INTERVAL; // 2000 мс
     * const thoroughTime = 0; // Без задержек
     *
     * console.log(`Ленивый режим: ~${lazyTime}мс минимум`);
     * console.log(`Быстрый режим: максимально быстро`);
     * ```
     *
     * @see {@link Thoroughness} Режимы работы
     * @see {@link do_process} Использование в процессе проверки */
    static PROCESS_INTERVAL = 2 as const;



    /** Скомпилированный набор критериев фильтрации.
     *
     * Содержит предварительно обработанные критерии для эффективной
     * проверки файлов. Критерии компилируются при вызове `set_criteria()`
     * и используются во всех последующих проверках до следующего изменения.
     *
     * - Пустой массив означает отсутствие критериев
     * - `undefined` будет означать, что объект выведен из эксплуатации (@see {@link decommission} `decommission()`)
     *
     * @see {@link set_criteria} Установка критериев
     * @see {@link criteria} Публичный геттер */
    private eligibility_criteria = [] as CompiledCriteriaSpec<CriteriaType>[];

    /** Кэш URI файлов, не соответствующих критериям.
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
     * Хранит прогресс обработки списка и
     * контроллер "текущего" Promise для возможности прерывания.
     * */
    private process_operation = {
        /** Источник таймера для интервальной обработки файлов.
         *
         * Хранит ссылку на активный интервал, созданный через `setInterval()`.
         * Используется для контроля процесса проверки и его прерывания.
         *
         * - `null` - нет активной проверки
         * - `GLib.Source` - идёт процесс проверки
         * */
        source: NO_SOURCE as SourceID,
        /** Текущий индекс для проверки */
        current_index: 0 as number,
        /** Контроллер Promise текущей операции */
        controller: {
            reject: undefined,
            resolve: undefined
        } as PromiseControllers<void>,
    };


    private criteria_operation = {
        /** Источник таймера для интервальной обработки критериев.
         *
         * Хранит ссылку на активный интервал, созданный через `setInterval()`.
         * Используется для контроля процесса проверки и его прерывания.
         *
         * - `null` - нет активной проверки
         * - `GLib.Source` - идёт процесс проверки
         * */
        source: NO_SOURCE as SourceID,
        /** Текущий индекс для проверки */
        current_index: 0 as number,
        /** Контроллер Promise текущей операции */
        controller: {
            reject: undefined,
            resolve: undefined
        } as PromiseControllers<void>,
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
    @GObjectDecorator.JSObjectProperty({
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
     * Реализации конкурентно-безопасного API в условиях среды GJS.
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
     * 3. Очищает кэш проверенных ("чистых") файлов
     * 4. Валидирует и компилирует новые критерии
     * 5. Устанавливает новые критерии (если валидация успешна)
     *
     * Нет специализированного метода для прерывания установки критериев,
     * используй `set_criteria([])`.
     *
     * @param criteria Массив критериев для установки
     *
     * @returns {Promise<void>} Promise, который разрешается после успешной
     *          установки критериев
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
    public set_criteria(criteria: CriteriaSpec<CriteriaType>[]): Promise<void> {

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
     * @param [msg='aborted'] Сообщение для `ProcessAbortError`
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
     * Проверяет каждый файл из списка на соответствие установленным критериям.
     * Для файлов с совпадениями генерирует сигнал `'matched-result'`.
     *
     * Файлы без совпадений добавляются в кэш для оптимизации повторных проверок.
     *
     * Если в момент вызова уже выполняется другая проверка, она будет прервана
     * с ошибкой `ProcessAbortError('New process will be initiated')`.
     *
     * @param items_info Список файлов для проверки
     * @param [thoroughness=Thoroughness.lazy] Режим проверки:
     *        - Thoroughness.lazy: медленная проверка с паузами, минимальная нагрузка
     *        - Thoroughness.thorough: быстрая проверка без пауз, высокая нагрузка
     *
     * @returns {Promise<void>} Promise, который разрешается после проверки всех файлов
     *
     * @throws {ProcessAbortError} Если проверка была прервана вызовом `process_abort()`
     *
     * @fires 'matched-result' Для каждого файла с совпадениями.
     *        Параметры:
     *        - `uri`: `string`,
     *        - `mode`: `Thoroughness`,
     *        - `sins`: `SinsInfo[]`
     *
     * @example
     * ```typescript
     * // Подготовка данных
     * const files = [
     *     { uri: 'file:///tmp/test.tmp', uri_display: '/tmp/test.tmp' },
     *     { uri: 'file:///home/user/doc.txt', uri_display: '/home/user/doc.txt' }
     * ];
     *
     * // Быстрая проверка с полным анализом
     * try {
     *     await inquisitor.do_process(files, Thoroughness.thorough);
     *     console.log('Проверка завершена');
     * } catch (error) {
     *     ...
     * }
     * ``` */
    public do_process(
        items_info: RecentItem[],
        thoroughness: Thoroughness = Thoroughness.lazy
    ): Promise<void> {
        // Прерываем текущую обработку, если она запущена
        this.process_abort('New process will be initiated');

        this.process_operation.current_index = 0;

        // Возвращаем Promise
        return new Promise<void>((resolve, reject) => {

            // Сохраняем контроллеры
            this.process_operation.controller.reject = reject;
            this.process_operation.controller.resolve = resolve;

            // Запускаем интервал для обработки
            // --------------------------------
            this.process_operation.source = setInterval(() => {
                // @todo Стоит весь колбек поместить в трай блок?
                // Проверяем завершение ...
                if (this.process_operation.current_index >= items_info.length) {

                    clearInterval(this.process_operation.source!);
                    this.process_operation.source = null;
                    this.process_operation.controller.resolve!();
                    return;
                }

                const current_file = items_info[this.process_operation.current_index];
                const sins = [] as SinsInfo[];

                // Проверяем, не находится ли файл уже в кэше чистых,
                // если да - пропускаем. Если нет - проверяем ...
                if (!this.trustworthy_list.has(current_file.uri)) {

                    if (current_file.uri_display && current_file.uri_display.length > 0) {
                        // Проверяем файл по критериям
                        for (const criterion of this.eligibility_criteria!) {

                            switch (criterion.type) {
                                case 'glob': {
                                    if ((criterion as CompiledCriteriaSpec<'glob'>).pattern_spec.match_string(current_file.uri_display)) {
                                        sins.push({
                                            type: criterion.type,
                                            label: (criterion as CompiledCriteriaSpec<'glob'>).label
                                        });
                                    }
                                    break;
                                }
                                default: {
                                    const _type: never = criterion.type;
                                    console.assert(false, `Неизвестный CriteriaType тип: ${_type}`);
                                    break;
                                }
                            }

                            // Для быстрого режима прерываем после первого совпадения
                            if (sins.length > 0 && thoroughness === Thoroughness.lazy) {
                                break;
                            }
                        }

                    } else {
                        // безоговорочно сообщаем о файлах без отображаемого пути
                        sins.push({
                            type: 'lint',
                            label: 'MISSING-DISPLAY-URI'
                        });
                    }

                    if (sins.length > 0) {
                        // Если есть совпадения, генерируем сигнал 'matched-result' ...
                        this.emit('matched-result', current_file.uri, thoroughness, sins);
                    } else {
                        // Если совпадений не было - добавляем в кэш чистых файлов ...
                        this.add_to_trustworthy_list(current_file.uri);
                    }
                }

                // Переходим к следующему файлу ...
                this.process_operation.current_index++;

            }, /* пауза, в зависимости от режима */ thoroughness * Inquisitor.PROCESS_INTERVAL);
        });
    }

    /** Добавляет URI в кэш "чистых" файлов (не соответствующих текущим критериям).
     *
     * Реализует FIFO-стратегию вытеснения: при достижении максимального
     * размера кэша (`MAX_CACHE_SIZE`) удаляется самая старая запись.
     *
     * @param uri URI файла для добавления в кэш
     *
     * @private
     * @example
     * ```typescript
     * // Внутреннее использование
     * if (sins.length === 0) {
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
    public decommission(): void {

        this.process_abort(`Object is being decommissioned`);

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

        this.eligibility_criteria = (undefined as unknown as typeof this.eligibility_criteria);
        this.trustworthy_list = (undefined as unknown as typeof this.trustworthy_list);
        this.process_operation = (undefined as unknown as typeof this.process_operation);
        this.criteria_operation = (undefined as unknown as typeof this.criteria_operation);
    }
}
