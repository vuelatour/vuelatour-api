// Dependencias que arrastran módulos pesados: fuera del spec.
jest.mock('../pyservices/pyservices.service', () => ({
  PyservicesService: class {},
}));
jest.mock('../profit-sharing/profit-sharing.service', () => ({
  ProfitSharingService: class {},
}));
jest.mock('./facturacion.client', () => ({ FacturacionClient: class {} }));
jest.mock('../flights/factura-cliente.service', () => ({
  FacturaClienteService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import type { SupabaseService } from '../supabase/supabase.service';
import type { PyservicesService } from '../pyservices/pyservices.service';
import type { ProfitSharingService } from '../profit-sharing/profit-sharing.service';
import type { FacturacionClient } from './facturacion.client';

/**
 * «SUBIR LA FACTURA DE ESTE GASTO» (22-sep-2026, palabras del cliente).
 *
 * Lo que se congela aquí:
 *  - el amarre es ADITIVO: solo toca ESE gasto (usar `amarrarGastos` desde
 *    la fila desamarraría en silencio los demás gastos que ampara la misma
 *    factura — caso VIP SAESA);
 *  - una factura SOLO en PDF (sin XML) es válida y entra con uuid_fiscal
 *    null;
 *  - un UUID ya registrado NO es un callejón sin salida: se reutiliza la
 *    fila y se responde `ya_existia: true`;
 *  - sin la migración `20260923000001`, subir PDF responde 409 explicado en
 *    vez de perder el papel.
 */

const GASTO = 'aaaaaaaa-0000-4000-8000-00000000g001';
const USER = 'bbbbbbbb-0000-4000-8000-00000000u001';
const UUID_CFDI = '11111111-2222-3333-4444-555555555555';

type Op = { m: string; args: unknown[] };

const METODOS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'or',
  'order',
  'limit',
  'range',
  'insert',
  'update',
  'delete',
];

interface Mundo {
  /** `factura_recibida.pdf_url` ya existe (migración aplicada). */
  conPdf?: boolean;
  /** El gasto existe. */
  gasto?: Record<string, unknown> | null;
  /** Ya hay una factura con ese uuid_fiscal. */
  recibidaPrevia?: Record<string, unknown> | null;
  /** Lo que devuelve el parser del XML (null = no se llama). */
  parse?: Record<string, unknown>;
}

function armar(m: Mundo = {}) {
  const llamadas: Array<{ tabla: string; ops: Op[] }> = [];
  const subidas: string[] = [];
  const borrados: string[][] = [];

  const service = {
    from(tabla: string) {
      const ops: Op[] = [];
      llamadas.push({ tabla, ops });
      const q: Record<string, unknown> = {};
      const cols = () =>
        String(
          (ops.find((o) => o.m === 'select')?.args[0] as string | undefined) ??
            '',
        );
      const esInsert = () => ops.some((o) => o.m === 'insert');
      const resolver = () => {
        if (tabla === 'factura_recibida') {
          if (!m.conPdf && cols().includes('pdf_url') && !esInsert()) {
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column factura_recibida.pdf_url does not exist',
              },
            };
          }
          if (esInsert()) return { data: { id: 'fr-1' } };
          // Lectura por uuid_fiscal (previa) o por id (respuesta canónica).
          const porUuid = ops.some(
            (o) => o.m === 'eq' && o.args[0] === 'uuid_fiscal',
          );
          if (porUuid) return { data: m.recibidaPrevia ?? null };
          return {
            data: { id: 'fr-1', uuid_fiscal: m.parse?.uuid_fiscal ?? null },
          };
        }
        if (tabla === 'gasto') {
          return { data: m.gasto === undefined ? { id: GASTO } : m.gasto };
        }
        return { data: null };
      };
      for (const met of METODOS) {
        q[met] = (...args: unknown[]) => {
          ops.push({ m: met, args });
          return q;
        };
      }
      q.maybeSingle = () => {
        const r = resolver();
        return Promise.resolve({
          data: r.data ?? null,
          error: r.error ?? null,
        });
      };
      q.then = (res: (v: unknown) => unknown) => {
        const r = resolver();
        return Promise.resolve({
          data: r.data ? [r.data] : [],
          error: r.error ?? null,
        }).then(res);
      };
      return q;
    },
    storage: {
      from() {
        return {
          upload: (path: string) => {
            subidas.push(path);
            return Promise.resolve({ error: null });
          },
          remove: (paths: string[]) => {
            borrados.push(paths);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };

  const parseFacturaRecibida = jest.fn().mockResolvedValue(m.parse ?? {});
  const svc = new InvoicesService(
    { service } as unknown as SupabaseService,
    {} as FacturacionClient,
    { parseFacturaRecibida } as unknown as PyservicesService,
    {} as ProfitSharingService,
  );
  return { svc, llamadas, subidas, borrados, parseFacturaRecibida };
}

/** El payload del insert a `factura_recibida`. */
const payloadInsert = (llamadas: Array<{ tabla: string; ops: Op[] }>) =>
  (llamadas
    .filter((l) => l.tabla === 'factura_recibida')
    .flatMap((l) => l.ops)
    .find((o) => o.m === 'insert')?.args[0] ?? {}) as Record<string, unknown>;

/** Los updates a `gasto` (el amarre). */
const updatesGasto = (llamadas: Array<{ tabla: string; ops: Op[] }>) =>
  llamadas
    .filter((l) => l.tabla === 'gasto')
    .flatMap((l) => l.ops)
    .filter((o) => o.m === 'update')
    .map((o) => o.args[0] as Record<string, unknown>);

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('crearRecibidaDeGasto', () => {
  it('sin XML ni PDF ⇒ 400 (no hay nada que subir)', async () => {
    const { svc, llamadas } = armar({ conPdf: true });
    await expect(
      svc.crearRecibidaDeGasto({ gasto_id: GASTO }, USER),
    ).rejects.toThrow(BadRequestException);
    expect(llamadas).toHaveLength(0);
  });

  it('PDF sin la migración aplicada ⇒ 409 explicado, sin subir nada', async () => {
    const { svc, subidas } = armar({ conPdf: false });
    await expect(
      svc.crearRecibidaDeGasto({ gasto_id: GASTO, pdf_b64: b64('%PDF') }, USER),
    ).rejects.toMatchObject({
      response: {
        error: 'PDF_FACTURA_NO_DISPONIBLE',
        details: { migracion: '20260923000001' },
      },
    });
    expect(subidas).toHaveLength(0);
  });

  it('gasto inexistente ⇒ 404 y no se toca Storage', async () => {
    const { svc, subidas } = armar({ conPdf: true, gasto: null });
    await expect(
      svc.crearRecibidaDeGasto({ gasto_id: GASTO, xml_b64: b64('<x/>') }, USER),
    ).rejects.toThrow('not found');
    expect(subidas).toHaveLength(0);
  });

  it('XML nuevo: guarda el XML, inserta la factura y amarra SOLO ese gasto', async () => {
    const { svc, llamadas, subidas } = armar({
      conPdf: true,
      parse: {
        uuid_fiscal: UUID_CFDI,
        emisor_rfc: 'AAA010101AAA',
        emisor_nombre: 'PROVEEDOR SA',
        total: 1234.56,
        moneda: 'MXN',
      },
    });
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: GASTO, xml_b64: b64('<cfdi/>') },
      USER,
    );
    expect(subidas).toEqual([`recibidas/${UUID_CFDI}.xml`]);
    expect(payloadInsert(llamadas)).toMatchObject({
      uuid_fiscal: UUID_CFDI,
      emisor_rfc: 'AAA010101AAA',
      estado: 'CLASIFICADA',
      gasto_id: GASTO,
      xml_url: `recibidas/${UUID_CFDI}.xml`,
      pdf_url: null,
    });
    // ADITIVO: un único update, al gasto de la fila (jamás un `.in()` que
    // reemplace la lista completa de gastos amparados).
    expect(updatesGasto(llamadas)).toEqual([
      { factura_recibida_id: 'fr-1', updated_by: USER },
    ]);
    expect(r).toMatchObject({ ya_existia: false });
  });

  it('XML + PDF: sube los dos con la misma base y guarda pdf_url', async () => {
    const { svc, llamadas, subidas } = armar({
      conPdf: true,
      parse: { uuid_fiscal: UUID_CFDI },
    });
    await svc.crearRecibidaDeGasto(
      { gasto_id: GASTO, xml_b64: b64('<cfdi/>'), pdf_b64: b64('%PDF') },
      USER,
    );
    expect(subidas).toEqual([
      `recibidas/${UUID_CFDI}.xml`,
      `recibidas/${UUID_CFDI}.pdf`,
    ]);
    expect(payloadInsert(llamadas).pdf_url).toBe(`recibidas/${UUID_CFDI}.pdf`);
  });

  it('SOLO PDF (proveedor que no manda XML): uuid_fiscal null y nota que lo dice', async () => {
    const { svc, llamadas, subidas, parseFacturaRecibida } = armar({
      conPdf: true,
    });
    await svc.crearRecibidaDeGasto(
      {
        gasto_id: GASTO,
        pdf_b64: b64('%PDF'),
        pdf_nombre: 'Factura Shell.pdf',
      },
      USER,
    );
    expect(parseFacturaRecibida).not.toHaveBeenCalled();
    expect(subidas).toHaveLength(1);
    expect(subidas[0]).toMatch(/^recibidas\/[0-9a-f-]+\.pdf$/);
    expect(payloadInsert(llamadas)).toMatchObject({
      uuid_fiscal: null,
      xml_url: null,
      estado: 'CLASIFICADA',
      gasto_id: GASTO,
      notas: 'Factura en PDF (sin XML): Factura Shell.pdf',
    });
    expect(updatesGasto(llamadas)).toHaveLength(1);
  });

  it('UUID ya registrado: NO es error — se reutiliza y se suma el gasto', async () => {
    const { svc, llamadas, subidas } = armar({
      conPdf: true,
      parse: { uuid_fiscal: UUID_CFDI },
      recibidaPrevia: { id: 'fr-previa' },
    });
    const r = await svc.crearRecibidaDeGasto(
      { gasto_id: GASTO, xml_b64: b64('<cfdi/>') },
      USER,
    );
    expect(r).toMatchObject({ ya_existia: true });
    // No se vuelve a subir el XML ni se inserta otra fila.
    expect(subidas).toHaveLength(0);
    expect(payloadInsert(llamadas)).toEqual({});
    expect(updatesGasto(llamadas)).toEqual([
      { factura_recibida_id: 'fr-previa', updated_by: USER },
    ]);
  });
});
