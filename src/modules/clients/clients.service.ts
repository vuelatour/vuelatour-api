import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { MENSAJE_ALIAS_INVALIDO } from '../../common/clave-cliente.util';
import {
  errorIdClienteNoDisponible,
  idClienteDisponible,
} from '../../common/id-cliente-disponible.util';
import type {
  CreateClienteDto,
  ListClientesQuery,
  SetTarifasClienteDto,
  UpdateClienteDto,
} from './dto/clients.dto';

// Incluye los datos fiscales CFDI 4.0 del cliente (régimen, uso, CP) y los de
// captura de la constancia (domicilio_fiscal, pais_residencia — extranjeros):
// el panel los edita y la facturación los exige antes de timbrar.
const COLS =
  'id, nombre, telefono, email, razon_social_default, rfc, regimen_fiscal_receptor, uso_cfdi, codigo_postal, domicilio_fiscal, pais_residencia, canal_origen, es_broker, es_interno, notas, activo, created_at, updated_at';

/**
 * Columnas de la fila del cliente según la sonda del ID de vuelo por cliente
 * (13-oct-2026, invariante 68): con la migración 20261013000006 se suma
 * `alias`; sin ella, `COLS` byte a byte (REGLA DURA de la sonda). String
 * plano: el select dinámico no se tipa desde el literal.
 */
function colsDe(conAlias: boolean): string {
  return conAlias ? `${COLS}, alias` : COLS;
}

/** Alias por consulta `.in()` de `alias_compartido_con` (tope de URL). */
const LOTE_ALIAS = 150;
/** Máximo de nombres en `alias_compartido_con`. */
const MAX_ALIAS_COMPARTIDO = 5;

/** Fila de `cliente` tal como sale del select dinámico. */
type FilaCliente = Record<string, unknown> & { id?: unknown; alias?: unknown };

/** ¿Es el CHECK `cliente_alias_chk` (23514)? Red de seguridad del DTO. */
function esAliasInvalido(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return (
    err?.code === '23514' && (err.message ?? '').includes('cliente_alias_chk')
  );
}

/** 400 `ALIAS_INVALIDO` con el MISMO texto que el DTO. */
function errorAliasInvalido(): BadRequestException {
  return new BadRequestException({
    error: 'ALIAS_INVALIDO',
    message: MENSAJE_ALIAS_INVALIDO,
  });
}

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Lista de clientes. ID DE VUELO POR CLIENTE (13-oct-2026, invariante 68,
   * ADITIVO): con la migración cada fila suma `alias` y
   * `alias_compartido_con` (nombres de OTROS clientes con el mismo alias) y
   * `q` también busca en el alias; `alias_disponible` (al FINAL) dice si la
   * migración está (el panel ofrece el campo solo con true). Sin ella, las
   * filas son byte a byte las del 0.0.74.
   */
  async list(filters: ListClientesQuery) {
    const conAlias = await idClienteDisponible(this.supabase.service);
    let q = this.supabase.service
      .from('cliente')
      .select(colsDe(conAlias), { count: 'exact' })
      .order('nombre', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);

    if (typeof filters.activo === 'boolean') q = q.eq('activo', filters.activo);
    else q = q.eq('activo', true);
    if (filters.canal_origen) q = q.eq('canal_origen', filters.canal_origen);
    if (typeof filters.es_broker === 'boolean')
      q = q.eq('es_broker', filters.es_broker);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `nombre.ilike.${term},email.ilike.${term},telefono.ilike.${term},rfc.ilike.${term}${
          conAlias ? `,alias.ilike.${term}` : ''
        }`,
      );
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as unknown as FilaCliente[];
    return {
      data: conAlias ? await this.conAliasCompartido(filas) : filas,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
      alias_disponible: conAlias,
    };
  }

  async findById(id: string) {
    const conAlias = await idClienteDisponible(this.supabase.service);
    const { data, error } = await this.supabase.service
      .from('cliente')
      .select(colsDe(conAlias))
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return this.filaDeRespuesta(data as unknown as FilaCliente, conAlias);
  }

  async create(dto: CreateClienteDto, createdBy: string) {
    const conAlias = await idClienteDisponible(this.supabase.service);
    // Un alias (aunque sea null = «el sugerido») sin la migración: 503 ANTES
    // de escribir (jamás un 500 por columna inexistente).
    if (dto.alias !== undefined && !conAlias) {
      throw errorIdClienteNoDisponible();
    }
    const { data, error } = await this.supabase.service
      .from('cliente')
      .insert({ ...dto, created_by: createdBy, updated_by: createdBy })
      .select(colsDe(conAlias))
      .maybeSingle();
    if (error) {
      if (esAliasInvalido(error)) throw errorAliasInvalido();
      if (error.code === '23505')
        throw new BadRequestException('Conflict — cliente already exists');
      throw new Error(error.message);
    }
    return this.filaDeRespuesta(data as unknown as FilaCliente, conAlias);
  }

  async update(id: string, dto: UpdateClienteDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const conAlias = await idClienteDisponible(this.supabase.service);
    if (dto.alias !== undefined && !conAlias) {
      throw errorIdClienteNoDisponible();
    }
    // `alias: null` viaja TAL CUAL: el trigger lo recalcula del nombre actual.
    const { data, error } = await this.supabase.service
      .from('cliente')
      .update({ ...dto, updated_by: updatedBy })
      .eq('id', id)
      .select(colsDe(conAlias))
      .maybeSingle();
    if (error) {
      if (esAliasInvalido(error)) throw errorAliasInvalido();
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Cliente ${id} not found`);
    return this.filaDeRespuesta(data as unknown as FilaCliente, conAlias);
  }

  /**
   * `GET /v1/clients/alias-en-uso` (13-oct-2026, invariante 68): clientes que
   * ya usan el alias (activos E inactivos), por nombre, sin el que se está
   * editando. Sin la migración ⇒ 503. Un error de lectura se LANZA (el panel
   * no muestra aviso y no bloquea).
   */
  async aliasEnUso(
    alias: string,
    excluir?: string,
  ): Promise<{
    alias: string;
    clientes: Array<{ id: string; nombre: string; activo: boolean }>;
  }> {
    if (!(await idClienteDisponible(this.supabase.service))) {
      throw errorIdClienteNoDisponible();
    }
    let q = this.supabase.service
      .from('cliente')
      .select('id, nombre, activo')
      .eq('alias', alias)
      .order('nombre', { ascending: true });
    if (excluir) q = q.neq('id', excluir);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      alias,
      clientes: ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
        id: c.id as string,
        nombre: c.nombre as string,
        activo: c.activo === true,
      })),
    };
  }

  /** La fila tal cual (sin migración) o con `alias_compartido_con`. */
  private async filaDeRespuesta(
    fila: FilaCliente,
    conAlias: boolean,
  ): Promise<FilaCliente> {
    if (!conAlias) return fila;
    return (await this.conAliasCompartido([fila]))[0];
  }

  /**
   * `alias_compartido_con` por fila (13-oct-2026, invariante 68): nombres
   * (recortados) de OTROS clientes —activos o no, de TODO el catálogo, no de
   * la página filtrada— con el mismo alias, en orden es-MX, máximo 5; [] si
   * nadie más lo usa. Una lectura en lotes de 150 alias, en paralelo. Si
   * alguna falla ⇒ `warn` y null en TODAS las filas: «no se sabe» nunca se
   * disfraza de «nadie» (jamás un [] falso).
   */
  private async conAliasCompartido<T extends { id?: unknown; alias?: unknown }>(
    filas: T[],
  ): Promise<Array<T & { alias_compartido_con: string[] | null }>> {
    const aliases = [
      ...new Set(
        filas
          .map((f) => f.alias)
          .filter((a): a is string => typeof a === 'string' && a !== ''),
      ),
    ];
    if (aliases.length === 0) {
      return filas.map((f) => ({ ...f, alias_compartido_con: [] }));
    }
    const porAlias = new Map<string, Array<{ id: unknown; nombre: string }>>();
    try {
      const lotes: string[][] = [];
      for (let i = 0; i < aliases.length; i += LOTE_ALIAS) {
        lotes.push(aliases.slice(i, i + LOTE_ALIAS));
      }
      const resultados = await Promise.all(
        lotes.map((lote) =>
          this.supabase.service
            .from('cliente')
            .select('id, nombre, alias')
            .in('alias', lote),
        ),
      );
      for (const r of resultados) {
        if (r.error) throw new Error(r.error.message);
        for (const c of (r.data ?? []) as Array<Record<string, unknown>>) {
          if (typeof c.alias !== 'string') continue;
          const nombre = typeof c.nombre === 'string' ? c.nombre.trim() : '';
          const lista = porAlias.get(c.alias) ?? [];
          lista.push({ id: c.id, nombre });
          porAlias.set(c.alias, lista);
        }
      }
    } catch (e) {
      this.logger.warn(
        `alias_compartido_con: no se pudo leer (${
          e instanceof Error ? e.message : String(e)
        }); se omite`,
      );
      return filas.map((f) => ({ ...f, alias_compartido_con: null }));
    }
    return filas.map((f) => {
      const otros =
        typeof f.alias === 'string'
          ? (porAlias.get(f.alias) ?? [])
              .filter((c) => c.id !== f.id && c.nombre !== '')
              .map((c) => c.nombre)
              .sort((a, b) => a.localeCompare(b, 'es-MX'))
              .slice(0, MAX_ALIAS_COMPARTIDO)
          : [];
      return { ...f, alias_compartido_con: otros };
    });
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activo: false }, updatedBy);
  }

  // ===== Tarifas preferenciales por aeronave =====
  // Si el cliente tiene tarifa pactada para un avión, el cotizador la usa en
  // lugar de la default (público/broker). Ver quotes.service.calculate().

  async listTarifas(clienteId: string) {
    await this.findById(clienteId);
    const { data, error } = await this.supabase.service
      .from('tarifa_cliente_aeronave')
      .select(
        'id, aeronave_id, tarifa_hora_usd, aeronave:aeronave!aeronave_id(matricula, modelo)',
      )
      .eq('cliente_id', clienteId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /** Reemplaza el set completo de tarifas preferenciales del cliente. */
  async setTarifas(
    clienteId: string,
    dto: SetTarifasClienteDto,
    userId: string,
  ) {
    await this.findById(clienteId);
    // Última tarifa gana si mandan la misma aeronave dos veces.
    const porAeronave = new Map<string, number>();
    for (const t of dto.tarifas)
      porAeronave.set(t.aeronave_id, t.tarifa_hora_usd);
    const keep = [...porAeronave.keys()];

    // Sin transacción (dos llamadas PostgREST): PRIMERO el upsert y después el
    // borrado — si algo falla a la mitad, a lo sumo sobran tarifas por quitar
    // (visibles y reintentables); nunca se pierden las pactadas.
    if (keep.length > 0) {
      const now = new Date().toISOString();
      const { error } = await this.supabase.service
        .from('tarifa_cliente_aeronave')
        .upsert(
          [...porAeronave].map(([aeronave_id, tarifa_hora_usd]) => ({
            cliente_id: clienteId,
            aeronave_id,
            tarifa_hora_usd,
            updated_at: now,
            updated_by: userId,
          })),
          { onConflict: 'cliente_id,aeronave_id' },
        );
      if (error) {
        if (error.code === '23503')
          throw new BadRequestException('Alguna aeronave no existe');
        throw new Error(error.message);
      }
    }

    // Las aeronaves que ya no vienen pierden su tarifa (vuelven a la default).
    let del = this.supabase.service
      .from('tarifa_cliente_aeronave')
      .delete()
      .eq('cliente_id', clienteId);
    if (keep.length > 0)
      del = del.not('aeronave_id', 'in', `(${keep.join(',')})`);
    const { error: delError } = await del;
    if (delError) throw new Error(delError.message);

    return this.listTarifas(clienteId);
  }
}
