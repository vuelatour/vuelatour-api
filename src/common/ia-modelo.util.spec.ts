import {
  AVISO_FUERA_DE_CATALOGO,
  AVISO_SIN_TARIFA,
  CATALOGO_MODELOS_IA,
  HEADER_IA_MODELO,
  MENSAJE_MODELO_INVALIDO,
  avisoModeloIa,
  esIdModeloValido,
  headersModeloIa,
  modeloDeValorJson,
  modeloDelCatalogo,
  resolverModeloEfectivo,
  tarifaDe,
  valorJsonDeModelo,
} from './ia-modelo.util';
import { costoIaUsd } from '../modules/ia-uso/ia-uso.service';

/**
 * CONTRATO del catálogo (2-oct-2026, revisado el mismo día). El panel
 * (`lib/admin/ia-modelo.ts`) lleva una COPIA LITERAL de esto con su test de
 * paridad: si cambia aquí, cambia allá en el mismo cambio. Solo modelos que
 * NO piensan cuando pyservices omite `thinking` (ver `CATALOGO_BASE`).
 */
const CATALOGO_CONTRATO = [
  {
    id: 'claude-opus-4-8',
    nombre: 'Claude Opus 4.8',
    descripcion: 'el que usa hoy el servidor; el más preciso',
    in_usd_por_millon: 5,
    out_usd_por_millon: 25,
  },
  {
    id: 'claude-sonnet-4-6',
    nombre: 'Claude Sonnet 4.6',
    descripcion: 'más barato (≈ 40 % menos por token)',
    in_usd_por_millon: 3,
    out_usd_por_millon: 15,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    nombre: 'Claude Haiku 4.5',
    descripcion: 'el más barato y rápido; menos preciso en tickets difíciles',
    in_usd_por_millon: 1,
    out_usd_por_millon: 5,
  },
];

describe('ia-modelo.util — catálogo', () => {
  it('es EXACTAMENTE el contrato (ids, nombres, descripciones, tarifas y orden)', () => {
    expect(CATALOGO_MODELOS_IA).toEqual(CATALOGO_CONTRATO);
  });

  it('la tarifa de cada modelo sale de TARIFAS (la misma con la que se cobra cada lectura)', () => {
    for (const m of CATALOGO_MODELOS_IA) {
      expect(tarifaDe(m.id)).toEqual({
        in_usd_por_millon: m.in_usd_por_millon,
        out_usd_por_millon: m.out_usd_por_millon,
      });
      // 1 M de entrada + 1 M de salida = in + out (costoIaUsd usa la misma regla).
      expect(costoIaUsd(m.id, 1_000_000, 1_000_000, 0, 0)).toBe(
        m.in_usd_por_millon + m.out_usd_por_millon,
      );
    }
  });

  it('todo id del catálogo es válido y tiene tarifa', () => {
    for (const m of CATALOGO_MODELOS_IA) {
      expect(esIdModeloValido(m.id)).toBe(true);
      expect(tarifaDe(m.id)).not.toBeNull();
      expect(modeloDelCatalogo(m.id)).toEqual(m);
    }
    expect(modeloDelCatalogo('claude-opus-4-7')).toBeNull();
    expect(modeloDelCatalogo(null)).toBeNull();
  });

  it('el default de hoy en prod (claude-opus-4-8) va primero', () => {
    expect(CATALOGO_MODELOS_IA[0].id).toBe('claude-opus-4-8');
  });

  it('Sonnet 5 y Opus 5.5 NO están en el catálogo (piensan si se omite `thinking`), pero siguen elegibles por «Otro» con su tarifa real', () => {
    for (const id of ['claude-sonnet-5', 'claude-opus-5-5']) {
      expect(modeloDelCatalogo(id)).toBeNull();
      expect(esIdModeloValido(id)).toBe(true);
      expect(avisoModeloIa(id)).toBe(AVISO_FUERA_DE_CATALOGO);
    }
    expect(tarifaDe('claude-sonnet-5')).toEqual({
      in_usd_por_millon: 2,
      out_usd_por_millon: 10,
    });
    expect(tarifaDe('claude-opus-5-5')).toEqual({
      in_usd_por_millon: 4,
      out_usd_por_millon: 20,
    });
  });
});

describe('ia-modelo.util — validación del id', () => {
  it.each([
    'claude-opus-4-8',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-3.5-x',
    'claude-abc',
  ])('acepta %s', (id) => {
    expect(esIdModeloValido(id)).toBe(true);
  });

  it.each([
    ['vacío', ''],
    ['sin prefijo claude-', 'opus-4-8'],
    ['mayúsculas', 'Claude-Opus-4-8'],
    ['espacios a los lados', ' claude-opus-4-8'],
    ['salto de línea al final', 'claude-opus-4-8\n'],
    ['muy corto', 'claude-ab'],
    ['muy largo', `claude-${'a'.repeat(81)}`],
    ['caracteres raros', 'claude-opus_4/8'],
    ['inyección de header', 'claude-opus\r\nX-Otro: 1'],
  ])('rechaza %s', (_caso, id) => {
    expect(esIdModeloValido(id)).toBe(false);
  });

  it('rechaza lo que no es string', () => {
    for (const v of [null, undefined, 5, ['claude-opus-4-8'], {}]) {
      expect(esIdModeloValido(v)).toBe(false);
    }
  });

  it('el máximo exacto (80 tras «claude-») pasa', () => {
    expect(esIdModeloValido(`claude-${'a'.repeat(80)}`)).toBe(true);
  });
});

describe('ia-modelo.util — tarifa, efectivo y valor_json', () => {
  it('tarifaDe por PREFIJO (sufijos de versión) y null sin tarifa conocida', () => {
    expect(tarifaDe('claude-opus-4-7')).toEqual({
      in_usd_por_millon: 5,
      out_usd_por_millon: 25,
    });
    expect(tarifaDe('claude-sonnet-5-20261001')).toEqual({
      in_usd_por_millon: 2,
      out_usd_por_millon: 10,
    });
    expect(tarifaDe('claude-nuevo-9')).toBeNull();
    expect(tarifaDe('')).toBeNull();
    expect(tarifaDe(null)).toBeNull();
  });

  it('resolverModeloEfectivo: configurado válido gana; si no, el del servidor; si no, null', () => {
    expect(resolverModeloEfectivo('claude-sonnet-5', 'claude-opus-4-8')).toBe(
      'claude-sonnet-5',
    );
    expect(resolverModeloEfectivo(null, 'claude-opus-4-8')).toBe(
      'claude-opus-4-8',
    );
    expect(resolverModeloEfectivo('Basura', ' claude-opus-4-8 ')).toBe(
      'claude-opus-4-8',
    );
    expect(resolverModeloEfectivo(null, null)).toBeNull();
    expect(resolverModeloEfectivo(undefined, '  ')).toBeNull();
  });

  it('valor_json: se guarda como arreglo (CHECK de la BD) y se lee de arreglo o string suelto', () => {
    expect(valorJsonDeModelo('claude-sonnet-5')).toEqual(['claude-sonnet-5']);
    expect(valorJsonDeModelo(null)).toBeNull();
    expect(modeloDeValorJson(['claude-sonnet-5'])).toBe('claude-sonnet-5');
    expect(modeloDeValorJson('claude-sonnet-5')).toBe('claude-sonnet-5');
    for (const raro of [null, undefined, [], ['Mary'], [5], {}, 'x', 7]) {
      expect(modeloDeValorJson(raro)).toBeNull();
    }
  });

  it('headersModeloIa: header SOLO con modelo válido', () => {
    expect(HEADER_IA_MODELO).toBe('X-IA-Modelo');
    expect(headersModeloIa('claude-sonnet-5')).toEqual({
      'X-IA-Modelo': 'claude-sonnet-5',
    });
    for (const v of [null, undefined, '', 'basura', 'claude-x\r\ny']) {
      expect(headersModeloIa(v)).toEqual({});
    }
  });
});

describe('ia-modelo.util — textos', () => {
  it('avisos literales (el panel los copia)', () => {
    expect(AVISO_SIN_TARIFA).toBe(
      'Sin tarifa conocida: el consumo se registra con costo 0 hasta agregar su tarifa.',
    );
    expect(AVISO_FUERA_DE_CATALOGO).toBe(
      'Este modelo no está en el catálogo: verifica que el id exista en Anthropic; si no existe, las lecturas con IA fallarán hasta corregirlo.',
    );
    expect(MENSAJE_MODELO_INVALIDO).toBe(
      'El id del modelo no es válido: debe empezar con «claude-» y llevar solo minúsculas, números, puntos o guiones (por ejemplo, claude-sonnet-4-6).',
    );
  });

  it('avisoModeloIa: null sin modelo o del catálogo; fuera del catálogo avisa y suma el de costo 0 si no hay tarifa', () => {
    expect(avisoModeloIa(null)).toBeNull();
    expect(avisoModeloIa('claude-sonnet-4-6')).toBeNull();
    expect(avisoModeloIa('claude-haiku-4-5-20251001')).toBeNull();
    expect(avisoModeloIa('claude-opus-4-7')).toBe(AVISO_FUERA_DE_CATALOGO);
    expect(avisoModeloIa('claude-nuevo-9')).toBe(
      `${AVISO_FUERA_DE_CATALOGO} ${AVISO_SIN_TARIFA}`,
    );
  });
});
