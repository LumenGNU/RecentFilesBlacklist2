/** @file: src/Ljs/Decommissionable.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 2.0.1 */
/**
 *  @changelog
 *
 * # 2.0.1 - Константа `DECOMMISSIONED`
 *
 * # 2.0.0 - Переработан
 *
 */

import GObject from 'gi://GObject?version=2.0';

import {
    NO_HANDLER,
    HandlerID
} from '../shared/common-types.js';

export const DECOMMISSIONED = false as const;

/** Тип для метода decommission: либо функция деактивации, либо false (уже выведен из эксплуатации).
 *
 * Этот подход позволяет проверять возможность деактивации:
 * - `function` - объект активен, можно вызвать `decommission()`
 * - `false` - объект уже выведен из эксплуатации, вызов невозможен */
export type DecommissionType = (() => void) | typeof DECOMMISSIONED;

/** Интерфейс для объектов, поддерживающих освобождение ресурсов.
 * aka "Пенсионная Служба"
 *
 * ## Философия
 *
 * - "Выведен из эксплуатации" - еще живой, но отстранен от дел.
 * - "Чистота - залог здоровья".
 * - "Уходишь - приберись за собою!".
 *
 * После вызова `decommission()` объект становится неработоспособным.
 * Любые попытки использовать его методы должны (и будут) выбрасывать `DecommissionedError`.
 * Унаследованная GObject инфраструктура остается рабочей.
 * Это помогает выявлять ошибки в lifecycle management на раннем этапе.
 *
 * ### Особенности контекста
 *
 * GNOME Shell extensions работают в среде GJS, которая имеет свои особенности:
 *
 * - Системный уровень: Ошибки в коде могут привести к краху всего рабочего стола пользователя.
 * - Управление памятью: Необходима тщательная очистка ресурсов (например, GObject) для предотвращения утечек.
 * - Обработчики сигналов: Их нужно корректно отключать, чтобы избежать проблем с памятью.
 * - Отличия от стандартного JS: Обычные практики JavaScript не всегда применимы из-за специфики GJS и GTK.
 * - Fail-fast поведение: Желательно быстро выявлять ошибки в управлении жизненным циклом объектов.
 *
 * Задача паттерна `Decommissionable` — обеспечить безопасное управление объектами, предотвращая использование
 * объектов после их деактивации, что может привести к трудно диагностируемым ошибкам.
 *
 * #### Описание паттернов
 *
 * 1. Паттерн DecommissionType = (() => void) | false
 *
 *    Этот подход реализован через интерфейс IDecommissionable, где:
 *      - Поле decommission может быть:
 *          - Функцией () => void, выполняющей деактивацию объекта.
 *          - Значением false, указывающим, что объект уже деактивирован
 *            и его бизнес логика уже не доступна.
 *      - После вызова `decommission()`:
 *          - Объект освобождает ресурсы (например, отключает сигналы).
 *          - Все методы объекта начинают выбрасывать `DecommissionedError`.
 *          - Поле `decommission` устанавливается в `false`.
 *          - Унаследованные GObject методы и свойства по прежнему доступны.
 *
 * Пример реализации:
 * ~~~typescript
 * export class MyClass implements IDecommissionable {
 *     private my_obj: { widget: Gtk.Widget; handlers: HandlerID[] = [] };
 *
 *     constructor() {
 *         this.my_obj.handlers.push(
 *             this.my_obj.widget.connect('signal1', this.handler.bind(this)),
 *             this.my_obj.widget.connect('signal2', this.handler.bind(this))
 *         );
 *     }
 *
 *     public decommission: DecommissionType = () => {
 *         decommission_signals(this.my_obj.widget, ...this.my_obj.handlers);
 *
 *         const throw_error = function() { throw new DecommissionedError(); };
 *
 *         this.someMethod = throw_error as typeof this.someMethod;
 *         ... другие методы ...
 *
 *         this.decommission = false;
 *     };
 *
 *     someMethod() {  ...  }
 * }
 * ~~~
 *
 * Использование:
 * ~~~typescript
 * const obj = new MyClass();
 * if (obj.decommission) {
 *     obj.decommission(); // Безопасно деактивируем объект
 * }
 * obj.someMethod(); // Выбросит DecommissionedError
 * ~~~
 *
 * #### Важно:
 *
 * - Объект никогда не увольняет сам себя!
 * - Только кто-то снаружи имеет право уволить объект!
 *
 * ### Подход с `is_decommissioned: boolean`
 *
 * В этом случае используется простой флаг, показывающий, деактивирован объект или нет:
 *
 * - `is_decommissioned = false` — объект активен.
 * - `is_decommissioned = true` — объект деактивирован.
 *
 * Использование:
 * ~~~typescript
 * const obj = new MyClass();
 * obj.decommission();
 * obj.someMethod(); // Выбросит ошибку, если метод проверяет флаг
 * ~~~
 *
 * ## Сравнительный анализ
 *
 * **Преимущества DecommissionType**
 *
 * Ясная семантика:
 * - Условие if (obj.decommission) означает "если объект можно деактивировать", что интуитивно понятно.
 * - После деактивации decommission === false, что исключает повторный вызов.
 *
 * Безопасность:
 * - Автоматически предотвращает повторную деактивацию.
 * - Методы объекта "ломаются" после деактивации, выбрасывая `DecommissionedError`.
 *
 * Fail-fast поведение:
 * - Любая попытка использовать объект после деактивации сразу вызывает исключение, что упрощает отладку.
 *
 * Строгая модель:
 * - Обеспечивает явный механизм деактивации через функцию, а не просто флаг состояния.
 *
 * **Недостатки DecommissionType**
 *
 * Сложность реализации:
 * - Требует больше кода (например, переопределение методов для выброса ошибок).
 * - Нужно вручную устанавливать `decommission = false` после очистки.
 *
 * Дополнительная дисциплина:
 * - Разработчик должен следить за корректной реализацией функции деактивации.
 *
 * **Преимущества is_decommissioned**
 *
 * Простота:
 * - Легче реализовать и понять.
 * - Не требует сложной логики с типами или переопределением методов.
 *
 * Минимализм:
 * - Подходит для простых случаев, где строгая дисциплина не обязательна.
 *
 * **Недостатки is_decommissioned**
 *
 * Меньшая безопасность:
 * - Не предотвращает повторную деактивацию автоматически.
 * - Зависит от того, проверяет ли каждый метод состояние флага.
 *
 * Отсутствие явного механизма:
 * - Флаг лишь указывает состояние, но не выполняет очистку сам по себе.
 *
 * Слабое fail-fast поведение:
 * - Если забыть проверить флаг в методе, ошибки могут проявиться позже и быть сложнее для диагностики.
 *
 * Таким образом, несмотря на большую сложность реализации, DecommissionType
 * оправдывает себя в условиях системного программирования, где надежность
 * и безопасность имеют приоритет над простотой.
 *
 * @example
 * ~~~typescript
 * // Асинхронный cleanup после decommission
 * if (!my_widget.decommission) {
 *     // Объект "на пенсии", но GObject методы работают
 *     my_widget.remove(child);  // ✅ GTK cleanup
 *     window.remove(my_widget); // ✅ Финальная уборка
 * }
 * ~~~
 * */
export interface IDecommissionable {

    /** Освобождает ресурсы, связанные с объектом.
     *
     * После вызова этого метода объект становится неработоспособным,
     * все его методы должны выбрасывать `DecommissionedError`.
     *
     * @warn Границы ответственности:
     *       - отключаем только свою бизнес-логику
     *       - Таймеры, обработчики, кастомные сигналы
     *       - GObject методы - НЕ ТРОГАЕМ! Система GJS должна правильно выполнить утилизацию
     *       - GTK infrastructure методы - НЕ ТРОГАЕМ!
     *
     * @note Семантика проверки: `if (object.decommission)` означает "если можно деактивировать объект"
     *
     * @affects Все методы объекта будут выбрасывать `DecommissionedError`
     * @affects decommission Станет (обязан стать) `false` после выполнения
     * @affects Делает объект, которым  уже нельзя пользоваться, таким, что им НЕВОЗМОЖНО пользоваться */
    decommission: DecommissionType;
}

/** Исключение, выбрасываемое при попытке использовать объект после
 * его вывода из эксплуатации.
 *
 * Это исключение указывает на ошибку в архитектуре приложения:
 * код пытается использовать уже деактивированный объект. */
export class DecommissionedError extends Error {
    constructor(message = 'Object has been decommissioned, further use is not possible') {
        super(message);
    }
}

/** Безопасно отключает обработчики сигналов от объекта GObject.
 *
 * Функция проверяет, подключен ли сигнал перед отключением,
 * что предотвращает ошибки при попытке отключить несуществующий обработчик.
 * Полезен в методах `decommission` для очистки подключений.
 *
 * @param gobject Объект GObject, от которого нужно отключить сигналы
 * @param handlers_ids Массив ID обработчиков сигналов для отключения
 *
 * @example
 * ~~~typescript
 * export class MyWidget implements IDecommissionable {
 *
 *     private my_obj {
 *         widget: Gtk.Widget;
 *         handlers: HandlerID[] = [];
 *     };
 *
 *     constructor() {
 *         ...
 *         // Подключаем сигналы
 *         this.my_obj.handlers.push(
 *             this.my_obj.widget.connect('signal1', this.handler.bind(this)),
 *             this.my_obj.widget.connect('signal2', this.handler.bind(this)),
 *             ...
 *         );
 *     }
 *
 *     public decommission: DecommissionType = () => {
 *
 *         // Безопасно отключаем все сигналы
 *         decommission_signals(this.my_obj.widget, ...this.my_obj.handlers);
 *
 *         // Остальная логика деактивации...
 *         this.decommission = false;
 *     };
 * }
 * ~~~ */
export function decommission_signals(gobject: GObject.Object, ...handlers_ids: HandlerID[]): void;
export function decommission_signals(gobject: GObject.Object, handlers_ids: HandlerID[]): void;
export function decommission_signals(gobject: GObject.Object, handlers_id: HandlerID | HandlerID[], ...handlers_ids: HandlerID[]): void {
    if (Array.isArray(handlers_id)) {
        handlers_ids = handlers_id;
    } else {
        handlers_ids.unshift(handlers_id);
    }

    for (const handler_id of handlers_ids) {
        if (handler_id > NO_HANDLER) {
            if (GObject.signal_handler_is_connected(gobject, handler_id)) {
                gobject.disconnect(handler_id);
            }
        }
    }
}