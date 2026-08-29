-- 28-ago-2026 · Inventario: código de barras CANÓNICO (UPC-A ↔ EAN-13).
--
-- Un EAN-13 que empieza con 0 ES el UPC-A con un cero de relleno (GTIN-12 →
-- GTIN-13): los escáneres entregan el mismo producto de cualquiera de las
-- dos formas ("0021400062153" vs "021400062153"). Sin canonizar, el índice
-- único no detecta el duplicado y la búsqueda por código falla según el
-- escáner. El API (normalizarCodigo) guarda y busca SIEMPRE los 12 dígitos;
-- esta función es el espejo en BD para que el candado de unicidad compare
-- lo mismo. No toca 14 dígitos (ITF-14 de la caja: su 0 inicial es el
-- indicador de empaque) ni códigos con letras (SKU internos).

create or replace function public.inventario_codigo_unico()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_codigo text := nullif(btrim(new.codigo), '');
begin
  if v_codigo is null then
    new.codigo := null;
    return new;
  end if;
  -- EAN-13 con prefijo 0 = UPC-A: se guarda y compara como 12 dígitos.
  if v_codigo ~ '^0\d{12}$' then
    v_codigo := substr(v_codigo, 2);
  end if;
  new.codigo := v_codigo;
  if tg_table_name = 'inventario_item' then
    if exists (select 1 from public.inventario_item_empaque e where e.codigo = v_codigo) then
      raise exception 'El código % ya pertenece a un empaque de otro producto', v_codigo
        using errcode = 'unique_violation';
    end if;
  elsif tg_table_name = 'inventario_item_empaque' then
    if exists (select 1 from public.inventario_item i where i.codigo = v_codigo) then
      raise exception 'El código % ya pertenece a un producto (unidad)', v_codigo
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$;

-- Canoniza lo ya guardado con prefijo 0 (hoy no hay filas así: el módulo
-- acaba de nacer). Se salta un código cuya forma de 12 dígitos ya exista en
-- ítems o empaques para no chocar con los índices únicos: ese caso se
-- resuelve a mano (dos registros del MISMO producto).
update public.inventario_item i
   set codigo = substr(i.codigo, 2)
 where i.codigo ~ '^0\d{12}$'
   and not exists (select 1 from public.inventario_item x where x.codigo = substr(i.codigo, 2))
   and not exists (select 1 from public.inventario_item_empaque e where e.codigo = substr(i.codigo, 2));

update public.inventario_item_empaque e
   set codigo = substr(e.codigo, 2)
 where e.codigo ~ '^0\d{12}$'
   and not exists (select 1 from public.inventario_item_empaque x where x.codigo = substr(e.codigo, 2))
   and not exists (select 1 from public.inventario_item i where i.codigo = substr(e.codigo, 2));
