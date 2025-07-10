/** @file: src/Ljs/DelayedSignal.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version:  2.3.0 */
/**
 * @changelog
 *
 * # 2.3.0 - imports.signals.addSignalMethods вместо
 *           наследования от GObject
 *
 * # 2.2.0 - Добавлен SignalsInterface, типизация сигналов
 *
 * # 2.1.0 - Добавлено свойство `debounce_delay`
 *         - рефакторинг
 *
 * # 2.0.1 - Проходит тесты
 *
 * # 2.0 - Переработан и упрощен
 *
 *  */

import GLib from 'gi://GLib?version=2.0';

import {
    IDecommissionable,
    DecommissionType,
    DECOMMISSIONED,
    DecommissionedError
} from './Decommissionable.js';

import {
    register_signals_for_prototype,
    ISignals
} from './ISignals.js';

export {
    SignalPropagate
} from './ISignals.js';

interface DelayedSignalSignatures {
    /** Сигнал, эмитируемый при первом планировании отложенной эмиссии.
     * При перепланировании (сброс уже активного таймера) этот сигнал НЕ эмиттируется.
     *
     * Т.е. он всегда перед сигналом 'occurred', если тот еще не выбрасывался,
     * или если после последнего выброса 'occurred' прошло больше `debounce_interval`,
     * и планируется новый выброс 'occurred'.
     *
     * @param source - Экземпляр DelayedSignal, который эмиттировал сигнал */
    'scheduled': () => boolean;

    /** Сигнал, эмитируемый когда срабатывает таймер (по истечении `debounce_interval`)
     * или при немедленной эмиссии через invoke()/flush().
     *
     * @param source - Экземпляр DelayedSignal, который эмиттировал сигнал */
    'occurred': () => boolean;

    /** Сигнал, эмитируемый при отмене запланированной эмиссии.
     *
     * @param source - Экземпляр DelayedSignal, который эмиттировал сигнал */
    'canceled': () => boolean;

}

//type SignalSignatures = DelayedSignalSignatures;

/** Класс, реализующий паттерн "debounce" на базе сигналов GObject.
 *
 * `DelayedSignal` позволяет эмиттить сигналы с задержкой, сбрасывая таймер при каждом
 * новом запросе, и предоставляет методы для управления этим процессом.
 *
 * ## Основные методы:
 *
 * - `pending_invoke()` - планирует отложенную эмиссию. При повторных вызовах
 *   перезапускает таймер.
 * - `invoke()` - немедленно эмиттит сигнал, очищая таймер.
 * - `flush()` - эмиттит сигнал только если таймер активен, затем очищает его.
 * - `cancel()` - отменяет таймер и эмиттит сигнал отмены.
 *
 * ## Сигналы:
 *
 * - **'scheduled'** - эмиттируется при *первом* планировании
 *   таймера. При перепланировании (сброс таймера) этот сигнал НЕ эмиттируется.
 *
 * - **'occurred'** - эмиттируется когда таймер срабатывает
 *   (по истечении времени или через `invoke`/`flush`).
 *
 * - **'canceled'** - эмиттируется при отмене таймера через `cancel()`
 *
 * ## Примеры использования:
 *
 * @example
 * ~~~typescript
 * // Базовое использование
 * const delayed_signal = new DelayedSignal(300);
 *
 * delayed_signal.connect('scheduled', () => {
 *     console.log('Действие запланировано');
 * });
 *
 * delayed_signal.connect('occurred', () => {
 *     console.log('Действие выполнено');
 *     perform_action();
 * });
 *
 * // Множественные вызовы сбрасывают таймер
 * delayed_signal.pending_invoke(); // → 'scheduled'
 * delayed_signal.pending_invoke(); // только сброс таймера
 * delayed_signal.pending_invoke(); // только сброс таймера
 * // через 300мс → 'occurred'
 * ~~~
 */
export class DelayedSignal implements IDecommissionable {


    static {
        // Применить сигнальный интерфейс к прототипу
        register_signals_for_prototype(DelayedSignal);
    }

    // #region SignalsInterface
    declare emit: ISignals<DelayedSignalSignatures>['emit'];
    declare connect: ISignals<DelayedSignalSignatures>['connect'];
    declare disconnect: ISignals<DelayedSignalSignatures>['disconnect'];
    declare disconnectAll: ISignals<DelayedSignalSignatures>['disconnectAll'];
    declare signalHandlerIsConnected: ISignals<DelayedSignalSignatures>['signalHandlerIsConnected'];
    // #endregion

    /** Активный таймер. */
    private timer: GLib.Source | null = null;

    /** Задержка в миллисекундах */
    private delay: number;

    /** Создает новый объект-эмиттер с механизмом debounce.
     *
     * @param delay Задержка в миллисекундах. Должно быть положительным целым числом.
     *
     * @throws {TypeError} Если debounce_interval не является положительным целым числом */
    constructor(delay: number) {

        delay = Number(delay);
        if (!Number.isInteger(delay) || delay <= 0) {
            throw new TypeError('DelayedSignal: Interval must be a positive integer');
        }

        this.delay = delay;
    }

    public get debounce_delay(): number {
        if (this.delay === undefined) {
            throw new DecommissionedError();
        }
        return this.delay;
    }

    /** Проверить, запланирована ли отложенная эмиссия.
     *
     * @returns true если таймер активен, false если нет */
    public is_pending(): boolean {
        return this.timer !== null;
    }

    /** Запланировать отложенную эмиссию сигнала.
     *
     * Если таймер уже активен, он будет сброшен и запланирован заново.
     * Сигнал 'scheduled' эмиттируется только при первом планировании, не при перепланировании.
     *
     * @fires DelayedSignal#scheduled Только при первом планировании (таймер неактивен)
     * @fires DelayedSignal#occurred После истечения debounce_interval
     *
     * @example
     * ~~~
     * // Базовое использование
     * const delayed_signal = new DelayedSignal(300);
     *
     * delayed_signal.connect('scheduled', () => {
     *     console.log('Действие запланировано');
     * });
     *
     * delayed_signal.connect('occurred', () => {
     *     console.log('Действие выполнено');
     *     perform_action();
     * });
     *
     * // Множественные вызовы сбрасывают таймер
     * delayed_signal.pending_invoke(); // → 'scheduled'
     * delayed_signal.pending_invoke(); // только сброс таймера
     * delayed_signal.pending_invoke(); // только сброс таймера
     * // через 300мс → 'occurred'
     * ~~~ */
    pending_invoke(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        } else {
            this.emit('scheduled');
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.emit('occurred');
        }, this.delay);
    }

    /** Немедленно эмиттить сигнал, независимо от состояния таймера.
     *
     * Если был запланирован таймер, он будет очищен.
     *
     * @fires DelayedSignal#occurred Немедленно после вызова
     *
     * @example
     * ~~~
    * // Немедленное выполнение
    * delayed_signal.pending_invoke(); // запланировали
    * delayed_signal.invoke();         // → 'occurred' сразу
     * ~~~ */
    public invoke(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.emit('occurred');
    }

    /** Немедленно эмиттит сигнал, если таймер был запланирован, и очистить его.
     *
     * Ничего не делает, если таймер не активен.
     *
     * @fires DelayedSignal#occurred Только если таймер был активен
     *
     * @example
     * ~~~
     * // Выполнить только если было запланировано
     * delayed_signal.pending_invoke();
     * // ...
     * delayed_signal.flush(); // → 'occurred'
     * delayed_signal.flush(); // ничего не происходит
     * ~~~ */
    public flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.emit('occurred');
        }
    }

    /** Отменить запланированную эмиссию и эмиттить сигнал отмены.
     * Если таймер был запланирован, код не получит сигнал 'occurred'
     *
     * Ничего не делает если таймер не был запущен.
     *
     * @fires DelayedSignal#'canceled' Только если таймер был активен
     *
     * @example
     * ~~~typescript
     * delayed_signal.pending_invoke(); // запланировали
     * delayed_signal.cancel();         // → 'canceled', таймер отменен
     * // сигнал 'occurred' НЕ будет эмиттирован
     * ~~~ */
    public cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
            this.emit('canceled');
        }
    }

    public decommission: DecommissionType = () => {

        // Останавливаем таймер
        this.cancel();

        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.emit = throw_decommissioned as never;
        this.connect = throw_decommissioned as never;
        this.is_pending = throw_decommissioned as never;
        this.pending_invoke = throw_decommissioned as never;
        this.invoke = throw_decommissioned as never;
        this.flush = throw_decommissioned as never;
        this.cancel = throw_decommissioned as never;

        this.timer = undefined as never;
        this.delay = undefined as never;

        this.decommission = DECOMMISSIONED;
    };
}
