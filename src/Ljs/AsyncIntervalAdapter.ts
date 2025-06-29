/** @file: src/Ljs/AsyncIntervalAdapter.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 *
 *  # 1.0.0 - Первый вариант
 */

import GLib from 'gi://GLib?version=2.0';

export type ResolveWrapper<PromiseType = unknown> = (value: PromiseType | PromiseLike<PromiseType>) => void;
export type RejectWrapper = (reason: Error) => void;

/** Происходит при отмене выполняющегося процесса AsyncIntervalAdapter.
 * Выбрасывается при вызове abort() или start_new() для активного процесса.
 * Это не критическая ошибка, а часть нормальной работы API для управления жизненным циклом процессов. */
export class ProcessAbortError extends Error {
    constructor(message = 'Process was aborted', options?: ErrorOptions) {
        super(message, options);
        this.name = 'ProcessAbortError';
    }
}

/** Обертка для выполнения итеративного кода в асинхронном контексте в GJS/GTK.
 *
 * Позволяет выполнить итеративный код, разбив его на небольшие шаги
 * через setInterval. Обеспечивает Promise интерфейс с возможностью отмены.
 *
 * Будет выполнять код в интервале до тех пор пока callback не вызовет resolve/reject,
 * или процесс не будет отменен.
 *
 * Повторные запуски будут отменять предыдущий процесс.
 *
 * ### API
 *
 * #### Параметры конструктора:
 * - `callback` - функция для выполнения одной итерации, получает resolve, reject и аргументы
 * - `delay` - интервал между итерациями в миллисекундах
 *
 * #### Свойства:
 * - `is_running` - индикатор активности процесса (readonly)
 *
 * #### Методы:
 * - `start_new(...args)` - запускает новый процесс, отменяя предыдущий
 * - `abort(msg?)` - отменяет текущий процесс
 *
 * ### Ошибки:
 * - `ExternalAbortError` - выбрасывается при отмене процесса через abort() или start_new()
 *
 * ### Особенности:
 * - **Асинхронное выполнение**: выполняет множественные операции небольшими порциями
 * - **Применение для итераций**: обработка массивов, циклов, последовательных операций
 * - **Пошаговое выполнение**: каждый шаг выполняется в отдельном setInterval вызове
 * - **Контроль завершения**: callback решает когда завершить (resolve) или продолжить
 * - Автоматическая очистка GLib.Source при завершении Promise
 * - Безопасная отмена: множественные вызовы start_new() корректно отменяют предыдущие
 * - Неизменяемые данные конструктора защищены от модификации
 *
 * ### Пример использования:
 * ~~~typescript
 * // Вместо блокирующего цикла: items.forEach(item => heavy_process(item));
 * // Разбивка итераций:
 * const processor = new AsyncIntervalAdapter<void, [number[]]>((resolve, reject, items) => {
 *     const item = items.shift(); // обрабатываем один элемент за итерацию
 *
 *     try {
 *          heavy_process(item); // операция над элементом
 *      } catch (error) {
 *          // обработка ошибки
 *          reject(error); // продолжение не возможно
 *      }
 *
 *     if (items.length > 0) {
 *         return; // продолжаем следующую итерацию
 *     }
 *     resolve(); // все итерации завершены
 * }, 10); // 10мс между итерациями
 *
 * await processor.start_new([1, 2, 3, ...1000]);
 * ~~~
 *
 * @template PromiseType Тип возвращаемого Promise значения
 * @template ArgsTypesTuple Типы дополнительных аргументов для callback */
export class AsyncIntervalAdapter<PromiseType = unknown, ArgsTypesTuple extends readonly unknown[] = unknown[]> {

    private process = {

        data: {
            /** Функция для выполнения одной итерации.
             * Определяет логику каждой итерации и условие завершения.
             * Получает resolve, reject и пользовательские аргументы. */
            callback: undefined as unknown as ((resolve: ResolveWrapper<PromiseType>, reject: RejectWrapper, ...args: ArgsTypesTuple) => void),
            /** Интервал между итерациями в миллисекундах */
            delay: undefined as undefined | number,
        },

        controller: {
            /** Активный GLib.Source для управления интервалом */
            source: undefined as undefined | GLib.Source,
            /** Враппер resolve текущего процесса */
            resolve: undefined as undefined | ResolveWrapper<PromiseType>,
            /** Враппер reject текущего процесса */
            reject: undefined as undefined | RejectWrapper,
        }

    };

    /** Создает новый AsyncIntervalAdapter с заданными параметрами.
     *
     * @param callback Функция для выполнения одной итерации, получает resolve, reject и args
     * @param delay Интервал между итерациями в миллисекундах
     *
     * @affects this.process.data Замораживается после инициализации
     * @affects this.process Запечатывается после инициализации
     * */
    constructor(callback: typeof this.process.data.callback, delay: typeof this.process.data.delay) {
        this.process.data.callback = callback;
        this.process.data.delay = delay;

        Object.freeze(this.process.data);
        Object.seal(this.process);
    }

    /** Проверяет активность текущего процесса.
     *
     * @returns true если источник не уничтожен и процесс выполняется */
    get is_running(): boolean {
        return this.process.controller.source !== undefined && !this.process.controller.source.is_destroyed();
    }

    /** Запускает новый процесс, отменяя предыдущий если он выполняется.
     *
     * При завершении автоматически очищает ресурсы.
     *
     * @param args Аргументы для передачи в callback
     * @returns Promise который завершится когда callback вызовет resolve/reject
     *          или будет вызван abort() или повторный start_new()
     *
     * @affects Вызывает abort('New process will be started') для отмены предыдущего процесса
     * @affects this.process.controller Обновляет source, resolve, reject для нового процесса
     *
     * @throws ExternalAbortError если процесс был отменен другим start_new() или abort() */
    start_new(...args: ArgsTypesTuple): Promise<PromiseType> {

        this.abort('New process will be started');

        return new Promise<PromiseType>((resolve, reject) => {

            // Обертки для автоматической очистки при завершении
            this.process.controller.resolve = Object.freeze((value: PromiseType | PromiseLike<PromiseType>) => {
                this.cleanup_current_process();
                resolve(value);
            });
            this.process.controller.reject = Object.freeze((reason: Error) => {
                this.cleanup_current_process();
                reject(reason);
            });

            // Создание и запуск нового интервала
            this.process.controller.source = setInterval(
                this.process.data.callback,
                this.process.data.delay,
                this.process.controller.resolve,
                this.process.controller.reject,
                ...args
            );
        });
    }

    /** Отменяет текущий выполняющийся процесс.
     *
     * Если процесс выполняется, отклоняет текущий промис с ExternalAbortError
     * и очищает интервал через вызов обертки this.process.controller.reject().
     *
     * @param msg Дополнительное сообщение для ExternalAbortError */
    abort(msg?: string): void {
        if (this.is_running) {
            this.process.controller.reject!(new ProcessAbortError(msg));
        }
    }

    /** Очищает ресурсы текущего процесса.
     * Останавливает setInterval источник и сбрасывает controller состояние.
     *
     * @affects this.process.controller.source Очищается через clearInterval и устанавливается в undefined
     * @affects this.process.controller.resolve Устанавливается в undefined
     * @affects this.process.controller.reject Устанавливается в undefined */
    private cleanup_current_process(): void {
        if (this.is_running) {
            clearInterval(this.process.controller.source!);
            this.process.controller.source = undefined;
            this.process.controller.resolve = undefined;
            this.process.controller.reject = undefined;
        }
    }
}
