/** @file: src/Ljs/IGSignals.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 *
 * # 1.0.0 - Первый вариант
 */

import type GObject from 'gi://GObject?version=2.0';

/** Generic интерфейс для type-safe типизации GObject сигналов.
 *
 * Переопределяет типы методов emit, connect, connect_after существующего GObject класса,
 * ограничивая их работу только с сигналами, объявленными в типе S.
 * Позволяет получить автокомплит названий сигналов и типизацию их параметров.
 *
 * @template T Тип GObject класса, для которого типизируются сигналы
 * @template S Record типов сигналов: ключ - название сигнала, значение - сигнатура функции
 *
 * @example
 * ```typescript
 * interface MySignals {
 *     'my-signal': (value: string) => void;
 * }
 * type AllSignals = MySignals & Gtk.Widget.SignalSignatures;
 *
 * class MyWidget extends Gtk.Widget implements IGSignals<MyWidget, AllSignals> {
 *     declare emit: IGSignals<MyWidget, AllSignals>['emit'];
 *     declare connect: IGSignals<MyWidget, AllSignals>['connect'];
 *     declare connect_after: IGSignals<MyWidget, AllSignals>['connect_after'];
 * }
 * ``` */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IGSignals<T, S extends Record<keyof S, (...args: any[]) => any>> {
    emit<K extends keyof S>(signal: K, ...args: Parameters<S[K]>): ReturnType<S[K]>;
    connect<K extends keyof S>(signal: K, callback: GObject.SignalCallback<T, S[K]>): number;
    connect_after<K extends keyof S>(signal: K, callback: GObject.SignalCallback<T, S[K]>): number;
}
