#!/usr/bin/env -S jasmine --verbose --module
/** @file: src/specs/AsyncIntervalAdapter.spec.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */

/// <reference types="jasmine" />

import GLib from 'gi://GLib?version=2.0';
import { AsyncIntervalAdapter, ProcessAbortError, RejectWrapper, ResolveWrapper } from "../Ljs/AsyncIntervalAdapter.js";



describe('AsyncIntervalAdapter edge cases', () => {

    /** Race condition: быстрые последовательные start_new */
    it('должен отменять предыдущий процесс при быстром вызове start_new', async () => {

        let execution_count = 0;

        const adapter = new AsyncIntervalAdapter<number>((resolve) => {
            execution_count++;
            if (execution_count > 100) resolve(execution_count);
        }, 1);

        // Запускаем 10 процессов подряд без await
        const promises = Array.from({ length: 10 }, () => adapter.start_new());

        // Только последний должен завершиться успешно
        const results = await Promise.allSettled(promises);

        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        expect(fulfilled.length)
            .withContext('Только один процесс должен завершиться успешно')
            .toBe(1);

        expect(results[9].status)
            .withContext('Только последний процесс должен завершиться успешно')
            .toBe('fulfilled');

        expect(rejected.length)
            .withContext('Остальные процессы должны быть отменены')
            .toBe(9);

        expect(rejected.every(r => r.reason instanceof ProcessAbortError))
            .withContext('Отклоненные процессы отклонены с ProcessAbortError')
            .toBe(true);
    });

    /** Утечка памяти: проверка очистки интервалов */
    it('интервалы не должны утекать при прерывании', (done) => {
        let intervals_created = 0;
        const original_setInterval = globalThis.setInterval;
        const active_intervals = new Set<GLib.Source>();

        // Мокаем setInterval для отслеживания
        globalThis.setInterval = function (callback: (...args: any[]) => any, delay?: number, ...args: any[]) {
            intervals_created++;
            const source = original_setInterval.apply(this, [callback, delay, ...args]);
            active_intervals.add(source);
            return source;
        };

        const adapter = new AsyncIntervalAdapter<void>(() => {
            // Бесконечный процесс
        }, 3);

        // Создаем и отменяем процессы
        for (let i = 0; i < 50; i++) {
            adapter.start_new().catch(() => { });
            setTimeout(() => {
                adapter.abort();
            }, 5);
        }

        // Восстанавливаем оригинальный setInterval
        globalThis.setInterval = original_setInterval;

        // Проверяем что все интервалы уничтожены
        setTimeout(() => {

            const alive = Array.from(active_intervals).filter(s => !s.is_destroyed());

            expect(intervals_created)
                .withContext('Будет создано 50 интервалов')
                .toBe(50);

            expect(alive.length)
                .withContext('Не будет живых интервалов')
                .toBe(0);


            done();
        }, 100);
    });

    /** Вызов resolve/reject после abort */
    it('должен игнорировать разрешение/отклонение после прерывания', async () => {

        let saved_resolve: ResolveWrapper<string> | null = null;
        let saved_reject: RejectWrapper | null = null;

        const adapter = new AsyncIntervalAdapter<string>((resolve, reject) => {
            saved_resolve = resolve;
            saved_reject = reject;
            // Не завершаем процесс
        }, 10);

        const promise = adapter.start_new();

        // Ждем пока callback сохранит resolve/reject
        await new Promise(r => setTimeout(r, 20));

        // Отменяем процесс
        adapter.abort('test abort');

        // Пытаемся вызвать resolve/reject после отмены
        saved_resolve!('should be ignored');
        saved_reject!(new Error('should also be ignored'));

        // Promise должен быть отклонен с ProcessAbortError
        await expectAsync(promise)
            .withContext('Будет отклонен с ProcessAbortError и сообщением "test abort"')
            .toBeRejectedWithError(ProcessAbortError, 'test abort');
    });

    /** Модификация args между итерациями */
    it('должен корректно обрабатывать изменяемые аргументы', async () => {
        const results: number[] = [];

        const adapter = new AsyncIntervalAdapter<void, [number[]]>((resolve, reject, items) => {
            if (items.length === 0) {
                resolve();
                return;
            }

            const item = items.shift()!;
            results.push(item);

            // Злонамеренная модификация массива
            if (item === 2) {
                items.push(666); // Добавляем элемент во время обработки
            }
        }, 1);

        await adapter.start_new([1, 2, 3]);

        // Должны обработать и добавленный элемент
        expect(results)
            .withContext('Будут обработаны и добавленный элемент')
            .toEqual([1, 2, 3, 666]);
    });

    /** Стресс-тест: тысячи быстрых abort/start циклов */
    it('должен выдержать стресс-тест без утечек', async () => {
        const adapter = new AsyncIntervalAdapter<void>(() => {
            // Пустой callback
        }, 0);

        const stress_cycles = 1000;

        for (let i = 0; i < stress_cycles; i++) {
            adapter.start_new().catch(() => { });
            if (i % 2 === 0) adapter.abort();
        }

        // Должен остаться только один активный процесс (или ни одного)
        if (adapter.is_running) {
            adapter.abort();
        }

        expect(adapter.is_running).toBe(false);
    });
});