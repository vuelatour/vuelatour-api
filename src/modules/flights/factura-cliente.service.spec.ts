import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FacturaClienteService } from './factura-cliente.service';
import type { SupabaseService } from '../supabase/supabase.service';

/**
 * FACTURA DEL SERVICIO POR VUELO (22-sep-2026). Lo que se congela aquí:
 *  - con la migración `20260923000001` SIN aplicar, LEER sigue funcionando
 *    (se deriva de `vuelo.facturado`) y ESCRIBIR responde 409 explicado —
 *    nunca un 500 ni un guardado que se pierde en silencio;
 *  - un CFDI timbrado no deja bajar el estatus (409 VUELO_CON_CFDI);
 *  - el archivo se sube ANTES de guardar el path y el anterior se borra
 *    DESPUÉS (ningún fallo deja al vuelo apuntando a un archivo que no
 *    existe), y un fallo al guardar el path retira el archivo huérfano.
 */

const VUELO = 'aaaaaaaa-0000-4000-8000-00000000v001';
const USER = 'bbbbbbbb-0000-4000-8000-00000000u001';

type Res = { data?: unknown; error?: unknown };

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
  /** Columnas de la migración presentes (false = 42703 en el sondeo). */
  columnas?: boolean;
  /** Columnas del FOLIO (`20260924000001`); false = 42703 en su sondeo. */
  columnasFolio?: boolean;
  /** Fila del vuelo. */
  vuelo?: Record<string, unknown> | null;
  /** Nombre del usuario que subió el archivo. */
  usuario?: { id: string; nombre: string } | null;
  /** El UPDATE de `vuelo` falla. */
  errorUpdate?: string;
  /** El upload a Storage falla. */
  errorUpload?: string;
}

function armar(m: Mundo = {}) {
  const conColumnas = m.columnas !== false;
  const updates: Array<Record<string, unknown>> = [];
  const subidas: Array<{ path: string; bytes: number; tipo?: string }> = [];
  const borrados: string[][] = [];
  const firmados: Array<{ path: string; segundos: number }> = [];
  const selects: string[] = [];

  const service = {
    from(tabla: string) {
      const q: Record<string, unknown> = {};
      let columnasPedidas = '';
      const resolver = (): Res => {
        if (tabla === 'vuelo') {
          if (!conColumnas && columnasPedidas.includes('factura_estatus')) {
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column vuelo.factura_estatus does not exist',
              },
            };
          }
          if (
            m.columnasFolio === false &&
            columnasPedidas.includes('factura_folio')
          ) {
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column vuelo.factura_folio does not exist',
              },
            };
          }
          return { data: m.vuelo === undefined ? { id: VUELO } : m.vuelo };
        }
        if (tabla === 'usuario') return { data: m.usuario ? [m.usuario] : [] };
        return { data: null };
      };
      for (const met of METODOS) {
        q[met] = (...args: unknown[]) => {
          if (met === 'select') {
            columnasPedidas = typeof args[0] === 'string' ? args[0] : '';
            if (tabla === 'vuelo') selects.push(columnasPedidas);
          }
          if (met === 'update') {
            updates.push(args[0] as Record<string, unknown>);
          }
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
        if (tabla === 'vuelo' && updates.length > 0 && m.errorUpdate) {
          return Promise.resolve({
            data: null,
            error: { message: m.errorUpdate },
          }).then(res);
        }
        return Promise.resolve({
          data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [],
          error: r.error ?? null,
        }).then(res);
      };
      return q;
    },
    storage: {
      from() {
        return {
          upload: (
            path: string,
            buf: Buffer,
            opts?: { contentType?: string },
          ) => {
            if (m.errorUpload) {
              return Promise.resolve({ error: { message: m.errorUpload } });
            }
            subidas.push({
              path,
              bytes: buf.length,
              tipo: opts?.contentType,
            });
            return Promise.resolve({ error: null });
          },
          remove: (paths: string[]) => {
            borrados.push(paths);
            return Promise.resolve({ error: null });
          },
          createSignedUrl: (path: string, segundos: number) => {
            firmados.push({ path, segundos });
            return Promise.resolve({
              data: { signedUrl: `https://firmada/${path}` },
              error: null,
            });
          },
        };
      },
    },
  };

  const svc = new FacturaClienteService({
    service,
  } as unknown as SupabaseService);
  return { svc, updates, subidas, borrados, firmados, selects };
}

const pdf = (bytes = 100) => ({
  buffer: Buffer.alloc(bytes, 1),
  nombre: 'Factura A-1.pdf',
  mime: 'application/pdf',
});

describe('FacturaClienteService · migración PENDIENTE', () => {
  it('LEER sigue funcionando: se deriva de vuelo.facturado', async () => {
    const { svc } = armar({
      columnas: false,
      vuelo: { id: VUELO, facturado: true },
    });
    await expect(svc.bloqueDeVuelo(VUELO)).resolves.toEqual({
      estatus: 'FACTURADO',
      archivo: null,
      folio: null,
      uuid: null,
    });
  });

  it('ESCRIBIR responde 409 explicado (nunca 500 ni guardado perdido)', async () => {
    const { svc, updates } = armar({
      columnas: false,
      vuelo: { id: VUELO, facturado: false },
    });
    await expect(
      svc.setEstatus(VUELO, 'ELABORADA_ENVIADA', USER),
    ).rejects.toThrow(ConflictException);
    await expect(svc.subirArchivo(VUELO, pdf(), USER)).rejects.toThrow(
      ConflictException,
    );
    expect(updates).toHaveLength(0);
  });

  it('el 409 dice QUÉ migración falta', async () => {
    const { svc } = armar({ columnas: false, vuelo: { id: VUELO } });
    await expect(
      svc.setEstatus(VUELO, 'FACTURADO', USER),
    ).rejects.toMatchObject({
      response: {
        error: 'FACTURA_CLIENTE_NO_DISPONIBLE',
        details: { migracion: '20260923000001' },
      },
    });
  });

  it('pedir la URL del archivo ⇒ 404 (no hay columna donde tenerlo)', async () => {
    const { svc } = armar({ columnas: false, vuelo: { id: VUELO } });
    await expect(svc.archivoUrl(VUELO)).rejects.toThrow(
      'no tiene archivo de factura',
    );
  });
});

describe('FacturaClienteService · estatus', () => {
  it('mueve el estatus y devuelve el bloque', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'SIN_FACTURA' },
    });
    await svc.setEstatus(VUELO, 'ELABORADA_ENVIADA', USER);
    expect(updates[0]).toMatchObject({
      factura_estatus: 'ELABORADA_ENVIADA',
      updated_by: USER,
    });
  });

  it('con CFDI timbrado NO puede bajar: 409 VUELO_CON_CFDI y nada se escribe', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: true, factura_estatus: 'FACTURADO' },
    });
    await expect(
      svc.setEstatus(VUELO, 'SIN_FACTURA', USER),
    ).rejects.toMatchObject({ response: { error: 'VUELO_CON_CFDI' } });
    expect(updates).toHaveLength(0);
  });

  it('con CFDI timbrado, dejarlo en FACTURADO sí se permite (idempotente)', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: true, factura_estatus: 'FACTURADO' },
    });
    await svc.setEstatus(VUELO, 'FACTURADO', USER);
    expect(updates[0]).toMatchObject({ factura_estatus: 'FACTURADO' });
  });
});

describe('FacturaClienteService · archivo', () => {
  it('sube el archivo, guarda path/nombre/quién/cuándo y lo agrupa por vuelo', async () => {
    const { svc, updates, subidas } = armar({
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'SIN_FACTURA' },
    });
    await svc.subirArchivo(VUELO, pdf(), USER);
    expect(subidas[0].path).toMatch(
      new RegExp(`^vuelos/${VUELO}/[0-9a-f-]+\\.pdf$`),
    );
    expect(subidas[0].tipo).toBe('application/pdf');
    expect(updates[0]).toMatchObject({
      factura_archivo_nombre: 'Factura A-1.pdf',
      factura_archivo_subida_por: USER,
      updated_by: USER,
    });
    expect(updates[0].factura_archivo_path).toBe(subidas[0].path);
    expect(typeof updates[0].factura_archivo_subida_at).toBe('string');
  });

  it('reemplazar: primero sube el nuevo, luego guarda el path, y AL FINAL borra el viejo', async () => {
    const { svc, subidas, borrados } = armar({
      vuelo: {
        id: VUELO,
        facturado: false,
        factura_estatus: 'ELABORADA_ENVIADA',
        factura_archivo_path: 'vuelos/v/viejo.pdf',
      },
    });
    await svc.subirArchivo(VUELO, pdf(), USER);
    expect(subidas).toHaveLength(1);
    expect(borrados).toEqual([['vuelos/v/viejo.pdf']]);
  });

  it('si el UPDATE falla, el archivo huérfano se retira del bucket', async () => {
    const { svc, borrados, subidas } = armar({
      vuelo: { id: VUELO, facturado: false },
      errorUpdate: 'se cayó la BD',
    });
    await expect(svc.subirArchivo(VUELO, pdf(), USER)).rejects.toThrow(
      'se cayó la BD',
    );
    expect(borrados).toEqual([[subidas[0].path]]);
  });

  it('si el UPLOAD falla, no se escribe nada en el vuelo', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: false },
      errorUpload: 'bucket lleno',
    });
    await expect(svc.subirArchivo(VUELO, pdf(), USER)).rejects.toThrow(
      'No se pudo guardar la factura',
    );
    expect(updates).toHaveLength(0);
  });

  it('formato no permitido ⇒ 400 y NADA sube', async () => {
    const { svc, subidas } = armar({ vuelo: { id: VUELO, facturado: false } });
    await expect(
      svc.subirArchivo(
        VUELO,
        { buffer: Buffer.alloc(10), nombre: 'foto.jpg', mime: 'image/jpeg' },
        USER,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(subidas).toHaveLength(0);
  });

  it('quitar: limpia los cuatro campos y borra el objeto', async () => {
    const { svc, updates, borrados } = armar({
      vuelo: {
        id: VUELO,
        facturado: false,
        factura_estatus: 'ELABORADA_ENVIADA',
        factura_archivo_path: 'vuelos/v/uno.pdf',
      },
    });
    await svc.quitarArchivo(VUELO, USER);
    expect(updates[0]).toMatchObject({
      factura_archivo_path: null,
      factura_archivo_nombre: null,
      factura_archivo_subida_at: null,
      factura_archivo_subida_por: null,
    });
    // El ESTATUS no se toca: quitar el papel no es «ya no está facturado».
    expect(updates[0]).not.toHaveProperty('factura_estatus');
    expect(borrados).toEqual([['vuelos/v/uno.pdf']]);
  });

  it('quitar sin archivo ⇒ 404 y no se borra nada', async () => {
    const { svc, borrados } = armar({
      vuelo: { id: VUELO, facturado: false, factura_archivo_path: null },
    });
    await expect(svc.quitarArchivo(VUELO, USER)).rejects.toThrow(
      'no tiene archivo de factura que quitar',
    );
    expect(borrados).toHaveLength(0);
  });

  it('la URL se firma 10 min (el bucket es privado)', async () => {
    const { svc, firmados } = armar({
      vuelo: {
        id: VUELO,
        facturado: false,
        factura_archivo_path: 'vuelos/v/uno.pdf',
      },
    });
    await expect(svc.archivoUrl(VUELO)).resolves.toEqual({
      url: 'https://firmada/vuelos/v/uno.pdf',
    });
    expect(firmados).toEqual([{ path: 'vuelos/v/uno.pdf', segundos: 600 }]);
  });
});

describe('FacturaClienteService · lote del listado', () => {
  it('sin ids no consulta nada', async () => {
    const { svc } = armar();
    await expect(svc.bloquesDeVuelos([])).resolves.toEqual(new Map());
  });

  it('con la migración pendiente deriva cada fila de su `facturado`', async () => {
    const { svc } = armar({ columnas: false });
    const mapa = await svc.bloquesDeVuelos([
      { id: 'v1', facturado: true },
      { id: 'v2', facturado: false },
    ]);
    expect(mapa.get('v1')).toEqual({
      estatus: 'FACTURADO',
      archivo: null,
      folio: null,
      uuid: null,
    });
    expect(mapa.get('v2')).toEqual({
      estatus: 'SIN_FACTURA',
      archivo: null,
      folio: null,
      uuid: null,
    });
  });
});

describe('FacturaClienteService · CFDI timbrado', () => {
  it('marcarFacturadoPorCfdi escribe FACTURADO', async () => {
    const { svc, updates } = armar({ vuelo: { id: VUELO, facturado: true } });
    await svc.marcarFacturadoPorCfdi(VUELO, USER);
    expect(updates[0]).toMatchObject({ factura_estatus: 'FACTURADO' });
  });

  it('si falla, NO lanza (el timbre ya se consumió)', async () => {
    const { svc } = armar({
      vuelo: { id: VUELO, facturado: true },
      errorUpdate: 'se cayó la BD',
    });
    await expect(
      svc.marcarFacturadoPorCfdi(VUELO, USER),
    ).resolves.toBeUndefined();
  });

  it('con la migración pendiente tampoco lanza: la derivación ya dice FACTURADO', async () => {
    const { svc, updates } = armar({
      columnas: false,
      vuelo: { id: VUELO, facturado: true },
    });
    await expect(
      svc.marcarFacturadoPorCfdi(VUELO, USER),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

// ===================== FOLIO (24-sep-2026) =====================

const xmlCfdi = (serie: string, folio: string, uuid: string) => ({
  buffer: Buffer.from(
    `\uFEFF<?xml version="1.0" encoding="utf-8"?><cfdi:Comprobante Version="4.0" ` +
      `NoCertificado="0001" Serie="${serie}" Folio="${folio}" Total="1">` +
      `<cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}"/>` +
      `</cfdi:Complemento></cfdi:Comprobante>`,
    'utf8',
  ),
  nombre: 'FECMID-90255.xml',
  // Los navegadores mandan el XML como octet-stream más veces de las que se cree.
  mime: 'application/octet-stream',
});
const UUID_CFDI = 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E';

describe('FacturaClienteService · folio en el PATCH', () => {
  it('captura el folio SIN archivo (caso #297: FACTURADO sin papel)', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'FACTURADO' },
    });
    await svc.actualizar(VUELO, { folio: '  A-1234 ' }, USER);
    expect(updates[0]).toEqual({ factura_folio: 'A-1234', updated_by: USER });
  });

  it('estatus + folio en UNA escritura', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'SIN_FACTURA' },
    });
    await svc.actualizar(
      VUELO,
      { estatus: 'ELABORADA_ENVIADA', folio: 'B-7' },
      USER,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      factura_estatus: 'ELABORADA_ENVIADA',
      factura_folio: 'B-7',
    });
  });

  it('folio "" o null lo BORRA', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, factura_folio: 'A-1' },
    });
    await svc.actualizar(VUELO, { folio: '' }, USER);
    await svc.actualizar(VUELO, { folio: null }, USER);
    expect(updates.map((u) => u.factura_folio)).toEqual([null, null]);
  });

  it('sin estatus ni folio ⇒ 400 y nada se escribe', async () => {
    const { svc, updates } = armar({ vuelo: { id: VUELO } });
    await expect(svc.actualizar(VUELO, {}, USER)).rejects.toThrow(
      BadRequestException,
    );
    expect(updates).toHaveLength(0);
  });

  it('folio SIN la migración 20260924000001 ⇒ 409 explicado y NADA se escribe (ni el estatus)', async () => {
    const { svc, updates } = armar({
      columnasFolio: false,
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'SIN_FACTURA' },
    });
    await expect(
      svc.actualizar(VUELO, { estatus: 'FACTURADO', folio: 'A-1' }, USER),
    ).rejects.toMatchObject({
      response: {
        error: 'FACTURA_FOLIO_NO_DISPONIBLE',
        details: { migracion: '20260924000001' },
      },
    });
    expect(updates).toHaveLength(0);
  });

  it('sin la migración del folio, el ESTATUS solo sigue funcionando como hoy', async () => {
    const { svc, updates, selects } = armar({
      columnasFolio: false,
      vuelo: { id: VUELO, facturado: false, factura_estatus: 'SIN_FACTURA' },
    });
    const bloque = await svc.setEstatus(VUELO, 'FACTURADO', USER);
    expect(updates[0]).toEqual({
      factura_estatus: 'FACTURADO',
      updated_by: USER,
    });
    expect(bloque.folio).toBeNull();
    // Nunca se pide la columna que no existe fuera de la sonda.
    expect(
      selects.filter(
        (x) => x.includes('factura_folio') && x !== 'factura_folio',
      ),
    ).toEqual([]);
  });

  it('el bloque devuelto trae el folio guardado', async () => {
    const { svc } = armar({
      vuelo: {
        id: VUELO,
        factura_estatus: 'FACTURADO',
        factura_folio: 'A-1234',
        factura_uuid: null,
      },
    });
    await expect(svc.bloqueDeVuelo(VUELO)).resolves.toMatchObject({
      estatus: 'FACTURADO',
      folio: 'A-1234',
      uuid: null,
    });
  });
});

describe('FacturaClienteService · folio al subir el archivo', () => {
  it('XML del CFDI: saca SERIE-FOLIO y el UUID solos', async () => {
    const { svc, updates, subidas } = armar({
      vuelo: { id: VUELO, facturado: false },
    });
    await svc.subirArchivo(
      VUELO,
      xmlCfdi('FECMID', '90255', UUID_CFDI.toLowerCase()),
      USER,
    );
    expect(subidas[0].tipo).toBe('application/xml');
    expect(updates[0]).toMatchObject({
      factura_folio: 'FECMID-90255',
      factura_uuid: UUID_CFDI,
    });
  });

  it('el folio TECLEADO gana sobre el del XML', async () => {
    const { svc, updates } = armar({ vuelo: { id: VUELO } });
    await svc.subirArchivo(VUELO, xmlCfdi('FECMID', '90255', UUID_CFDI), USER, {
      folio: 'VT-77',
    });
    expect(updates[0]).toMatchObject({
      factura_folio: 'VT-77',
      factura_uuid: UUID_CFDI,
    });
  });

  it('PDF con folio tecleado: lo guarda', async () => {
    const { svc, updates } = armar({ vuelo: { id: VUELO } });
    await svc.subirArchivo(VUELO, pdf(), USER, { folio: 'A-1' });
    expect(updates[0]).toMatchObject({ factura_folio: 'A-1' });
    expect(updates[0]).not.toHaveProperty('factura_uuid');
  });

  it('PDF SIN folio: CONSERVA el folio que ya tenía (reemplazar el papel no borra el dato)', async () => {
    const { svc, updates } = armar({
      vuelo: { id: VUELO, factura_folio: 'A-1', factura_uuid: UUID_CFDI },
    });
    await svc.subirArchivo(VUELO, pdf(), USER);
    expect(updates[0]).not.toHaveProperty('factura_folio');
    expect(updates[0]).not.toHaveProperty('factura_uuid');
  });

  it('folio tecleado SIN la migración del folio ⇒ 409 y NADA sube', async () => {
    const { svc, updates, subidas } = armar({
      columnasFolio: false,
      vuelo: { id: VUELO },
    });
    await expect(
      svc.subirArchivo(VUELO, pdf(), USER, { folio: 'A-1' }),
    ).rejects.toMatchObject({
      response: { error: 'FACTURA_FOLIO_NO_DISPONIBLE' },
    });
    expect(subidas).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('XML SIN la migración del folio: el archivo se sube como hoy y el folio no se escribe', async () => {
    const { svc, updates, subidas } = armar({
      columnasFolio: false,
      vuelo: { id: VUELO },
    });
    await svc.subirArchivo(VUELO, xmlCfdi('A', '1', UUID_CFDI), USER);
    expect(subidas).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('factura_folio');
    expect(updates[0]).not.toHaveProperty('factura_uuid');
    expect(updates[0]).toHaveProperty('factura_archivo_path');
  });

  it('más de 10 MB ⇒ 413 ARCHIVO_MUY_GRANDE con el peso, y NADA sube', async () => {
    const { svc, subidas } = armar({ vuelo: { id: VUELO } });
    const bytes = Math.round(10.4 * 1024 * 1024);
    const err = await svc
      .subirArchivo(VUELO, pdf(bytes), USER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err).toMatchObject({
      response: {
        error: 'ARCHIVO_MUY_GRANDE',
        message: 'El archivo pesa 10.4 MB y el máximo son 10 MB.',
        details: { bytes, limite_bytes: 10 * 1024 * 1024 },
      },
    });
    expect(subidas).toHaveLength(0);
  });
});
