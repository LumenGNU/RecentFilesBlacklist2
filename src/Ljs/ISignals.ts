/** @file: src/Ljs/ISignals.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 *
 * # 1.0.0 - Первый вариант
 */

import type GObject from 'gi://GObject?version=2.0';

type SignalNames<T> = {
    [K in keyof T]: T[K] extends (...args: unknown[]) => boolean ? K : never;
}[keyof T];

/** ISignals - Типизированная система сигналов
 *
 * Модуль ISignals предоставляет типизированную обертку над {@link https://gjs-docs.gnome.org/gjs/signals.md imports.signals}
 * для использования сигнальной системы в нативных TypeScript классах.
 *
 * ## Основные компоненты
 *
 * `ISignals<S>` - интерфейс типизированных сигналов
 *                 Описывает методы для работы с сигналами, которые добавляются
 *                 через `imports.signals.addSignalMethods()`.
 *                 Типовые параметры:
 *                 - `S` - объект с описанием сигналов класса, где ключи - имена сигналов,
 *                 а значения - типы callback функций
 *
 * `register_signals_for_prototype()` - регистрация сигналов для прототипа класса.
 *                                      Утилитарная функция для добавления сигнальных методов к прототипу класса.
 *
 * SignalPropagate - управление распространением сигнала
 *                   Позволяет остановить испускание сигнала, если callback вернет SignalPropagate.STOP.
 *                   Просто константы, которые проще помнить.
 *                   Константы для контроля эмиссии сигналов:
 *                   `CONTINUE`: `false` - продолжить вызов остальных обработчиков
 *                   `STOP`: `true` - остановить эмиссию, не вызывать остальные обработчики
 *
 * ### Использование
 *
 * Шаг 1: Определить сигналы класса
 * ~~~typescript
 * // Первым параметром в функцию обработчик всегда передается globalThis,
 * // его не нужно здесь указывать, он будет подставлен в сигнатуру автоматически
 * interface MyClassSignals {
 *    'started': () => boolean;
 *    'progress': (completed: number, total: number) => boolean;
 *    'finished': (result: string) => boolean;
 * }
 * ~~~
 *
 * Шаг 2: Реализовать ISignals в классе
 * ~~~typescript
 * import {
 *     ISignals,
 *     register_signals_for_prototype,
 *     SignalPropagate
 * } from './Ljs/ISignals.js';
 *
 * export class MyClass implements ISignals<MyClassSignals> {
 *
 *     static {
 *         // Вызывается один раз при определении класса. Добавляет
 *         // сигнальные методы ко всем экземплярам класса.
 *         register_signals_for_prototype(MyClass);
 *     }
 *
 *     // Типизированные методы получаем автоматически.
 *     // Нет необходимости реализовывать, достаточно только объявить типы -
 *     // методы автоматически добавляются после register_signals_for_prototype(MyClass).
 *     // Теперь IDE будет помогать
 *     declare emit: ISignals<MyClassSignals>['emit'];
 *     declare connect: ISignals<MyClassSignals>['connect'];
 *     declare disconnect: ISignals<MyClassSignals>['disconnect'];
 *     declare disconnectAll: ISignals<MyClassSignals>['disconnectAll'];
 *     declare signalHandlerIsConnected: ISignals<MyClassSignals>['signalHandlerIsConnected'];
 *
 *     start_work() {
 *         this.emit('started');
 *
 *         // Работа с прогрессом
 *         for (let i = 0; i <= 100; i += 10) {
 *             this.emit('progress', i, 100);
 *         }
 *
 *         this.emit('finished', 'success');
 *     }
 * }
 * ~~~
 *
 * Шаг 3: Подключить обработчики
 *
 * ~~~typescript
 * const worker = new MyClass();
 *
 * // Автодополнение знает что 'started' не принимает параметров
 * worker.connect('started', () => {
 *     console.log('Работа началась');
 *     return SignalPropagate.CONTINUE;
 * });
 *
 * // Автодополнение знает типы параметров для 'progress'
 * worker.connect('progress', (global, completed: number, total: number) => {
 *     console.log(`Прогресс: ${completed}/${total}`);
 *
 *     if (completed >= 50) {
 *         // Остановить сигнал здесь, другие обработчики не будут вызваны
 *         return SignalPropagate.STOP;
 *     }
 *
 *     return SignalPropagate.CONTINUE;
 * });
 *
 * worker.connect('finished', (global, result: string) => {
 *     console.log(`Завершено с результатом: ${result}`);
 *     return SignalPropagate.CONTINUE;
 * });
 *
 * worker.start_work();
 * ~~~
 *
 * ## Особенности
 *
 * ### Типизация
 * - Автодополнение: IDE автоматически предлагает правильные имена сигналов
 * - Проверка типов: TypeScript проверяет соответствие аргументов при emit() и connect()
 * - Безопасность: Невозможно подключиться к несуществующему сигналу
 *
 * ### Совместимость с imports.signals
 * - SignalCallback: Первый параметр всегда globalThis (особенность imports.signals)
 * - Возвращаемое значение: true останавливает эмиссию, false продолжает
 * - Идентификаторы: connect() возвращает числовой ID для disconnect()
 *
 * ## Управление жизненным циклом (надуманный пример)
 *
 * ~~~typescript
 * class MyWidget implements ISignals<MyWidgetSignals> {
 *     private external_signal_ids: number[] = [];
 *
 *     constructor() {
 *         // Подключаемся к ВНЕШНИМ объектам
 *         this.external_signal_ids.push(
 *             some_external_object.connect('changed', this.on_external_changed.bind(this))
 *         );
 *     }
 *
 *     destroy() {
 *         // Отключаем обработчики от ВНЕШНИХ объектов
 *         this.external_signal_ids.forEach(id =>
 *             some_external_object.disconnect(id)
 *         );
 *         this.external_signal_ids = [];
 *
 *         // Отключаем все обработчики подключенные К ЭТОМУ объекту
 *         this.disconnectAll();
 *     }
 *
 *     private on_external_changed() {
 *         // Реагируем на изменения во внешнем объекте
 *         this.emit('data-updated');
 *         return SignalPropagate.CONTINUE;
 *     }
 * }
 * ~~~
 *
 * ## Когда использовать:
 *
 * Когда нужен контроль и проверки над сигналами, но нет повода наследовать GObject.Object.
 *
 * */
export interface ISignals<S extends Record<keyof S, (...args: unknown[]) => boolean>> {
    /** Выдает сигнал для объекта.
     * Выдача сигнала прекращается, если обработчик сигнала возвращает значение true. @see {@link SignalPropagate}.
     * @param signal Имя сигнала
     * @param args Аргументы сигнала */
    emit: <K extends SignalNames<S>>(signal: K, ...args: Parameters<S[K]>) => void;
    /** Подключает обратный вызов к сигналу по имени. Передайте возвращенный ID в disconnect(), чтобы удалить обработчик.
     * Если callback возвращает true, эмиссия прекращается и другие обработчики не вызываются.
     * Предупреждение: в отличие от сигналов GObject, этот сигнал в обратном вызове всегда будет ссылаться на глобальный объект (т. е. globalThis). */
    connect: <K extends SignalNames<S>>(signal: K, callback: GObject.SignalCallback<typeof globalThis, S[K]>) => number;
    /** Отключает обработчик сигнала.
     * @param handlerId Идентификатор обработчика, который необходимо отключить */
    disconnect: (handlerId: number) => void;
    /** Отключает все обработчики сигнала. */
    disconnectAll: () => void;
    /** Проверяет, подключен ли идентификатор обработчика.
     * @param handlerId Идентификатор обработчика, который необходимо проверить
     * @returns  true, если подключен, или false, если нет */
    signalHandlerIsConnected: (handlerId: number) => boolean;
}

/** Регистрация сигналов для прототипа.
 * @see {@link ISignals}
 * @param cls Класс реализующий ISignals */
export const register_signals_for_prototype = function <
    S extends Record<keyof S, (...args: unknown[]) => boolean>,
    T extends ISignals<S>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
>(cls: new (...args: any[]) => T) {
    imports.signals.addSignalMethods(cls.prototype);
};

/** Управление распространением сигналов */
export const SignalPropagate = {
    /** Продолжить эмиссию */
    CONTINUE: false,
    /** Остановить эмиссию */
    STOP: true
};