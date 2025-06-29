/** @file: src/client/ReportListBox.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 * @changelog
 * # 1.0.0 - Первый вариант.
 * */

import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {
    IDecommissionable,
    DecommissionType,
    DECOMMISSIONED,
    DecommissionedError,
    decommission_signals
} from '../Ljs/Decommissionable.js';
import {
    NO_HANDLER,
    HandlerID,
    Report,
    ReportFields
} from '../shared/common-types.js';
import type {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ReportItem, // используется только в ссылках в комментариях
} from '../shared/common-types.js';
import {
    GDecorator
} from '../Ljs/GObjectDecorators.js';
import {
    AsyncIntervalAdapter,
    ProcessAbortError
} from '../Ljs/AsyncIntervalAdapter.js';
import type {
    ResolveWrapper,
    RejectWrapper
} from '../Ljs/AsyncIntervalAdapter.js';

/** Одноразовая инициализация CSS стилей для всех экземпляров `ReportListBox`.
 * После выполнения становится `false`, предотвращая повторную инициализацию.
 *
 * @param widget Виджет для получения display контекста
 *
 * @affects Глобальные CSS стили применяются к display
 * @affects one_time_styling Становится `false` после выполнения
 * */
let one_time_styling: ((widget: Gtk.Widget) => void) | false = (widget: Gtk.Widget) => {

    const css_provider = Gtk.CssProvider.new();
    css_provider.load_from_string(`

            report-list-box row > box {
                margin: 0px;
                padding: 0.35rem;
                font-size: 0.95rem;
            }

            report-list-box row > box:dir(ltr) {
                border-left-style: solid;
                border-left-width: 7px;
                padding-left: 6px;
            }

            report-list-box row > box:dir(rtl) {
                border-right-style: solid;
                border-right-width: 7px;
                padding-right: 6px;
            }

            report-list-box row > box {
                border-color: rgba(0, 0, 6, 0.1);
            }

            report-list-box.dark row > box {
                border-color: rgba(0, 0, 6, 0.1);
            }

            report-list-box row > box.matched {
                border-color: rgba(255, 193, 87, 0.75);
                background-color: rgba(255, 192, 87, 0.15);
            }

            report-list-box.dark row > box.matched {
                border-color: rgba(255, 193, 87, 0.65);
                background-color: rgba(255, 192, 87, 0.1);
            }

        `);

    const display = widget.get_display();
    Gtk.StyleContext.add_provider_for_display(
        display,
        css_provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    one_time_styling = false;
};

/** Расширение для Gtk.Box добавляющее свойство uri. */
interface HasUriProperty {
    uri?: string;
}

/** Сигнатуры сигналов специфичных для ReportListBox. */
interface DelayedSignalSignatures {
    'row-activated': (uri: string) => void;
}

type SignalSignatures = DelayedSignalSignatures & Adw.Bin.SignalSignatures;

/** ReportListBox - {@link Report виджет для отображения отчета}.
 *
 * Наследует от Adw.Bin.
 *
 * Отображает список с выделением элементов имеющие не пустой {@link ReportItem список критериев фильтрации}
 *  ("sins").
 *
 * - Использует темную тему, если имеет CSS-класс `dark`.
 * - Активация строк по клику.
 *
 * ### API
 *
 * #### Сигналы и уведомления:
 * - `row-activated'(uri: string) Испускается при клике на строку списка
 *
 * #### Методы:
 * - `present_report(report: Report)` Отображает переданный отчет
 * - `clear()` Очищает список (показывает placeholder)
 * - `decommission()` Деактивирует виджет и освобождает ресурсы
 *
 * ### Ошибки:
 * - `DecommissionedError` При попытке использования после деактивации
 *
 * ### CSS узлы:
 *
 * ~~~
 * report-list-box[.dark]
 * └── list.data-table
 *     ├── row
 *     │   └── box[.matched]
 *     │       ├──label.monospace
 *     │       └──label.caption.monospace /может отсутствовать, присутствует только в box.matched/
 *     ├── row
 *     └── ...
 *
 * ~~~
 *
 * */
@GDecorator.Class({
    CssName: 'report-list-box',
    Signals: {
        /** Испускается при клике на строку */
        'row-activated': {
            param_types: [
                GObject.TYPE_STRING // uri
            ]
        }
    }
})
export class ReportListBox extends Adw.Bin implements IDecommissionable {

    // #region SignalsInterface
    // ------------------------

    override emit<K extends keyof SignalSignatures>(signal: K, ...args: Parameters<SignalSignatures[K]>): ReturnType<SignalSignatures[K]> {
        return super.emit(signal, ...args) as ReturnType<SignalSignatures[K]>;
    }

    override connect<K extends keyof SignalSignatures>(signal: K, callback: GObject.SignalCallback<this, SignalSignatures[K]>): number {
        return super.connect(signal, callback);
    }

    override connect_after<K extends keyof SignalSignatures>(signal: K, callback: GObject.SignalCallback<this, SignalSignatures[K]>): number {
        return super.connect_after(signal, callback);
    }

    // #endregion

    static RENDER_BATCH_SIZE = 50;

    private list_box = {
        widget: undefined as unknown as Gtk.ListBox,
        activate_row_hid: NO_HANDLER as HandlerID
    };

    private placeholder: Adw.StatusPage;

    batch_renderer!: AsyncIntervalAdapter<void, [Report]>;


    /** Создает и инициализирует виджет ReportListBox.
     * Настраивает внутренний ListBox, placeholder, стили и обработчики событий.
     * Автоматически применяет CSS стили и настраивает поддержку темной темы.
     *
     * @affects Глобальные CSS стили применяются через {@link one_time_styling}
     * @affects Подключается к изменениям темы через StyleManager
     * */
    constructor() {
        super();

        this.list_box.widget = Gtk.ListBox.new();
        this.list_box.widget.add_css_class('data-table');
        this.list_box.widget.margin_top = 6;
        this.list_box.widget.margin_bottom = 18;
        this.list_box.widget.selection_mode = Gtk.SelectionMode.NONE;


        this.set_child(this.list_box.widget);

        // @bm:
        //this.list_box.set_show_separators(true);

        this.placeholder = Adw.StatusPage.new();
        this.placeholder.set_title('No results');
        this.placeholder.set_description('Now history list is empty or history disabled in system');
        this.placeholder.set_icon_name('document-open-recent-symbolic');

        this.list_box.widget.set_placeholder(this.placeholder);

        if (one_time_styling) {
            one_time_styling(this);
        }

        { // @todo: Вынести
            function set_dark(this: Gtk.Widget, style_manager: Adw.StyleManager) {
                if (style_manager.dark) {
                    this.add_css_class('dark');
                } else {
                    this.remove_css_class('dark');
                }
            }

            const style_manager = Adw.StyleManager.get_default();

            set_dark.call(this, style_manager);

            style_manager.connect('notify::dark', set_dark.bind(this));
        }

        this.list_box.activate_row_hid = this.list_box.widget.connect('row-activated', this.row_activated_cb.bind(this));

        this.batch_renderer = new AsyncIntervalAdapter(this.render_items_cb.bind(this), 0);

    }

    /** Обработчик активации строки списка.
     *
     * Извлекает URI из активированной строки и испускает сигнал `'row-activated'`.
     *
     * @param _list_box Источник события (не используется)
     * @param list_box_row Активированная строка списка
     *
     * @fires ReportListBox#'row-activated' Передает URI активированной строки
     * */
    private row_activated_cb(_list_box: Gtk.ListBox, list_box_row: Gtk.ListBoxRow) {
        const box = list_box_row.get_child() as (Gtk.Box & HasUriProperty);
        console.assert(box.uri !== undefined, 'Row must have URI property set');
        this.emit('row-activated', box.uri!);
    }

    /** Отображает новый отчет.
     *
     * Полностью заменяет текущее содержимое.
     *
     * @param report Массив элементов отчета для отображения
     *
     * @affects report Будет очищен после обработки
     * @affects Полностью очищает и перестраивает содержимое {@link list_box.widget}
     * @affects При пустом отчете показывает placeholder
     *
     * @affects Строки с {@link ReportItem элементами} имеющими не пустой список критериев фильтрации получают CSS-класс `matched`.
     * */
    public async present_report(report: Report): Promise<void> {

        this.batch_renderer.abort();

        this.list_box.widget.remove_all();

        if (report.length === 0) {
            this.list_box.widget.set_placeholder(this.placeholder);
        }

        this.list_box.widget.set_sensitive(false);
        try {
            await this.batch_renderer.start_new(report);
            this.list_box.widget.set_sensitive(true);
            return;
        } catch (error) {
            if (!(error instanceof ProcessAbortError)) {
                throw error;
            }
        }
    }

    private render_items_cb(resolve: ResolveWrapper<void>, reject: RejectWrapper, report: Report) {

        if (report.length === 0) {
            resolve();
            return;
        }

        try {
            // нет контракта "readonly Report". Используя splice - я в своем праве!
            for (const report_item of report.splice(0, ReportListBox.RENDER_BATCH_SIZE)) {

                const row_container: Gtk.Box & HasUriProperty = Gtk.Box.new(Gtk.Orientation.VERTICAL, 0);

                const label = Gtk.Label.new(report_item[ReportFields.URI_DISPLAY]);
                label.xalign = 0;
                label.add_css_class('monospace');

                row_container.append(label);

                row_container.uri = report_item[ReportFields.URI];

                if (report_item[ReportFields.SINS].length > 0) {

                    row_container.add_css_class('matched');

                    const info = report_item[ReportFields.SINS].map(([type, info]) => `${type}: ${info}`).join(', ');

                    const label = Gtk.Label.new(info);
                    label.xalign = 0;
                    label.add_css_class('caption');
                    label.add_css_class('monospace');

                    row_container.append(label);

                }

                this.list_box.widget.append(row_container);
            }
        } catch (error) {
            console.error('Error in render_items_cb:', (error as Error).message);
            reject(error as Error);
        }
    }

    /** Очищает список и показывает placeholder.
     *
     * Эквивалентно вызову `present_report([])`.
     *
     * @affects Полностью очищает содержимое list_box
     * @affects Показывает placeholder с сообщением "No results"
     * */
    public clear(): Promise<void> {
        return this.present_report([]);
    }

    /** Деактивация виджета и освобождение ресурсов.
     *
     * Отключает все сигналы, очищает содержимое и блокирует дальнейшее использование.
     *
     * После вызова все методы будут выбрасывать DecommissionedError.
     *
     * @affects this.list_box.widget Будет равен undefined
     * @affects this.placeholder Будет равен undefined
     * @affects this.present_report Будет выбрасывать DecommissionedError
     * @affects this.clear Будет выбрасывать DecommissionedError
     * @affects Все внутренние сигналы будут отключены
     * @affects this.decommission Будет равен DECOMMISSIONED
     *
     * @see {@link IDecommissionable}
     * */
    public decommission: DecommissionType = () => {

        this.batch_renderer.abort();

        decommission_signals(this.list_box.widget, this.list_box.activate_row_hid);

        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        this.present_report = throw_decommissioned as typeof this.present_report;
        this.clear = throw_decommissioned as typeof this.clear;

        this.list_box.widget.set_placeholder(null);
        this.list_box.widget.remove_all();
        this.list_box.widget = (undefined as unknown as typeof this.list_box.widget);

        this.placeholder = (undefined as unknown as typeof this.placeholder);

        this.decommission = DECOMMISSIONED;
    };

}
