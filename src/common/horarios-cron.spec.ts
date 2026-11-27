import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronTime } from 'cron';
import {
  CRON_ALERTAS_CADA_HORA,
  CRON_CALENDAR_COLA,
  CRON_GASTOS_RELEER_FOLIO,
  CRON_RECIBIDAS_RELEER_FOLIO,
  CRON_RECORDATORIO_EVENTOS,
  CRON_RECORDATORIO_TACO,
  CRON_SERVICIO_HORAS,
  CRON_TACO_LIVE,
  TAREAS_RECURRENTES,
} from './horarios-cron';

/**
 * Tareas recurrentes ESCALONADAS (27-nov-2026, invariante 148). La base se
 * cayó dos veces a la hora en punto (25-nov 17:01, 27-nov 17:00): en el
 * segundo 0 del minuto 0 arrancaban a la vez ocho tareas. Aquí se congela que
 * ninguna vuelva a coincidir con otra y que cada una conserve su frecuencia.
 */

/** Valores de UN campo cron (asterisco, lista, rango y rango con paso) en [0, tope). */
function campo(expr: string, tope: number): number[] {
  const out = new Set<number>();
  for (const parte of expr.split(',')) {
    const [rango, pasoTxt] = parte.split('/');
    const paso = pasoTxt ? Number(pasoTxt) : 1;
    let desde = 0;
    let hasta = tope - 1;
    if (rango !== '*') {
      const [a, b] = rango.split('-');
      desde = Number(a);
      hasta = b !== undefined ? Number(b) : pasoTxt ? tope - 1 : Number(a);
    }
    for (let v = desde; v <= hasta; v += paso) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** Segundos de UNA hora (0..3599) en los que dispara la expresión de 6 campos. */
function disparosEnUnaHora(cron: string): number[] {
  const [seg, min, hora, dia, mes, dow] = cron.trim().split(/\s+/);
  // Todas las recurrentes corren a toda hora, todos los días.
  expect([hora, dia, mes, dow]).toEqual(['*', '*', '*', '*']);
  const out: number[] = [];
  for (const m of campo(min, 60)) {
    for (const s of campo(seg, 60)) out.push(m * 60 + s);
  }
  return out.sort((a, b) => a - b);
}

describe('horarios-cron · ninguna tarea recurrente coincide con otra', () => {
  it('todas las expresiones son de 6 campos y válidas para la librería cron', () => {
    for (const t of TAREAS_RECURRENTES) {
      expect(t.cron.trim().split(/\s+/)).toHaveLength(6);
      expect(() => new CronTime(t.cron)).not.toThrow();
    }
  });

  it('en una hora completa, NINGÚN segundo tiene dos tareas arrancando a la vez', () => {
    const ocupado = new Map<number, string>();
    const choques: string[] = [];
    for (const t of TAREAS_RECURRENTES) {
      for (const s of disparosEnUnaHora(t.cron)) {
        const otro = ocupado.get(s);
        if (otro) {
          choques.push(
            `${otro} y ${t.nombre} en el minuto ${Math.floor(s / 60)}, segundo ${s % 60}`,
          );
        }
        ocupado.set(s, t.nombre);
      }
    }
    expect(choques).toEqual([]);
  });

  it('la HORA EN PUNTO (minuto 0, segundo 0) solo trae el recordatorio de cada minuto — antes eran ocho', () => {
    const enPunto = TAREAS_RECURRENTES.filter((t) =>
      disparosEnUnaHora(t.cron).includes(0),
    ).map((t) => t.nombre);
    expect(enPunto).toEqual(['recordatorio-taco']);
  });

  it('cada tarea conserva su FRECUENCIA (solo cambió cuándo cae)', () => {
    const veces = (cron: string) => disparosEnUnaHora(cron).length;
    expect(veces(CRON_ALERTAS_CADA_HORA)).toBe(1); // cada hora
    expect(veces(CRON_RECORDATORIO_TACO)).toBe(60); // cada minuto
    expect(veces(CRON_RECORDATORIO_EVENTOS)).toBe(60); // cada minuto
    expect(veces(CRON_SERVICIO_HORAS)).toBe(6); // cada 10 min
    expect(veces(CRON_TACO_LIVE)).toBe(6); // cada 10 min
    expect(veces(CRON_RECIBIDAS_RELEER_FOLIO)).toBe(6); // cada 10 min
    expect(veces(CRON_GASTOS_RELEER_FOLIO)).toBe(12); // cada 5 min
    expect(veces(CRON_CALENDAR_COLA)).toBe(180); // cada 20 s
  });

  it('los intervalos son parejos: 10 min entre corridas de las de cada 10, 5 de la de cada 5, 20 s la cola', () => {
    const saltos = (cron: string) => {
      const d = disparosEnUnaHora(cron);
      return [...new Set(d.slice(1).map((x, i) => x - d[i]))];
    };
    expect(saltos(CRON_SERVICIO_HORAS)).toEqual([600]);
    expect(saltos(CRON_TACO_LIVE)).toEqual([600]);
    expect(saltos(CRON_RECIBIDAS_RELEER_FOLIO)).toEqual([600]);
    expect(saltos(CRON_GASTOS_RELEER_FOLIO)).toEqual([300]);
    expect(saltos(CRON_CALENDAR_COLA)).toEqual([20]);
    expect(saltos(CRON_RECORDATORIO_TACO)).toEqual([60]);
    expect(saltos(CRON_RECORDATORIO_EVENTOS)).toEqual([60]);
  });

  it('dos tareas PESADAS (las de minuto) nunca caen en el mismo minuto', () => {
    const deMinuto = [
      CRON_ALERTAS_CADA_HORA,
      CRON_SERVICIO_HORAS,
      CRON_TACO_LIVE,
      CRON_RECIBIDAS_RELEER_FOLIO,
      CRON_GASTOS_RELEER_FOLIO,
    ];
    const minutos = deMinuto.flatMap((c) =>
      disparosEnUnaHora(c).map((s) => Math.floor(s / 60)),
    );
    expect(new Set(minutos).size).toBe(minutos.length);
  });
});

describe('horarios-cron · cableado: cada servicio usa SU constante', () => {
  const leer = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf8');

  it('los decoradores apuntan a las constantes (ninguna expresión recurrente suelta)', () => {
    const alerts = leer('modules/alerts/alerts.service.ts');
    expect(alerts).toContain('@Cron(CRON_ALERTAS_CADA_HORA)');
    expect(alerts).toContain('@Cron(CRON_RECORDATORIO_TACO)');
    expect(alerts).toContain('@Cron(CRON_RECORDATORIO_EVENTOS)');
    expect(alerts).toContain(
      "@Cron(CRON_SERVICIO_HORAS, { timeZone: 'America/Cancun' })",
    );
    expect(alerts).not.toContain('CronExpression.EVERY_');
    expect(leer('modules/flights/flights.service.ts')).toContain(
      "@Cron(CRON_TACO_LIVE, { name: 'taco-live-deduce' })",
    );
    expect(leer('modules/facturacion/invoices.service.ts')).toContain(
      "@Cron(CRON_RECIBIDAS_RELEER_FOLIO, { name: 'recibidas-releer-folio' })",
    );
    expect(leer('modules/expenses/folio-relectura.service.ts')).toContain(
      "@Cron(CRON_GASTOS_RELEER_FOLIO, { name: 'gastos-releer-folio' })",
    );
    expect(leer('modules/calendar/calendar-sync.service.ts')).toContain(
      "@Cron(CRON_CALENDAR_COLA, { name: 'calendar-sync-cola' })",
    );
  });

  it('en todo `src/modules` ya no queda un cron «cada N minutos/segundos» escrito a mano', () => {
    const archivos = [
      'modules/alerts/alerts.service.ts',
      'modules/flights/flights.service.ts',
      'modules/facturacion/invoices.service.ts',
      'modules/expenses/folio-relectura.service.ts',
      'modules/calendar/calendar-sync.service.ts',
    ];
    for (const a of archivos) {
      expect(leer(a)).not.toMatch(/@Cron\('\*\/\d+ /);
    }
  });
});
