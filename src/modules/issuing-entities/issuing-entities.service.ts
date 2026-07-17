import { X509Certificate } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type {
  CreateIssuingEntityDto,
  ListIssuingEntitiesQuery,
  UpdateIssuingEntityDto,
  UploadCsdDto,
} from './dto/issuing-entities.dto';

const COLS =
  'id, codigo, razon_social, rfc, regimen_fiscal_sat, codigo_postal, direccion, email_facturacion, telefono, pac_proveedor, notas, activa, csd_cer_url, csd_key_url, created_at, updated_at';

@Injectable()
export class IssuingEntitiesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters: ListIssuingEntitiesQuery) {
    let q = this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(COLS, { count: 'exact' })
      .order('codigo', { ascending: true })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (typeof filters.activa === 'boolean') q = q.eq('activa', filters.activa);
    else q = q.eq('activa', true);
    if (filters.q) {
      const term = `%${filters.q}%`;
      q = q.or(
        `codigo.ilike.${term},razon_social.ilike.${term},rfc.ilike.${term}`,
      );
    }
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return {
      data: data ?? [],
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async findById(id: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(COLS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Entidad fiscal ${id} not found`);
    return data;
  }

  async findByCodigo(codigo: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .select(COLS)
      .eq('codigo', codigo.toUpperCase())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new NotFoundException(`Entidad fiscal ${codigo} not found`);
    return data;
  }

  async create(dto: CreateIssuingEntityDto, createdBy: string) {
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .insert({
        ...dto,
        codigo: dto.codigo.toUpperCase(),
        created_by: createdBy,
        updated_by: createdBy,
      })
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('codigo or rfc already exists');
      throw new Error(error.message);
    }
    return data!;
  }

  async update(id: string, dto: UpdateIssuingEntityDto, updatedBy: string) {
    if (Object.keys(dto).length === 0) return this.findById(id);
    const patch: Record<string, unknown> = { ...dto, updated_by: updatedBy };
    if (dto.codigo) patch.codigo = dto.codigo.toUpperCase();
    const { data, error } = await this.supabase.service
      .from('entidad_fiscal_emisora')
      .update(patch)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        throw new ConflictException('codigo or rfc collision');
      throw new Error(error.message);
    }
    if (!data) throw new NotFoundException(`Entidad fiscal ${id} not found`);
    return data;
  }

  async softDelete(id: string, updatedBy: string) {
    return this.update(id, { activa: false }, updatedBy);
  }

  /**
   * Sube el CSD del SAT (.cer/.key en DER) al bucket privado `csd` y guarda
   * las rutas en la emisora. El primer timbrado lo registra en el PAC
   * automáticamente; la contraseña vive en el env CSD_PASSWORD (nunca en BD).
   */
  async uploadCsd(id: string, dto: UploadCsdDto, updatedBy: string) {
    const entidad = await this.findById(id);
    const codigo = String(entidad.codigo);

    const cer = Buffer.from(dto.cer_b64, 'base64');
    const key = Buffer.from(dto.key_b64, 'base64');

    // El .cer debe ser un certificado X.509 real (los del SAT vienen en DER):
    // atrapa basura, PEM y el .key subido en el lugar del .cer.
    let certificado: X509Certificate;
    try {
      certificado = new X509Certificate(cer);
    } catch {
      throw new BadRequestException(
        'El archivo .cer no es un certificado válido del SAT. ' +
          'Verifica que subiste el .cer del CSD (no el .key ni la e.firma renombrada).',
      );
    }
    // El certificado trae el RFC del titular: si no coincide con la emisora,
    // es el CSD de otra empresa (o la e.firma de una persona) — rechazar
    // aquí y no hasta que el SAT rebote el timbrado.
    const rfcEmisora = entidad.rfc ? String(entidad.rfc).toUpperCase() : null;
    if (rfcEmisora && !certificado.subject.toUpperCase().includes(rfcEmisora)) {
      throw new BadRequestException(
        `El certificado no pertenece al RFC ${rfcEmisora} de esta emisora. ` +
          'Verifica que sea el CSD correcto.',
      );
    }
    if (new Date(certificado.validTo).getTime() < Date.now()) {
      throw new BadRequestException(
        `El certificado está VENCIDO (venció el ${certificado.validTo}). ` +
          'Sube el CSD renovado.',
      );
    }
    // La llave privada cifrada (PKCS#8 DER) también empieza con 0x30, pero
    // NUNCA parsea como certificado: si parsea, subieron el .cer dos veces.
    if (key.length < 64 || key[0] !== 0x30) {
      throw new BadRequestException(
        'El archivo .key no parece una llave privada CSD del SAT (formato DER).',
      );
    }
    try {
      new X509Certificate(key);
      throw new BadRequestException(
        'El archivo .key es un certificado, no una llave privada: ' +
          'parece que subiste el .cer en ambos campos.',
      );
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // No parsea como certificado: es lo esperado para una llave.
    }

    // Rutas VERSIONADAS: la BD apunta al par vigente y solo se actualiza
    // cuando AMBOS archivos subieron. Si una renovación falla a medias, el
    // timbrado sigue usando el par anterior consistente (nunca cer nuevo con
    // key vieja). Los pares viejos quedan en el bucket como historial.
    const storage = this.supabase.service.storage.from('csd');
    const version = Date.now();
    const cerPath = `${codigo}/csd-${version}.cer`;
    const keyPath = `${codigo}/csd-${version}.key`;
    const [upCer, upKey] = await Promise.all([
      storage.upload(cerPath, cer, { contentType: 'application/octet-stream' }),
      storage.upload(keyPath, key, { contentType: 'application/octet-stream' }),
    ]);
    if (upCer.error)
      throw new Error(`No se pudo guardar el .cer: ${upCer.error.message}`);
    if (upKey.error)
      throw new Error(`No se pudo guardar el .key: ${upKey.error.message}`);

    return this.update(
      id,
      { csd_cer_url: cerPath, csd_key_url: keyPath } as UpdateIssuingEntityDto,
      updatedBy,
    );
  }
}
