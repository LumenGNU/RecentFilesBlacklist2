/** @file: src/service/Inquisitor.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 * # 1.0.0 - Стабильная версия
 */

import GObject from 'gi://GObject?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { Decommissionable, DecommissionedError } from '../shared/Decommissionable.interface.js';
import { GObjectDecorator } from '../shared/gobject-decorators.js';

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

/** Информация о файле для проверки.
 *
 * Содержит URI файла и его отображаемую версию. */
export interface ItemsInfo {
    /** URI файла */
    uri: string,
    /** Отображаемый путь файла для пользователя.
     * Может быть null для некорректных записей */
    uri_display: string | null,
};

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
export class ProcessAbortError extends Error { }

/** Ошибка отсутствия критериев фильтрации.
 *
 * Выбрасывается при попытке запустить проверку файлов методом `do_process()`
 * без предварительной установки критериев через `set_criteria()`.
 *
 * Эта ошибка указывает на неправильный порядок инициализации или на то,
 * что критерии были сброшены но не установлены заново.
 *
 * @extends {Error}
 *
 * @example
 * ```typescript
 * const inquisitor = new Inquisitor();
 *
 * // Попытка проверки без критериев
 * try {
 *     await inquisitor.do_process(files); // Выбросит EmptyCriteriaError
 * } catch (error) {
 *     if (error instanceof EmptyCriteriaError) {
 *         console.error('Необходимо сначала установить критерии');
 *
 *         // Устанавливаем критерии и повторяем
 *         await inquisitor.set_criteria([
 *             { type: 'glob', pattern: '*.tmp' }
 *         ]);
 *         await inquisitor.do_process(files); // Теперь работает
 *     }
 * }
 * ```
 *
 * @see {@link Inquisitor.set_criteria} Для установки критериев
 * @see {@link Inquisitor.criteria} Для проверки текущих критериев */
export class EmptyCriteriaError extends Error { }

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
export class CriteriaValidateError extends Error { }

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
 * - Вставляет паузы между проверками файлов (`PROCESS_INTERVAL` мс)
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
 * - Кэш сбрасывается при изменении критериев через `set_criteria()`
 * - Файлы из кэша пропускаются при последующих проверках
 *   если критерии не менялись
 *
 * Это особенно эффективно при частых проверках одного и того же
 * списка данных с небольшими изменениями если критерии не меняются.
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
 * ## Обработка ошибок
 *
 * - `EmptyCriteriaError` - попытка запустить проверку без критериев
 * - `CriteriaValidateError` - ошибка валидации при установке критериев
 * - `ProcessAbortError` - процесс был прерван вызовом `process_abort()`
 * - `DecommissionedError` - попытка использовать выведенный из эксплуатации объект
 *
 * ## Производительность
 *
 * - Использует скомпилированные `GLib.PatternSpec` для быстрого сопоставления
 * - Кэширует результаты для избежания повторных проверок
 * - В ленивом режиме распределяет нагрузку по времени
 * - Поддерживает прерывание длительных операций
 *
 * ## Сигналы
 *
 * ### `'matched-result'`
 * Генерируется для каждого файла, соответствующего хотя бы одному критерию.
 *
 * Параметры:
 * - `uri: string` - URI проверенного файла
 * - `mode: Thoroughness` - режим, в котором выполнялась проверка
 * - `sins: SinsInfo[]` - массив информации о совпавших критериях
 * */
@GObjectDecorator.Class({
    Signals: {
        /** Генерируется после проверки каждого файла, если были совпадения. */
        'matched-result': {
            param_types: [
                /** matched-result::uri:string - URI файла */
                GObject.TYPE_STRING,
                /** matched-result::mode:Thoroughness - режим проверки */
                GObject.TYPE_UINT,
                /** matched-result::sins:SinsInfo[] - массив совпавших критериев */
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
     * @readonly
     * @static
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

    /** Базовый интервал между проверками файлов в миллисекундах.
     *
     * Определяет задержку между обработкой отдельных файлов в процессе
     * проверки. Фактическая задержка зависит от выбранного режима:
     *
     * - **Thoroughness.thorough** (0): задержка = 0 * 2 = 0 мс (без пауз)
     * - **Thoroughness.lazy** (1): задержка = 1 * 2 = 2 мс
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
     * @readonly
     * @static
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

    /** Источник таймера для интервальной обработки файлов.
     *
     * Хранит ссылку на активный интервал, созданный через setInterval().
     * Используется для контроля процесса проверки и его прерывания.
     *
     * - `undefined` - нет активной проверки
     * - `GLib.Source` - идёт процесс проверки
     *
     * @private */
    private tribunal_source = undefined as GLib.Source | undefined;

    /** Скомпилированный набор критериев фильтрации.
     *
     * Содержит предварительно обработанные критерии для эффективной
     * проверки файлов. Критерии компилируются при вызове `set_criteria()`
     * и используются во всех последующих проверках до следующего изменения.
     *
     * - Пустой массив означает отсутствие критериев
     * - `undefined` будет означать, что объект выведен из эксплуатации (@see {@link decommission} `decommission()`)
     *
     * @private
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
     * @private
     * @see {@link add_to_trustworthy_list} Добавление в кэш */
    private trustworthy_list = new Set<string>();

    /** Состояние текущего процесса проверки.
     *
     * Хранит прогресс обработки списка и
     * функцию отклонения "текущего" Promise для возможности прерывания.
     *
     * @private
     * @property {number} current - Индекс текущего обрабатываемого файла
     * @property {Function|undefined} reject - Функция отклонения Promise из do_process() */
    private process_protocol = {
        /** Текущий индекс */
        current: 0 as number,
        reject: undefined as ((reason?: Error) => void) | undefined
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
     * @returns Массив установленных критериев или `undefined`, если критерии
     *          не установлены или список пуст
     *
     * @throws {ObjectDecommissionedError} Если объект выведен из эксплуатации
     *
     * @readonly
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
    public get criteria(): CompiledCriteriaSpec<CriteriaType>[] | undefined {

        // проверяем, не выведен ли объект из эксплуатации
        if (this.eligibility_criteria === undefined) {
            throw new DecommissionedError();
        }

        return this.eligibility_criteria.length > 0 ? this.eligibility_criteria : undefined;
    }

    /** Устанавливает новые критерии фильтрации.
     *
     * Будет выполнено:
     * 1. Прерывает текущую проверку (если выполняется)
     * 2. Сбрасывает старые критерии
     * 3. Очищает кэш проверенных ("чистых") файлов
     * 4. Валидирует и компилирует новые критерии
     * 5. Устанавливает новые критерии (если валидация успешна)
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
     * */
    public set_criteria(criteria: CriteriaSpec<CriteriaType>[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            // Останавливаем текущую проверку при изменении критериев
            this.process_abort('Stopping for criteria update');
            // Сбрасываем старые критерии
            // Даже если валидация завершится с ошибкой, старые критерии не должны использоваться
            this.eligibility_criteria = [];
            this.notify('criteria');

            // Очищаем кэш "чистых" файлов
            this.trustworthy_list.clear();

            // временный массив для скомпилированных критериев
            const _eligibility_criteria = [] as CompiledCriteriaSpec<CriteriaType>[];

            try {

                if (!Array.isArray(criteria)) {
                    throw new CriteriaValidateError('Criterion must be an Array');
                }

                // Компилируем критерии, заполняем во временный массив
                for (const criterion of criteria) {
                    if (typeof criterion !== 'object' || criterion === null) {
                        throw new CriteriaValidateError('Criterion must be an object');
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
                }
            } catch (error) {
                reject(new CriteriaValidateError('Validation error. Criteria not be compiled', { cause: error }));
            }

            // перемещаем, а не копируем:
            this.eligibility_criteria = _eligibility_criteria.splice(0, Infinity);

            if (this.eligibility_criteria.length > 0) {
                // уведомляем о смене критериев
                this.notify('criteria');
            }

            resolve();
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
        if (this.tribunal_source) {

            if (this.process_protocol.reject) {
                this.process_protocol.reject(new ProcessAbortError(msg));
                this.process_protocol.reject = undefined;
            }

            clearInterval(this.tribunal_source);
            this.tribunal_source = undefined;
            return true;
        }
        return false;
    }

    /** Запускает асинхронную проверку списка файлов.
     *
     * Проверяет каждый файл из списка на соответствие установленным критериям.
     * Для файлов с совпадениями генерирует сигнал `'matched-result'`.
     *
     * Файлы без совпадений добавляются в кэш для оптимизации повторных проверок.
     *
     * Если в момент вызова уже выполняется другая проверка, она будет прервана.
     *
     * @param items_info Список файлов для проверки
     * @param [thoroughness=Thoroughness.lazy] Режим проверки:
     *        - Thoroughness.lazy: медленная проверка с паузами, минимальная нагрузка
     *        - Thoroughness.thorough: быстрая проверка без пауз, высокая нагрузка
     *
     * @returns {Promise<void>} Promise, который разрешается после проверки всех файлов
     *
     * @throws {EmptyCriteriaError} Если критерии не установлены
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
     *     if (error instanceof EmptyCriteriaError) {
     *         console.error('Сначала установите критерии');
     *     }
     * }
     * ``` */
    public do_process(
        items_info: ItemsInfo[],
        thoroughness: Thoroughness = Thoroughness.lazy
    ): Promise<void> {
        // Прерываем текущую обработку, если она запущена
        this.process_abort('New process will be initiated');

        // Если критериев нет - нечего проверять
        if (this.eligibility_criteria.length === 0) {
            return Promise.reject(new EmptyCriteriaError(`Empty criteria`));
        }

        this.process_protocol.current = 0;

        // Возвращаем Promise
        return new Promise<void>((resolve, reject) => {

            // Сохраняем контроллеры
            this.process_protocol.reject = reject;

            // Запускаем интервал для обработки
            // --------------------------------
            this.tribunal_source = setInterval(() => {

                // Проверяем завершение ...
                if (this.process_protocol.current >= items_info.length) {

                    if (this.tribunal_source) {
                        clearInterval(this.tribunal_source);
                    }
                    this.tribunal_source = undefined;
                    this.process_protocol.reject = undefined;
                    resolve();
                    return;
                }

                const current_file = items_info[this.process_protocol.current];
                const sins = [] as SinsInfo[];

                // Проверяем, не находится ли файл уже в кэше чистых,
                // если да - пропускаем. Если нет - проверяем ...
                if (!this.trustworthy_list.has(current_file.uri)) {

                    if (current_file.uri_display && current_file.uri_display.length > 0) {
                        // Проверяем файл по критериям
                        for (const criterion of this.eligibility_criteria!) {

                            switch (criterion.type) {
                                case 'glob':
                                    if ((criterion as CompiledCriteriaSpec<'glob'>).pattern_spec.match_string(current_file.uri_display)) {
                                        sins.push({
                                            type: criterion.type,
                                            label: (criterion as CompiledCriteriaSpec<'glob'>).label
                                        });
                                    }
                                    break;
                                default:
                                    ((type: never) => {
                                        console.assert(false, `Неизвестный CriteriaType тип: ${type}`);
                                    })(criterion.type);
                                    break;
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
                this.process_protocol.current++;

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

        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.do_process = (throw_decommissioned as typeof this.do_process);
        this.process_abort = (throw_decommissioned as typeof this.process_abort);
        this.set_criteria = (throw_decommissioned as typeof this.set_criteria);

        this.eligibility_criteria = (undefined as unknown as typeof this.eligibility_criteria);
        this.trustworthy_list = (undefined as unknown as typeof this.trustworthy_list);
        this.process_protocol = (undefined as unknown as typeof this.process_protocol);
    }
}
