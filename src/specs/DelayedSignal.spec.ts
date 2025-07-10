#!/usr/bin/env -S jasmine --verbose --module
/** @file: src/specs/DelayedSignal.spec.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version:  2.3.0 */

/// <reference types="jasmine" />

import { DelayedSignal } from '../Ljs/DelayedSignal.js';
import { DecommissionedError } from '../Ljs/Decommissionable.js';

describe('DelayedSignal', () => {

    beforeEach(() => {
        jasmine.clock().install();
    });

    afterEach(() => {
        jasmine.clock().uninstall();
    });

    // Добавь этот тест для проверки что jasmine.clock работает:
    it('DEBUG: проверка что jasmine.clock перехватывает setTimeout', () => {
        let called = false;
        setTimeout(() => { called = true; }, 100);

        jasmine.clock().tick(50);
        expect(called).toBe(false);

        jasmine.clock().tick(50);
        expect(called).toBe(true);
    });

    // И этот для проверки сигналов:
    it('DEBUG: проверка что сигналы действительно работают', () => {
        const signal = new DelayedSignal(300);
        let signal_received = false;

        signal.connect('scheduled', (_global) => {
            signal_received = true;
            console.log('Сигнал scheduled получен!');
            return false;
        });

        signal.pending_invoke();
        expect(signal_received).toBe(true);
    });

    describe('constructor', () => {
        it('создает объект с корректной задержкой', () => {
            const signal = new DelayedSignal(300);
            expect(signal.debounce_delay).toBe(300);
        });

        it('выбрасывает TypeError для неположительной задержки', () => {
            expect(() => new DelayedSignal(0)).toThrowError(TypeError);
            expect(() => new DelayedSignal(-100)).toThrowError(TypeError);
        });

        it('выбрасывает TypeError для нецелой задержки', () => {
            expect(() => new DelayedSignal(300.5)).toThrowError(TypeError);
            expect(() => new DelayedSignal(NaN)).toThrowError(TypeError);
        });
    });

    describe('is_pending', () => {
        it('возвращает false изначально', () => {
            const signal = new DelayedSignal(300);
            expect(signal.is_pending()).toBe(false);
        });

        it('возвращает true после pending_invoke', () => {
            const signal = new DelayedSignal(300);
            signal.pending_invoke();
            expect(signal.is_pending()).toBe(true);
        });

        it('возвращает false после срабатывания таймера', () => {
            const signal = new DelayedSignal(300);
            signal.pending_invoke();

            jasmine.clock().tick(300);
            expect(signal.is_pending()).toBe(false);
        });
    });

    describe('pending_invoke', () => {
        it('эмиттирует scheduled при первом вызове', () => {
            const signal = new DelayedSignal(300);
            const scheduled_spy = jasmine.createSpy('scheduled');
            signal.connect('scheduled', scheduled_spy);

            signal.pending_invoke();
            expect(scheduled_spy).toHaveBeenCalledTimes(1);
        });

        it('НЕ эмиттирует scheduled при повторном вызове', () => {
            const signal = new DelayedSignal(300);
            const scheduled_spy = jasmine.createSpy('scheduled');
            signal.connect('scheduled', scheduled_spy);

            signal.pending_invoke();
            signal.pending_invoke();
            signal.pending_invoke();

            expect(scheduled_spy).toHaveBeenCalledTimes(1);
        });

        it('эмиттирует occurred после истечения времени', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.pending_invoke();
            jasmine.clock().tick(299);
            expect(occurred_spy).not.toHaveBeenCalled();

            jasmine.clock().tick(1);
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });

        it('сбрасывает таймер при повторном вызове (debounce)', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.pending_invoke();
            jasmine.clock().tick(250);

            signal.pending_invoke(); // сброс таймера
            jasmine.clock().tick(250);
            expect(occurred_spy).not.toHaveBeenCalled();

            jasmine.clock().tick(50);
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });
    });

    describe('invoke', () => {
        it('эмиттирует occurred немедленно', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.invoke();
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });

        it('отменяет запланированный таймер и эмиттирует occurred', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.pending_invoke();
            expect(signal.is_pending()).toBe(true);

            signal.invoke();
            expect(signal.is_pending()).toBe(false);
            expect(occurred_spy).toHaveBeenCalledTimes(1);

            // Таймер отменен, больше сигналов не будет
            jasmine.clock().tick(300);
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });
    });

    describe('flush', () => {
        it('эмиттирует occurred если таймер активен', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.pending_invoke();
            signal.flush();

            expect(occurred_spy).toHaveBeenCalledTimes(1);
            expect(signal.is_pending()).toBe(false);
        });

        it('ничего не делает если таймер неактивен', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.flush();
            expect(occurred_spy).not.toHaveBeenCalled();
        });
    });

    describe('cancel', () => {
        it('эмиттирует canceled если таймер активен', () => {
            const signal = new DelayedSignal(300);
            const canceled_spy = jasmine.createSpy('canceled');
            signal.connect('canceled', canceled_spy);

            signal.pending_invoke();
            signal.cancel();

            expect(canceled_spy).toHaveBeenCalledTimes(1);
            expect(signal.is_pending()).toBe(false);
        });

        it('ничего не делает если таймер неактивен', () => {
            const signal = new DelayedSignal(300);
            const canceled_spy = jasmine.createSpy('canceled');
            signal.connect('canceled', canceled_spy);

            signal.cancel();
            expect(canceled_spy).not.toHaveBeenCalled();
        });

        it('предотвращает эмиссию occurred', () => {
            const signal = new DelayedSignal(300);
            const occurred_spy = jasmine.createSpy('occurred');
            signal.connect('occurred', occurred_spy);

            signal.pending_invoke();
            signal.cancel();

            jasmine.clock().tick(300);
            expect(occurred_spy).not.toHaveBeenCalled();
        });
    });

    describe('decommission', () => {
        it('вызывает cancel при деактивации', () => {
            const signal = new DelayedSignal(300);
            const canceled_spy = jasmine.createSpy('canceled');
            signal.connect('canceled', canceled_spy);

            signal.pending_invoke();
            signal.decommission && signal.decommission();

            expect(canceled_spy).toHaveBeenCalledTimes(1);
        });

        it('выбрасывает DecommissionedError при обращении к методам', () => {
            const signal = new DelayedSignal(300);
            signal.decommission && signal.decommission();

            expect(() => signal.pending_invoke()).toThrowError(DecommissionedError);
            expect(() => signal.invoke()).toThrowError(DecommissionedError);
            expect(() => signal.flush()).toThrowError(DecommissionedError);
            expect(() => signal.cancel()).toThrowError(DecommissionedError);
            expect(() => signal.is_pending()).toThrowError(DecommissionedError);
            expect(() => signal.emit('occurred')).toThrowError(DecommissionedError);
        });

        it('выбрасывает DecommissionedError при обращении к debounce_delay', () => {
            const signal = new DelayedSignal(300);
            signal.decommission && signal.decommission();

            expect(() => signal.debounce_delay).toThrowError(DecommissionedError);
        });
    });

    describe('сложные сценарии', () => {
        it('корректно работает при множественных операциях', () => {
            const signal = new DelayedSignal(200);
            const scheduled_spy = jasmine.createSpy('scheduled');
            const occurred_spy = jasmine.createSpy('occurred');
            const canceled_spy = jasmine.createSpy('canceled');

            signal.connect('scheduled', scheduled_spy);
            signal.connect('occurred', occurred_spy);
            signal.connect('canceled', canceled_spy);

            // Первое планирование
            signal.pending_invoke();
            expect(scheduled_spy).toHaveBeenCalledTimes(1);

            // Сброс таймера
            jasmine.clock().tick(150);
            signal.pending_invoke();
            expect(scheduled_spy).toHaveBeenCalledTimes(1); // НЕ увеличился

            // Отмена
            signal.cancel();
            expect(canceled_spy).toHaveBeenCalledTimes(1);

            // Новое планирование после отмены
            signal.pending_invoke();
            expect(scheduled_spy).toHaveBeenCalledTimes(2); // Увеличился

            // Срабатывание
            jasmine.clock().tick(200);
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });

        it('scheduled эмиттируется заново после полного цикла', () => {
            const signal = new DelayedSignal(100);
            const scheduled_spy = jasmine.createSpy('scheduled');
            signal.connect('scheduled', scheduled_spy);

            // Первый цикл
            signal.pending_invoke();
            jasmine.clock().tick(100);
            expect(scheduled_spy).toHaveBeenCalledTimes(1);

            // Второй цикл - должен снова эмиттировать scheduled
            signal.pending_invoke();
            expect(scheduled_spy).toHaveBeenCalledTimes(2);
        });

        it('EDGE: очень быстрые множественные вызовы', () => {
            const signal = new DelayedSignal(100);
            const scheduled_spy = jasmine.createSpy('scheduled');
            const occurred_spy = jasmine.createSpy('occurred');

            signal.connect('scheduled', scheduled_spy);
            signal.connect('occurred', occurred_spy);

            // Быстрая последовательность
            for (let i = 0; i < 10; i++) {
                signal.pending_invoke();
            }

            expect(scheduled_spy).toHaveBeenCalledTimes(1);

            jasmine.clock().tick(100);
            expect(occurred_spy).toHaveBeenCalledTimes(1);
        });
    });
});