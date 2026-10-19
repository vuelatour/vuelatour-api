import {
  MENSAJE_FECHA_FUTURA_CONCILIADO,
  esReplicaMarcarPagado,
  mensajeFechaPagoYaRepuesta,
} from './por-pagar.util';

/**
 * Reglas PURAS que agregó la revisión adversaria del 19-oct-2026 al lote
 * «por pagar» (invariante 93): la réplica idempotente de «marcar pagado»
 * (P6) y los textos del candado de reposición al marcar pagado (P7) y del
 * conciliado con fecha futura (P9). Panel y app enseñan los textos tal cual.
 */

const HOY = '2026-10-20';
const pagado = { por_pagar: false, conciliado: false, fecha_gasto: HOY };

describe('esReplicaMarcarPagado (P6)', () => {
  it('pagado por la bandera, sin conciliar, con `false` sin fecha o con la MISMA ⇒ réplica', () => {
    for (const fechaEnviada of [undefined, null, HOY, `${HOY}T10:00:00`]) {
      expect(
        esReplicaMarcarPagado({
          porPagarEnviado: false,
          fechaEnviada,
          vigente: pagado,
          hoy: HOY,
        }),
      ).toBe(true);
    }
  });

  it('otra fecha, otro valor de la llave o un vigente por pagar ⇒ NO es réplica', () => {
    const base = { porPagarEnviado: false, vigente: pagado, hoy: HOY };
    expect(esReplicaMarcarPagado({ ...base, fechaEnviada: '2026-10-19' })).toBe(
      false,
    );
    for (const porPagarEnviado of [true, undefined, null, 'false']) {
      expect(esReplicaMarcarPagado({ ...base, porPagarEnviado })).toBe(false);
    }
    expect(
      esReplicaMarcarPagado({
        ...base,
        vigente: { ...pagado, por_pagar: true },
      }),
    ).toBe(false);
  });

  it('conciliado, sin la columna (sin migración) o con fecha vigente FUTURA ⇒ NO es réplica', () => {
    const base = { porPagarEnviado: false, hoy: HOY };
    expect(
      esReplicaMarcarPagado({
        ...base,
        vigente: { ...pagado, conciliado: true },
      }),
    ).toBe(false);
    expect(
      esReplicaMarcarPagado({
        ...base,
        vigente: { conciliado: false, fecha_gasto: HOY },
      }),
    ).toBe(false);
    expect(
      esReplicaMarcarPagado({
        ...base,
        vigente: { ...pagado, fecha_gasto: '2026-10-21' },
      }),
    ).toBe(false);
    expect(
      esReplicaMarcarPagado({
        ...base,
        vigente: { ...pagado, fecha_gasto: null },
      }),
    ).toBe(false);
  });
});

describe('textos de la revisión', () => {
  it('GASTO_EN_REPOSICION al marcar pagado (P7): la fecha del PAGO y la de la reposición, dd/mm/aaaa', () => {
    expect(mensajeFechaPagoYaRepuesta('2026-10-19', '2026-10-22')).toBe(
      'La fecha del pago (19/10/2026) ya quedó cubierta por la reposición del 22/10/2026 de tu caja chica: usa una fecha posterior o pide a oficina que lo marque pagado.',
    );
  });

  it('GASTO_CONCILIADO al mover a futuro la fecha de un conciliado (P9)', () => {
    expect(MENSAJE_FECHA_FUTURA_CONCILIADO).toBe(
      'Este gasto ya está conciliado con el banco: su fecha es la del cargo y no puede quedar en el futuro (quedaría «por pagar»). Si ese cargo no es su pago, desvincúlalo primero en Conciliación.',
    );
  });
});
