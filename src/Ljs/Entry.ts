/** @file: src/Ljs/Entry.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 *
 * # 1.0.0 - Первый вариант
*/

import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

import {
    HandlerID,
    NO_HANDLER
} from '../shared/common-types.js';

import {
    IDecommissionable,
    DecommissionedError,
    decommission_signals
} from './Decommissionable.js';

import {
    GObjectDecorator
} from './GObjectDecorators.js';

import {
    DelayedSignal
} from './DelayedSignal.js';

export type EntryConstructorProps = Omit<Gtk.Entry.ConstructorProps, 'truncate_multiline' | 'truncateMultiline'> & {
    debounce_delay: number;
};

/** ## Entry
 *
 * Основан на Gtk.Entry, но добавляет:
 * - Debounced сигнал 'debounced-changed' для снижения частоты обработки
 * - Фикс "broken accounting of active state" для контекстного меню
 * - Принудительный truncate_multiline для предотвращения assertion ошибок
 * - Lifecycle управление через IDecommissionable
 *
 * ### API
 *
 * #### Параметры конструктора:
 * - `debounce_delay` задержка для debounced сигнала (мс, минимум DEFAULT_TIMEOUT)
 * - все стандартные параметры Gtk.Entry (`truncate_multiline` игнорируется и всегда будет true)
 *
 * #### Сигналы:
 * - `'debounced-changed'` испускается через `debounce_delay` мс после последнего изменения текста
 *
 * #### Константы:
 * - `DEFAULT_TIMEOUT` минимальная задержка для debounced сигнала (330мс)
 *
 * #### Свойства:
 * - `truncate_multiline` всегда true, предотвращает GTK assertion ошибки
 * - `debounce_delay` используемое время задержки для debounced-сигнала `'debounced-changed'`, только для чтения
 *
 * #### Методы:
 * - `decommission()` освобождение ресурсов и отключение сигналов
 *
 * #### Статические методы:
 * - `new()` создание нового Entry
 * - `new_with_buffer()` создание Entry с указанным буфером
 * - `new_entry()` создание обычного Gtk.Entry с фиксами
 * - `new_entry_with_buffer()` создание Gtk.Entry с буфером и фиксами
 *
 * ### Ошибки:
 * - `DecommissionedError` при попытке использования после decommission()
 *
 * ### Особенности реализации:
 *
 * #### Фикс контекстного меню
 * Решает проблему "broken accounting of active state" в GTK4, после которой
 * Gtk.Entry может испытывать проблемы с контекстным меню (например, игнорирует клики мыши).
 * Использует frame clock API для корректного позиционирования и показа контекстного меню.
 *
 * #### Debounced сигналы
 * Использует `DelayedSignal` для слияния быстрых изменений текста в один
 * сигнал через заданный delay. Снижает нагрузку на обработчики при быстром
 * изменении текста.
 *
 * ### Пример использования:
 *
 * ~~~typescript
 * const entry = new Entry({ debounce_delay: 500 });
 * entry.connect('debounced-changed', () => {
 *     console.log('Текст изменился:', entry.text);
 * });
 *
 * // Или обычный Entry с фиксами
 * const regular_entry: Gtk.Entry = Entry.new_entry();
 * ~~~
 * */
@GObjectDecorator.Class({
    GTypeName: 'Ljs-Entry',
    CssName: 'entry',
    Signals: {
        'debounced-changed': {}
    },
    GTypeFlags: GObject.TypeFlags.FINAL
})
export class Entry extends Gtk.Entry implements IDecommissionable {

    /** Минимальная задержка для debounced сигнала в миллисекундах
     *
     * 330мс - как минимально полезная задержка */
    public static DEFAULT_DELAY = 330 as const;

    /** Внутреннее состояние debounced механизма */
    private debounced = {
        changes: undefined as unknown as DelayedSignal,
        handler_id: NO_HANDLER as HandlerID,
    };

    /** Создает новый Entry с расширенной функциональностью.
     *
     * @param properties параметры конструктора, `debounce_delay` задает задержку для debounced сигнала */
    constructor(properties?: Partial<EntryConstructorProps>) {

        const {
            debounce_delay,
            ...super_properties
        } = properties ?? {};

        super(super_properties);

        // Принудительно включаем truncate_multiline для предотвращения GTK assertion ошибок
        this.truncate_multiline = true;
        Entry.fix_entry_context_menu(this);

        // Настройка debounced сигнала 'debounced-changed'
        this.debounced.changes = new DelayedSignal(Math.max(debounce_delay ?? 0, Entry.DEFAULT_DELAY));
        this.debounced.handler_id = this.debounced.changes.connect('occurred', this.emit_debounced_changed.bind(this));

    }

    /** Переопределение `truncate_multiline` для предотвращения GTK assertion ошибок.
     * Всегда устанавливает значение в **true** независимо от переданного параметра.
     *
     * Предотвращает ошибку: "gtk_accessible_text_get_contents: assertion 'end >= start' failed"
     *
     * @note Следует понимать что это js-свойство, GObject-свойство `'truncate-multiline'`
     *       Gtk.Entry по прежнему доступно для изменения. */
    override set truncate_multiline(_val: boolean) {
        super.truncate_multiline = true;
        this.notify('truncate-multiline');
    }

    override get truncate_multiline(): boolean {
        return super.truncate_multiline;
    }

    /** Возвращает используемою задержку для debounced-сигнала в миллисекундах. */
    get debounce_delay(): number {
        if (this.debounced.changes === undefined) {
            throw new DecommissionedError();
        }
        return this.debounced.changes.debounce_delay;
    }

    /** Внутренний обработчик изменений текста в Entry.
     * Запускает отложенный debounced-сигнал.
     *
     * @see {@link https://gjs.guide/guides/gobject/subclassing.html#default-handler Default handler для сигнала 'changed' (GJS автоматически подключает on_* методы)}.
     *
     * @fires 'debounced-changed' (с задержкой)
     *
     * @throws DecommissionedError если объект уже деактивирован */
    private on_changed() {
        if (this.debounced.changes === undefined) {
            throw new DecommissionedError();
        }
        this.debounced.changes.pending_invoke();
    }

    /** Внутренний обработчик по умолчанию для debounced сигнала 'debounced-changed'.
     * Пустая реализация - может быть полезен для тестирования.
     *
     * @see {@link https://gjs.guide/guides/gobject/subclassing.html#default-handler Default handler для сигнала 'debounced-changed' (GJS автоматически подключает on_* методы)}. */
    private on_debounced_changed() {
        /* nothing */
    }

    /** Внутренний метод для испускания `'debounced-changed'` сигнала. */
    private emit_debounced_changed() {
        this.emit('debounced-changed');
    }

    // #region Fixes

    /** Фикс контекстного меню Entry.
     *
     * Решает проблему "broken accounting of active state" в GTK4, что
     * может приводить к проблемам с контекстным меню виджета. Проблема
     * возникает при вызове стандартного контекстного меню через правую
     * кнопку мыши.
     *
     * Решение:
     * 1. Отключает стандартную реакцию на правую кнопку мыши
     * 2. Добавляет собственный gesture controller для правой кнопки
     * 3. Вызывает menu.popup action программно
     * 4. Корректно позиционировать меню
     *
     * Сейчас используется frame clock API для выдержки правильных
     * интервалов при показе контекстного меню.
     * Frame count логика:
     * - 0 кадров: система создает и подключает меню к виджету
     * - n-1 кадр: подготовка к показу
     * - n кадр: финальное позиционирование меню
     *
     * Сейчас используется n=9 кадров.
     *
     * @param entry Entry для которого применяется фикс */
    private static fix_entry_context_menu(entry: Gtk.Entry): void {

        // Отключает реакцию на правую кнопку мыши в стандартном gesture controller
        const controllers = entry.get_delegate()!.observe_controllers();
        for (let n = 0; n < controllers.get_n_items(); n++) {
            if (controllers.get_item(n) instanceof Gtk.GestureClick) {
                if ((controllers.get_item(n) as Gtk.GestureClick).name === 'gtk-text-click-gesture') {
                    (controllers.get_item(n) as Gtk.GestureClick).set_button(1); // только левая кнопка
                    break;
                }
            }
        }

        // Добавляем собственный controller для правой кнопки мыши
        const gesture_controller = new Gtk.GestureClick();
        gesture_controller.set_button(3);
        gesture_controller.connect('pressed', (source: Gtk.GestureClick, _n_press: number, x: number, _y: number) => {
            const text_area = (source.get_widget() as Gtk.Entry).get_delegate()! as Gtk.Text;

            // Вызываем menu.popup action программно (избегаем broken state)
            // Это практически полностью исключает возникновение проблемы
            text_area.activate_action('menu.popup', null);

            // То, что происходит в этом цикле направлено на улучшение
            // UX, и от этого, впринципе, можно отказаться.
            // Задача этого кода - спозиционировать меню центрально относительно
            // курсора мыши. А после закрытия меню, вернуть его в исходное положение
            // (в начало виджета) для правильного отображения при вызове с клавиатуры.
            // Находим созданное popover меню...
            let popover = text_area.get_first_child();
            while (popover) {
                if (popover instanceof Gtk.PopoverMenu) {

                    // Frame clock workaround для корректного позиционирования
                    let frame_count = 9;
                    const tid = popover.add_tick_callback((popover: Gtk.Widget, _frame_clock: Gdk.FrameClock): boolean => {
                        if (frame_count === 9) {
                            // Скрываем меню на начальной фазе
                            // Предотвращаем графические артефакты
                            popover.set_visible(false);
                        }

                        if (frame_count === 2) {
                            // Если отдалить этот кадр от следующего то будет
                            // эффект "прыжка", что не красиво если поле ввода широкое
                            // Показываем меню
                            popover.set_visible(true);
                            // поместить это в финальный кадр - тоже не возможно:
                            // нужно дать время для правильного расчета размера,
                            // иначе ширина меню всегда будет получена как 70, что неправильно
                        }

                        if (frame_count === 1) {
                            if (popover instanceof Gtk.PopoverMenu) {

                                // Финальное позиционирование меню
                                popover.set_offset(x - (popover.get_first_child()!.get_width() / 2), 0);

                                // Сброс offset и отключение tick callback при закрытии меню
                                const hid = popover.connect('closed', (sender) => {
                                    popover.set_offset(0, 0);
                                    popover.remove_tick_callback(tid);
                                    sender.disconnect(hid);
                                });
                            }
                        }

                        return --frame_count > 0;
                    });

                    // Нашли - прерываем цикл
                    break;
                }
                popover = popover.get_next_sibling();
            }
        });

        // Подключаем controller
        // @see {@link https://docs.gtk.org/gtk4/method.Widget.remove_controller.html Widgets will remove all event controllers automatically when they are destroyed}
        entry.add_controller(gesture_controller);
    }

    // #endregion

    /** Деактивация Entry и освобождение ресурсов.
     * Отключает все сигналы и останавливает debounced механизм.
     * После вызова объект нельзя использовать. */
    public decommission(): void {
        this.debounced.changes.cancel();
        decommission_signals(this.debounced.changes, this.debounced.handler_id);

        this.debounced.changes = undefined as unknown as typeof this.debounced.changes;
    }

    // #region Фабричные методы

    /** Создает новый Entry с расширенной функциональностью.
     *
     * @returns новый экземпляр Entry */
    static override new(): Entry {
        return new Entry();
    }

    /** Создает новый Entry с указанным буфером.
     *
     * @param buffer буфер для Entry
     * @returns новый экземпляр Entry с указанным буфером */
    static override new_with_buffer(buffer: Gtk.EntryBuffer): Entry {
        return new Entry({
            buffer: buffer
        });
    }

    /** Создает обычный Gtk.Entry с применением фиксов.
     * Возвращает стандартный Gtk.Entry для API совместимости,
     * но с применением фиксов.
     *
     * @returns Gtk.Entry с примененными фиксами */
    static new_entry(): Gtk.Entry {
        const entry = Gtk.Entry.new();
        entry.truncate_multiline = true;
        Entry.fix_entry_context_menu(entry);
        return entry;

    }

    /** Создает обычный Gtk.Entry с буфером и фиксами.
    *
    * @param buffer буфер для Entry
    * @returns Gtk.Entry с буфером и примененными фиксами */
    static new_entry_with_buffer(buffer: Gtk.EntryBuffer): Gtk.Entry {
        const entry = Gtk.Entry.new_with_buffer(buffer);
        entry.truncate_multiline = true;
        Entry.fix_entry_context_menu(entry);
        return entry;
    }

    // #endregion
}
