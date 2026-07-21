import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { FilaCombustibleCruda } from '../pyservices/pyservices.service';
import { ExpensesService } from './expenses.service';
import { Rol } from '../../common/types/auth.types';
import {
  CategoriaGasto,
  EstatusComprobante,
  MedioPago,
  Moneda,
  TipoCombustible,
} from './dto/expenses.dto';
import { MAX_FILAS_COMBUSTIBLE } from './dto/combustible-masivo.dto';
import type {
  CargaMasivaCombustibleDto,
  CargaMasivaCombustibleResult,
  FilaCombustibleDto,
  FilaPreviewCombustible,
  PreviewCargaCombustibleDto,
  PreviewCargaCombustibleResult,
} from './dto/combustible-masivo.dto';

interface AeronaveCat {
  id: string;
  matricula: string;
  activa: boolean;
}
interface ProveedorCat {
  id: string;
  nombre: string;
}
interface VueloCat {
  id: string;
  folio: number;
  aeronave_id: string | null;
  matricula: string | null;
}

/**
 * Carga masiva de combustibles desde Excel (doc 5.3): la oficina descarga la
 * plantilla con los catálogos reales, la llena, y el sistema valida TODO
 * contra el negocio antes de crear un solo gasto. El preview nunca escribe;
 * la carga definitiva RE-VALIDA cada fila (no se confía en el cliente) y
 * crea gasto por gasto vía ExpensesService.create (hereda origen OFICINA,
 * detección de duplicados y las reglas del gasto normal).
 */
@Injectable()
export class CombustibleMasivoService {
  private readonly logger = new Logger(CombustibleMasivoService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly expenses: ExpensesService,
  ) {}

  /** Plantilla XLSX con catálogos reales (pyservices la dibuja). */
  async plantillaXlsx(): Promise<Buffer> {
    const [avRes, prRes] = await Promise.all([
      this.supabase.service
        .from('aeronave')
        .select('matricula')
        .eq('activa', true)
        .order('matricula', { ascending: true }),
      this.supabase.service
        .from('proveedor')
        .select('nombre')
        .eq('activo', true)
        .order('nombre', { ascending: true }),
    ]);
    if (avRes.error) throw new Error(avRes.error.message);
    if (prRes.error) throw new Error(prRes.error.message);
    return this.pyservices.generarPlantillaCombustible({
      matriculas: (avRes.data ?? []).map((a) => a.matricula as string),
      proveedores: (prRes.data ?? []).map((p) => p.nombre as string),
      medios_pago: Object.values(MedioPago),
      monedas: Object.values(Moneda),
      tipos_combustible: Object.values(TipoCombustible),
    });
  }

  /**
   * Valida el archivo SIN crear nada: pyservices lee el Excel (valores
   * crudos) y aquí se resuelve cada fila contra el negocio — matrícula→
   * aeronave, folio→vuelo, proveedor por nombre, fechas Cancún, duplicados.
   */
  async preview(
    dto: PreviewCargaCombustibleDto,
  ): Promise<PreviewCargaCombustibleResult> {
    const parsed = await this.pyservices.parseCombustible(
      dto.archivo_base64,
      dto.filename,
    );
    const crudas = parsed?.filas ?? [];
    if (crudas.length === 0) {
      throw new BadRequestException(
        'El archivo no contiene filas de datos. Llena la plantilla y vuelve a subirla.',
      );
    }
    if (crudas.length > MAX_FILAS_COMBUSTIBLE) {
      throw new BadRequestException(
        `El archivo tiene ${crudas.length} filas; el máximo por carga es ${MAX_FILAS_COMBUSTIBLE}. Divide el archivo.`,
      );
    }

    const [aeronaves, proveedores] = await Promise.all([
      this.loadAeronaves(),
      this.loadProveedores(),
    ]);
    const vuelosPorFolio = await this.loadVuelosPorFolio(crudas);

    const hoy = this.hoyCancun();
    const filas = crudas.map((f) =>
      this.normalizarFila(f, aeronaves, proveedores, vuelosPorFolio, hoy),
    );

    await this.marcarPosiblesDuplicados(filas);

    const conError = filas.filter((r) => r.errores.length > 0).length;
    return {
      filas,
      resumen: {
        total: filas.length,
        validas: filas.length - conError,
        con_error: conError,
        con_advertencia: filas.filter((r) => r.advertencias.length > 0).length,
      },
    };
  }

  /**
   * Crea los gastos GAS de las filas (normalizadas por el preview). Cada
   * fila se RE-VALIDA en servidor; se procesan TODAS aunque alguna falle —
   * nada de mitades silenciosas: la respuesta dice exactamente qué se creó
   * y qué no (con su fila y su motivo).
   */
  async cargaMasiva(
    dto: CargaMasivaCombustibleDto,
    userId: string,
    rol: Rol,
  ): Promise<CargaMasivaCombustibleResult> {
    const hoy = this.hoyCancun();

    // Existencia de referencias, en lote (el preview NO es autorización).
    const aeronaveIds = [...new Set(dto.filas.map((f) => f.aeronave_id))];
    const vueloIds = [
      ...new Set(
        dto.filas.map((f) => f.vuelo_id).filter((v): v is string => !!v),
      ),
    ];
    const provIds = [
      ...new Set(
        dto.filas.map((f) => f.proveedor_id).filter((v): v is string => !!v),
      ),
    ];

    const { data: avData, error: avErr } = await this.supabase.service
      .from('aeronave')
      .select('id')
      .in('id', aeronaveIds);
    if (avErr) throw new Error(avErr.message);
    const aeronavesOk = new Set((avData ?? []).map((a) => a.id as string));

    let vuelosOk = new Set<string>();
    if (vueloIds.length > 0) {
      const { data, error } = await this.supabase.service
        .from('vuelo')
        .select('id')
        .in('id', vueloIds);
      if (error) throw new Error(error.message);
      vuelosOk = new Set((data ?? []).map((v) => v.id as string));
    }
    let proveedoresOk = new Set<string>();
    if (provIds.length > 0) {
      const { data, error } = await this.supabase.service
        .from('proveedor')
        .select('id')
        .in('id', provIds);
      if (error) throw new Error(error.message);
      proveedoresOk = new Set((data ?? []).map((p) => p.id as string));
    }

    const errores: Array<{ fila: number; error: string }> = [];
    let creados = 0;
    // En orden y una por una: si una fila falla, las demás siguen.
    for (const fila of dto.filas) {
      const errs = this.revalidarFila(
        fila,
        hoy,
        aeronavesOk,
        vuelosOk,
        proveedoresOk,
      );
      if (errs.length > 0) {
        errores.push({ fila: fila.fila, error: errs.join(' ') });
        continue;
      }
      try {
        await this.expenses.create(
          {
            categoria: CategoriaGasto.GAS,
            monto: fila.monto,
            moneda: fila.moneda,
            tc_gasto: fila.tc_gasto,
            fecha_gasto: fila.fecha_gasto,
            medio_pago: fila.medio_pago,
            vuelo_id: fila.vuelo_id,
            aeronave_id: fila.aeronave_id,
            proveedor_id: fila.proveedor_id,
            litros: fila.litros,
            tipo_combustible: fila.tipo_combustible,
            lugar: fila.lugar,
            fecha_hora_carga: fila.fecha_hora_carga,
            estatus_comprobante: fila.estatus_comprobante,
            notas: fila.notas,
          },
          userId,
          rol,
          // Sin push por fila: una carga de 50 renglones no debe disparar 50
          // avisos a admin (el propio admin es quien la está haciendo).
          { notificar: false },
        );
        creados += 1;
      } catch (err) {
        errores.push({
          fila: fila.fila,
          error:
            err instanceof Error ? err.message : 'No se pudo crear el gasto.',
        });
      }
    }

    this.logger.log(
      `Carga masiva de combustibles: ${creados} gastos creados, ${errores.length} filas con error (usuario ${userId})`,
    );
    return { creados, errores };
  }

  // ===== Normalización y validación =====

  private normalizarFila(
    f: FilaCombustibleCruda,
    aeronaves: Map<string, AeronaveCat>,
    proveedores: Map<string, ProveedorCat>,
    vuelosPorFolio: Map<number, VueloCat>,
    hoy: string,
  ): FilaPreviewCombustible {
    const errores: string[] = [];
    const advertencias: string[] = [];
    const datos: Partial<FilaCombustibleDto> = { fila: f.fila };

    // Matrícula → aeronave (case-insensitive, ignora guiones/espacios).
    const matCruda = (f.matricula ?? '').trim();
    if (!matCruda) {
      errores.push('Falta la matrícula.');
    } else {
      const av = aeronaves.get(this.normMatricula(matCruda));
      if (!av) {
        errores.push(`La matrícula '${matCruda}' no existe en la flota.`);
      } else {
        datos.aeronave_id = av.id;
        datos.matricula = av.matricula;
        if (!av.activa) {
          advertencias.push(`La aeronave ${av.matricula} está inactiva.`);
        }
      }
    }

    // Fecha (día Cancún) + hora → fecha_gasto / fecha_hora_carga.
    const fecha = (f.fecha ?? '').trim();
    if (!fecha) {
      errores.push('Falta la fecha.');
    } else if (!this.fechaValida(fecha)) {
      errores.push(`Fecha inválida '${fecha}' (usa AAAA-MM-DD).`);
    } else if (fecha > hoy) {
      errores.push(`La fecha ${fecha} es futura (hoy Cancún: ${hoy}).`);
    } else {
      datos.fecha_gasto = fecha;
      const hora = (f.hora ?? '').trim();
      if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
        errores.push(`Hora inválida '${hora}' (usa HH:MM, 24 hrs).`);
      } else {
        // Sin hora en el Excel: mediodía Cancún (el día no se mueve de mes).
        datos.fecha_hora_carga = `${fecha}T${hora || '12:00'}:00-05:00`;
      }
    }

    // Litros y monto (> 0; el check de la BD también lo exige).
    const litros = f.litros == null ? NaN : Number(f.litros);
    if (f.litros == null) errores.push('Faltan los litros.');
    else if (!Number.isFinite(litros) || litros <= 0)
      errores.push('Los litros deben ser un número mayor a 0.');
    else datos.litros = Math.round(litros * 100) / 100;

    const monto = f.monto == null ? NaN : Number(f.monto);
    if (f.monto == null) errores.push('Falta el monto.');
    else if (!Number.isFinite(monto) || monto <= 0)
      errores.push('El monto debe ser un número mayor a 0.');
    else datos.monto = Math.round(monto * 100) / 100;

    // Moneda y tipo de cambio.
    const mon = (f.moneda ?? '').trim().toUpperCase();
    if (!mon) errores.push('Falta la moneda (MXN o USD).');
    else if (!(Object.values(Moneda) as string[]).includes(mon))
      errores.push(`Moneda '${f.moneda ?? ''}' inválida (MXN o USD).`);
    else datos.moneda = mon as Moneda;

    if (f.tipo_cambio != null) {
      const tc = Number(f.tipo_cambio);
      if (!Number.isFinite(tc) || tc <= 0)
        errores.push('El tipo de cambio debe ser mayor a 0.');
      else datos.tc_gasto = Math.round(tc * 10000) / 10000;
    }
    if (datos.moneda === Moneda.MXN && datos.tc_gasto == null) {
      advertencias.push(
        'Carga en MXN sin tipo de cambio: queda fuera del balance USD hasta capturar su TC.',
      );
    }

    // Tipo de combustible (opcional; si viene, debe ser del catálogo).
    const tipo = (f.tipo_combustible ?? '').trim().toUpperCase();
    if (tipo) {
      if ((Object.values(TipoCombustible) as string[]).includes(tipo))
        datos.tipo_combustible = tipo as TipoCombustible;
      else
        errores.push(
          `Tipo de combustible '${f.tipo_combustible ?? ''}' inválido (TURBOSINA o AVGAS).`,
        );
    }

    const lugar = (f.lugar ?? '').trim();
    if (lugar) datos.lugar = lugar;

    // Medio de pago (enum exacto del gasto).
    const medio = (f.medio_pago ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '_');
    if (!medio) errores.push('Falta el medio de pago.');
    else if (!(Object.values(MedioPago) as string[]).includes(medio))
      errores.push(
        `Medio de pago '${f.medio_pago ?? ''}' inválido (${Object.values(MedioPago).join(', ')}).`,
      );
    else datos.medio_pago = medio as MedioPago;

    // Folio de vuelo (opcional) → vuelo_id; avisar si es de OTRA aeronave.
    const folioRaw = f.folio_vuelo;
    if (folioRaw != null && String(folioRaw).trim() !== '') {
      const folio = Number(String(folioRaw).trim().replace(/^#/, ''));
      if (!Number.isInteger(folio) || folio <= 0) {
        errores.push(`Folio de vuelo '${String(folioRaw)}' inválido.`);
      } else {
        const v = vuelosPorFolio.get(folio);
        if (!v) {
          errores.push(`No existe un vuelo con folio ${folio}.`);
        } else {
          datos.vuelo_id = v.id;
          datos.folio_vuelo = folio;
          if (
            datos.aeronave_id &&
            v.aeronave_id &&
            v.aeronave_id !== datos.aeronave_id
          ) {
            advertencias.push(
              `El vuelo #${folio} es de otra aeronave (${v.matricula ?? 'sin matrícula'}).`,
            );
          }
        }
      }
    }

    // Proveedor por nombre normalizado. Si no existe NO se crea: solo aviso.
    const provNombre = (f.proveedor ?? '').trim();
    if (provNombre) {
      const p = proveedores.get(this.normNombre(provNombre));
      if (p) {
        datos.proveedor_id = p.id;
        datos.proveedor_nombre = p.nombre;
      } else {
        advertencias.push(
          `El proveedor '${provNombre}' no está en el catálogo: el gasto se creará sin proveedor.`,
        );
      }
    }

    // Comprobante de la plantilla → enum real del gasto.
    const comp = this.mapComprobante(f.comprobante);
    if (comp === undefined) {
      errores.push(
        `Comprobante '${f.comprobante ?? ''}' inválido (FACTURA, TICKET o PENDIENTE).`,
      );
    } else {
      datos.estatus_comprobante = comp;
    }

    const notas = (f.notas ?? '').trim();
    if (notas) datos.notas = notas;

    return {
      fila: f.fila,
      ok: errores.length === 0,
      errores,
      advertencias,
      datos,
    };
  }

  /** Re-validación de negocio en la carga definitiva (los tipos/enums ya los garantizó el DTO). */
  private revalidarFila(
    fila: FilaCombustibleDto,
    hoy: string,
    aeronavesOk: Set<string>,
    vuelosOk: Set<string>,
    proveedoresOk: Set<string>,
  ): string[] {
    const errs: string[] = [];
    if (!aeronavesOk.has(fila.aeronave_id)) errs.push('La aeronave no existe.');
    if (!this.fechaValida(fila.fecha_gasto)) {
      errs.push(`Fecha inválida '${fila.fecha_gasto}' (usa AAAA-MM-DD).`);
    } else if (fila.fecha_gasto > hoy) {
      errs.push(`La fecha ${fila.fecha_gasto} es futura (hoy Cancún: ${hoy}).`);
    }
    if (!(fila.litros > 0)) errs.push('Los litros deben ser mayores a 0.');
    if (!(fila.monto > 0)) errs.push('El monto debe ser mayor a 0.');
    if (fila.tc_gasto != null && !(fila.tc_gasto > 0))
      errs.push('El tipo de cambio debe ser mayor a 0.');
    if (fila.vuelo_id && !vuelosOk.has(fila.vuelo_id))
      errs.push('El vuelo ligado no existe.');
    if (fila.proveedor_id && !proveedoresOk.has(fila.proveedor_id))
      errs.push('El proveedor ligado no existe.');
    const dia = this.diaCancun(fila.fecha_hora_carga);
    if (!dia) {
      errs.push('fecha_hora_carga inválida (usa ISO 8601).');
    } else if (dia !== fila.fecha_gasto) {
      errs.push(
        `fecha_hora_carga cae en ${dia} (día Cancún) pero fecha_gasto es ${fila.fecha_gasto}.`,
      );
    }
    return errs;
  }

  /**
   * Advertencia de posible duplicado: ya existe un gasto GAS de esa aeronave
   * con la MISMA fecha y el mismo monto (±0.01). También marca filas
   * repetidas dentro del propio archivo (misma aeronave+fecha+monto).
   */
  private async marcarPosiblesDuplicados(
    filas: FilaPreviewCombustible[],
  ): Promise<void> {
    const conClave = filas.filter(
      (r) =>
        r.datos.aeronave_id != null &&
        r.datos.fecha_gasto != null &&
        r.datos.monto != null,
    );
    if (conClave.length === 0) return;

    const { data: existentes, error } = await this.supabase.service
      .from('gasto')
      .select('aeronave_id, fecha_gasto, monto')
      .eq('categoria', 'GAS')
      .in('aeronave_id', [
        ...new Set(conClave.map((r) => r.datos.aeronave_id!)),
      ])
      .in('fecha_gasto', [
        ...new Set(conClave.map((r) => r.datos.fecha_gasto!)),
      ]);
    if (error) throw new Error(error.message);

    for (const r of conClave) {
      const dup = (existentes ?? []).some(
        (g) =>
          g.aeronave_id === r.datos.aeronave_id &&
          g.fecha_gasto === r.datos.fecha_gasto &&
          Math.abs(Number(g.monto) - r.datos.monto!) <= 0.01,
      );
      if (dup) {
        r.advertencias.push(
          `Posible duplicado: ya existe un gasto GAS de ${r.datos.matricula ?? 'esta aeronave'} el ${r.datos.fecha_gasto} por el mismo monto.`,
        );
      }
    }

    const vistos = new Map<string, number>();
    for (const r of conClave) {
      const key = `${r.datos.aeronave_id}|${r.datos.fecha_gasto}|${r.datos.monto!.toFixed(2)}`;
      const primera = vistos.get(key);
      if (primera != null) {
        r.advertencias.push(
          `Fila repetida en el archivo (misma matrícula, fecha y monto que la fila ${primera}).`,
        );
      } else {
        vistos.set(key, r.fila);
      }
    }
  }

  // ===== Catálogos =====

  private async loadAeronaves(): Promise<Map<string, AeronaveCat>> {
    // TODAS (no solo activas): una carga histórica de un avión hoy inactivo
    // debe entrar — con advertencia, no con error.
    const { data, error } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula, activa');
    if (error) throw new Error(error.message);
    const map = new Map<string, AeronaveCat>();
    for (const a of data ?? []) {
      map.set(this.normMatricula(a.matricula as string), {
        id: a.id as string,
        matricula: a.matricula as string,
        activa: a.activa !== false,
      });
    }
    return map;
  }

  private async loadProveedores(): Promise<Map<string, ProveedorCat>> {
    const { data, error } = await this.supabase.service
      .from('proveedor')
      .select('id, nombre');
    if (error) throw new Error(error.message);
    const map = new Map<string, ProveedorCat>();
    for (const p of data ?? []) {
      const key = this.normNombre(p.nombre as string);
      if (key && !map.has(key)) {
        map.set(key, { id: p.id as string, nombre: p.nombre as string });
      }
    }
    return map;
  }

  private async loadVuelosPorFolio(
    crudas: FilaCombustibleCruda[],
  ): Promise<Map<number, VueloCat>> {
    const folios = [
      ...new Set(
        crudas
          .map((f) =>
            f.folio_vuelo == null
              ? NaN
              : Number(String(f.folio_vuelo).trim().replace(/^#/, '')),
          )
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
    const map = new Map<number, VueloCat>();
    if (folios.length === 0) return map;
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(
        'id, folio, aeronave_id, aeronave:aeronave!aeronave_id(matricula)',
      )
      .in('folio', folios);
    if (error) throw new Error(error.message);
    for (const v of data ?? []) {
      const a = v.aeronave as
        | { matricula?: string }
        | { matricula?: string }[]
        | null;
      const matricula = Array.isArray(a)
        ? (a[0]?.matricula ?? null)
        : (a?.matricula ?? null);
      map.set(Number(v.folio), {
        id: v.id as string,
        folio: Number(v.folio),
        aeronave_id: (v.aeronave_id as string | null) ?? null,
        matricula,
      });
    }
    return map;
  }

  // ===== Utilerías =====

  private normMatricula(s: string): string {
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** Nombre normalizado: sin acentos, mayúsculas, solo alfanumérico. */
  private normNombre(s: string): string {
    return s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();
  }

  /** Hoy en día Cancún (UTC−5): las fechas del Excel se comparan contra esto. */
  private hoyCancun(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(new Date());
  }

  private diaCancun(iso: string): string | null {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Cancun',
    }).format(d);
  }

  /** 'YYYY-MM-DD' real (rechaza 2026-02-30 y formatos raros). */
  private fechaValida(f: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
    const d = new Date(`${f}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
  }

  /**
   * Comprobante de la plantilla → enum estatus_comprobante de la BD
   * (FACTURA/VALE/SIN_COMPROBANTE). TICKET equivale a VALE; PENDIENTE (o
   * vacío) = SIN_COMPROBANTE. undefined = valor inválido.
   */
  private mapComprobante(v: string | null): EstatusComprobante | undefined {
    const s = (v ?? '').trim().toUpperCase().replace(/\s+/g, '_');
    if (!s || s === 'PENDIENTE' || s === 'SIN_COMPROBANTE')
      return EstatusComprobante.SIN_COMPROBANTE;
    if (s === 'FACTURA') return EstatusComprobante.FACTURA;
    if (s === 'TICKET' || s === 'VALE') return EstatusComprobante.VALE;
    return undefined;
  }
}
